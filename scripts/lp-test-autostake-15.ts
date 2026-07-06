// Phase 2 live verification (direct, no dev server): mint -> auto-stake ->
// read real accounting fields -> unstake -> zap-out, for agent-0g-mainnet-15.
//
// Verifies:
//   - Task 5 (auto-stake after mint): runLpMintForAgent returns tokenId, then
//     runLpExitForAgent({kind:"stake"}) chains. The mint path now uses the
//     retry-load helper so a flaky RPC read doesn't abort the chain.
//   - Tasks 1/2 (real per-position accounting + price range): the new position
//     is read back and run through computeLpPositionAccounting to print real
//     amount0/amount1, unclaimedFee0/1, valueUSD, unrealizedPnlUSD, aprPct
//     (staking), priceLowerUSD/priceUpperUSD.
//   - The readLpPositionByTokenId fallback resolves the freshly minted
//     tokenId even when sellableLpPositions is empty (getLogs timeout).
//
// Funds STAY in the vault (zap-out returns 0G to the vault; NOT withdrawn to
// owner). Real money. DEPLOYER pays gas. Usage:
//   node --conditions=react-server --import tsx scripts/lp-test-autostake-15.ts --phase=read
//   node --conditions=react-server --import tsx scripts/lp-test-autostake-15.ts --phase=all

import dotenv from "dotenv";
import { createPublicClient, createWalletClient, formatEther, getAddress, http, type Address, type Chain, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { runLpMintForAgent } from "../lib/agent/lp/lp-mint";
import { runLpExitForAgent, readLpPositionByTokenId } from "../lib/agent/lp/lp-exec";
import { quoteLpZapOut } from "../lib/agent/lp/lp-zapout-quote";
import { makeMainnetPublicClient } from "../lib/agent/lp/lp-context";
import { MAX_TICK, MIN_TICK, nearestUsableTick } from "../lib/agent/lp/tick-math";
import { computeLpPositionAccounting } from "../lib/agent/lp/lp-position-accounting";
import { fetchPoolMetaMap } from "../lib/agent/single-agent-server";
import { agentKeyForDeployment, loadOgAgentWorkspace } from "../lib/agent/single-agent-server";
import { policyVaultV3Abi } from "../lib/contracts/policy-vault-v3";
import { findZiaLpVaultByPool, uniswapV3PoolAbi, ZIA_LP_MAINNET } from "../lib/contracts/zia-lp";

dotenv.config({ path: ".env.local", quiet: true });

const preferredMainnetRpc = process.env.OG_MAINNET_RPC_URL?.trim();
if (preferredMainnetRpc) process.env.OG_RPC_URL = preferredMainnetRpc;

const CHAIN_ID = 16661;
const AGENT_ID = "agent-0g-mainnet-15";
const POOL_ADDRESS = getAddress("0x23336572435eC92d25eF0dD2D468B2a1aBF7BB4f"); // W0G/USDC
const W0G_ADDRESS = ZIA_LP_MAINNET.wrappedNative; // W0G leg for w0gIsToken0
const MINT_AMOUNT_0G = "0.005";

type Phase = "read" | "enable-key" | "mint" | "stake" | "accounting" | "unstake" | "zap-out" | "disable-key" | "all";

interface Args { phase: Phase }

function parseArgs(argv: string[]): Args {
  const args: Args = { phase: "all" };
  for (let i = 0; i < argv.length; i += 1) {
    const v = argv[i];
    if (v === "--phase") args.phase = readNext(argv, ++i, v) as Phase;
    else if (v === "--help" || v === "-h") {
      console.log("Usage: node --conditions=react-server --import tsx scripts/lp-test-autostake-15.ts [--phase read|enable-key|mint|stake|accounting|unstake|zap-out|disable-key|all]");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${v}`);
  }
  return args;
}

function readNext(argv: string[], i: number, flag: string): string {
  const v = argv[i];
  if (v === undefined) throw new Error(`${flag} requires a value.`);
  return v;
}

function readPrivateKeyEnv(name: string): Hex {
  const v = process.env[name]?.trim();
  if (!v || !/^0x[0-9a-fA-F]{64}$/u.test(v)) throw new Error(`${name} must be a 0x-prefixed 32-byte private key.`);
  return v as Hex;
}

function make0GMainnetChain(rpcUrl: string): Chain {
  return {
    id: CHAIN_ID,
    name: "0G Mainnet",
    nativeCurrency: { decimals: 18, name: "0G", symbol: "0G" },
    rpcUrls: { default: { http: [rpcUrl] } },
    blockExplorers: { default: { name: "0G ChainScan", url: "https://chainscan.0g.ai" } },
  };
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

async function waitForLpCooldown(vault: Address, cooldownSecondsRaw: string, label: string) {
  const cooldownSeconds = Number(cooldownSecondsRaw);
  if (!Number.isFinite(cooldownSeconds) || cooldownSeconds <= 0) return;
  const pc = makeMainnetPublicClient();
  const lastLpActionAt = await pc.readContract({ address: vault, abi: policyVaultV3Abi, functionName: "lastLpActionAt" }) as bigint;
  if (lastLpActionAt === 0n) return;
  const block = await pc.getBlock();
  const waitSeconds = Number(lastLpActionAt) + cooldownSeconds + 3 - Number(block.timestamp);
  if (waitSeconds <= 0) return;
  console.log(JSON.stringify({ label, stage: "cooldown-wait", waitSeconds }));
  await sleep(waitSeconds * 1000);
}

async function setAgentKeyEnabled(vault: Address, agentKey: Hex, enabled: boolean): Promise<Hex> {
  const rpcUrl = process.env.OG_RPC_URL?.trim();
  if (!rpcUrl) throw new Error("OG_RPC_URL is required.");
  const chain = make0GMainnetChain(rpcUrl);
  const deployer = privateKeyToAccount(readPrivateKeyEnv("DEPLOYER_PRIVATE_KEY"));
  const pc = createPublicClient({ chain, transport: http(rpcUrl, { retryCount: 0, timeout: 8_000 }) });
  const wc = createWalletClient({ account: deployer, chain, transport: http(rpcUrl) });
  console.log(JSON.stringify({ stage: enabled ? "enable-key" : "disable-key", action: "submit" }));
  const txHash = await wc.writeContract({ address: vault, abi: policyVaultV3Abi, functionName: "setAgentKeyEnabled", args: [agentKey, enabled], account: deployer, chain });
  const receipt = await pc.waitForTransactionReceipt({ hash: txHash, confirmations: 2 });
  if (receipt.status !== "success") throw new Error(`${enabled ? "enable" : "disable"}-key tx reverted: ${txHash}`);
  console.log(JSON.stringify({ stage: enabled ? "enable-key" : "disable-key", txHash, status: "confirmed" }));
  return txHash;
}

// Replicates deriveManualMintRange from the mint/defaults route.
function deriveManualMintRange(currentTick: number, tickSpacing: number, w0gIsToken0: boolean): { tickLower: number; tickUpper: number } {
  const spacing = Math.max(1, Math.abs(Math.trunc(tickSpacing)));
  const steps = Math.max(2, Math.floor(4_000 / spacing));
  const width = steps * spacing;
  let tickLower: number;
  let tickUpper: number;
  if (w0gIsToken0) {
    tickUpper = nearestUsableTick(currentTick + spacing, spacing);
    tickLower = tickUpper - width;
  } else {
    tickLower = nearestUsableTick(currentTick, spacing);
    tickUpper = tickLower + width;
  }
  if (tickLower >= currentTick) tickLower = nearestUsableTick(currentTick - spacing, spacing);
  if (tickUpper <= currentTick) tickUpper = nearestUsableTick(currentTick + spacing, spacing);
  if (tickUpper <= tickLower) tickUpper = Math.min(MAX_TICK, tickLower + spacing);
  if (tickUpper <= tickLower) tickLower = Math.max(MIN_TICK, tickUpper - spacing);
  return { tickLower, tickUpper };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const phase = args.phase;
  const want = (p: Phase) => phase === p || phase === "all";

  const account = privateKeyToAccount(readPrivateKeyEnv("DEPLOYER_PRIVATE_KEY"));
  const owner = account.address as Address;
  const pc = makeMainnetPublicClient();

  const workspace = await loadOgAgentWorkspace({ agentId: AGENT_ID, live: true, ownerAddress: owner });
  const deployment = workspace.agent.deployment;
  if (!deployment) throw new Error(`No deployment for ${AGENT_ID}.`);
  const vault = deployment.vault;
  const agentKey = (deployment.agentKey ?? agentKeyForDeployment(deployment)) as Hex;
  const lpPolicy = workspace.vault.lpPolicy;
  const cooldownSecondsLp = lpPolicy?.cooldownSecondsLp ?? "0";
  const lpMinOutBps = lpPolicy?.lpMinOutBps ?? 0;

  // Derive mint range from slot0 + tickSpacing + token0 (for w0gIsToken0).
  const [slot0, tickSpacing, token0] = await Promise.all([
    pc.readContract({ address: POOL_ADDRESS, abi: uniswapV3PoolAbi, functionName: "slot0" }) as Promise<readonly [bigint, number, ...unknown[]]>,
    pc.readContract({ address: POOL_ADDRESS, abi: uniswapV3PoolAbi, functionName: "tickSpacing" }) as Promise<number>,
    pc.readContract({ address: POOL_ADDRESS, abi: uniswapV3PoolAbi, functionName: "token0" }) as Promise<Address>,
  ]);
  const currentTick = Number(slot0[1]);
  const w0gIsToken0 = token0.toLowerCase() === W0G_ADDRESS.toLowerCase();
  const range = deriveManualMintRange(currentTick, tickSpacing, w0gIsToken0);
  const vaultBalance0G = await pc.getBalance({ address: vault });

  console.log(JSON.stringify({
    stage: "read",
    agentId: AGENT_ID, vault, owner,
    pool: POOL_ADDRESS, currentTick, tickSpacing, w0gIsToken0,
    tickLower: range.tickLower, tickUpper: range.tickUpper,
    mintAmount0G: MINT_AMOUNT_0G,
    vaultBalance0G: formatEther(vaultBalance0G),
    cooldownSecondsLp, lpMinOutBps,
    allowStaking: lpPolicy?.allowStaking ?? false,
    sellableLpPositionsCount: (workspace.vault.sellableLpPositions ?? []).length,
  }, null, 2));

  if (phase === "read") return;

  let keyWasEnabled = false;
  if (want("enable-key")) {
    const already = await pc.readContract({ address: vault, abi: policyVaultV3Abi, functionName: "agentKeyEnabled", args: [agentKey] }).catch(() => false) as boolean;
    if (already) { console.log(JSON.stringify({ stage: "enable-key", skipped: "already-enabled" })); keyWasEnabled = true; }
    else { await setAgentKeyEnabled(vault, agentKey, true); keyWasEnabled = true; }
  }

  let mintedTokenId: string | undefined;
  try {
    if (want("mint")) {
      await waitForLpCooldown(vault, cooldownSecondsLp, "mint");
      console.log(JSON.stringify({ stage: "mint", action: "submit", amount0G: MINT_AMOUNT_0G, tickLower: range.tickLower, tickUpper: range.tickUpper }));
      const result = await runLpMintForAgent({
        deployment,
        constrainPoolAddress: POOL_ADDRESS,
        overrideTickLower: range.tickLower,
        overrideTickUpper: range.tickUpper,
        overrideAmount0G: MINT_AMOUNT_0G,
      });
      mintedTokenId = result.tokenId;
      console.log(JSON.stringify({ stage: "mint", lpTxHash: result.lpTxHash, proofTxHash: result.proofTxHash, tokenId: result.tokenId, liquidity: result.liquidity, poolAddress: result.poolAddress, tickLower: result.tickLower, tickUpper: result.tickUpper, amount0G: result.amount0G, quoteSource: result.quoteSource }));
    } else {
      // For non-mint phases, fall back to the last known position if any.
      mintedTokenId = (workspace.vault.sellableLpPositions ?? [])[0]?.tokenId;
    }
    if (!mintedTokenId) throw new Error("No tokenId from mint; cannot continue.");

    if (want("stake")) {
      await waitForLpCooldown(vault, cooldownSecondsLp, "stake");
      console.log(JSON.stringify({ stage: "stake", action: "submit", tokenId: mintedTokenId }));
      const result = await runLpExitForAgent({ deployment, kind: "stake", poolAddress: POOL_ADDRESS, tokenId: mintedTokenId });
      console.log(JSON.stringify({ stage: "stake", lpTxHash: result.lpTxHash, proofTxHash: result.proofTxHash, tokenId: mintedTokenId }));
    }

    if (want("accounting") || want("unstake") || want("zap-out")) {
      // Read the position via the fallback (sellableLpPositions is empty on
      // quiknode getLogs timeout) + compute full accounting from pool meta.
      const base = await readLpPositionByTokenId(mintedTokenId, vault, agentKey, pc);
      if (!base) throw new Error(`Fallback read did not resolve position #${mintedTokenId}.`);
      const meta = await fetchPoolMetaMap(pc, [POOL_ADDRESS.toLowerCase()]);
      const pool = meta.get(POOL_ADDRESS.toLowerCase()) ?? null;
      if (!pool) {
        console.log(JSON.stringify({ stage: "accounting", skipped: "pool-meta-unavailable", base }));
      } else {
        // Re-read tokensOwed + liquidity fresh from NFPM for the accounting
        // input (readLpPositionByTokenId does not surface fees).
        const pos = await pc.readContract({ address: ZIA_LP_MAINNET.nonfungiblePositionManager, abi: [{ name: "positions", type: "function", stateMutability: "view", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ name: "nonce", type: "uint96" }, { name: "operator", type: "address" }, { name: "token0", type: "address" }, { name: "token1", type: "address" }, { name: "fee", type: "uint24" }, { name: "tickLower", type: "int24" }, { name: "tickUpper", type: "int24" }, { name: "liquidity", type: "uint128" }, { name: "feeGrowthInside0LastX128", type: "uint256" }, { name: "feeGrowthInside1LastX128", type: "uint256" }, { name: "tokensOwed0", type: "uint128" }, { name: "tokensOwed1", type: "uint128" }] }], functionName: "positions", args: [BigInt(mintedTokenId)] }) as readonly bigint[];
        const accounting = computeLpPositionAccounting({
          pool,
          liquidity: BigInt(pos[7]),
          tickLower: Number(pos[5]),
          tickUpper: Number(pos[6]),
          tokensOwed0: BigInt(pos[10]),
          tokensOwed1: BigInt(pos[11]),
          deployedNative0G: base.deployedNative0G,
          staked: base.staked,
        });
        console.log(JSON.stringify({ stage: "accounting", tokenId: mintedTokenId, staked: base.staked,
          token0Symbol: accounting.token0Symbol, token1Symbol: accounting.token1Symbol,
          amount0: accounting.amount0, amount1: accounting.amount1,
          unclaimedFee0: accounting.unclaimedFee0, unclaimedFee1: accounting.unclaimedFee1,
          leg0USD: accounting.leg0USD, leg1USD: accounting.leg1USD,
          valueUSD: accounting.valueUSD, entryUSD: accounting.entryUSD,
          unrealizedPnlUSD: accounting.unrealizedPnlUSD, unrealizedPnlPct: accounting.unrealizedPnlPct, unrealizedPnlTone: accounting.unrealizedPnlTone,
          aprPct: accounting.aprPct, stakingAprPct: accounting.stakingAprPct, tradingAprPct: accounting.tradingAprPct, aprStatus: accounting.aprStatus,
          priceLowerUSD: accounting.priceLowerUSD, priceUpperUSD: accounting.priceUpperUSD, priceLabelSymbol: accounting.priceLabelSymbol,
        }, null, 2));
      }
    }

    if (want("unstake")) {
      await waitForLpCooldown(vault, cooldownSecondsLp, "unstake");
      console.log(JSON.stringify({ stage: "unstake", action: "submit", tokenId: mintedTokenId }));
      const result = await runLpExitForAgent({ deployment, kind: "unstake", poolAddress: POOL_ADDRESS, tokenId: mintedTokenId });
      console.log(JSON.stringify({ stage: "unstake", lpTxHash: result.lpTxHash, proofTxHash: result.proofTxHash, tokenId: mintedTokenId }));
    }

    if (want("zap-out")) {
      await waitForLpCooldown(vault, cooldownSecondsLp, "zap-out");
      const fresh = await readLpPositionByTokenId(mintedTokenId, vault, agentKey, pc);
      if (!fresh || fresh.liquidity === "0") {
        console.log(JSON.stringify({ stage: "zap-out", skipped: "no-liquidity", tokenId: mintedTokenId }));
      } else {
        const quote = await quoteLpZapOut({ publicClient: pc, poolAddress: POOL_ADDRESS, tokenId: mintedTokenId, liquidity: BigInt(fresh.liquidity), tickLower: fresh.tickLower, tickUpper: fresh.tickUpper, lpMinOutBps });
        console.log(JSON.stringify({ stage: "zap-out-quote", tokenId: mintedTokenId, totalW0GOut: quote.totalW0GOut.toString(), amountOutMin: quote.amountOutMin.toString() }));
        const result = await runLpExitForAgent({ deployment, kind: "zap-out", poolAddress: POOL_ADDRESS, tokenId: mintedTokenId, quotedAmountOut: quote.quotedAmountOut, amountOutMin: quote.amountOutMin, quotedSqrtPriceX96: quote.sqrtPriceX96 });
        console.log(JSON.stringify({ stage: "zap-out", lpTxHash: result.lpTxHash, proofTxHash: result.proofTxHash, tokenId: mintedTokenId, amountOutMin: result.amountOutMin?.toString() }));
      }
    }
  } finally {
    if (keyWasEnabled && want("disable-key")) {
      try {
        const already = await pc.readContract({ address: vault, abi: policyVaultV3Abi, functionName: "agentKeyEnabled", args: [agentKey] }).catch(() => true) as boolean;
        if (already === false) console.log(JSON.stringify({ stage: "disable-key", skipped: "already-disabled" }));
        else await setAgentKeyEnabled(vault, agentKey, false);
      } catch (e) { console.error("disable-key failed:", e instanceof Error ? e.message : String(e)); }
    }
  }

  const finalBalance = await pc.getBalance({ address: vault });
  console.log(JSON.stringify({ stage: "done", phase, vaultBalance0G: formatEther(finalBalance) }));
}

main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; });