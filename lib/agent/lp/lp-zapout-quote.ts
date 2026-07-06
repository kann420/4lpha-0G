// Zap-out quote — mirrors the on-chain adapter path
// (contracts/ZiaLpAdapter.sol:362-415): decreaseLiquidity (min 0) → swap the
// non-W0G leg back to W0G via the router (router amountOutMinimum: 0) → unwrap
// W0G → native out. The ONLY slippage protection is the final native-out floor
// (`request.amount0Min` on zap-out). A pure inverse-liquidity-math quote is
// INSUFFICIENT — it would miss the paired-token swap leg and produce a wrong
// floor. So this quote mirrors the full path and derives `amountOutMin` from
// the expected total W0G out.
//
// No `server-only` here so the quote stays unit-testable; it imports
// tick-math.ts (also pure) + the partner route client (server use only in
// practice). The vault's `LpBadDelta` check (PolicyVaultV3.sol:989-991) is the
// on-chain backstop; AGENTS.md requires nonzero slippage protection, so
// amountOutMin is floored to >=1 wei (the route rejects a zero floor).
// Live execution uses the exact-pool Zia QuoterV2, not partner /route fallback.

import type { Address, PublicClient } from "viem";

import { getAmountsForLiquidity, getSqrtRatioAtTick, minLpOutFor } from "@/lib/agent/lp/tick-math";
import { quoteZiaExactPoolSwap, readPairedToken } from "@/lib/agent/lp/lp-context";
import { uniswapV3PoolAbi, verifyZappablePool, ZIA_LP_MAINNET } from "@/lib/contracts/zia-lp";

export interface LpZapOutQuote {
  poolAddress: Address;
  tokenId: string;
  liquidity: bigint;
  sqrtPriceX96: bigint;
  w0gIsToken0: boolean;
  // Token amounts owed from decreasing `liquidity` (smallest-unit bigints).
  amount0Owed: bigint;
  amount1Owed: bigint;
  // The W0G leg straight out of decreaseLiquidity (no swap needed).
  w0gLegAmount: bigint;
  // The paired-side leg, swapped back to W0G through the exact LP pool.
  pairedLegAmount: bigint;
  pairedLegSwapOutputW0G: bigint;
  // Total W0G = w0gLeg + swap output. Native out is 1:1 unwrap.
  totalW0GOut: bigint;
  // Native-out floor = ceil(totalW0GOut * lpMinOutBps / 10000), >=1 wei.
  amountOutMin: bigint;
  quotedAmountOut: bigint; // = totalW0GOut (the expected native out)
}

export async function quoteLpZapOut(input: {
  publicClient: PublicClient;
  poolAddress: Address;
  tokenId: string;
  liquidity: bigint;
  tickLower: number;
  tickUpper: number;
  lpMinOutBps: number;
}): Promise<LpZapOutQuote> {
  const { publicClient, poolAddress, tokenId, liquidity, tickLower, tickUpper, lpMinOutBps } = input;
  if (liquidity <= 0n) {
    throw new Error("zap-out requires a position with nonzero liquidity (staked positions report 0).");
  }

  const [verification, slot0] = await Promise.all([
    verifyZappablePool(poolAddress, publicClient),
    publicClient.readContract({
      address: poolAddress,
      abi: uniswapV3PoolAbi,
      functionName: "slot0",
      args: [],
    }) as Promise<readonly [bigint, number, ...unknown[]]>,
  ]);
  if (!verification) throw new Error("Pool is not zappable (no W0G leg).");
  const sqrtPriceX96 = slot0[0];
  const w0gIsToken0 = verification.w0gIsToken0;

  // 1. Inverse tick math: amounts owed from burning `liquidity`.
  const { amount0: amount0Owed, amount1: amount1Owed } = getAmountsForLiquidity(
    sqrtPriceX96,
    tickLower,
    tickUpper,
    liquidity,
  );

  // 2. Split into the W0G leg + the paired leg. The adapter swaps the paired
  //    leg back to W0G via the router; the W0G leg is already W0G.
  const w0gLegAmount = w0gIsToken0 ? amount0Owed : amount1Owed;
  const pairedLegAmount = w0gIsToken0 ? amount1Owed : amount0Owed;

  let pairedLegSwapOutputW0G = 0n;
  if (pairedLegAmount > 0n) {
    const pairedToken = await readPairedToken(publicClient, poolAddress);
    pairedLegSwapOutputW0G = await quoteZiaExactPoolSwap(
      publicClient,
      poolAddress,
      pairedToken,
      ZIA_LP_MAINNET.wrappedNative,
      pairedLegAmount,
    );
    if (pairedLegSwapOutputW0G <= 0n) {
      throw new Error("Zia exact-pool quoter returned zero swap output for the paired-side leg.");
    }
  }

  // 3. Total W0G out = W0G leg + swap output. Native out is 1:1 unwrap.
  const totalW0GOut = w0gLegAmount + pairedLegSwapOutputW0G;
  if (totalW0GOut <= 0n) {
    throw new Error("zap-out quote produced zero total W0G out; aborting before on-chain send.");
  }

  // 4. amountOutMin = ceil(totalW0GOut * lpMinOutBps / 10000), floored to >=1 wei.
  //    Mirrors PolicyVaultV3.minLpOutFor; nonzero slippage protection is required.
  const amountOutMin = floor1(minLpOutFor(totalW0GOut, lpMinOutBps));

  return {
    poolAddress,
    tokenId,
    liquidity,
    sqrtPriceX96,
    w0gIsToken0,
    amount0Owed,
    amount1Owed,
    w0gLegAmount,
    pairedLegAmount,
    pairedLegSwapOutputW0G,
    totalW0GOut,
    amountOutMin,
    quotedAmountOut: totalW0GOut,
  };
}

function floor1(v: bigint): bigint {
  return v < 1n ? 1n : v;
}

// Re-export so callers that compute a drift guard can reuse the canonical
// tick→sqrt without importing tick-math directly.
export { getSqrtRatioAtTick };
