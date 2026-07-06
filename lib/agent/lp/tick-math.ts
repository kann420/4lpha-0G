import type { Address } from "viem";

// Uniswap V3 tick math + LP quote helpers for the 0G LP Agent.
//
// The critical invariant (codex audit, HIGH risk): the off-chain quote MUST
// mirror `ZiaLpAdapter._computeSwapAmount` exactly (contracts/ZiaLpAdapter.sol:
// 304-324), otherwise the vault's `amount0Min/amount1Min` floors diverge from
// the on-chain swap and the simulation reverts (or proof gas is spent before the
// LP simulation catches the drift — see docs/lp-backend-wire-plan.md §Audit #4).
//
// TickMath constants are the canonical Uniswap V3 values (v3-sdk tickMath.ts),
// reproduced verbatim. LiquidityMath mirrors v3-core LiquidityMath.sol. All
// arithmetic is bigint and floors (matching Solidity `/` and `>>`) unless noted.

export const MIN_TICK = -887_272;
export const MAX_TICK = 887_272;

const Q32 = 2n ** 32n;
const Q96 = 2n ** 96n;
const BPS = 10_000n;

/// Ceil division — mirrors Solidity `(a + b - 1) / b`. Used by `computeSwapAmount`
/// to reproduce the adapter's bias toward the W0G side being the binding constraint.
export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new Error("ceilDiv: divisor must be positive");
  return (a + b - 1n) / b;
}

/// Mirror of `ZiaLpAdapter._computeSwapAmount`. Returns the amount of W0G to swap
/// to the paired side before the NFPM mint. Out-of-range inputs return 0 or the
/// full amount (the vault's amount0Min/amount1Min > 0 requirement rejects those
/// before they reach the adapter).
///
/// `w0gIsToken0` matches the adapter's flag: true when the pool's token0 is W0G.
/// `numerator = w0gIsToken0 ? (currentTick - tickLower) : (tickUpper - currentTick)`.
export function computeSwapAmount(
  amount0G: bigint,
  currentTick: number,
  tickLower: number,
  tickUpper: number,
  w0gIsToken0: boolean,
): bigint {
  const range = tickUpper - tickLower;
  if (range <= 0) throw new Error("computeSwapAmount: tickUpper must be > tickLower");
  const numerator = w0gIsToken0 ? currentTick - tickLower : tickUpper - currentTick;
  if (numerator <= 0) return 0n;
  if (numerator >= range) return amount0G;
  // ceilDiv(amount0G * numerator, range) — over-swap by <1 unit to bias W0G binding.
  return ceilDiv(BigInt(numerator) * amount0G, BigInt(range));
}

/// `minLpOutFor(quote, bps)` — mirrors `PolicyVaultV3.minLpOutFor`:
/// `(quote * bps + (BPS - 1)) / BPS` (ceil). With bps=9500, this is ~95% of quote.
export function minLpOutFor(quote: bigint, lpMinOutBps: number): bigint {
  const bps = BigInt(lpMinOutBps);
  return (quote * bps + (BPS - 1n)) / BPS;
}

/// Round a tick down to the nearest usable tick for a given tickSpacing.
/// Mirrors Uniswap V3 `nearestUsableTick` (v3-sdk): `floor(tick / spacing) * spacing`.
export function nearestUsableTick(tick: number, tickSpacing: number): number {
  if (tickSpacing <= 0) throw new Error("tickSpacing must be positive");
  const rounded = Math.floor(tick / tickSpacing) * tickSpacing;
  if (rounded < MIN_TICK) return MIN_TICK;
  if (rounded > MAX_TICK) return MAX_TICK;
  return rounded;
}

function mulShift(n: bigint, x: bigint): bigint {
  // v3-sdk: `(n * x) >> 128` — keeps the Q128.128 representation stable across
  // each fixed-point multiply (constants are ~2^128, i.e. Q128 multipliers).
  return (n * x) >> 128n;
}

/// Canonical Uniswap V3 `TickMath.getSqrtRatioAtTick`. Returns sqrtPriceX96
/// (Q64.96) for a tick. Throws outside [MIN_TICK, MAX_TICK]. Constants verbatim
/// from v3-sdk tickMath.ts.
export function getSqrtRatioAtTick(tick: number): bigint {
  if (tick < MIN_TICK || tick > MAX_TICK || !Number.isInteger(tick)) {
    throw new Error(`tick out of range: ${tick}`);
  }
  const absTick = tick < 0 ? -tick : tick;

  let ratio: bigint =
    (absTick & 0x1) !== 0
      ? 0xfffcb933bd6fad37aa2d162d1a594001n
      : 0x100000000000000000000000000000000n;
  if ((absTick & 0x2) !== 0) ratio = mulShift(ratio, 0xfff97272373d413259a46990580e213an);
  if ((absTick & 0x4) !== 0) ratio = mulShift(ratio, 0xfff2e50f5f656932ef12357cf3c7fdccn);
  if ((absTick & 0x8) !== 0) ratio = mulShift(ratio, 0xffe5caca7e10e4e61c3624eaa0941cd0n);
  if ((absTick & 0x10) !== 0) ratio = mulShift(ratio, 0xffcb9843d60f6159c9db58835c926644n);
  if ((absTick & 0x20) !== 0) ratio = mulShift(ratio, 0xff973b41fa98c081472e6896dfb254c0n);
  if ((absTick & 0x40) !== 0) ratio = mulShift(ratio, 0xff2ea16466c96a3843ec78b326b52861n);
  if ((absTick & 0x80) !== 0) ratio = mulShift(ratio, 0xfe5dee046a99a2a811c461f1969c3053n);
  if ((absTick & 0x100) !== 0) ratio = mulShift(ratio, 0xfcbe86c7900a88aedcffc83b479aa3a4n);
  if ((absTick & 0x200) !== 0) ratio = mulShift(ratio, 0xf987a7253ac413176f2b074cf7815e54n);
  if ((absTick & 0x400) !== 0) ratio = mulShift(ratio, 0xf3392b0822b70005940c7a398e4b70f3n);
  if ((absTick & 0x800) !== 0) ratio = mulShift(ratio, 0xe7159475a2c29b7443b29c7fa6e889d9n);
  if ((absTick & 0x1000) !== 0) ratio = mulShift(ratio, 0xd097f3bdfd2022b8845ad8f792aa5825n);
  if ((absTick & 0x2000) !== 0) ratio = mulShift(ratio, 0xa9f746462d870fdf8a65dc1f90e061e5n);
  if ((absTick & 0x4000) !== 0) ratio = mulShift(ratio, 0x70d869a156d2a1b890bb3df62baf32f7n);
  if ((absTick & 0x8000) !== 0) ratio = mulShift(ratio, 0x31be135f97d08fd981231505542fcfa6n);
  if ((absTick & 0x10000) !== 0) ratio = mulShift(ratio, 0x9aa508b5b7a84e1c677de54f3e99bc9n);
  if ((absTick & 0x20000) !== 0) ratio = mulShift(ratio, 0x5d6af8dedb81196699c329225ee604n);
  if ((absTick & 0x40000) !== 0) ratio = mulShift(ratio, 0x2216e584f5fa1ea926041bedfe98n);
  if ((absTick & 0x80000) !== 0) ratio = mulShift(ratio, 0x48a170391f7dc42444e8fa2n);

  if (tick > 0) ratio = (2n ** 256n - 1n) / ratio;

  // back to Q96 — ceil if there is a remainder (matches v3-sdk).
  return ratio % Q32 > 0n ? ratio / Q32 + 1n : ratio / Q32;
}

/// `getLiquidityForAmount0(sqrtRatioAX96, sqrtRatioBX96, amount0)` — v3-core
/// LiquidityMath. Returns the liquidity for amount0 of token0 in the range.
function getLiquidityForAmount0(sqrtRatioAX96: bigint, sqrtRatioBX96: bigint, amount0: bigint): bigint {
  if (sqrtRatioAX96 > sqrtRatioBX96) {
    [sqrtRatioAX96, sqrtRatioBX96] = [sqrtRatioBX96, sqrtRatioAX96];
  }
  const intermediate = (sqrtRatioAX96 * sqrtRatioBX96) / Q96;
  return (amount0 * intermediate) / (sqrtRatioBX96 - sqrtRatioAX96);
}

/// `getLiquidityForAmount1(sqrtRatioAX96, sqrtRatioBX96, amount1)` — v3-core.
function getLiquidityForAmount1(sqrtRatioAX96: bigint, sqrtRatioBX96: bigint, amount1: bigint): bigint {
  if (sqrtRatioAX96 > sqrtRatioBX96) {
    [sqrtRatioAX96, sqrtRatioBX96] = [sqrtRatioBX96, sqrtRatioAX96];
  }
  return (amount1 * Q96) / (sqrtRatioBX96 - sqrtRatioAX96);
}

/// `getLiquidityForAmounts(sqrtPriceX96, tickLower, tickUpper, amount0, amount1)`
/// — v3-core. Picks the binding liquidity depending on where the current price
/// sits relative to the position range.
export function getLiquidityForAmounts(
  sqrtPriceX96: bigint,
  tickLower: number,
  tickUpper: number,
  amount0: bigint,
  amount1: bigint,
): bigint {
  const sqrtRatioAX96 = getSqrtRatioAtTick(tickLower);
  const sqrtRatioBX96 = getSqrtRatioAtTick(tickUpper);
  if (sqrtPriceX96 <= sqrtRatioAX96) {
    return getLiquidityForAmount0(sqrtRatioAX96, sqrtRatioBX96, amount0);
  }
  if (sqrtPriceX96 < sqrtRatioBX96) {
    const liquidity0 = getLiquidityForAmount0(sqrtPriceX96, sqrtRatioBX96, amount0);
    const liquidity1 = getLiquidityForAmount1(sqrtRatioAX96, sqrtPriceX96, amount1);
    return liquidity0 < liquidity1 ? liquidity0 : liquidity1;
  }
  return getLiquidityForAmount1(sqrtRatioAX96, sqrtRatioBX96, amount1);
}

/// `getAmount0ForLiquidity(sqrtRatioAX96, sqrtRatioBX96, liquidity)` — v3-core
/// LiquidityMath. Returns the amount of token0 owed for `liquidity` in the
/// range [tickA, tickB]. Floors (matches Solidity `/`).
export function getAmount0ForLiquidity(
  sqrtRatioAX96: bigint,
  sqrtRatioBX96: bigint,
  liquidity: bigint,
): bigint {
  if (sqrtRatioAX96 > sqrtRatioBX96) {
    [sqrtRatioAX96, sqrtRatioBX96] = [sqrtRatioBX96, sqrtRatioAX96];
  }
  // mulDiv(liquidity << 96, sqrtB - sqrtA, sqrtB) / sqrtA — exact in bigint.
  const shifted = liquidity << 96n;
  const numerator = (shifted * (sqrtRatioBX96 - sqrtRatioAX96)) / sqrtRatioBX96;
  return numerator / sqrtRatioAX96;
}

/// `getAmount1ForLiquidity(sqrtRatioAX96, sqrtRatioBX96, liquidity)` — v3-core.
/// Returns the amount of token1 owed for `liquidity` in the range.
export function getAmount1ForLiquidity(
  sqrtRatioAX96: bigint,
  sqrtRatioBX96: bigint,
  liquidity: bigint,
): bigint {
  if (sqrtRatioAX96 > sqrtRatioBX96) {
    [sqrtRatioAX96, sqrtRatioBX96] = [sqrtRatioBX96, sqrtRatioAX96];
  }
  return (liquidity * (sqrtRatioBX96 - sqrtRatioAX96)) / Q96;
}

/// `getAmountsForLiquidity(sqrtPriceX96, tickLower, tickUpper, liquidity)` —
/// v3-sdk SqrtPriceMath.getAmountsForLiquidity. Returns the [amount0, amount1]
/// owed when burning `liquidity` from a position, depending on where the
/// current price sits relative to the position range. Used by the zap-out
/// quote to mirror the adapter's decreaseLiquidity output.
export function getAmountsForLiquidity(
  sqrtPriceX96: bigint,
  tickLower: number,
  tickUpper: number,
  liquidity: bigint,
): { amount0: bigint; amount1: bigint } {
  const sqrtRatioAX96 = getSqrtRatioAtTick(tickLower);
  const sqrtRatioBX96 = getSqrtRatioAtTick(tickUpper);
  if (sqrtPriceX96 <= sqrtRatioAX96) {
    return { amount0: getAmount0ForLiquidity(sqrtRatioAX96, sqrtRatioBX96, liquidity), amount1: 0n };
  }
  if (sqrtPriceX96 < sqrtRatioBX96) {
    return {
      amount0: getAmount0ForLiquidity(sqrtPriceX96, sqrtRatioBX96, liquidity),
      amount1: getAmount1ForLiquidity(sqrtRatioAX96, sqrtPriceX96, liquidity),
    };
  }
  return { amount0: 0n, amount1: getAmount1ForLiquidity(sqrtRatioAX96, sqrtRatioBX96, liquidity) };
}

/// Result of an LP mint quote. All fields are bigint floors safe to pass to the
/// vault as `quotedLiquidity`/`quotedAmount0/1`/`amount0Min/amount1Min`.
export interface LpMintQuote {
  poolAddress: Address;
  tickLower: number;
  tickUpper: number;
  amount0G: bigint; // native 0G input
  swapAmount: bigint; // W0G the adapter will swap to the paired side
  w0gIsToken0: boolean;
  amountW0GSide: bigint; // unswapped W0G (one leg)
  amountPairedSide: bigint; // swapped output (other leg)
  amount0Desired: bigint; // token0 leg (W0G or paired depending on ordering)
  amount1Desired: bigint; // token1 leg
  quotedLiquidity: bigint; // conservative floor (≤ actual mint liquidity)
  quotedAmount0: bigint; // expected token0 mint output (floor)
  quotedAmount1: bigint; // expected token1 mint output (floor)
  amount0Min: bigint; // = minLpOutFor(quotedAmount0), floored to >=1 wei
  amount1Min: bigint; // = minLpOutFor(quotedAmount1), floored to >=1 wei
}

/// Quote a single-sided 0G zap-in mint. The caller supplies the live pool reads
/// (sqrtPriceX96, currentTick from slot0) and the swap output amount for the
/// balancing leg (from the partner /route or QuoterV2 — kept out of this pure
/// module so the quote stays deterministic and testable).
///
/// `swapOutputAmount` is the paired-side amount produced by swapping
/// `swapAmount` W0G. `lpMinOutBps` is the vault's slippage bps (e.g. 9500).
/// `quotedLiquidity` is floored by the bps margin so the vault's
/// `liquidity >= minLpOutFor(quotedLiquidity)` + `actual >= request.liquidity`
/// checks pass under normal market movement.
export function quoteLpMint(input: {
  poolAddress: Address;
  sqrtPriceX96: bigint;
  currentTick: number;
  tickLower: number;
  tickUpper: number;
  amount0G: bigint;
  w0gIsToken0: boolean;
  swapOutputAmount: bigint;
  lpMinOutBps: number;
}): LpMintQuote {
  const { poolAddress, sqrtPriceX96, currentTick, tickLower, tickUpper, amount0G, w0gIsToken0, swapOutputAmount, lpMinOutBps } = input;

  const swapAmount = computeSwapAmount(amount0G, currentTick, tickLower, tickUpper, w0gIsToken0);
  const amountW0GSide = amount0G - swapAmount;
  const amountPairedSide = swapOutputAmount;

  // Assign legs by pool token ordering. The vault sets amount0Desired = native
  // amount and amount1Desired = 0 (it wraps + swaps internally), but the quote
  // still needs both legs to estimate liquidity.
  const amount0Desired = w0gIsToken0 ? amountW0GSide : amountPairedSide;
  const amount1Desired = w0gIsToken0 ? amountPairedSide : amountW0GSide;

  const theoreticalLiquidity = getLiquidityForAmounts(sqrtPriceX96, tickLower, tickUpper, amount0Desired, amount1Desired);

  // Conservative floors: apply the bps margin so a small adverse price move
  // between quote and mint does not trip `actual < request.liquidity` or
  // `actual < amount0Min/amount1Min`.
  const quotedLiquidity = minLpOutFor(theoreticalLiquidity, lpMinOutBps);
  const quotedAmount0 = minLpOutFor(amount0Desired, lpMinOutBps);
  const quotedAmount1 = minLpOutFor(amount1Desired, lpMinOutBps);

  // amount0Min/amount1Min must be >= minLpOutFor(quotedAmount0/1) AND <= actual.
  // Setting them to the floor is the tightest safe choice. Floor at 1 wei — the
  // vault forbids zero min-out (PolicyVaultV3.sol:722).
  const amount0Min = floor1(minLpOutFor(quotedAmount0, lpMinOutBps));
  const amount1Min = floor1(minLpOutFor(quotedAmount1, lpMinOutBps));

  return {
    poolAddress,
    tickLower,
    tickUpper,
    amount0G,
    swapAmount,
    w0gIsToken0,
    amountW0GSide,
    amountPairedSide,
    amount0Desired,
    amount1Desired,
    quotedLiquidity: floor1(quotedLiquidity),
    quotedAmount0,
    quotedAmount1,
    amount0Min,
    amount1Min,
  };
}

function floor1(v: bigint): bigint {
  return v < 1n ? 1n : v;
}
