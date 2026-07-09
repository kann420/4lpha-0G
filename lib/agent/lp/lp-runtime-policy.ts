import { formatEther, parseEther } from "viem";

import type { LpBrainFence } from "@/lib/agent/runtime/types";
import type { OgAgentRuntimeSettings } from "@/lib/agent/single-agent";

export interface LpMintBudget {
  agentMaxPerPosition0G?: string;
  agentMaxPerPositionWei?: bigint;
  balanceWei: bigint;
  limitingFactor: "agent-max-per-position" | "remaining-exposure" | "vault-balance" | "vault-per-action-ceiling";
  maxAmount0G: string;
  maxAmountWei: bigint;
  remainingLpExposure0G: string;
  remainingLpExposureWei: bigint;
  vaultPerActionCapWei: bigint;
}

export function parseLpDecimal0G(value: string, label = "0G amount"): bigint {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{1,18})?$/u.test(normalized)) {
    throw new Error(`${label} must be a positive decimal with <= 18 fractional digits.`);
  }
  return parseEther(normalized);
}

export function parseOptionalAgentMaxPerPosition0G(value: string | undefined): bigint | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const parsed = parseLpDecimal0G(trimmed, "maxPerPosition0G");
  return parsed > 0n ? parsed : undefined;
}

export function computeLpMintBudget(input: {
  balance0G?: string;
  maxLpExposure0G: string;
  maxPerPosition0G?: string;
  openLpExposure0G?: string;
  perLpActionCap0G: string;
}): LpMintBudget {
  const balanceWei = parseLpDecimal0G(input.balance0G ?? "0", "vault balance0G");
  const maxExposureWei = parseLpDecimal0G(input.maxLpExposure0G, "maxLpExposure0G");
  const openExposureWei = parseLpDecimal0G(input.openLpExposure0G ?? "0", "openLpExposure0G");
  const remainingLpExposureWei = maxExposureWei > openExposureWei ? maxExposureWei - openExposureWei : 0n;
  const vaultPerActionCapWei = parseLpDecimal0G(input.perLpActionCap0G, "perLpActionCap0G");
  const agentMaxPerPositionWei = parseOptionalAgentMaxPerPosition0G(input.maxPerPosition0G);

  const caps: Array<{ factor: LpMintBudget["limitingFactor"]; value: bigint }> = [
    { factor: "vault-balance", value: balanceWei },
    { factor: "remaining-exposure", value: remainingLpExposureWei },
    { factor: "vault-per-action-ceiling", value: vaultPerActionCapWei },
  ];
  if (agentMaxPerPositionWei !== undefined) {
    caps.push({ factor: "agent-max-per-position", value: agentMaxPerPositionWei });
  }

  let limiting = caps[0]!;
  for (const candidate of caps.slice(1)) {
    if (candidate.value < limiting.value) {
      limiting = candidate;
    }
  }
  return {
    agentMaxPerPosition0G: input.maxPerPosition0G?.trim() || undefined,
    agentMaxPerPositionWei,
    balanceWei,
    limitingFactor: limiting.factor,
    maxAmount0G: formatEther(limiting.value),
    maxAmountWei: limiting.value,
    remainingLpExposure0G: formatEther(remainingLpExposureWei),
    remainingLpExposureWei,
    vaultPerActionCapWei,
  };
}

export function applyRuntimeLpFence(fence: LpBrainFence, runtime?: Partial<OgAgentRuntimeSettings>): LpBrainFence {
  return {
    ...fence,
    minAprPct: normalizeApr(runtime?.minAprPct, fence.minAprPct),
    maxAprPct: normalizeNullableApr(runtime?.maxAprPct, fence.maxAprPct),
  };
}

function normalizeApr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1000, Math.max(0, value))
    : fallback;
}

function normalizeNullableApr(value: number | null | undefined, fallback: number | null): number | null {
  if (value === null) return null;
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1000, Math.max(0, value))
    : fallback;
}
