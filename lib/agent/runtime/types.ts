import type { AgentTradeExecution, AgentTradePreview, AgentTradeRequest } from "@/lib/types";

export type OgAgentWorkerAction = "buy" | "sell" | "hold";
export type OgAgentWorkerRunStatus = "blocked" | "dry_run" | "errored" | "executed" | "held";

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
