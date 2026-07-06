import type { Address, Hex } from "viem";
import type { AgentTradeExecution, AgentTradePreview, AgentTradeRequest } from "@/lib/types";

export type OgAgentWorkerAction = "buy" | "sell" | "hold";
export type OgAgentWorkerRunStatus = "blocked" | "dry_run" | "errored" | "executed" | "held";

// --- LP Agent brain types ---
// The LP brain (lib/agent/runtime/lp-brain.ts) only ever SUGGESTS a
// {poolAddress, tickLower, tickUpper, amount0G} within the user's fence; the
// Policy Vault V3 enforces it on-chain. The brain never signs, never calls the
// vault, and never invents pools/ticks/amounts outside the supplied allowlist.

export interface LpPoolCandidate {
  poolAddress: Address;
  label: string;
  feeTier: number;
  tickSpacing: number;
  currentTick: number;
  w0gIsToken0: boolean;
  stakingAprPct: number;
  tvlUSD: number | null;
  volume24hUSD: number | null;
  // The vault's W0G-leg allowlist intersection is enforced server-side before
  // the brain ever sees candidates, so the LLM cannot pick a non-zappable pool.
}

export interface LpBrainFence {
  perLpActionCap0G: string; // decimal string — max 0G per single LP NFT
  maxLpExposure0G: string; // decimal string — total 0G across all LP NFTs
  openLpExposure0G: string; // decimal string — currently deployed
  remainingLpExposure0G: string; // decimal string — headroom for a new mint
  lpMinOutBps: number; // vault slippage bps (e.g. 9500)
  cooldownSecondsLp: number;
  minLiquidityFloor: bigint;
  allowStaking: boolean;
  maxTickWidth: number; // server-side guard: max |tickUpper - tickLower|
  minAprPct: number; // user APR filter
  maxAprPct: number | null;
}

export interface LpBrainDecision {
  action: "mint" | "hold";
  poolAddress?: Address;
  tickLower?: number;
  tickUpper?: number;
  amount0G?: string;
  confidence: number;
  reasons: string[];
  summary: string;
  model?: string;
  normalized: boolean;
  rawMessage?: string;
  source: "0g-compute-router";
  trace?: {
    billingTotalCost?: string;
    provider?: string;
    requestId?: string;
    teeVerified?: boolean;
    tickWidthBounded: boolean;
  };
}

export interface OgAgentTradeCandidate {
  action: Exclude<OgAgentWorkerAction, "hold">;
  amountIn: string;
  inputToken: string;
  outputToken: string;
  policyDecision: "allow" | "review" | "reject";
  preview?: AgentTradePreview;
  quoteStatus: "ready" | "review" | "blocked" | "unavailable";
  reason?: string;
  request: AgentTradeRequest;
  routeId: string;
  routeLabel: string;
  slippageBps: number;
}

export interface OgAgentBrainDecision {
  action: OgAgentWorkerAction;
  amount0G?: string;
  confidence: number;
  model?: string;
  normalized: boolean;
  rawMessage?: string;
  reasons: string[];
  routeId?: string;
  sellPercent?: number;
  slippageBps: number;
  source: "0g-compute-router";
  summary: string;
  trace?: {
    billingTotalCost?: string;
    provider?: string;
    requestId?: string;
    teeVerified?: boolean;
  };
}

export interface OgAgentRuntimeRunRecord {
  agentId: string;
  agentName: string;
  agentRef?: string;
  candidates: OgAgentTradeCandidate[];
  completedAt: string;
  cycleId: string;
  decision: OgAgentBrainDecision;
  error?: string;
  execution?: AgentTradeExecution;
  request?: AgentTradeRequest;
  startedAt: string;
  status: OgAgentWorkerRunStatus;
}

export interface OgAgentRuntimeStoreArtifact {
  runs: OgAgentRuntimeRunRecord[];
  updatedAt: string;
}

// --- LP Agent worker types ---
// The autonomous LP worker (lib/agent/runtime/lp-worker.ts) mints LP positions
// within the vault's on-chain fence when an agent has idle balance + is off
// cooldown + the owner has opted in via runtime.automation.autoMint. Exits
// (unstake / zap-out / rebalance / TP / SL / compound) are user-manual in this
// phase — the worker only mints entries.

export type OgAgentLpRunStatus = "blocked" | "dry_run" | "errored" | "executed" | "held";

export type OgAgentLpDecision = "mint" | "hold" | "stake" | "unstake" | "zap-out" | "withdraw-native";

export interface OgAgentLpRunRecord {
  agentId: string;
  agentName: string;
  agentRef?: string;
  cycleId: string;
  startedAt: string;
  finishedAt: string;
  decision: OgAgentLpDecision;
  brainSummary?: string;
  model?: string;
  vault?: Address;
  poolAddress?: Address;
  tickLower?: number;
  tickUpper?: number;
  tokenId?: string;
  amount0G?: string;
  balanceBefore0G?: string;
  balanceAfter0G?: string;
  lpTxHash?: Hex;
  proofTxHash?: Hex;
  status: OgAgentLpRunStatus;
  error?: string;
}

export interface OgAgentLpStoreArtifact {
  runs: OgAgentLpRunRecord[];
  updatedAt: string;
}
