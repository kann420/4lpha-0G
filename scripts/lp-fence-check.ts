// Smoke check for lib/agent/lp/lp-fence.ts. Run with: npx tsx scripts/lp-fence-check.ts
//
// Verifies:
//   1. translateLpFence({maxPositions:3, maxPerPosition0G:'0.5'}) ->
//      perLpActionCap0G=0.5e18, maxLpExposure0G=1.5e18 (exact multiply).
//   2. deriveMaxPositions === 3 (round-trip).
//   3. buildTightenPolicyCall throws cannot_loosen_policy on a loosen attempt.
//   4. buildTightenPolicyCall returns tightened=false when nothing changes.
//   5. deriveMaxPositions is divide-by-zero safe (perLpActionCap0G=0 -> 0).
//   6. runtime mint budget uses maxPerPosition0G as the agent cap and keeps
//      perLpActionCap0G as a vault ceiling/backstop.

import { parseEther } from "viem";
import {
  buildTightenPolicyCall,
  CannotLoosenPolicyError,
  deriveMaxPositions,
  translateLpFence,
} from "../lib/agent/lp/lp-fence";
import { buildDeterministicFallbackMintAttempts, isRetryableLpMintError } from "../lib/agent/lp/lp-fallback";
import { computeLpMintBudget } from "../lib/agent/lp/lp-runtime-policy";
import type { LpBrainFence, LpPoolCandidate } from "../lib/agent/runtime/types";
import type { PolicyVaultV3Policy } from "../lib/contracts/policy-vault-v3";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`ok: ${msg}`);
}

const currentLp = {
  perLpActionCap0G: parseEther("1"),
  lpDailyCap0G: parseEther("10"),
  maxLpExposure0G: parseEther("10"),
  cooldownSecondsLp: 60n,
  lpMinOutBps: 9000,
  minLiquidityFloor: 1n,
  allowStaking: true,
};

const current: PolicyVaultV3Policy = {
  perTradeCap0G: parseEther("1"),
  dailyCap0G: parseEther("10"),
  maxExposure0G: parseEther("10"),
  cooldownSeconds: 60n,
  maxDeadlineWindowSeconds: 600n,
  defaultMinOutBps: 9000,
  lp: currentLp,
};

// 1. translate
const translated = translateLpFence({ maxPositions: 3, maxPerPosition0G: "0.5" }, currentLp);
assert(translated.perLpActionCap0G === parseEther("0.5"), "perLpActionCap0G = 0.5e18");
assert(translated.maxLpExposure0G === parseEther("1.5"), "maxLpExposure0G = 1.5e18 (exact multiply)");
assert(translated.maxLpExposure0G === translated.perLpActionCap0G * 3n, "maxLpExposure0G = perLpActionCap0G * N");

// 2. deriveMaxPositions round-trip
assert(deriveMaxPositions(translated) === 3, "deriveMaxPositions(translated) === 3");

// 3. loosen attempt throws
let loosenThrew = false;
try {
  // current.perLpActionCap0G = 1.0; requesting 2.0 should throw cannot_loosen_policy
  buildTightenPolicyCall(current, { ...currentLp, perLpActionCap0G: parseEther("2"), maxLpExposure0G: parseEther("20") });
} catch (err) {
  loosenThrew = err instanceof CannotLoosenPolicyError;
}
assert(loosenThrew, "buildTightenPolicyCall throws CannotLoosenPolicyError on loosen");

// 4. tightened=false when nothing changes (request === current)
const same = buildTightenPolicyCall(current, currentLp);
assert(same.tightened === false, "tightened=false when nothing changes");

// 5. tightened=true on a real tighten + divide-by-zero safety
assert(deriveMaxPositions({ perLpActionCap0G: 0n, maxLpExposure0G: 10n }) === 0, "deriveMaxPositions divide-by-zero -> 0");
const tightened = buildTightenPolicyCall(current, translated); // 1.0 -> 0.5 (tighten)
assert(tightened.tightened === true, "tightened=true on per-position tighten");
assert(tightened.nextPolicy.lp.perLpActionCap0G === parseEther("0.5"), "nextPolicy carries tightened perLpActionCap0G");
assert(tightened.nextPolicy.lp.maxLpExposure0G === parseEther("1.5"), "nextPolicy carries tightened maxLpExposure0G");

// 6. allowStaking loosen (false -> true) throws
let stakingLoosenThrew = false;
try {
  buildTightenPolicyCall(
    { ...current, lp: { ...currentLp, allowStaking: false } },
    { ...currentLp, allowStaking: true },
  );
} catch (err) {
  stakingLoosenThrew = err instanceof CannotLoosenPolicyError;
}
assert(stakingLoosenThrew, "allowStaking false->true throws CannotLoosenPolicyError");

// 7. lpMinOutBps loosen (decrease) throws
let bpsLoosenThrew = false;
try {
  buildTightenPolicyCall(current, { ...currentLp, lpMinOutBps: 8000 });
} catch (err) {
  bpsLoosenThrew = err instanceof CannotLoosenPolicyError;
}
assert(bpsLoosenThrew, "lpMinOutBps decrease throws CannotLoosenPolicyError");

// 8. Runtime budget: high vault cap no longer bottlenecks the agent.
const agent23Budget = computeLpMintBudget({
  balance0G: "30",
  maxLpExposure0G: "1000000",
  maxPerPosition0G: "1",
  openLpExposure0G: "0",
  perLpActionCap0G: "1000000",
});
assert(agent23Budget.maxAmountWei === parseEther("1"), "runtime budget balance=30 high vault cap maxPerPosition=1 -> maxAmount=1");
assert(agent23Budget.limitingFactor === "agent-max-per-position", "runtime budget limiting factor is agent max per position");

const maxThreeBudget = computeLpMintBudget({
  balance0G: "30",
  maxLpExposure0G: "1000000",
  maxPerPosition0G: "3",
  openLpExposure0G: "0",
  perLpActionCap0G: "1000000",
});
assert(maxThreeBudget.maxAmountWei === parseEther("3"), "runtime budget maxPerPosition=3 with high vault cap -> maxAmount=3");

const lowVaultCeilingBudget = computeLpMintBudget({
  balance0G: "30",
  maxLpExposure0G: "1000000",
  maxPerPosition0G: "3",
  openLpExposure0G: "0",
  perLpActionCap0G: "1",
});
assert(lowVaultCeilingBudget.maxAmountWei === parseEther("1"), "runtime budget low vault ceiling=1 maxPerPosition=3 -> maxAmount=1");
assert(lowVaultCeilingBudget.limitingFactor === "vault-per-action-ceiling", "low vault ceiling wins with explicit limiting factor");

// 9. Deterministic fallback: skip open/failed pools and build a safe active range.
const fallbackFence: LpBrainFence = {
  perLpActionCap0G: "1000000",
  maxLpExposure0G: "1000000",
  openLpExposure0G: "0",
  remainingLpExposure0G: "1000000",
  lpMinOutBps: 9500,
  cooldownSecondsLp: 0,
  minLiquidityFloor: 1n,
  allowStaking: true,
  maxTickWidth: 4000,
  minAprPct: 0,
  maxAprPct: null,
};
const fallbackPools: LpPoolCandidate[] = [
  {
    poolAddress: "0x1111111111111111111111111111111111111111",
    label: "open",
    feeTier: 3000,
    tickSpacing: 60,
    currentTick: -292081,
    w0gIsToken0: true,
    stakingAprPct: 5,
    tvlUSD: 100,
    volume24hUSD: 100,
  },
  {
    poolAddress: "0x2222222222222222222222222222222222222222",
    label: "failed",
    feeTier: 3000,
    tickSpacing: 60,
    currentTick: -90510,
    w0gIsToken0: true,
    stakingAprPct: 50,
    tvlUSD: 1000,
    volume24hUSD: 1000,
  },
  {
    poolAddress: "0x3333333333333333333333333333333333333333",
    label: "fallback",
    feeTier: 3000,
    tickSpacing: 60,
    currentTick: -12345,
    w0gIsToken0: false,
    stakingAprPct: 25,
    tvlUSD: 500,
    volume24hUSD: 500,
  },
];
const fallbackAttempts = buildDeterministicFallbackMintAttempts({
  amount0G: "1",
  failedPoolAddresses: [fallbackPools[1]!.poolAddress],
  fence: fallbackFence,
  maxAttempts: 3,
  openPoolAddresses: [fallbackPools[0]!.poolAddress],
  pools: fallbackPools,
});
assert(fallbackAttempts.length === 1, "fallback builder excludes open and failed pools");
assert(fallbackAttempts[0]!.poolAddress === fallbackPools[2]!.poolAddress, "fallback builder selects remaining pool");
assert(
  fallbackAttempts[0]!.tickLower < fallbackPools[2]!.currentTick
    && fallbackPools[2]!.currentTick < fallbackAttempts[0]!.tickUpper,
  "fallback range strictly contains current tick",
);
assert(
  fallbackAttempts[0]!.tickUpper - fallbackAttempts[0]!.tickLower <= fallbackFence.maxTickWidth,
  "fallback range respects maxTickWidth",
);

// 10. Retry classification: market/runtime slippage retries, hard blockers do not.
assert(isRetryableLpMintError("Price slippage check"), "Price slippage check is retryable");
assert(
  isRetryableLpMintError("Quote swap amount is zero - the tick range is outside the pool's active range."),
  "quote-zero is retryable",
);
assert(!isRetryableLpMintError("Agent is paused; arm it before minting."), "paused agent is non-retryable");
assert(
  !isRetryableLpMintError("ProofRegistry owner does not match DEPLOYER_PRIVATE_KEY; cannot accept this proof"),
  "proof owner mismatch is non-retryable",
);

console.log("\nAll lp-fence smoke checks passed.");
