import "server-only";

import { z, type ZodType } from "zod";
import { isAddress, type Address } from "viem";

import { callOgComputeRouter, resolveOgComputeRouterConfig } from "@/lib/copilot/router";
import { buildLpSystemPrompt } from "@/lib/agent/runtime/lp-system-prompt";
import { parse0G } from "@/lib/agent/lp/lp-context";
import type { LpBrainDecision, LpBrainFence, LpPoolCandidate } from "@/lib/agent/runtime/types";

// LP Agent brain — the decision layer. Calls the 0G Compute Router (sole
// reasoning path) with allowlisted Zia pool candidates + the user policy fence,
// and returns a {poolAddress, tickLower, tickUpper, amount0G} suggestion or hold.
//
// The brain NEVER signs, NEVER calls the vault, and NEVER invents pools/ticks/
// amounts outside the supplied allowlist. Every output is post-parse-validated
// against the fence; any violation downgrades to hold. There is NO live 50-50
// fallback — when the partner route / quote is unavailable the caller skips
// execution and the brain's decision is advisory only.

const lpDecisionSchema = z.object({
  action: z.enum(["mint", "hold"]),
  poolAddress: emptyStringToUndefined(z.string()),
  tickLower: z.number().int().min(-887_272).max(887_272).catch(0),
  tickUpper: z.number().int().min(-887_272).max(887_272).catch(0),
  amount0G: emptyStringToUndefined(z.string()),
  confidence: z.number().min(0).max(100).catch(50),
  reasons: z.array(z.string()).min(1).max(5).catch(["Reviewed the LP pool context within the user fence."]),
  summary: z.string().min(1).max(500).catch("Reviewed the LP pool context within the user fence."),
});

export interface LpBrainInput {
  pools: readonly LpPoolCandidate[];
  fence: LpBrainFence;
  vaultBalance0G: string;
  readiness: { vaultReady: boolean; storageUploadReady: boolean; vaultWarnings: string[] };
  selectedModel?: string;
}

export async function decideLpAction(input: LpBrainInput): Promise<LpBrainDecision> {
  const routerConfig = resolveOgComputeRouterConfig("mainnet");
  if ("error" in routerConfig) {
    throw routerConfig.error;
  }

  const systemPrompt = buildLpSystemPrompt({
    fence: input.fence,
    poolCount: input.pools.length,
    readiness: input.readiness,
  });

  const message = JSON.stringify(
    {
      candidates: input.pools.map((p) => ({
        poolAddress: p.poolAddress,
        label: p.label,
        feeTier: p.feeTier,
        tickSpacing: p.tickSpacing,
        currentTick: p.currentTick,
        w0gIsToken0: p.w0gIsToken0,
        stakingAprPct: p.stakingAprPct,
        tvlUSD: p.tvlUSD,
        volume24hUSD: p.volume24hUSD,
        // Server pre-computes usable tick bounds on the pool's tickSpacing so the
        // LLM does not have to do modular arithmetic.
        usableTickLower: Math.floor(p.currentTick / p.tickSpacing) * p.tickSpacing - 50 * p.tickSpacing,
        usableTickUpper: Math.ceil(p.currentTick / p.tickSpacing) * p.tickSpacing + 50 * p.tickSpacing,
      })),
      fence: {
        perLpActionCap0G: input.fence.perLpActionCap0G,
        maxLpExposure0G: input.fence.maxLpExposure0G,
        openLpExposure0G: input.fence.openLpExposure0G,
        remainingLpExposure0G: input.fence.remainingLpExposure0G,
        lpMinOutBps: input.fence.lpMinOutBps,
        maxTickWidth: input.fence.maxTickWidth,
        minAprPct: input.fence.minAprPct,
        maxAprPct: input.fence.maxAprPct,
      },
      vaultBalance0G: input.vaultBalance0G,
      readiness: {
        vaultReady: input.readiness.vaultReady,
        storageUploadReady: input.readiness.storageUploadReady,
        vaultWarnings: input.readiness.vaultWarnings,
      },
      output_contract: {
        action: "mint | hold",
        poolAddress: "must match one supplied candidate when action is mint",
        tickLower: "integer, on the pool tickSpacing, within usable bounds",
        tickUpper: "integer > tickLower, on the pool tickSpacing, within usable bounds",
        amount0G: "human decimal 0G string, never wei, <= perLpActionCap0G and <= remainingLpExposure0G",
        confidence: "0-100 number",
        reasons: "1-5 short audit-safe rationale lines, no chain-of-thought",
        summary: "one audit-safe sentence",
      },
      task:
        "Return JSON only. Pick exactly one action. Never include markdown. Never invent pools, ticks, amounts, wallets, or keys.",
    },
    null,
    2,
  );

  const response = await callOgComputeRouter({
    config: routerConfig,
    messages: [{ content: message, role: "operator" }],
    systemPrompt,
    selectedModel: input.selectedModel,
  });

  return normalizeLpDecision({
    pools: input.pools,
    fence: input.fence,
    model: response.model,
    rawMessage: response.message,
    trace: response.trace,
  });
}

function normalizeLpDecision(input: {
  pools: readonly LpPoolCandidate[];
  fence: LpBrainFence;
  model: string;
  rawMessage: string;
  trace?: { billingTotalCost?: string; provider?: string; requestId?: string; teeVerified?: boolean };
}): LpBrainDecision {
  const { pools, fence, model, rawMessage, trace } = input;

  let extracted: unknown;
  try {
    extracted = extractJsonObject(rawMessage);
  } catch {
    return hold(model, rawMessage, ["0G Compute Router response did not contain a JSON object."], trace, false);
  }

  const parsed = lpDecisionSchema.safeParse(extracted);
  if (!parsed.success) {
    return hold(model, rawMessage, ["0G Compute Router response was not valid LP decision JSON."], trace, false);
  }

  const decision = parsed.data;
  if (decision.action === "hold") {
    return {
      action: "hold",
      confidence: decision.confidence,
      model,
      normalized: false,
      rawMessage: truncate(rawMessage, 2000),
      reasons: decision.reasons.map(sanitizeReason),
      source: "0g-compute-router",
      summary: sanitizeReason(decision.summary),
      trace: trace ? { ...trace, tickWidthBounded: true } : { tickWidthBounded: true },
    };
  }

  // Post-parse fence validation — any violation downgrades to hold.
  const pool = decision.poolAddress
    ? pools.find((p) => p.poolAddress.toLowerCase() === decision.poolAddress!.toLowerCase())
    : undefined;
  if (!pool || !decision.poolAddress || !isAddress(decision.poolAddress)) {
    return hold(
      model,
      rawMessage,
      [...decision.reasons.map(sanitizeReason), "Selected pool is not in the allowlisted candidate set."],
      trace,
      true,
    );
  }

  if (!decision.amount0G) {
    return hold(model, rawMessage, [...decision.reasons.map(sanitizeReason), "Mint decision is missing amount0G."], trace, true);
  }
  let amount: bigint;
  try {
    amount = parse0G(decision.amount0G);
  } catch {
    return hold(model, rawMessage, [...decision.reasons.map(sanitizeReason), "amount0G must be a positive number."], trace, true);
  }
  if (amount <= 0n) {
    return hold(model, rawMessage, [...decision.reasons.map(sanitizeReason), "amount0G must be a positive number."], trace, true);
  }
  if (amount > parse0G(fence.perLpActionCap0G)) {
    return hold(model, rawMessage, [...decision.reasons.map(sanitizeReason), "amount0G exceeds per-NFT cap."], trace, true);
  }
  if (amount > parse0G(fence.remainingLpExposure0G)) {
    return hold(model, rawMessage, [...decision.reasons.map(sanitizeReason), "amount0G exceeds remaining exposure headroom."], trace, true);
  }

  const normalizedTicks = normalizeTickBand(decision.tickLower, decision.tickUpper, pool, fence);
  if (!normalizedTicks) {
    return hold(model, rawMessage, [...decision.reasons.map(sanitizeReason), "Selected tick range is invalid."], trace, true);
  }

  return {
    action: "mint",
    poolAddress: decision.poolAddress as Address,
    tickLower: normalizedTicks.tickLower,
    tickUpper: normalizedTicks.tickUpper,
    amount0G: decision.amount0G,
    confidence: decision.confidence,
    model,
    normalized: normalizedTicks.normalized,
    rawMessage: truncate(rawMessage, 2000),
    reasons: decision.reasons.map(sanitizeReason),
    source: "0g-compute-router",
    summary: sanitizeReason(decision.summary),
    trace: trace ? { ...trace, tickWidthBounded: true } : { tickWidthBounded: true },
  };
}

function normalizeTickBand(
  tickLower: number,
  tickUpper: number,
  pool: LpPoolCandidate,
  fence: LpBrainFence,
): { normalized: boolean; tickLower: number; tickUpper: number } | null {
  if (!Number.isInteger(tickLower) || !Number.isInteger(tickUpper) || tickLower >= tickUpper) {
    return null;
  }

  const spacing = pool.tickSpacing;
  if (!Number.isInteger(spacing) || spacing <= 0) {
    return null;
  }

  let lower = alignDown(tickLower, spacing);
  let upper = alignUp(tickUpper, spacing);
  let normalized = lower !== tickLower || upper !== tickUpper;
  const maxWidth = alignDown(fence.maxTickWidth, spacing);
  if (maxWidth < spacing) {
    return null;
  }

  if (upper - lower > maxWidth) {
    const center = alignNearest(pool.currentTick, spacing);
    const half = Math.max(spacing, alignDown(Math.trunc(maxWidth / 2), spacing));
    lower = alignDown(center - half, spacing);
    upper = alignUp(center + half, spacing);
    if (upper - lower > maxWidth) {
      upper = lower + maxWidth;
    }
    normalized = true;
  }

  return lower < upper && upper - lower <= fence.maxTickWidth
    ? { normalized, tickLower: lower, tickUpper: upper }
    : null;
}

function alignDown(value: number, spacing: number): number {
  return Math.floor(value / spacing) * spacing;
}

function alignUp(value: number, spacing: number): number {
  return Math.ceil(value / spacing) * spacing;
}

function alignNearest(value: number, spacing: number): number {
  return Math.round(value / spacing) * spacing;
}

function hold(
  model: string,
  rawMessage: string,
  reasons: string[],
  trace: { billingTotalCost?: string; provider?: string; requestId?: string; teeVerified?: boolean } | undefined,
  normalized: boolean,
): LpBrainDecision {
  return {
    action: "hold",
    confidence: 0,
    model,
    normalized,
    rawMessage: truncate(rawMessage, 2000),
    reasons: reasons.slice(0, 5),
    source: "0g-compute-router",
    summary: "Held because the LLM decision could not be safely applied within the fence.",
    trace: trace ? { ...trace, tickWidthBounded: true } : { tickWidthBounded: true },
  };
}

function extractJsonObject(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return JSON.parse(trimmed);
  }
  const match = trimmed.match(/\{[\s\S]*\}/u);
  if (!match) throw new Error("No JSON object found.");
  return JSON.parse(match[0]);
}

function sanitizeReason(value: string): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, 500);
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

function emptyStringToUndefined<T extends ZodType>(schema: T) {
  return z.preprocess((value) => {
    if (value === null || value === undefined || value === "") return undefined;
    return value;
  }, schema.optional());
}
