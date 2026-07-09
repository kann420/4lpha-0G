import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";

import { network } from "hardhat";
import {
  getAddress,
  keccak256,
  parseEther,
  stringToHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
// Must equal MockDexAdapter.DEFAULT_POOL_ID (keccak256("4LPHA_0G_MOCK_POOL")) so the
// preexisting swap adapter accepts the poolId V4Swap forwards. V2/V3 tests use the same string.
const SWAP_POOL_ID = keccak256(stringToHex("4LPHA_0G_MOCK_POOL"));
const LP_POOL_ID = keccak256(stringToHex("4LPHA_0G_V4_MOCK_LP_POOL_W0G_PAIRED"));
const LP_POOL_NON_W0G = keccak256(stringToHex("4LPHA_0G_V4_MOCK_LP_POOL_PAIRED_OTHER"));
const SWEEP_POOL_ID = keccak256(stringToHex("4LPHA_0G_V4_SWEEP_POOL"));
const AUDIT_ROOT = keccak256(stringToHex("v4-audit-root"));
const MODEL_HASH = keccak256(stringToHex("v4-model-metadata"));
const ZERO_HASH = `0x${"00".repeat(32)}` as Hex;
const BPS = 10_000n;
const LP_MIN_OUT_BPS = 9500n;
const UNBOUNDED = (1n << 256n) - 1n;

type ContractLike = { address: Address; abi: Abi };

describe("0G PolicyVaultV4 split", async function () {
  const { viem, networkHelpers } = await network.create();
  const publicClient = await viem.getPublicClient();
  let nonceCounter = 1n;

  const swapPolicy = {
    perTradeCap0G: UNBOUNDED,
    dailyCap0G: UNBOUNDED,
    maxExposure0G: UNBOUNDED,
    cooldownSeconds: 0n,
    maxDeadlineWindowSeconds: 3600n,
    defaultMinOutBps: 5000,
  };

  const lpPolicy = {
    perLpActionCap0G: UNBOUNDED,
    lpDailyCap0G: UNBOUNDED,
    maxLpExposure0G: UNBOUNDED,
    cooldownSecondsLp: 0n,
    lpMinOutBps: Number(LP_MIN_OUT_BPS),
    minLiquidityFloor: 0n,
    allowStaking: true,
  };

  async function deployFixture() {
    const [owner, executor, other, identity] = await viem.getWalletClients();

    const proofRegistry = await viem.deployContract("ProofRegistry", [owner.account.address]);
    const registry = await viem.deployContract("VaultRegistryV4", []);

    const swapToken = await viem.deployContract("MockAssetToken", [owner.account.address]);
    const swapAdapter = await viem.deployContract("MockDexAdapter", [
      owner.account.address,
      swapToken.address,
      parseEther("2"),
      parseEther("0.5"),
    ]);
    await swapToken.write.setMinter([swapAdapter.address], { account: owner.account });

    const wnative = await viem.deployContract("MockWrappedNative", [owner.account.address]);
    const pairedToken = await viem.deployContract("MockAssetToken", [owner.account.address]);
    const otherToken = await viem.deployContract("MockAssetToken", [owner.account.address]);
    const nfpm = await viem.deployContract("MockNfpm", [owner.account.address]);
    const lpAdapter = await viem.deployContract("MockZiaLpAdapterV4", [
      owner.account.address,
      wnative.address,
      nfpm.address,
      pairedToken.address,
    ]);
    await nfpm.write.transferOwnership([lpAdapter.address], { account: owner.account });
    await pairedToken.write.setMinter([lpAdapter.address], { account: owner.account });
    await otherToken.write.setMinter([lpAdapter.address], { account: owner.account });
    await wnative.write.setMinter([lpAdapter.address], { account: owner.account });

    await lpAdapter.write.registerPool([LP_POOL_ID, wnative.address, pairedToken.address, 3000], {
      account: owner.account,
    });
    await lpAdapter.write.registerPool([LP_POOL_NON_W0G, pairedToken.address, otherToken.address, 3000], {
      account: owner.account,
    });
    await lpAdapter.write.registerPool([SWEEP_POOL_ID, pairedToken.address, wnative.address, 3000], {
      account: owner.account,
    });

    const stakeVault = await viem.deployContract("MockZiaVault", [owner.account.address, nfpm.address]);

    const lpEntry = await viem.deployContract("PolicyVaultV4LpEntry", [
      owner.account.address,
      executor.account.address,
      lpAdapter.address,
      proofRegistry.address,
      true,
      registry.address,
      lpPolicy,
      [LP_POOL_ID, LP_POOL_NON_W0G],
      [stakeVault.address],
      [stakeVault.address, ZERO_ADDRESS],
    ], { account: owner.account });

    const lpExit = await viem.deployContract("PolicyVaultV4LpExit", [
      owner.account.address,
      executor.account.address,
      lpAdapter.address,
      proofRegistry.address,
      true,
      registry.address,
      lpEntry.address,
      [LP_POOL_ID, LP_POOL_NON_W0G, SWEEP_POOL_ID],
      [wnative.address, pairedToken.address],
    ], { account: owner.account });

    const swap = await viem.deployContract("PolicyVaultV4Swap", [
      owner.account.address,
      executor.account.address,
      swapAdapter.address,
      proofRegistry.address,
      swapPolicy,
      [swapToken.address, pairedToken.address],
      [SWAP_POOL_ID],
      true,
      registry.address,
    ], { account: owner.account });

    await registry.write.registerLpEntry([lpEntry.address], { account: owner.account });
    await registry.write.registerLpExit([lpExit.address], { account: owner.account });
    await registry.write.registerSwap([swap.address], { account: owner.account });
    await lpEntry.write.setLpExitVault([lpExit.address], { account: owner.account });

    await owner.sendTransaction({ to: swapAdapter.address, value: parseEther("10") });
    await owner.sendTransaction({ to: lpAdapter.address, value: parseEther("10") });
    await owner.sendTransaction({ to: swap.address, value: parseEther("20") });
    await owner.sendTransaction({ to: lpEntry.address, value: parseEther("20") });

    const agentA = agentKey(identity.account.address, 1n);

    return {
      owner,
      executor,
      other,
      identity,
      proofRegistry,
      registry,
      swapToken,
      swapAdapter,
      wnative,
      pairedToken,
      otherToken,
      nfpm,
      lpAdapter,
      stakeVault,
      swap,
      lpEntry,
      lpExit,
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
      "agent-proof-registry:v4-test",
    ]);
  }

  async function buildTradeRequest(
    vault: ContractLike,
    agentKey_: Hex,
    tokenIn: Address,
    tokenOut: Address,
    amountIn: bigint,
    quotedAmountOut: bigint,
    isBuy: boolean,
  ) {
    const policySnapshotHash = (await publicClient.readContract({
      address: vault.address,
      abi: vault.abi,
      functionName: "policyHash",
    })) as Hex;
    const draft = {
      tokenIn,
      tokenOut,
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
      args: [isBuy, draft],
    })) as Hex;
    const actionHash = (await publicClient.readContract({
      address: vault.address,
      abi: vault.abi,
      functionName: "actionHashFor",
      args: [vaultActionHash, AUDIT_ROOT, policySnapshotHash],
    })) as Hex;
    return { ...draft, vaultActionHash, actionHash };
  }

  type LpDraft = {
    actionType: number;
    agentKey: Hex;
    poolId: Hex;
    stakeVault: Address;
    tokenIn: Address;
    tokenOut: Address;
    tokenId: bigint;
    tickLower: number;
    tickUpper: number;
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

  async function buildLpRequest(
    target: ContractLike,
    policySource: ContractLike,
    draft: Partial<LpDraft> & { actionType: number; agentKey: Hex; poolId: Hex },
  ): Promise<LpDraft> {
    const policySnapshotHash = (await publicClient.readContract({
      address: policySource.address,
      abi: policySource.abi,
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
      tickLower: draft.tickLower ?? -1000,
      tickUpper: draft.tickUpper ?? 1000,
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
      address: target.address,
      abi: target.abi,
      functionName: "vaultActionHashForLp",
      args: [base],
    })) as Hex;
    const actionHash = (await publicClient.readContract({
      address: target.address,
      abi: target.abi,
      functionName: "actionHashFor",
      args: [vaultActionHash, AUDIT_ROOT, policySnapshotHash],
    })) as Hex;
    return { ...base, vaultActionHash, actionHash };
  }

  async function mintLp(fixture: Awaited<ReturnType<typeof deployFixture>>, amount0G = parseEther("1")) {
    const mint = await buildLpRequest(fixture.lpEntry, fixture.lpEntry, {
      actionType: 2,
      agentKey: fixture.agentA,
      poolId: LP_POOL_ID,
      amount0Desired: amount0G,
      liquidity: amount0G,
      amount0Min: minLpOutFor(amount0G),
      amount1Min: minLpOutFor(amount0G),
      quotedLiquidity: amount0G,
      quotedAmount0: amount0G,
      quotedAmount1: amount0G,
    });
    await acceptProof(fixture.proofRegistry, mint);
    await fixture.lpEntry.write.zapInMintLp([mint], { account: fixture.executor.account });
    return 1n;
  }

  it("deploys the owner-called V4 registry model and keeps all thirds under size caps", async function () {
    const { owner, registry, swap, lpEntry, lpExit } = await networkHelpers.loadFixture(deployFixture);
    const resolved = await registry.read.vaultOf([owner.account.address]);
    assert.deepEqual(
      resolved.map((value: Address) => getAddress(value)),
      [swap.address, lpEntry.address, lpExit.address].map((value) => getAddress(value)),
    );
    assert.equal(await lpEntry.read.lpExitVault(), getAddress(lpExit.address));

    for (const [label, address, target] of [
      ["PolicyVaultV4Swap", swap.address, 24576],
      ["PolicyVaultV4LpEntry", lpEntry.address, 23000],
      ["PolicyVaultV4LpExit", lpExit.address, 23000],
      ["VaultRegistryV4", registry.address, 24576],
    ] as const) {
      const bytecode = await publicClient.getBytecode({ address });
      assert.ok(bytecode && bytecode !== "0x", `${label} bytecode missing`);
      const bytes = (bytecode.length - 2) / 2;
      assert.ok(bytes < target, `${label} size ${bytes} exceeds ${target}`);
    }
  });

  it("rejects owner-spoofed registration and accepts only the real owner call", async function () {
    const { owner, other, registry, swap } = await networkHelpers.loadFixture(deployFixture);
    const fake = await viem.deployContract("ReenteringFactory", [owner.account.address], { account: other.account });
    await assert.rejects(registry.write.registerSwap([fake.address], { account: other.account }));
    assert.equal(getAddress(await registry.read.swapVaultOf([owner.account.address])), getAddress(swap.address));
  });

  it("rejects re-registration of an already-registered owner slot (one-shot)", async function () {
    const { owner, registry, swap } = await networkHelpers.loadFixture(deployFixture);
    // deployFixture already registered owner's swap slot. Re-registering any
    // vault owned by owner must revert AlreadyRegistered — one-shot registration
    // prevents an owner from silently swapping in a different vault after the
    // resolver has pinned the first one.
    await assert.rejects(registry.write.registerSwap([swap.address], { account: owner.account }), /AlreadyRegistered/);
  });

  it("executes V4 swap buy/sell through the swap third and rejects disabled agent-key buys", async function () {
    const { owner, executor, proofRegistry, swapToken, swap, agentA } = await networkHelpers.loadFixture(deployFixture);
    const disabledBuy = await buildTradeRequest(
      swap,
      agentA,
      ZERO_ADDRESS,
      swapToken.address,
      parseEther("0.1"),
      parseEther("0.2"),
      true,
    );
    await acceptProof(proofRegistry, disabledBuy);
    await assert.rejects(swap.write.buy([disabledBuy], { account: executor.account }));

    await swap.write.setAgentKeyEnabled([agentA, true], { account: owner.account });
    const buy = await buildTradeRequest(
      swap,
      agentA,
      ZERO_ADDRESS,
      swapToken.address,
      parseEther("0.1"),
      parseEther("0.2"),
      true,
    );
    await acceptProof(proofRegistry, buy);
    await swap.write.buy([buy], { account: executor.account });
    assert.equal(await swap.read.positionUnits([swapToken.address]), parseEther("0.2"));

    const sell = await buildTradeRequest(
      swap,
      agentA,
      swapToken.address,
      ZERO_ADDRESS,
      parseEther("0.2"),
      parseEther("0.1"),
      false,
    );
    await acceptProof(proofRegistry, sell);
    await swap.write.sell([sell], { account: executor.account });
    assert.equal(await swap.read.positionUnits([swapToken.address]), 0n);
  });

  it("mints, stakes, unstakes, and zaps out through the split LP entry/exit thirds", async function () {
    const fixture = await networkHelpers.loadFixture(deployFixture);
    const { owner, executor, proofRegistry, lpEntry, lpExit, stakeVault, nfpm, agentA } = fixture;
    await lpEntry.write.setAgentKeyEnabled([agentA, true], { account: owner.account });
    await lpExit.write.setAgentKeyEnabled([agentA, true], { account: owner.account });

    const tokenId = await mintLp(fixture);
    assert.equal(getAddress(await nfpm.read.ownerOf([tokenId])), getAddress(lpEntry.address));
    assert.equal(await lpEntry.read.openLpExposure0G(), parseEther("1"));

    const stake = await buildLpRequest(lpEntry, lpEntry, {
      actionType: 7,
      agentKey: agentA,
      poolId: LP_POOL_ID,
      stakeVault: stakeVault.address,
      tokenId,
    });
    await acceptProof(proofRegistry, stake);
    await lpEntry.write.stakeLp([stake], { account: executor.account });
    assert.equal(getAddress(await nfpm.read.ownerOf([tokenId])), getAddress(stakeVault.address));

    const unstake = await buildLpRequest(lpExit, lpEntry, {
      actionType: 8,
      agentKey: agentA,
      poolId: LP_POOL_ID,
      stakeVault: stakeVault.address,
      tokenId,
    });
    await acceptProof(proofRegistry, unstake);
    await lpExit.write.unstakeLp([unstake], { account: executor.account });
    assert.equal(getAddress(await nfpm.read.ownerOf([tokenId])), getAddress(lpEntry.address));

    const zapOut = await buildLpRequest(lpExit, lpEntry, {
      actionType: 10,
      agentKey: agentA,
      poolId: LP_POOL_ID,
      tokenId,
      liquidity: parseEther("1"),
      amount0Min: minLpOutFor(parseEther("1")),
      quotedAmountOut: parseEther("1"),
    });
    await acceptProof(proofRegistry, zapOut);
    await lpExit.write.zapOut([zapOut], { account: executor.account });
    assert.equal(await lpEntry.read.openLpExposure0G(), 0n);
    assert.equal(await lpEntry.read.lpNftOwner([tokenId]), ZERO_HASH);
  });

  it("blocks new LP entries after allowlist or agent-key disable but keeps exits available", async function () {
    const fixture = await networkHelpers.loadFixture(deployFixture);
    const { owner, executor, proofRegistry, lpEntry, lpExit, agentA } = fixture;
    await lpEntry.write.setAgentKeyEnabled([agentA, true], { account: owner.account });
    await lpExit.write.setAgentKeyEnabled([agentA, true], { account: owner.account });
    const tokenId = await mintLp(fixture);

    await lpEntry.write.disableLpPool([LP_POOL_ID], { account: owner.account });
    await lpEntry.write.setAgentKeyEnabled([agentA, false], { account: owner.account });
    const blockedIncrease = await buildLpRequest(lpEntry, lpEntry, {
      actionType: 3,
      agentKey: agentA,
      poolId: LP_POOL_ID,
      tokenId,
      amount0Desired: parseEther("0.1"),
      liquidity: parseEther("0.1"),
      amount0Min: minLpOutFor(parseEther("0.1")),
      amount1Min: minLpOutFor(parseEther("0.1")),
      quotedAmount0: parseEther("0.1"),
      quotedAmount1: parseEther("0.1"),
    });
    await acceptProof(proofRegistry, blockedIncrease);
    await assert.rejects(lpEntry.write.zapInIncreaseLiquidity([blockedIncrease], { account: executor.account }));

    const decrease = await buildLpRequest(lpExit, lpEntry, {
      actionType: 4,
      agentKey: agentA,
      poolId: LP_POOL_ID,
      tokenId,
      liquidity: parseEther("0.5"),
      amount0Min: minLpOutFor(parseEther("0.5")),
      amount1Min: minLpOutFor(parseEther("0.5")),
      quotedAmount0: parseEther("0.5"),
      quotedAmount1: parseEther("0.5"),
    });
    await acceptProof(proofRegistry, decrease);
    await lpExit.write.decreaseLiquidity([decrease], { account: executor.account });
    assert.equal(await lpEntry.read.lpNftOwner([tokenId]), agentA);
    assert.equal(await lpEntry.read.lpNftDeployedNative([tokenId]), parseEther("0.5"));
  });

  it("enforces nonzero min-out on LP exits and the documented burn zero-quote exception", async function () {
    const fixture = await networkHelpers.loadFixture(deployFixture);
    const { owner, executor, proofRegistry, lpEntry, lpExit, agentA } = fixture;
    await lpEntry.write.setAgentKeyEnabled([agentA, true], { account: owner.account });
    await lpExit.write.setAgentKeyEnabled([agentA, true], { account: owner.account });
    const tokenId = await mintLp(fixture);

    const badCollect = await buildLpRequest(lpExit, lpEntry, {
      actionType: 5,
      agentKey: agentA,
      poolId: LP_POOL_ID,
      tokenId,
      amount0Min: 0n,
      amount1Min: 1n,
    });
    await acceptProof(proofRegistry, badCollect);
    await assert.rejects(lpExit.write.collectFees([badCollect], { account: executor.account }));

    const decrease = await buildLpRequest(lpExit, lpEntry, {
      actionType: 4,
      agentKey: agentA,
      poolId: LP_POOL_ID,
      tokenId,
      liquidity: parseEther("1"),
      amount0Min: minLpOutFor(parseEther("1")),
      amount1Min: minLpOutFor(parseEther("1")),
      quotedAmount0: parseEther("1"),
      quotedAmount1: parseEther("1"),
    });
    await acceptProof(proofRegistry, decrease);
    await lpExit.write.decreaseLiquidity([decrease], { account: executor.account });

    const burn = await buildLpRequest(lpExit, lpEntry, {
      actionType: 6,
      agentKey: agentA,
      poolId: LP_POOL_ID,
      tokenId,
      quotedAmount0: 0n,
      quotedAmount1: 0n,
      amount0Min: 0n,
      amount1Min: 0n,
    });
    await acceptProof(proofRegistry, burn);
    await lpExit.write.burnLp([burn], { account: executor.account });
    assert.equal(await lpEntry.read.lpNftOwner([tokenId]), ZERO_HASH);
  });

  it("sweeps only LpExit-local allowlisted tokens and routes", async function () {
    const fixture = await networkHelpers.loadFixture(deployFixture);
    const { owner, executor, proofRegistry, lpEntry, lpExit, pairedToken, agentA } = fixture;
    await lpExit.write.setAgentKeyEnabled([agentA, true], { account: owner.account });
    await pairedToken.write.setMinter([owner.account.address], { account: owner.account });
    await pairedToken.write.mint([lpExit.address, parseEther("1")], { account: owner.account });

    const sweep = await buildLpRequest(lpExit, lpEntry, {
      actionType: 9,
      agentKey: agentA,
      poolId: SWEEP_POOL_ID,
      tokenIn: pairedToken.address,
      tokenOut: ZERO_ADDRESS,
      amount0Desired: parseEther("1"),
      amount1Min: minLpOutFor(parseEther("1")),
      quotedAmountOut: parseEther("1"),
    });
    await acceptProof(proofRegistry, sweep);
    await lpExit.write.sweepToken([sweep], { account: executor.account });
    assert.equal(await pairedToken.read.balanceOf([lpExit.address]), 0n);
  });

  it("keeps owner recovery paths owner-only on all thirds", async function () {
    const fixture = await networkHelpers.loadFixture(deployFixture);
    const { owner, executor, other, lpEntry, lpExit, swap, stakeVault, nfpm, agentA } = fixture;
    await lpEntry.write.setAgentKeyEnabled([agentA, true], { account: owner.account });
    await lpExit.write.setAgentKeyEnabled([agentA, true], { account: owner.account });
    const tokenId = await mintLp(fixture);

    await assert.rejects(swap.write.withdrawNative([1n], { account: executor.account }));
    await assert.rejects(lpEntry.write.withdrawNative([1n], { account: executor.account }));
    await assert.rejects(lpExit.write.withdrawNative([1n], { account: executor.account }));
    await assert.rejects(lpEntry.write.rescueNft([tokenId, other.account.address], { account: executor.account }));

    const stake = await buildLpRequest(lpEntry, lpEntry, {
      actionType: 7,
      agentKey: agentA,
      poolId: LP_POOL_ID,
      stakeVault: stakeVault.address,
      tokenId,
    });
    await acceptProof(fixture.proofRegistry, stake);
    await lpEntry.write.stakeLp([stake], { account: executor.account });
    await lpExit.write.unstakeLpOwner([tokenId, stakeVault.address], { account: owner.account });
    assert.equal(getAddress(await nfpm.read.ownerOf([tokenId])), getAddress(lpEntry.address));
  });

  it("keeps LP exits available while paused, blocked only by revokeExecutor (B4)", async function () {
    const fixture = await networkHelpers.loadFixture(deployFixture);
    const { owner, executor, proofRegistry, lpEntry, lpExit, stakeVault, nfpm, agentA } = fixture;
    await lpEntry.write.setAgentKeyEnabled([agentA, true], { account: owner.account });
    await lpExit.write.setAgentKeyEnabled([agentA, true], { account: owner.account });
    const tokenId = await mintLp(fixture);

    // Stake (an entry) before pausing so we have a staked NFT to unstake under pause.
    const stake = await buildLpRequest(lpEntry, lpEntry, {
      actionType: 7,
      agentKey: agentA,
      poolId: LP_POOL_ID,
      stakeVault: stakeVault.address,
      tokenId,
    });
    await acceptProof(proofRegistry, stake);
    await lpEntry.write.stakeLp([stake], { account: executor.account });

    // Pause both LP thirds — an exit (unstake) MUST still succeed (B4: pause blocks entries only).
    await lpEntry.write.setPaused([true], { account: owner.account });
    await lpExit.write.setPaused([true], { account: owner.account });
    const unstake = await buildLpRequest(lpExit, lpEntry, {
      actionType: 8,
      agentKey: agentA,
      poolId: LP_POOL_ID,
      stakeVault: stakeVault.address,
      tokenId,
    });
    await acceptProof(proofRegistry, unstake);
    await lpExit.write.unstakeLp([unstake], { account: executor.account });
    assert.equal(getAddress(await nfpm.read.ownerOf([tokenId])), getAddress(lpEntry.address));

    // revokeExecutor is the hard kill switch — now an exit MUST revert.
    await lpExit.write.revokeExecutor({ account: owner.account });
    const zapOut = await buildLpRequest(lpExit, lpEntry, {
      actionType: 10,
      agentKey: agentA,
      poolId: LP_POOL_ID,
      tokenId,
      liquidity: parseEther("1"),
      amount0Min: minLpOutFor(parseEther("1")),
      quotedAmountOut: parseEther("1"),
    });
    await acceptProof(proofRegistry, zapOut);
    await assert.rejects(lpExit.write.zapOut([zapOut], { account: executor.account }));
  });

  it("rejects zero-quote exits on zapOut and sweepToken (M2)", async function () {
    const fixture = await networkHelpers.loadFixture(deployFixture);
    const { owner, executor, proofRegistry, lpEntry, lpExit, pairedToken, agentA } = fixture;
    await lpEntry.write.setAgentKeyEnabled([agentA, true], { account: owner.account });
    await lpExit.write.setAgentKeyEnabled([agentA, true], { account: owner.account });
    const tokenId = await mintLp(fixture);

    // zapOut with a 1-wei min but a ZERO quote must revert: minLpOutFor(0)==0 would otherwise let the
    // executor unwind at ~any price. amount0Min=1 isolates the quotedAmountOut==0 clause (pre-fix this
    // passed the min-out check and proceeded).
    const badZap = await buildLpRequest(lpExit, lpEntry, {
      actionType: 10,
      agentKey: agentA,
      poolId: LP_POOL_ID,
      tokenId,
      liquidity: parseEther("1"),
      amount0Min: 1n,
      quotedAmountOut: 0n,
    });
    await acceptProof(proofRegistry, badZap);
    await assert.rejects(lpExit.write.zapOut([badZap], { account: executor.account }));

    // sweepToken with a zero quote must revert for the same reason.
    await pairedToken.write.setMinter([owner.account.address], { account: owner.account });
    await pairedToken.write.mint([lpExit.address, parseEther("1")], { account: owner.account });
    const badSweep = await buildLpRequest(lpExit, lpEntry, {
      actionType: 9,
      agentKey: agentA,
      poolId: SWEEP_POOL_ID,
      tokenIn: pairedToken.address,
      tokenOut: ZERO_ADDRESS,
      amount0Desired: parseEther("1"),
      amount1Min: 1n,
      quotedAmountOut: 0n,
    });
    await acceptProof(proofRegistry, badSweep);
    await assert.rejects(lpExit.write.sweepToken([badSweep], { account: executor.account }));
  });

  it("does not expose generic arbitrary execution selectors in V4 vault sources", function () {
    for (const file of [
      "contracts/PolicyVaultV4Swap.sol",
      "contracts/PolicyVaultV4LpEntry.sol",
      "contracts/PolicyVaultV4LpExit.sol",
    ]) {
      const source = fs.readFileSync(file, "utf8");
      assert.equal(/\bdelegatecall\b/u.test(source), false, `${file} contains delegatecall`);
      assert.equal(/\bmulticall\b/u.test(source), false, `${file} contains multicall`);
      assert.equal(/function\s+execute\s*\(/u.test(source), false, `${file} exposes execute`);
      assert.equal(/function\s+\w+\s*\(\s*address\s+target/u.test(source), false, `${file} exposes target`);
      assert.equal(/function\s+\w+\s*\(\s*address\s+recipient/u.test(source), false, `${file} exposes recipient`);
    }
  });
});

function minLpOutFor(quote: bigint, bps: bigint = LP_MIN_OUT_BPS): bigint {
  return (quote * bps + (BPS - 1n)) / BPS;
}

function agentKey(identityAddress: Address, tokenId: bigint): Hex {
  return keccak256(
    `0x${identityAddress.slice(2).padStart(64, "0")}${tokenId.toString(16).padStart(64, "0")}` as Hex,
  );
}
