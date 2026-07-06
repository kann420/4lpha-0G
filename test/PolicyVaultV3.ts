import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import {
  encodeAbiParameters,
  getAddress,
  keccak256,
  parseEther,
  stringToHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
const NATIVE_TOKEN = ZERO_ADDRESS;
const SWAP_POOL_ID = keccak256(stringToHex("4LPHA_0G_MOCK_POOL"));
const LP_POOL_ID = keccak256(stringToHex("4LPHA_0G_MOCK_LP_POOL_W0G_PAIRED"));
const LP_POOL_NON_W0G = keccak256(stringToHex("4LPHA_0G_MOCK_LP_POOL_PAIRED_OTHER"));
const AUDIT_ROOT = keccak256(stringToHex("v3-audit-root"));
const MODEL_HASH = keccak256(stringToHex("v3-model-metadata"));
const ZERO_HASH = `0x${"00".repeat(32)}` as Hex;
const BPS = 10_000n;
const LP_MIN_OUT_BPS = 9500n; // 5% slippage floor

type VaultLike = { address: Address; abi: Abi };
type AdapterLike = { address: Address; abi: Abi };

const UNBOUNDED = (1n << 256n) - 1n;

// ceilDiv(quote * bps, BPS) — mirrors the contract minLpOutFor
function minLpOutFor(quote: bigint, bps: bigint = LP_MIN_OUT_BPS): bigint {
  return (quote * bps + (BPS - 1n)) / BPS;
}

describe("0G PolicyVaultV3", async function () {
  const { viem, networkHelpers } = await network.create();
  const publicClient = await viem.getPublicClient();
  let nonceCounter = 1n;

  const basePolicy = {
    perTradeCap0G: UNBOUNDED,
    dailyCap0G: UNBOUNDED,
    maxExposure0G: UNBOUNDED,
    cooldownSeconds: 0n,
    maxDeadlineWindowSeconds: 3600n,
    defaultMinOutBps: 5000,
    lp: {
      perLpActionCap0G: UNBOUNDED,
      lpDailyCap0G: UNBOUNDED,
      maxLpExposure0G: UNBOUNDED,
      cooldownSecondsLp: 0n,
      lpMinOutBps: Number(LP_MIN_OUT_BPS),
      minLiquidityFloor: 0n,
      allowStaking: true,
    },
  };

  async function deployFixture() {
    const [owner, executor, other, identity] = await viem.getWalletClients();

    const registry = await viem.deployContract("ProofRegistry", [owner.account.address]);

    // Swap path (V2 surface)
    const swapToken = await viem.deployContract("MockAssetToken", [owner.account.address]);
    const swapAdapter = await viem.deployContract("MockDexAdapter", [
      owner.account.address,
      swapToken.address,
      parseEther("2"),
      parseEther("0.5"),
    ]);
    await swapToken.write.setMinter([swapAdapter.address]);

    // LP path
    const wnative = await viem.deployContract("MockWrappedNative", [owner.account.address]);
    const pairedToken = await viem.deployContract("MockAssetToken", [owner.account.address]);
    const otherToken = await viem.deployContract("MockAssetToken", [owner.account.address]);
    const nfpm = await viem.deployContract("MockNfpm", [owner.account.address]);
    const lpAdapter = await viem.deployContract("MockZiaLpAdapter", [
      owner.account.address,
      wnative.address,
      nfpm.address,
      pairedToken.address,
    ]);
    await nfpm.write.transferOwnership([lpAdapter.address], { account: owner.account });
    await pairedToken.write.setMinter([lpAdapter.address], { account: owner.account });
    await otherToken.write.setMinter([lpAdapter.address], { account: owner.account });
    await wnative.write.setMinter([lpAdapter.address], { account: owner.account });

    // W0G-leg pool + non-W0G pool (negative test)
    await lpAdapter.write.registerPool([LP_POOL_ID, wnative.address, pairedToken.address, 3000], {
      account: owner.account,
    });
    await lpAdapter.write.registerPool([LP_POOL_NON_W0G, pairedToken.address, otherToken.address, 3000], {
      account: owner.account,
    });

    // Stake vault
    const stakeVault = await viem.deployContract("MockZiaVault", [owner.account.address, nfpm.address]);

    const vault = await viem.deployContract("PolicyVaultV3", [
      owner.account.address,
      executor.account.address,
      swapAdapter.address,
      lpAdapter.address,
      registry.address,
      basePolicy,
      [swapToken.address, pairedToken.address],
      [SWAP_POOL_ID],
      [LP_POOL_ID, LP_POOL_NON_W0G],
      [stakeVault.address],
      [stakeVault.address, ZERO_ADDRESS], // parallel: W0G pool bound to stake vault, non-W0G pool unbound
      true,
      true,
    ]);

    // Fund adapter for native returns (zap-out, sweep native-out, sell path)
    await owner.sendTransaction({ to: swapAdapter.address, value: parseEther("10") });
    await owner.sendTransaction({ to: lpAdapter.address, value: parseEther("10") });
    // Fund vault with native for swaps + LP zap-in
    await owner.sendTransaction({ to: vault.address, value: parseEther("50") });

    const agentA = agentKey(identity.account.address, 1n);

    return {
      owner,
      executor,
      other,
      identity,
      registry,
      swapToken,
      swapAdapter,
      wnative,
      pairedToken,
      otherToken,
      nfpm,
      lpAdapter,
      stakeVault,
      vault,
      agentA,
    };
  }

  async function latestDeadline() {
    const latest = await networkHelpers.time.latest();
    return BigInt(latest + 600);
  }

  async function acceptProof(
    registry: { write: { acceptProof: (args: readonly [Hex, Hex, Hex, Hex, string, Hex, string]) => Promise<Hex> } },
    request: { actionHash: Hex; policySnapshotHash: Hex; vaultActionHash: Hex },
  ) {
    await registry.write.acceptProof([
      request.actionHash,
      AUDIT_ROOT,
      request.policySnapshotHash,
      MODEL_HASH,
      `0g-storage://${request.actionHash.slice(2, 18)}`,
      request.vaultActionHash,
      "agent-proof-registry:v3-test",
    ]);
  }

  // ---- Swap request builder (V2 verbatim surface) ----
  async function buyRequest(vault: VaultLike, token: Address, agentKey_: Hex, amountIn = parseEther("0.1")) {
    const policySnapshotHash = (await publicClient.readContract({
      address: vault.address,
      abi: vault.abi,
      functionName: "policyHash",
    })) as Hex;
    const quotedAmountOut = amountIn * 2n;
    const draft = {
      tokenIn: ZERO_ADDRESS,
      tokenOut: getAddress(token),
      amountIn,
      quotedAmountOut,
      amountOutMin: quotedAmountOut / 2n,
      deadline: await latestDeadline(),
      nonce: nonceCounter++,
      agentKey: agentKey_,
      poolId: SWAP_POOL_ID,
      vaultActionHash: ZERO_HASH,
      actionHash: ZERO_HASH,
      policySnapshotHash,
      auditRoot: AUDIT_ROOT,
    };
    const vaultActionHash = (await publicClient.readContract({
      address: vault.address,
      abi: vault.abi,
      functionName: "vaultActionHashFor",
      args: [true, draft],
    })) as Hex;
    const actionHash = (await publicClient.readContract({
      address: vault.address,
      abi: vault.abi,
      functionName: "actionHashFor",
      args: [vaultActionHash, AUDIT_ROOT, policySnapshotHash],
    })) as Hex;
    return { ...draft, vaultActionHash, actionHash };
  }

  // ---- LP action request builder ----
  type LpDraft = {
    actionType: number;
    agentKey: Hex;
    poolId: Hex;
    stakeVault: Address;
    tokenIn: Address;
    tokenOut: Address;
    tokenId: bigint;
    tickLower: bigint;
    tickUpper: bigint;
    amount0Desired: bigint;
    amount1Desired: bigint;
    liquidity: bigint;
    amount0Min: bigint;
    amount1Min: bigint;
    quotedLiquidity: bigint;
    quotedAmount0: bigint;
    quotedAmount1: bigint;
    quotedAmountOut: bigint;
    deadline: bigint;
    nonce: bigint;
    vaultActionHash: Hex;
    actionHash: Hex;
    policySnapshotHash: Hex;
    auditRoot: Hex;
  };

  async function buildLpRequest(vault: VaultLike, draft: Partial<LpDraft> & { actionType: number; agentKey: Hex; poolId: Hex }): Promise<LpDraft> {
    const policySnapshotHash = (await publicClient.readContract({
      address: vault.address,
      abi: vault.abi,
      functionName: "policyHash",
    })) as Hex;
    const base: LpDraft = {
      actionType: draft.actionType,
      agentKey: draft.agentKey,
      poolId: draft.poolId,
      stakeVault: draft.stakeVault ?? ZERO_ADDRESS,
      tokenIn: draft.tokenIn ?? ZERO_ADDRESS,
      tokenOut: draft.tokenOut ?? ZERO_ADDRESS,
      tokenId: draft.tokenId ?? 0n,
      tickLower: draft.tickLower ?? -1000n,
      tickUpper: draft.tickUpper ?? 1000n,
      amount0Desired: draft.amount0Desired ?? 0n,
      amount1Desired: draft.amount1Desired ?? 0n,
      liquidity: draft.liquidity ?? 0n,
      amount0Min: draft.amount0Min ?? 0n,
      amount1Min: draft.amount1Min ?? 0n,
      quotedLiquidity: draft.quotedLiquidity ?? 0n,
      quotedAmount0: draft.quotedAmount0 ?? 0n,
      quotedAmount1: draft.quotedAmount1 ?? 0n,
      quotedAmountOut: draft.quotedAmountOut ?? 0n,
      deadline: draft.deadline ?? (await latestDeadline()),
      nonce: draft.nonce ?? nonceCounter++,
      vaultActionHash: ZERO_HASH,
      actionHash: ZERO_HASH,
      policySnapshotHash,
      auditRoot: AUDIT_ROOT,
    };
    const vaultActionHash = (await publicClient.readContract({
      address: vault.address,
      abi: vault.abi,
      functionName: "vaultActionHashForLp",
      args: [base],
    })) as Hex;
    const actionHash = (await publicClient.readContract({
      address: vault.address,
      abi: vault.abi,
      functionName: "actionHashFor",
      args: [vaultActionHash, AUDIT_ROOT, policySnapshotHash],
    })) as Hex;
    return { ...base, vaultActionHash, actionHash };
  }

  // ===========================================================
  // V2 swap surface (byte-for-byte port)
  // ===========================================================

  it("executes a V2-style buy/sell roundtrip on the V3 contract", async function () {
    const { owner, executor, registry, swapToken, vault, agentA } = await networkHelpers.loadFixture(deployFixture);
    await vault.write.setAgentKeyEnabled([agentA, true], { account: owner.account });

    const buy = await buyRequest(vault, swapToken.address, agentA, parseEther("0.1"));
    await acceptProof(registry, buy);
    await vault.write.buy([buy], { account: executor.account });
    assert.equal(await vault.read.positionUnits([swapToken.address]), parseEther("0.2"));

    const sell = await (async () => {
      const policySnapshotHash = (await publicClient.readContract({
        address: vault.address,
        abi: vault.abi,
        functionName: "policyHash",
      })) as Hex;
      const amountIn = parseEther("0.2");
      const quotedAmountOut = amountIn / 2n;
      const draft = {
        tokenIn: getAddress(swapToken.address),
        tokenOut: ZERO_ADDRESS,
        amountIn,
        quotedAmountOut,
        amountOutMin: quotedAmountOut / 2n,
        deadline: await latestDeadline(),
        nonce: nonceCounter++,
        agentKey: agentA,
        poolId: SWAP_POOL_ID,
        vaultActionHash: ZERO_HASH,
        actionHash: ZERO_HASH,
        policySnapshotHash,
        auditRoot: AUDIT_ROOT,
      };
      const vaultActionHash = (await publicClient.readContract({
        address: vault.address,
        abi: vault.abi,
        functionName: "vaultActionHashFor",
        args: [false, draft],
      })) as Hex;
      const actionHash = (await publicClient.readContract({
        address: vault.address,
        abi: vault.abi,
        functionName: "actionHashFor",
        args: [vaultActionHash, AUDIT_ROOT, policySnapshotHash],
      })) as Hex;
      return { ...draft, vaultActionHash, actionHash };
    })();
    await acceptProof(registry, sell);
    await vault.write.sell([sell], { account: executor.account });
    assert.equal(await vault.read.positionUnits([swapToken.address]), 0n);
  });

  // ===========================================================
  // LP zap-in mint
  // ===========================================================

  it("accepts safe ERC721 returns from Zia staking vault withdrawals", async function () {
    const { vault } = await networkHelpers.loadFixture(deployFixture);
    assert.equal(
      await vault.read.onERC721Received([ZERO_ADDRESS, ZERO_ADDRESS, 1n, "0x"]),
      "0x150b7a02",
    );
  });

  it("zap-mints an LP NFT, tracks exposure, and rejects non-W0G pools", async function () {
    const { owner, executor, registry, vault, lpAdapter, nfpm, agentA } = await networkHelpers.loadFixture(deployFixture);
    await vault.write.setAgentKeyEnabled([agentA, true], { account: owner.account });

    const amount0G = parseEther("1");
    const quotedLiquidity = amount0G;
    const req = await buildLpRequest(vault, {
      actionType: 2, // ZAP_IN_MINT_LP
      agentKey: agentA,
      poolId: LP_POOL_ID,
      amount0Desired: amount0G,
      liquidity: quotedLiquidity,
      amount0Min: minLpOutFor(amount0G),
      amount1Min: minLpOutFor(amount0G),
      quotedLiquidity,
      quotedAmount0: amount0G,
      quotedAmount1: amount0G,
    });
    await acceptProof(registry, req);
    await vault.write.zapInMintLp([req], { account: executor.account });

    const exposure = (await vault.read.openLpExposure0G()) as bigint;
    assert.equal(exposure, amount0G);
    assert.equal(await vault.read.agentLpNotionalDeployed([agentA]), amount0G);
    assert.equal(await nfpm.read.balanceOf([vault.address]), 1n);

    // Non-W0G pool must revert LpPoolNotZappable
    const badReq = await buildLpRequest(vault, {
      actionType: 2,
      agentKey: agentA,
      poolId: LP_POOL_NON_W0G,
      amount0Desired: amount0G,
      liquidity: quotedLiquidity,
      amount0Min: minLpOutFor(amount0G),
      amount1Min: minLpOutFor(amount0G),
      quotedLiquidity,
      quotedAmount0: amount0G,
      quotedAmount1: amount0G,
    });
    await acceptProof(registry, badReq);
    await assert.rejects(vault.write.zapInMintLp([badReq], { account: executor.account }));
  });


  // ===========================================================
  // vault-direct stake / unstake
  // ===========================================================

  it("stakes an LP NFT directly into the Zia vault and unstakes it", async function () {
    const { owner, executor, registry, vault, stakeVault, nfpm, agentA } = await networkHelpers.loadFixture(deployFixture);
    await vault.write.setAgentKeyEnabled([agentA, true], { account: owner.account });

    const amount0G = parseEther("1");
    const mint = await buildLpRequest(vault, {
      actionType: 2,
      agentKey: agentA,
      poolId: LP_POOL_ID,
      amount0Desired: amount0G,
      liquidity: amount0G,
      amount0Min: minLpOutFor(amount0G),
      amount1Min: minLpOutFor(amount0G),
      quotedLiquidity: amount0G,
      quotedAmount0: amount0G,
      quotedAmount1: amount0G,
    });
    await acceptProof(registry, mint);
    await vault.write.zapInMintLp([mint], { account: executor.account });
    const tokenId = 1n;

    const stake = await buildLpRequest(vault, {
      actionType: 7, // STAKE_LP
      agentKey: agentA,
      poolId: LP_POOL_ID,
      stakeVault: stakeVault.address,
      tokenId,
    });
    await acceptProof(registry, stake);
    await vault.write.stakeLp([stake], { account: executor.account });
    assert.equal(getAddress(await nfpm.read.ownerOf([tokenId])), getAddress(stakeVault.address));
    assert.equal(getAddress(await stakeVault.read.depositorOf([tokenId])), getAddress(vault.address));

    const unstake = await buildLpRequest(vault, {
      actionType: 8, // UNSTAKE_LP
      agentKey: agentA,
      poolId: LP_POOL_ID,
      stakeVault: stakeVault.address,
      tokenId,
    });
    await acceptProof(registry, unstake);
    await vault.write.unstakeLp([unstake], { account: executor.account });
    assert.equal(getAddress(await nfpm.read.ownerOf([tokenId])), getAddress(vault.address));
  });

  // ===========================================================
  // exit-lockup guard (Codex high-severity fix) — exits survive allowlist disables
  // ===========================================================

  it("lets unstakeLp and zapOut proceed after disableStakeVault/disableLpPool, and blocks new entries", async function () {
    const { owner, executor, registry, vault, stakeVault, nfpm, agentA } = await networkHelpers.loadFixture(deployFixture);
    await vault.write.setAgentKeyEnabled([agentA, true], { account: owner.account });

    const amount0G = parseEther("1");
    const mint = await buildLpRequest(vault, {
      actionType: 2,
      agentKey: agentA,
      poolId: LP_POOL_ID,
      amount0Desired: amount0G,
      liquidity: amount0G,
      amount0Min: minLpOutFor(amount0G),
      amount1Min: minLpOutFor(amount0G),
      quotedLiquidity: amount0G,
      quotedAmount0: amount0G,
      quotedAmount1: amount0G,
    });
    await acceptProof(registry, mint);
    await vault.write.zapInMintLp([mint], { account: executor.account });
    const tokenId = 1n;

    const stake = await buildLpRequest(vault, {
      actionType: 7,
      agentKey: agentA,
      poolId: LP_POOL_ID,
      stakeVault: stakeVault.address,
      tokenId,
    });
    await acceptProof(registry, stake);
    await vault.write.stakeLp([stake], { account: executor.account });

    // Owner tightens: disable the stake vault AND the LP pool while the NFT is staked.
    await vault.write.disableStakeVault([stakeVault.address], { account: owner.account });
    await vault.write.disableLpPool([LP_POOL_ID], { account: owner.account });

    // New entry on the disabled pool is blocked.
    const blockedMint = await buildLpRequest(vault, {
      actionType: 2,
      agentKey: agentA,
      poolId: LP_POOL_ID,
      amount0Desired: amount0G,
      liquidity: amount0G,
      amount0Min: minLpOutFor(amount0G),
      amount1Min: minLpOutFor(amount0G),
      quotedLiquidity: amount0G,
      quotedAmount0: amount0G,
      quotedAmount1: amount0G,
    });
    await acceptProof(registry, blockedMint);
    await assert.rejects(vault.write.zapInMintLp([blockedMint], { account: executor.account }));

    // Exit survives: unstake still works even though the stake vault is disabled.
    const unstake = await buildLpRequest(vault, {
      actionType: 8,
      agentKey: agentA,
      poolId: LP_POOL_ID,
      stakeVault: stakeVault.address,
      tokenId,
    });
    await acceptProof(registry, unstake);
    await vault.write.unstakeLp([unstake], { account: executor.account });
    assert.equal(getAddress(await nfpm.read.ownerOf([tokenId])), getAddress(vault.address));

    // Exit survives: zapOut still works even though the LP pool is disabled.
    const zapOut = await buildLpRequest(vault, {
      actionType: 10,
      agentKey: agentA,
      poolId: LP_POOL_ID,
      tokenId,
      liquidity: amount0G,
      amount0Min: minLpOutFor(amount0G),
      quotedAmountOut: amount0G,
    });
    await acceptProof(registry, zapOut);
    await vault.write.zapOut([zapOut], { account: executor.account });

    assert.equal(await vault.read.openLpExposure0G(), 0n);
    assert.equal(await nfpm.read.balanceOf([vault.address]), 0n);
  });

  // ===========================================================
  // zap-out (full burn accounting — no ghost exposure)
  // ===========================================================

  it("zap-out fully burns the NFT and zeros exposure without ghost notional", async function () {
    const { owner, executor, registry, vault, lpAdapter, nfpm, agentA } = await networkHelpers.loadFixture(deployFixture);
    await vault.write.setAgentKeyEnabled([agentA, true], { account: owner.account });

    const amount0G = parseEther("1");
    const mint = await buildLpRequest(vault, {
      actionType: 2,
      agentKey: agentA,
      poolId: LP_POOL_ID,
      amount0Desired: amount0G,
      liquidity: amount0G,
      amount0Min: minLpOutFor(amount0G),
      amount1Min: minLpOutFor(amount0G),
      quotedLiquidity: amount0G,
      quotedAmount0: amount0G,
      quotedAmount1: amount0G,
    });
    await acceptProof(registry, mint);
    await vault.write.zapInMintLp([mint], { account: executor.account });
    const tokenId = 1n;

    const quotedOut = amount0G;
    const zapOut = await buildLpRequest(vault, {
      actionType: 10, // ZAP_OUT
      agentKey: agentA,
      poolId: LP_POOL_ID,
      tokenId,
      liquidity: amount0G,
      amount0Min: minLpOutFor(quotedOut),
      quotedAmountOut: quotedOut,
    });
    await acceptProof(registry, zapOut);
    await vault.write.zapOut([zapOut], { account: executor.account });

    assert.equal(await vault.read.openLpExposure0G(), 0n);
    assert.equal(await vault.read.agentLpNotionalDeployed([agentA]), 0n);
    assert.equal(await nfpm.read.balanceOf([vault.address]), 0n);
  });

  it("blocks stakeLp after disable/allowStaking=false but still lets unstakeLp proceed (exit-lockup branch coverage)", async function () {
    const { owner, executor, registry, vault, stakeVault, nfpm, agentA } = await networkHelpers.loadFixture(deployFixture);
    await vault.write.setAgentKeyEnabled([agentA, true], { account: owner.account });

    const amount0G = parseEther("1");
    // Mint two NFTs: #1 will be staked, #2 stays in vault custody.
    const mint1 = await buildLpRequest(vault, {
      actionType: 2,
      agentKey: agentA,
      poolId: LP_POOL_ID,
      amount0Desired: amount0G,
      liquidity: amount0G,
      amount0Min: minLpOutFor(amount0G),
      amount1Min: minLpOutFor(amount0G),
      quotedLiquidity: amount0G,
      quotedAmount0: amount0G,
      quotedAmount1: amount0G,
    });
    await acceptProof(registry, mint1);
    await vault.write.zapInMintLp([mint1], { account: executor.account });

    const mint2 = await buildLpRequest(vault, {
      actionType: 2,
      agentKey: agentA,
      poolId: LP_POOL_ID,
      amount0Desired: amount0G,
      liquidity: amount0G,
      amount0Min: minLpOutFor(amount0G),
      amount1Min: minLpOutFor(amount0G),
      quotedLiquidity: amount0G,
      quotedAmount0: amount0G,
      quotedAmount1: amount0G,
    });
    await acceptProof(registry, mint2);
    await vault.write.zapInMintLp([mint2], { account: executor.account });

    const stakedId = 1n;
    const custodiedId = 2n;

    const stake = await buildLpRequest(vault, {
      actionType: 7,
      agentKey: agentA,
      poolId: LP_POOL_ID,
      stakeVault: stakeVault.address,
      tokenId: stakedId,
    });
    await acceptProof(registry, stake);
    await vault.write.stakeLp([stake], { account: executor.account });

    // Tighten: allowStaking=false (entry gate). New stakeLp on the custodied NFT must reject.
    const tightened = { ...basePolicy, lp: { ...basePolicy.lp, allowStaking: false } };
    await vault.write.tightenPolicy([tightened], { account: owner.account });

    const blockedStake = await buildLpRequest(vault, {
      actionType: 7,
      agentKey: agentA,
      poolId: LP_POOL_ID,
      stakeVault: stakeVault.address,
      tokenId: custodiedId,
    });
    await acceptProof(registry, blockedStake);
    await assert.rejects(vault.write.stakeLp([blockedStake], { account: executor.account }));

    // Exit survives allowStaking=false: unstake the staked NFT still works.
    const unstake = await buildLpRequest(vault, {
      actionType: 8,
      agentKey: agentA,
      poolId: LP_POOL_ID,
      stakeVault: stakeVault.address,
      tokenId: stakedId,
    });
    await acceptProof(registry, unstake);
    await vault.write.unstakeLp([unstake], { account: executor.account });
    assert.equal(getAddress(await nfpm.read.ownerOf([stakedId])), getAddress(vault.address));
  });

  // ===========================================================
  // claimRewards — standalone no-modifier (Codex round-5 major 1)
  // ===========================================================

  it("reverts claimRewards as RewardsNotConfigured regardless of caller/pause state", async function () {
    const { owner, executor, vault, agentA } = await networkHelpers.loadFixture(deployFixture);
    await vault.write.setAgentKeyEnabled([agentA, true], { account: owner.account });

    const dummy = await buildLpRequest(vault, {
      actionType: 11, // CLAIM_REWARDS
      agentKey: agentA,
      poolId: LP_POOL_ID,
    });
    // Callable by anyone, no executor/pause gating — must always revert RewardsNotConfigured
    // (assert the exact selector, not just a generic rejection — Codex info-finding fix).
    async function assertRewardsNotConfigured(p: Promise<unknown>) {
      try {
        await p;
        assert.fail("expected claimRewards to revert");
      } catch (err: unknown) {
        const msg = String((err as { message?: string }).message ?? err);
        assert.ok(msg.includes("RewardsNotConfigured"), `expected RewardsNotConfigured, got: ${msg}`);
      }
    }
    await assertRewardsNotConfigured(vault.write.claimRewards([dummy], { account: executor.account }));
    await assertRewardsNotConfigured(vault.write.claimRewards([dummy], { account: owner.account }));

    await vault.write.setPaused([true], { account: owner.account });
    await assertRewardsNotConfigured(vault.write.claimRewards([dummy], { account: executor.account }));
  });

  // ===========================================================
  // Replay protection (LP)
  // ===========================================================

  it("rejects a replayed LP action hash", async function () {
    const { owner, executor, registry, vault, agentA } = await networkHelpers.loadFixture(deployFixture);
    await vault.write.setAgentKeyEnabled([agentA, true], { account: owner.account });

    const amount0G = parseEther("1");
    const mint = await buildLpRequest(vault, {
      actionType: 2,
      agentKey: agentA,
      poolId: LP_POOL_ID,
      amount0Desired: amount0G,
      liquidity: amount0G,
      amount0Min: minLpOutFor(amount0G),
      amount1Min: minLpOutFor(amount0G),
      quotedLiquidity: amount0G,
      quotedAmount0: amount0G,
      quotedAmount1: amount0G,
    });
    await acceptProof(registry, mint);
    await vault.write.zapInMintLp([mint], { account: executor.account });
    // Same actionHash already used — must revert Replay.
    await assert.rejects(vault.write.zapInMintLp([mint], { account: executor.account }));
  });

  // ===========================================================
  // Zero min-out rejected (LP)
  // ===========================================================

  it("rejects zap-mint with zero amount0Min (deny zero slippage protection)", async function () {
    const { owner, executor, registry, vault, agentA } = await networkHelpers.loadFixture(deployFixture);
    await vault.write.setAgentKeyEnabled([agentA, true], { account: owner.account });

    const amount0G = parseEther("1");
    const req = await buildLpRequest(vault, {
      actionType: 2,
      agentKey: agentA,
      poolId: LP_POOL_ID,
      amount0Desired: amount0G,
      liquidity: amount0G,
      amount0Min: 0n, // forbidden
      amount1Min: minLpOutFor(amount0G),
      quotedLiquidity: amount0G,
      quotedAmount0: amount0G,
      quotedAmount1: amount0G,
    });
    await acceptProof(registry, req);
    await assert.rejects(vault.write.zapInMintLp([req], { account: executor.account }));
  });

  // ===========================================================
  // M1: paired-token leftover handling (oversized leftovers become W0G refund)
  // ===========================================================

  it("converts oversized paired leftovers to W0G refund and accepts sub-bound paired dust", async function () {
    const { owner, executor, registry, vault, lpAdapter, pairedToken, wnative, agentA } =
      await networkHelpers.loadFixture(deployFixture);
    await vault.write.setAgentKeyEnabled([agentA, true], { account: owner.account });

    const amount0G = parseEther("1");
    // 10% paired leftover exceeds the dust bound, so it is converted back to W0G
    // and credited as a refund against deployed exposure.
    const overLeftover = amount0G / 10n;
    await lpAdapter.write.setDustToVault([overLeftover], { account: owner.account });
    const overDust = await buildLpRequest(vault, {
      actionType: 2,
      agentKey: agentA,
      poolId: LP_POOL_ID,
      amount0Desired: amount0G,
      liquidity: amount0G,
      amount0Min: minLpOutFor(amount0G),
      amount1Min: minLpOutFor(amount0G),
      quotedLiquidity: amount0G,
      quotedAmount0: amount0G,
      quotedAmount1: amount0G,
    });
    await acceptProof(registry, overDust);
    await vault.write.zapInMintLp([overDust], { account: executor.account });
    assert.equal(await vault.read.openLpExposure0G(), amount0G - overLeftover);
    assert.equal(await vault.read.agentLpNotionalDeployed([agentA]), amount0G - overLeftover);
    assert.equal(await wnative.read.balanceOf([vault.address]), overLeftover);

    // 0.1% paired dust is within the bound, so it is swept as paired dust and
    // deployed0G still records the full input for this second mint.
    const underDustAmount = amount0G / 1000n;
    await lpAdapter.write.setDustToVault([underDustAmount], { account: owner.account });
    const underDust = await buildLpRequest(vault, {
      actionType: 2,
      agentKey: agentA,
      poolId: LP_POOL_ID,
      amount0Desired: amount0G,
      liquidity: amount0G,
      amount0Min: minLpOutFor(amount0G),
      amount1Min: minLpOutFor(amount0G),
      quotedLiquidity: amount0G,
      quotedAmount0: amount0G,
      quotedAmount1: amount0G,
    });
    await acceptProof(registry, underDust);
    await vault.write.zapInMintLp([underDust], { account: executor.account });
    assert.equal(await vault.read.openLpExposure0G(), amount0G - overLeftover + amount0G);
    assert.equal(await vault.read.agentLpNotionalDeployed([agentA]), amount0G - overLeftover + amount0G);
    assert.equal(await pairedToken.read.balanceOf([vault.address]), underDustAmount);
  });

  it("accepts unused W0G returned to the vault and accounts deployed exposure net of refund", async function () {
    const { owner, executor, registry, vault, lpAdapter, wnative, nfpm, agentA } = await networkHelpers.loadFixture(deployFixture);
    await vault.write.setAgentKeyEnabled([agentA, true], { account: owner.account });

    const amount0G = parseEther("1");
    await lpAdapter.write.setW0GRefundToVault([amount0G], { account: owner.account });
    const fullRefundReq = await buildLpRequest(vault, {
      actionType: 2,
      agentKey: agentA,
      poolId: LP_POOL_ID,
      amount0Desired: amount0G,
      liquidity: amount0G,
      amount0Min: minLpOutFor(amount0G),
      amount1Min: minLpOutFor(amount0G),
      quotedLiquidity: amount0G,
      quotedAmount0: amount0G,
      quotedAmount1: amount0G,
    });
    await acceptProof(registry, fullRefundReq);
    await assert.rejects(vault.write.zapInMintLp([fullRefundReq], { account: executor.account }));

    const w0gRefund = amount0G / 2n;
    const deployedNative = amount0G - w0gRefund;
    await lpAdapter.write.setW0GRefundToVault([w0gRefund], { account: owner.account });
    const req = await buildLpRequest(vault, {
      actionType: 2,
      agentKey: agentA,
      poolId: LP_POOL_ID,
      amount0Desired: amount0G,
      liquidity: deployedNative,
      amount0Min: minLpOutFor(deployedNative),
      amount1Min: minLpOutFor(deployedNative),
      quotedLiquidity: deployedNative,
      quotedAmount0: deployedNative,
      quotedAmount1: deployedNative,
    });
    await acceptProof(registry, req);
    await vault.write.zapInMintLp([req], { account: executor.account });

    const tokenId = 1n;
    assert.equal(await vault.read.openLpExposure0G(), deployedNative);
    assert.equal(await vault.read.agentLpNotionalDeployed([agentA]), deployedNative);
    assert.equal(await vault.read.lpNftDeployedNative([tokenId]), deployedNative);
    assert.equal(await wnative.read.balanceOf([vault.address]), w0gRefund);
    assert.equal(await nfpm.read.balanceOf([vault.address]), 1n);
  });

  // ===========================================================
  // Factory V3
  // ===========================================================

  it("keeps FactoryV3 owner-bound, one V3 vault per owner, VERSION=3", async function () {
    // PolicyVaultFactoryV3 deployed bytecode is 28,596 bytes — over EIP-170's 24,576 cap.
    // It cannot be deployed on the default hardhat network or 0G mainnet, so run this
    // case only on the `hardhatMainnet` simulated network (allowUnlimitedContractSize).
    // V3 ships as a singleton via scripts/create-mainnet-vault-v3.ts; FactoryV3 is
    // non-shipping and kept for local-size coverage only.
    if (network.name !== "hardhatMainnet") {
      this.skip();
      return;
    }
    const { owner, executor, other, registry, swapAdapter, lpAdapter, swapToken, stakeVault } =
      await networkHelpers.loadFixture(deployFixture);
    const factory = await viem.deployContract("PolicyVaultFactoryV3");
    assert.equal(await factory.read.VERSION(), 3n);

    await assert.rejects(
      factory.write.createVault(
        [
          owner.account.address,
          executor.account.address,
          swapAdapter.address,
          lpAdapter.address,
          registry.address,
          basePolicy,
          [swapToken.address],
          [SWAP_POOL_ID],
          [LP_POOL_ID],
          [stakeVault.address],
          [stakeVault.address],
          true,
          true,
        ],
        { account: other.account },
      ),
    );

    await factory.write.createVault([
      owner.account.address,
      executor.account.address,
      swapAdapter.address,
      lpAdapter.address,
      registry.address,
      basePolicy,
      [swapToken.address],
      [SWAP_POOL_ID],
      [LP_POOL_ID],
      [stakeVault.address],
      [stakeVault.address],
      true,
      true,
    ]);
    const v = await factory.read.vaultOf([owner.account.address]);
    assert.notEqual(v, ZERO_ADDRESS);

    // Second create for same owner must revert VaultAlreadyExists.
    await assert.rejects(
      factory.write.createVault([
        owner.account.address,
        executor.account.address,
        swapAdapter.address,
        lpAdapter.address,
        registry.address,
        basePolicy,
        [swapToken.address],
        [SWAP_POOL_ID],
        [LP_POOL_ID],
        [stakeVault.address],
        [stakeVault.address],
        true,
        true,
      ]),
    );
  });
});

function agentKey(identityAddress: Address, tokenId: bigint): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { name: "identityAddress", type: "address" },
        { name: "tokenId", type: "uint256" },
      ],
      [identityAddress, tokenId],
    ),
  );
}
