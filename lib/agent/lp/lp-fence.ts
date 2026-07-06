import { parseEther } from "viem";

import type { PolicyVaultV3LpPolicy, PolicyVaultV3Policy } from "@/lib/contracts/policy-vault-v3";

// Max-positions translation for the LP Agent — NO contract change.
//
// The deployed `PolicyVaultV3.LpPolicy` has exactly 7 fields
// (perLpActionCap0G, lpDailyCap0G, maxLpExposure0G, cooldownSecondsLp,
// lpMinOutBps, minLiquidityFloor, allowStaking). There is NO on-chain position
// count cap. The UI exposes "Max positions" + "Max per position (0G)"; this
// module translates those into the existing caps so the vault still only sees
// the shipping 7 fields, and `floor(maxLpExposure0G / perLpActionCap0G)` rounds
// back to the requested N.
//
// HONESTY (codex audit #10): this is "effective max positions (exposure-
// bounded)", NOT a strict on-chain count. A compromised executor could open
// many small NFTs summing under `maxLpExposure0G`; the on-chain guarantee is
// that TOTAL 0G deployed cannot exceed `maxLpExposure0G`, not that the NFT
// COUNT cannot exceed N. The UI must label this as "effective max positions".

const WEI_PER_0G = 10n ** 18n;

export interface LpFenceInput {
  maxPositions: number; // UI "Max positions" — integer 1..10
  maxPerPosition0G: string; // UI "Max per position (0G)" — decimal string, <= 18 fractional digits
}

export interface LpFenceLpPolicy {
  perLpActionCap0G: bigint;
  lpDailyCap0G: bigint;
  maxLpExposure0G: bigint;
  cooldownSecondsLp: bigint;
  lpMinOutBps: number;
  minLiquidityFloor: bigint;
  allowStaking: boolean;
}

export class CannotLoosenPolicyError extends Error {
  readonly field: string;
  readonly current: string;
  readonly requested: string;
  constructor(field: string, current: bigint | number | boolean, requested: bigint | number | boolean) {
    super(
      `cannot_loosen_policy: field ${field} would loosen (current=${current.toString()} requested=${requested.toString()}); admin may only tighten`,
    );
    this.name = "CannotLoosenPolicyError";
    this.field = field;
    this.current = current.toString();
    this.requested = requested.toString();
  }
}

/// Translate the UI fence (maxPositions × maxPerPosition0G) into the 7 shipping
/// `LpPolicy` fields. The `current` policy is supplied so we can carry forward
/// the non-translated fields (cooldown, bps, floor, allowStaking) unchanged and
/// clamp `lpDailyCap0G` down to the new total exposure when a full rebalance day
/// would otherwise exceed it.
///
/// Throws if the UI inputs are invalid (maxPositions not int 1..10, per-position
/// non-positive, etc.). Does NOT compare to `current` for tightening — that is
/// `buildTightenPolicyCall`'s job. This function only computes the requested
/// shape.
export function translateLpFence(input: LpFenceInput, current: PolicyVaultV3LpPolicy): LpFenceLpPolicy {
  if (!Number.isInteger(input.maxPositions) || input.maxPositions < 1 || input.maxPositions > 10) {
    throw new Error(`translateLpFence: maxPositions must be an integer 1..10, got ${input.maxPositions}`);
  }
  if (!/^\d+(\.\d{1,18})?$/u.test(input.maxPerPosition0G.trim())) {
    throw new Error(`translateLpFence: maxPerPosition0G must be a positive decimal with <= 18 fractional digits`);
  }

  const perLpActionCap0G = parseEther(input.maxPerPosition0G.trim());
  if (perLpActionCap0G <= 0n) {
    throw new Error("translateLpFence: maxPerPosition0G must be > 0");
  }

  // Exact multiply so floor(maxLpExposure0G / perLpActionCap0G) === maxPositions.
  const maxLpExposure0G = perLpActionCap0G * BigInt(input.maxPositions);
  if (maxLpExposure0G < perLpActionCap0G) {
    throw new Error("translateLpFence: maxLpExposure0G overflow");
  }

  // A full rebalance day cannot exceed total exposure — clamp the daily cap down
  // to the new total exposure if the existing daily cap is now too generous.
  // The vault enforces daily + total independently; tightening here keeps the UI
  // promise that "max N positions × P 0G" bounds the day as well.
  const lpDailyCap0G = current.lpDailyCap0G > maxLpExposure0G ? maxLpExposure0G : current.lpDailyCap0G;

  return {
    perLpActionCap0G,
    lpDailyCap0G,
    maxLpExposure0G,
    cooldownSecondsLp: current.cooldownSecondsLp,
    lpMinOutBps: current.lpMinOutBps,
    minLiquidityFloor: current.minLiquidityFloor,
    allowStaking: current.allowStaking,
  };
}

/// Derive the display "effective max positions" from the on-chain caps.
/// `floor(maxLpExposure0G / perLpActionCap0G)`, guarded against divide-by-zero.
/// Returns 0 when perLpActionCap0G is 0 (the vault would reject any mint in
/// that state anyway).
export function deriveMaxPositions(lp: { perLpActionCap0G: bigint; maxLpExposure0G: bigint }): number {
  if (lp.perLpActionCap0G <= 0n) return 0;
  return Number(lp.maxLpExposure0G / lp.perLpActionCap0G);
}

/// Build the `nextPolicy` tuple for `tightenPolicy` from the current on-chain
/// policy + the UI-translated LP fence. Swap fields are carried forward
/// unchanged (the LP fence does not touch them).
///
/// Tightening rules (vault on-chain `tightenPolicy` is the backstop; this throws
/// BEFORE the route spends gas simulating):
///   - numeric caps: `next = min(current, ui)`
///   - `lpMinOutBps`: only increase
///   - `cooldownSecondsLp`: only increase
///   - `allowStaking`: only `true -> false` (tighten)
///   - swap-path fields: unchanged
///
/// Returns `tightened=false` when no field actually decreased, so the deploy
/// route can skip the on-chain `tightenPolicy` call and save gas.
export function buildTightenPolicyCall(
  current: PolicyVaultV3Policy,
  uiFenceLp: LpFenceLpPolicy,
): { nextPolicy: PolicyVaultV3Policy; tightened: boolean } {
  // Per-field min(current, ui). Throw on any loosen attempt.
  const perLpActionCap0G = tightenBig(current.lp.perLpActionCap0G, uiFenceLp.perLpActionCap0G, "lp.perLpActionCap0G");
  const lpDailyCap0G = tightenBig(current.lp.lpDailyCap0G, uiFenceLp.lpDailyCap0G, "lp.lpDailyCap0G");
  const maxLpExposure0G = tightenBig(current.lp.maxLpExposure0G, uiFenceLp.maxLpExposure0G, "lp.maxLpExposure0G");
  const cooldownSecondsLp = tightenBig(current.lp.cooldownSecondsLp, uiFenceLp.cooldownSecondsLp, "lp.cooldownSecondsLp");
  const lpMinOutBps = tightenNumber(current.lp.lpMinOutBps, uiFenceLp.lpMinOutBps, "lp.lpMinOutBps");
  const minLiquidityFloor = tightenBig(current.lp.minLiquidityFloor, uiFenceLp.minLiquidityFloor, "lp.minLiquidityFloor");
  const allowStaking = tightenBoolean(current.lp.allowStaking, uiFenceLp.allowStaking, "lp.allowStaking");

  const nextPolicy: PolicyVaultV3Policy = {
    perTradeCap0G: current.perTradeCap0G,
    dailyCap0G: current.dailyCap0G,
    maxExposure0G: current.maxExposure0G,
    cooldownSeconds: current.cooldownSeconds,
    maxDeadlineWindowSeconds: current.maxDeadlineWindowSeconds,
    defaultMinOutBps: current.defaultMinOutBps,
    lp: {
      perLpActionCap0G,
      lpDailyCap0G,
      maxLpExposure0G,
      cooldownSecondsLp,
      lpMinOutBps,
      minLiquidityFloor,
      allowStaking,
    },
  };

  const tightened =
    perLpActionCap0G < current.lp.perLpActionCap0G ||
    lpDailyCap0G < current.lp.lpDailyCap0G ||
    maxLpExposure0G < current.lp.maxLpExposure0G ||
    cooldownSecondsLp > current.lp.cooldownSecondsLp ||
    lpMinOutBps > current.lp.lpMinOutBps ||
    minLiquidityFloor > current.lp.minLiquidityFloor ||
    (!allowStaking && current.lp.allowStaking);

  return { nextPolicy, tightened };
}

function tightenBig(current: bigint, requested: bigint, label: string): bigint {
  if (requested > current) {
    throw new CannotLoosenPolicyError(label, current, requested);
  }
  return requested;
}

function tightenNumber(current: number, requested: number, label: string): number {
  if (requested < current) {
    throw new CannotLoosenPolicyError(label, current, requested);
  }
  return requested;
}

function tightenBoolean(current: boolean, requested: boolean, label: string): boolean {
  // allowStaking: only true -> false is a tighten. false -> true is a loosen.
  if (!current && requested) {
    throw new CannotLoosenPolicyError(label, current, requested);
  }
  return requested;
}

export { WEI_PER_0G };