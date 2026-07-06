import "server-only";

import { parseEther, type Address, type Hex, type PublicClient } from "viem";

import { decideLpAction } from "@/lib/agent/runtime/lp-brain";
import { executeMainnetPolicyVaultLpAction, type PolicyVaultLpExecution } from "@/lib/executor/policy-vault-lp";
import { agentKeyForDeployment } from "@/lib/agent/single-agent-server";
import type { OgAgentDeploymentRecord } from "@/lib/agent/single-agent";
import { loadReadyLpWorkspace } from "@/lib/agent/lp/lp-workspace-load";
import {
  uniswapV3PoolAbi,
  verifyZappablePool,
  ZIA_LP_MAINNET,
} from "@/lib/contracts/zia-lp";
import { quoteLpMint } from "@/lib/agent/lp/tick-math";
import { buildFence, buildPoolCandidates, makeMainnetPublicClient, parse0G, quoteZiaExactPoolSwap, readPairedToken } from "@/lib/agent/lp/lp-context";

// Shared LP mint helper — the brain (0G Compute Router) picks a pool + tick
// range + amount within the fence, then `quoteLpMint` computes the conservative
// floors, then `executeMainnetPolicyVaultLpAction` enforces it on-chain through
// the Policy Vault V3 LP adapter. Used by:
//   - the deploy orchestrator's optional first-mint (lib/agent/lp/lp-deploy.ts)
//   - the per-card mint-new-NFT-in-same-pool route (app/api/agents/lp/[id]/mint)
//
// HONESTY (codex audit #7): there is NO live 50-50 fallback. If the partner
// /route is unavailable, the quote cannot be computed, so the mint is skipped
// with a clear reason — the brain's decision is advisory only until the quote
// path is live.
// Live execution uses the exact-pool Zia QuoterV2, not partner /route fallback.

export interface RunLpMintInput {
  deployment: OgAgentDeploymentRecord;
  llmModel?: string;
  publicClient?: PublicClient;
  // Per-card mint route constrains the brain to a single pool (the source card's
  // pool). When supplied, the candidate set is exactly this pool and the brain
  // is told to pick it or hold. When omitted (first-mint), all zappable pools
  // are candidates.
  constrainPoolAddress?: Address;
  // Per-card mint route may also constrain the tick range + amount (UI-driven).
  // When supplied, the brain is bypassed entirely and the caller's values are
  // quoted + executed directly (the UI is the "brain" in that path).
  overrideTickLower?: number;
  overrideTickUpper?: number;
  overrideAmount0G?: string;
}

export interface RunLpMintResult {
  lpTxHash: Hex;
  // 0G Chain proof anchoring tx (acceptProof on the vault's immutable
  // proofRegistry). Undefined when the proof was already accepted (rare
  // idempotent skip). Surfaced so the worker run record + UI can show the
  // proof link alongside the LP mint tx.
  proofTxHash?: Hex;
  tokenId?: string;
  liquidity?: string;
  poolAddress: Address;
  tickLower: number;
  tickUpper: number;
  amount0G: string;
  brainSummary?: string;
  quoteSource: "llm-intent" | "ui-intent";
}

export async function runLpMintForAgent(input: RunLpMintInput): Promise<RunLpMintResult> {
  // Load with retry — readVaultSnapshot is wrapped in withTimeout and a flaky
  // mainnet RPC read can leave the snapshot ready:false even though the vault
  // is fine on-chain. The shared helper retries until the V3 vault snapshot is
  // usable so the auto-stake chain (mint → stake) isn't aborted by a transient
  // RPC timeout at the mint step.
  const workspace = await loadReadyLpWorkspace(input.deployment);
  const vault = workspace.vault;
  // loadReadyLpWorkspace guarantees ready + vault + lpAdapter + lpPolicy and
  // throws on paused / executorRevoked / chain-mismatch (non-transient). This
  // check is a TypeScript type-guard (narrowing vault.lpPolicy for the buildFence
  // / quote reads below), not a runtime defense — the helper has already
  // guaranteed all four conditions before returning.
  if (!vault.ready || !vault.vault || !vault.lpAdapter || !vault.lpPolicy) {
    throw new Error("LP mint requires a ready V3 vault with an LP adapter and lpPolicy.");
  }
  // Re-check the OFF-CHAIN agent pause flag from the FRESH snapshot. The route /
  // worker pre-check it on a stale load (S0); an off-chain pause
  // (deployment.paused in the registry) does NOT call setAgentKeyEnabled(false)
  // on-chain, so the on-chain executor preflight does NOT backstop it. Without
  // this fresh-S1 re-check, a paused agent could mint successfully on-chain —
  // violating the "keep paused agents paused" invariant. loadReadyLpWorkspace
  // only inspects the vault snapshot, not agent status, so this check is real.
  if (workspace.agent.status === "paused") {
    throw new Error("Agent is paused; arm it before minting.");
  }

  const publicClient = input.publicClient ?? makeMainnetPublicClient();

  // Build the candidate set + fence from the live snapshot.
  const pools = await buildPoolCandidates(publicClient, input.constrainPoolAddress);
  const fence = buildFence(vault);

  // Decide: either the UI override (per-card route) or the brain.
  let decision: { poolAddress: Address; tickLower: number; tickUpper: number; amount0G: string; summary?: string; quoteSource: "llm-intent" | "ui-intent" };
  const overrideSupplied =
    input.constrainPoolAddress !== undefined &&
    input.overrideTickLower !== undefined &&
    input.overrideTickUpper !== undefined &&
    input.overrideAmount0G !== undefined;
  if (overrideSupplied) {
    const poolAddress = input.constrainPoolAddress;
    const tickLower = input.overrideTickLower;
    const tickUpper = input.overrideTickUpper;
    const amount0G = input.overrideAmount0G;
    if (!poolAddress || tickLower === undefined || tickUpper === undefined || amount0G === undefined) {
      throw new Error("override mint requires constrainPoolAddress, overrideTickLower, overrideTickUpper, overrideAmount0G");
    }
    decision = {
      poolAddress,
      tickLower,
      tickUpper,
      amount0G,
      summary: "UI-driven per-card mint",
      quoteSource: "ui-intent",
    };
  } else {
    const brainDecision = await decideLpAction({
      pools,
      fence,
      vaultBalance0G: vault.balance0G ?? "0",
      readiness: {
        vaultReady: vault.ready,
        storageUploadReady: workspace.storage.uploadReady,
        vaultWarnings: vault.warnings,
      },
      selectedModel: input.llmModel,
    });
    if (brainDecision.action !== "mint" || !brainDecision.poolAddress || brainDecision.tickLower === undefined || brainDecision.tickUpper === undefined || !brainDecision.amount0G) {
      throw new Error(`LP brain returned hold: ${brainDecision.summary}`);
    }
    decision = {
      poolAddress: brainDecision.poolAddress,
      tickLower: brainDecision.tickLower,
      tickUpper: brainDecision.tickUpper,
      amount0G: brainDecision.amount0G,
      summary: brainDecision.summary,
      quoteSource: "llm-intent",
    };
  }

  // Quote: read slot0 for sqrtPriceX96 + currentTick, verify W0G leg, then use
  // Zia QuoterV2 for the exact pool/fee the adapter will execute. NO 50-50 fallback.
  const quote = await buildQuote(publicClient, decision.poolAddress, decision.tickLower, decision.tickUpper, decision.amount0G, vault.lpPolicy.lpMinOutBps);

  // Execute through the V3 LP adapter.
  const agentKey = agentKeyForDeployment({ identityAddress: input.deployment.identityAddress, tokenId: input.deployment.tokenId });
  const execution: PolicyVaultLpExecution = await executeMainnetPolicyVaultLpAction({
    networkId: "mainnet",
    agentKey,
    vaultAddress: input.deployment.vault,
    action: {
      kind: "zap-in-mint",
      poolAddress: decision.poolAddress,
      amount0G: decision.amount0G,
      tickLower: decision.tickLower,
      tickUpper: decision.tickUpper,
      quotedLiquidity: quote.quotedLiquidity,
      quotedAmount0: quote.quotedAmount0,
      quotedAmount1: quote.quotedAmount1,
      amount0Min: quote.amount0Min,
      amount1Min: quote.amount1Min,
      quotedSqrtPriceX96: quote.sqrtPriceX96,
    },
    agentRef: input.deployment.agentRef,
  });

  return {
    lpTxHash: execution.lpTxHash,
    proofTxHash: execution.proofTxHash,
    tokenId: execution.tokenId?.toString(),
    liquidity: execution.liquidity?.toString(),
    poolAddress: decision.poolAddress,
    tickLower: decision.tickLower,
    tickUpper: decision.tickUpper,
    amount0G: decision.amount0G,
    brainSummary: decision.summary,
    quoteSource: decision.quoteSource,
  };
}

// --- helpers ---

async function buildQuote(
  publicClient: PublicClient,
  poolAddress: Address,
  tickLower: number,
  tickUpper: number,
  amount0G: string,
  lpMinOutBps: number,
) {
  const [verification, slot0] = await Promise.all([
    verifyZappablePool(poolAddress, publicClient),
    publicClient.readContract({ address: poolAddress, abi: uniswapV3PoolAbi, functionName: "slot0", args: [] }) as Promise<readonly [bigint, number, ...unknown[]]>,
  ]);
  if (!verification) throw new Error("Pool is not zappable (no W0G leg).");
  const sqrtPriceX96 = slot0[0];
  const currentTick = Number(slot0[1]);
  const w0gIsToken0 = verification.w0gIsToken0;

  // Compute the balancing swap amount off-chain (mirrors the adapter), then
  // quote the exact one-hop pool swap the adapter will execute. NO 50-50 fallback.
  const { computeSwapAmount } = await import("@/lib/agent/lp/tick-math");
  const amount0GWei = parse0G(amount0G);
  const swapAmount = computeSwapAmount(amount0GWei, currentTick, tickLower, tickUpper, w0gIsToken0);
  if (swapAmount <= 0n) {
    throw new Error("Quote swap amount is zero — the tick range is outside the pool's active range.");
  }

  const pairedToken = await readPairedToken(publicClient, poolAddress);
  const swapOutputAmount = await quoteZiaExactPoolSwap(
    publicClient,
    poolAddress,
    ZIA_LP_MAINNET.wrappedNative,
    pairedToken,
    swapAmount,
  );
  if (swapOutputAmount <= 0n) {
    throw new Error("Zia exact-pool quoter returned zero swap output.");
  }

  const quote = quoteLpMint({
    poolAddress,
    sqrtPriceX96,
    currentTick,
    tickLower,
    tickUpper,
    amount0G: amount0GWei,
    w0gIsToken0,
    swapOutputAmount,
    lpMinOutBps,
  });
  // Expose the quoted sqrtPriceX96 so the executor can re-read slot0 and reject
  // a stale quote (quote_drift) before spending acceptProof gas. The number is
  // the pool price observed at quote time; the vault's on-chain delta/min-out
  // checks remain the authoritative backstop for drift that slips through.
  return { ...quote, sqrtPriceX96 };
}
