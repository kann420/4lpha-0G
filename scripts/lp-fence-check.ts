// Smoke check for lib/agent/lp/lp-fence.ts. Run with: npx tsx scripts/lp-fence-check.ts
//
// Verifies:
//   1. translateLpFence({maxPositions:3, maxPerPosition0G:'0.5'}) ->
//      perLpActionCap0G=0.5e18, maxLpExposure0G=1.5e18 (exact multiply).
//   2. deriveMaxPositions === 3 (round-trip).
//   3. buildTightenPolicyCall throws cannot_loosen_policy on a loosen attempt.
//   4. buildTightenPolicyCall returns tightened=false when nothing changes.
//   5. deriveMaxPositions is divide-by-zero safe (perLpActionCap0G=0 -> 0).

import { parseEther } from "viem";
import {
  buildTightenPolicyCall,
  CannotLoosenPolicyError,
  deriveMaxPositions,
  translateLpFence,
} from "../lib/agent/lp/lp-fence";
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

console.log("\nAll lp-fence smoke checks passed.");