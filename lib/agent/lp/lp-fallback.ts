import type { Address } from "viem";

import { MAX_TICK, MIN_TICK } from "@/lib/agent/lp/tick-math";
import type { LpBrainFence, LpPoolCandidate } from "@/lib/agent/runtime/types";

export type LpMintAttemptSource = "fallback" | "llm";

export interface LpMintAttempt {
  amount0G: string;
  poolAddress: Address;
  source: LpMintAttemptSource;
  tickLower: number;
  tickUpper: number;
}

const NON_RETRYABLE_PATTERNS = [
  /agent is paused/i,
  /not armed/i,
  /policyvault is paused/i,
  /policy vault is paused/i,
  /executor is revoked/i,
  /agent key is not enabled/i,
  /proofregistry owner/i,
  /insufficient funds/i,
  /no lp mint budget/i,
  /max positions reached/i,
  /storage upload is not ready/i,
  /requires a ready v3 vault/i,
  /pool is not zappable/i,
  /invalidlppool/i,
  /invalidactiontype/i,
  /exact lp quote tokens do not match/i,
  /amount0g exceeds/i,
  /lp mint amount must be/i,
  /0g amount must/i,
];

const RETRYABLE_PATTERNS = [
  /quote swap amount is zero/i,
  /zia exact-pool quoter returned zero/i,
  /quote_drift/i,
  /price slippage check/i,
  /slippage/i,
  /min[-\s]?out/i,
  /amount0min/i,
  /amount1min/i,
  /lpinvalidminout/i,
  /lpbaddelta/i,
  /too little received/i,
];

export function isRetryableLpMintError(message: string): boolean {
  if (NON_RETRYABLE_PATTERNS.some((pattern) => pattern.test(message))) return false;
  return RETRYABLE_PATTERNS.some((pattern) => pattern.test(message));
}

export function buildDeterministicFallbackMintAttempts(input: {
  amount0G: string;
  failedPoolAddresses: readonly Address[];
  fence: LpBrainFence;
  maxAttempts: number;
  openPoolAddresses: readonly Address[];
  pools: readonly LpPoolCandidate[];
}): LpMintAttempt[] {
  const blocked = new Set([
    ...input.openPoolAddresses.map((address) => address.toLowerCase()),
    ...input.failedPoolAddresses.map((address) => address.toLowerCase()),
  ]);

  return [...input.pools]
    .filter((pool) => !blocked.has(pool.poolAddress.toLowerCase()))
    .sort(compareFallbackPools)
    .map((pool): LpMintAttempt | null => {
      const range = widestActiveRange(pool, input.fence.maxTickWidth);
      if (!range) return null;
      return {
        amount0G: input.amount0G,
        poolAddress: pool.poolAddress,
        source: "fallback",
        tickLower: range.tickLower,
        tickUpper: range.tickUpper,
      };
    })
    .filter((attempt): attempt is LpMintAttempt => attempt !== null)
    .slice(0, Math.max(0, input.maxAttempts));
}

function compareFallbackPools(a: LpPoolCandidate, b: LpPoolCandidate): number {
  const apr = b.stakingAprPct - a.stakingAprPct;
  if (apr !== 0) return apr;
  const tvl = (b.tvlUSD ?? -1) - (a.tvlUSD ?? -1);
  if (tvl !== 0) return tvl;
  return (b.volume24hUSD ?? -1) - (a.volume24hUSD ?? -1);
}

function widestActiveRange(
  pool: LpPoolCandidate,
  maxTickWidth: number,
): { tickLower: number; tickUpper: number } | null {
  const spacing = pool.tickSpacing;
  if (!Number.isInteger(spacing) || spacing <= 0) return null;

  const minUsable = Math.ceil(MIN_TICK / spacing) * spacing;
  const maxUsable = Math.floor(MAX_TICK / spacing) * spacing;
  const maxWidth = alignDown(maxTickWidth, spacing);
  if (maxWidth < spacing * 2 || maxUsable - minUsable < spacing * 2) return null;

  const width = Math.min(maxWidth, alignDown(maxUsable - minUsable, spacing));
  const half = Math.max(spacing, alignDown(Math.trunc(width / 2), spacing));
  let lower = alignDown(pool.currentTick - half, spacing);
  let upper = lower + width;
  ({ lower, upper } = clampRange({ lower, maxUsable, minUsable, upper, width }));

  if (pool.currentTick <= lower) {
    lower = alignDown(pool.currentTick - spacing, spacing);
    upper = lower + width;
    ({ lower, upper } = clampRange({ lower, maxUsable, minUsable, upper, width }));
  }
  if (pool.currentTick >= upper) {
    upper = alignUp(pool.currentTick + spacing, spacing);
    lower = upper - width;
    ({ lower, upper } = clampRange({ lower, maxUsable, minUsable, upper, width }));
  }

  return lower < pool.currentTick && pool.currentTick < upper && upper - lower <= maxTickWidth
    ? { tickLower: lower, tickUpper: upper }
    : null;
}

function clampRange(input: {
  lower: number;
  maxUsable: number;
  minUsable: number;
  upper: number;
  width: number;
}): { lower: number; upper: number } {
  let { lower, upper } = input;
  if (lower < input.minUsable) {
    lower = input.minUsable;
    upper = lower + input.width;
  }
  if (upper > input.maxUsable) {
    upper = input.maxUsable;
    lower = upper - input.width;
  }
  return { lower, upper };
}

function alignDown(value: number, spacing: number): number {
  return Math.floor(value / spacing) * spacing;
}

function alignUp(value: number, spacing: number): number {
  return Math.ceil(value / spacing) * spacing;
}
