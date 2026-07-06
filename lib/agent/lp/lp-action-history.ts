import "server-only";

import type { Address, Hex } from "viem";

import { appendOgAgentLpRun } from "@/lib/agent/runtime/lp-store";
import type { OgAgentDeploymentRecord } from "@/lib/agent/single-agent";
import type { OgAgentLpDecision, OgAgentLpRunStatus } from "@/lib/agent/runtime/types";

export async function recordLpActionHistory(input: {
  deployment: OgAgentDeploymentRecord;
  decision: Exclude<OgAgentLpDecision, "hold">;
  status?: OgAgentLpRunStatus;
  startedAt?: string;
  finishedAt?: string;
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
  error?: string;
}): Promise<void> {
  const finishedAt = input.finishedAt ?? new Date().toISOString();
  await appendOgAgentLpRun({
    agentId: input.deployment.id,
    agentName: input.deployment.name,
    agentRef: input.deployment.agentRef,
    amount0G: input.amount0G,
    balanceAfter0G: input.balanceAfter0G,
    balanceBefore0G: input.balanceBefore0G,
    brainSummary: input.brainSummary,
    cycleId: `manual-${input.decision}-${Date.parse(finishedAt) || Date.now()}`,
    decision: input.decision,
    error: input.error,
    finishedAt,
    lpTxHash: input.lpTxHash,
    model: input.model,
    poolAddress: input.poolAddress,
    proofTxHash: input.proofTxHash,
    startedAt: input.startedAt ?? finishedAt,
    status: input.status ?? "executed",
    tickLower: input.tickLower,
    tickUpper: input.tickUpper,
    tokenId: input.tokenId,
    vault: input.vault ?? input.deployment.vault,
  });
}
