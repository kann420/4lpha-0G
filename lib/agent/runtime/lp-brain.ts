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
  // Pools that already have an open LP position for this agent (lowercased).
  // The brain is asked not to re-enter them; the post-parse gate below is the
  // authoritative backstop (Bug 3: duplicate pool pairs). Sourced from the
  // validated sellableLpPositions list in the worker — NOT the raw registry —
  // so a stale cached pool cannot block a pool forever.
  openPoolAddresses?: readonly Address[];
  // Agent-enforced per-position cap (create-form "Max 0G/position", decimal 0G
  // string). The brain clamps each mint's amount0G to this value (stricter than
  // the vault's perLpActionCap0G backstop). Bug 2: agent-enforced, NOT vault.
  maxPerPosition0G?: string;
  selectedModel?: string;
}

export async function decideLpAction(input: LpBrainInput): Promise<LpBrainDecision> {
  const routerConfig = resolveOgComputeRouterConfig("mainnet");
  if ("error" in routerConfig) {
    throw routerConfig.error;
  }

  const systemPrompt = buildLpSystemPrompt({
    fence: input.fence,
    maxPerPosition0G: input.maxPerPosition0G,
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
        // Agent-enforced per-position cap (Bug 2): stricter than the vault's
        // perLpActionCap0G backstop. amount0G must be <= this value.
        maxPerPosition0G: input.maxPerPosition0G,
      },
      vaultBalance0G: input.vaultBalance0G,
      readiness: {
        vaultReady: input.readiness.vaultReady,
        storageUploadReady: input.readiness.storageUploadReady,
        vaultWarnings: input.readiness.vaultWarnings,
      },
      // Pools the agent already holds an LP position in. Re-entering the same
      // pair would duplicate the position (Bug 3); pick a different candidate
      // or hold. The server re-validates this after the response.
      openPoolAddresses: (input.openPoolAddresses ?? []).map((a) => a.toLowerCase()),
      output_contract: {
        action: "mint | hold",
        poolAddress: "must match one supplied candidate when action is mint",
        tickLower: "integer, on the pool tickSpacing, within usable bounds",
        tickUpper: "integer > tickLower, on the pool tickSpacing, within usable bounds",
        amount0G: "human decimal 0G string, never wei, <= vault per-action ceiling, <= maxPerPosition0G when set, and <= remainingLpExposure0G",
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
    openPoolAddresses: input.openPoolAddresses ?? [],
    maxPerPosition0G: input.maxPerPosition0G,
    model: response.model,
    rawMessage: response.message,
    trace: response.trace,
  });
}

function normalizeLpDecision(input: {
  pools: readonly LpPoolCandidate[];
  fence: LpBrainFence;
  openPoolAddresses: readonly Address[];
  maxPerPosition0G?: string;
  model: string;
  rawMessage: string;
  trace?: { billingTotalCost?: string; provider?: string; requestId?: string; teeVerified?: boolean };
}): LpBrainDecision {
  const { pools, fence, openPoolAddresses, maxPerPosition0G, model, rawMessage, trace } = input;

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

  // Dedup gate (Bug 3: duplicate pool pairs). The vault enforces total 0G
  // exposure + per-action cap but NOT one-NFT-per-pool, so this server-side
  // gate is the authoritative backstop. The openPoolAddresses list is derived
  // from the validated sellableLpPositions (worker) — a stale cached pool from
  // the raw registry is filtered out by readLpPositionByTokenId on the listing
  // path, so an exited pool is not blocked forever.
  const openPoolSet = new Set(openPoolAddresses.map((a) => a.toLowerCase()));
  if (openPoolSet.has(pool.poolAddress.toLowerCase())) {
    return hold(
      model,
      rawMessage,
      [...decision.reasons.map(sanitizeReason), "Pool already has an open position; pick a different pool or hold."],
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
    return hold(model, rawMessage, [...decision.reasons.map(sanitizeReason), "amount0G exceeds vault per-action ceiling."], trace, true);
  }
  // Agent-enforced per-position cap (Bug 2): the operator's create-form
  // "Max 0G/position" — stricter than the vault's perLpActionCap0G backstop.
  // Clamp here (server-side); the vault is NOT tightened.
  const trimmedMaxPerPosition0G = maxPerPosition0G?.trim();
  if (trimmedMaxPerPosition0G) {
    let agentMaxPerPosition: bigint;
    try {
      agentMaxPerPosition = parse0G(trimmedMaxPerPosition0G);
    } catch {
      return hold(model, rawMessage, [...decision.reasons.map(sanitizeReason), "maxPerPosition0G is invalid."], trace, true);
    }
    if (agentMaxPerPosition > 0n && amount > agentMaxPerPosition) {
      return hold(model, rawMessage, [...decision.reasons.map(sanitizeReason), "amount0G exceeds agent max per position (maxPerPosition0G)."], trace, true);
    }
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
  if (maxWidth < spacing * 2) {
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

  if (!containsActiveTick(lower, upper, pool.currentTick)) {
    const requestedWidth = upper > lower ? upper - lower : maxWidth;
    const width = Math.max(spacing * 2, Math.min(maxWidth, alignDown(requestedWidth, spacing)));
    const activeRange = deriveActiveTickRange(pool.currentTick, spacing, width, pool.w0gIsToken0);
    lower = activeRange.tickLower;
    upper = activeRange.tickUpper;
    normalized = true;
  }

  return lower < upper && containsActiveTick(lower, upper, pool.currentTick) && upper - lower <= fence.maxTickWidth
    ? { normalized, tickLower: lower, tickUpper: upper }
    : null;
}

function containsActiveTick(tickLower: number, tickUpper: number, currentTick: number): boolean {
  return tickLower < currentTick && currentTick < tickUpper;
}

function deriveActiveTickRange(
  currentTick: number,
  spacing: number,
  width: number,
  w0gIsToken0: boolean,
): { tickLower: number; tickUpper: number } {
  let tickLower: number;
  let tickUpper: number;
  if (w0gIsToken0) {
    tickUpper = alignUp(currentTick + spacing, spacing);
    tickLower = tickUpper - width;
  } else {
    tickLower = alignDown(currentTick, spacing);
    tickUpper = tickLower + width;
  }
  if (tickLower >= currentTick) {
    tickLower = alignDown(currentTick - spacing, spacing);
    tickUpper = tickLower + width;
  }
  if (tickUpper <= currentTick) {
    tickUpper = alignUp(currentTick + spacing, spacing);
    tickLower = tickUpper - width;
  }
  return { tickLower, tickUpper };
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
