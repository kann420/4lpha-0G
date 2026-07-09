import type { Address } from "viem";

import { getAmountsForLiquidity } from "@/lib/agent/lp/tick-math";

// Pure per-position accounting for V3 LP positions. Takes the raw on-chain
// reads (NFPM positions() fields + slot0) + the Zia pool metadata (prices, APR,
// symbols, decimals) and returns the human-readable accounting fields shown on
// the LP detail page (Balance / Assets / Unclaimed fee / Unrealized PnL / APR
// + the user-facing price range). Kept pure + synchronous so it is unit-testable
// without network; the caller fetches pool meta (slot0 + getZiaPool) and passes
// it in. When a required input is missing the corresponding field is left
// undefined and the UI shows "—" rather than a fake number.

export interface LpPoolMeta {
  poolAddress: Address;
  sqrtPriceX96: bigint;
  currentTick: number;
  token0Symbol: string;
  token1Symbol: string;
  token0Decimals: number;
  token1Decimals: number;
  token0PriceUSD: number | null;
  token1PriceUSD: number | null;
  aprTotal: number | null | undefined;
  aprTrading: number | null | undefined;
  aprStaking: number | null | undefined;
  // Absolute https logo URL for the pair icon, or null when Zia has no usable
  // (absolute) logo for that token — see getZiaTokenLogoUrl.
  token0LogoUrl: string | null;
  token1LogoUrl: string | null;
}

export interface LpPositionAccountingInput {
  pool: LpPoolMeta;
  liquidity: bigint;
  tickLower: number;
  tickUpper: number;
  tokensOwed0: bigint;
  tokensOwed1: bigint;
  deployedNative0G: string; // decimal string (e.g. "0.15")
  staked: boolean;
}

export interface LpPositionAccounting {
  token0Symbol: string;
  token1Symbol: string;
  token0Decimals: number;
  token1Decimals: number;
  amount0: string;
  amount1: string;
  unclaimedFee0: string;
  unclaimedFee1: string;
  leg0USD: number | null;
  leg1USD: number | null;
  valueUSD: number | null;
  entryUSD: number | null;
  unrealizedPnlUSD: number | null;
  unrealizedPnlPct: number | null;
  unrealizedPnlTone: "success" | "danger" | "neutral";
  aprPct: number | null;
  stakingAprPct: number | null;
  tradingAprPct: number | null;
  aprStatus: "staked-earning" | "unstaked-trading-only" | "unknown";
  priceLowerUSD: number | null;
  priceUpperUSD: number | null;
  priceLabelSymbol: string;
}

const STABLE_SYMBOLS = new Set(["USDC", "USDT", "DAI", "USDCE", "USDC.E"]);

/// Format a smallest-unit bigint amount to a human-readable decimal string with
/// up to `dp` decimal places (trailing zeros trimmed, but at least 1 dp when the
/// value is non-zero). Returns "0" for zero input.
export function formatTokenAmount(amountWei: bigint, decimals: number, dp = 6): string {
  if (amountWei <= 0n) return "0";
  const neg = amountWei < 0n;
  const abs = neg ? -amountWei : amountWei;
  const divisor = 10n ** BigInt(decimals);
  const whole = abs / divisor;
  const fraction = abs % divisor;
  let fractionStr = "";
  if (fraction > 0n) {
    const padded = fraction.toString().padStart(decimals, "0");
    fractionStr = padded.slice(0, dp).replace(/0+$/u, "");
  }
  const result = fractionStr ? `${whole.toString()}.${fractionStr}` : whole.toString();
  return neg ? `-${result}` : result;
}

/// USD price of token0 at a given tick, anchored to the pool's current
/// token0PriceUSD. price_token0_in_token1(t) = 1.0001^t × 10^(decimals0-decimals1),
/// so price_token0_USD(t) = token0PriceUSD × 1.0001^(t - currentTick). Returns
/// null when token0PriceUSD is missing or the Math.pow overflows.
function priceToken0USDAt(tick: number, currentTick: number, token0PriceUSD: number | null): number | null {
  if (token0PriceUSD === null || !Number.isFinite(token0PriceUSD)) return null;
  const ratio = Math.pow(1.0001, tick - currentTick);
  if (!Number.isFinite(ratio) || ratio <= 0) return null;
  const price = token0PriceUSD * ratio;
  return Number.isFinite(price) ? price : null;
}

/// USD price of token1 at a given tick (inverted — token1 price falls as tick
/// rises). price_token1_USD(t) = token1PriceUSD × 1.0001^(currentTick - t).
function priceToken1USDAt(tick: number, currentTick: number, token1PriceUSD: number | null): number | null {
  if (token1PriceUSD === null || !Number.isFinite(token1PriceUSD)) return null;
  const ratio = Math.pow(1.0001, currentTick - tick);
  if (!Number.isFinite(ratio) || ratio <= 0) return null;
  const price = token1PriceUSD * ratio;
  return Number.isFinite(price) ? price : null;
}

function pickNonStableSymbol(token0Symbol: string, token1Symbol: string): string {
  const t0Stable = STABLE_SYMBOLS.has(token0Symbol.toUpperCase());
  const t1Stable = STABLE_SYMBOLS.has(token1Symbol.toUpperCase());
  if (!t0Stable) return token0Symbol;
  if (!t1Stable) return token1Symbol;
  return token0Symbol; // both stable — fall back to token0
}

function pnlTone(pnlUSD: number | null): "success" | "danger" | "neutral" {
  if (pnlUSD === null || !Number.isFinite(pnlUSD) || pnlUSD === 0) return "neutral";
  return pnlUSD > 0 ? "success" : "danger";
}

export function computeLpPositionAccounting(input: LpPositionAccountingInput): LpPositionAccounting {
  const { pool, liquidity, tickLower, tickUpper, tokensOwed0, tokensOwed1, deployedNative0G, staked } = input;
  const {
    currentTick,
    token0Symbol,
    token1Symbol,
    token0Decimals,
    token1Decimals,
    token0PriceUSD,
    token1PriceUSD,
    aprStaking,
    aprTrading,
  } = pool;

  // Leg amounts owed when burning `liquidity` (smallest-unit bigints).
  const { amount0, amount1 } = getAmountsForLiquidity(pool.sqrtPriceX96, tickLower, tickUpper, liquidity);
  const amount0Human = formatTokenAmount(amount0, token0Decimals);
  const amount1Human = formatTokenAmount(amount1, token1Decimals);
  const unclaimedFee0 = formatTokenAmount(tokensOwed0, token0Decimals);
  const unclaimedFee1 = formatTokenAmount(tokensOwed1, token1Decimals);

  // USD value of the position = sum of legs × priceUSD. Use the BigInt-scaled
  // human amount strings (not raw wei) so Number() stays well within 2^53 for
  // any realistic token quantity. A leg with amount 0 contributes $0
  // regardless of price, so a missing priceUSD on the zero leg (out-of-range
  // one-sided position) does NOT blank the total — only a missing price on a
  // non-zero leg blanks it.
  const leg0USD = amount0 === 0n
    ? 0
    : token0PriceUSD !== null ? Number(amount0Human) * token0PriceUSD : null;
  const leg1USD = amount1 === 0n
    ? 0
    : token1PriceUSD !== null ? Number(amount1Human) * token1PriceUSD : null;
  const valueUSD = leg0USD !== null && leg1USD !== null ? leg0USD + leg1USD : null;

  // Entry baseline = deployedNative0G × current W0G priceUSD. NOTE: no
  // deposit-time W0G price is recorded on-chain, so this is a HODL-baseline
  // (current value of the deposited 0G had it stayed liquid), not a true
  // cost basis. unrealizedPnlUSD = valueUSD - entryUSD therefore reads as
  // fees-minus-impermanent-loss vs holding, not total return vs deposit
  // cost. W0G is whichever leg carries the W0G symbol; null when neither.
  const w0gIsToken0 = token0Symbol.toUpperCase() === "W0G";
  const w0gPriceUSD = w0gIsToken0 ? token0PriceUSD : token1Symbol.toUpperCase() === "W0G" ? token1PriceUSD : null;
  const deployed = Number(deployedNative0G);
  const entryUSD = w0gPriceUSD !== null && Number.isFinite(deployed) ? deployed * w0gPriceUSD : null;

  const unrealizedPnlUSD = valueUSD !== null && entryUSD !== null && entryUSD > 0 ? valueUSD - entryUSD : null;
  const unrealizedPnlPct = unrealizedPnlUSD !== null && entryUSD !== null && entryUSD > 0
    ? (unrealizedPnlUSD / entryUSD) * 100
    : null;

  // APR: staked → staking leg; !staked → trading leg. Unknown when the field is
  // null/undefined. aprPct mirrors the chosen leg (null when unknown).
  const stakingApr = aprStaking ?? null;
  const tradingApr = aprTrading ?? null;
  const aprStatus: LpPositionAccounting["aprStatus"] = staked
    ? stakingApr !== null ? "staked-earning" : "unknown"
    : tradingApr !== null ? "unstaked-trading-only" : "unknown";
  const aprPct = staked ? stakingApr : tradingApr;

  // Price range: USD bounds for the non-stable leg at tickLower/tickUpper.
  const labelSymbol = pickNonStableSymbol(token0Symbol, token1Symbol);
  const labelIsToken0 = labelSymbol === token0Symbol;
  let priceLowerUSD: number | null = null;
  let priceUpperUSD: number | null = null;
  if (labelIsToken0) {
    const lo = priceToken0USDAt(tickLower, currentTick, token0PriceUSD);
    const hi = priceToken0USDAt(tickUpper, currentTick, token0PriceUSD);
    if (lo !== null && hi !== null) {
      priceLowerUSD = Math.min(lo, hi);
      priceUpperUSD = Math.max(lo, hi);
    }
  } else {
    const lo = priceToken1USDAt(tickUpper, currentTick, token1PriceUSD); // higher tick → lower token1 price
    const hi = priceToken1USDAt(tickLower, currentTick, token1PriceUSD);
    if (lo !== null && hi !== null) {
      priceLowerUSD = Math.min(lo, hi);
      priceUpperUSD = Math.max(lo, hi);
    }
  }

  return {
    token0Symbol,
    token1Symbol,
    token0Decimals,
    token1Decimals,
    amount0: amount0Human,
    amount1: amount1Human,
    unclaimedFee0,
    unclaimedFee1,
    leg0USD: leg0USD ?? null,
    leg1USD: leg1USD ?? null,
    valueUSD,
    entryUSD,
    unrealizedPnlUSD,
    unrealizedPnlPct,
    unrealizedPnlTone: pnlTone(unrealizedPnlUSD),
    aprPct,
    stakingAprPct: stakingApr,
    tradingAprPct: tradingApr,
    aprStatus,
    priceLowerUSD,
    priceUpperUSD,
    priceLabelSymbol: labelSymbol,
  };
}