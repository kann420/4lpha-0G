import "server-only";

// Single source of truth for the 0G mainnet LP gate. Both the executor
// (lib/executor/policy-vault-lp.ts) and the LP API routes (app/api/agents/lp/*)
// call this so they cannot drift. The vault is mainnet-only (chain ID 16661);
// mock adapters are forbidden on mainnet; live trading needs an extra flag.
//
// `deploy` does NOT require AGENT_TRADE_LIVE_ENABLED (you can mint AgenticID +
// tightenPolicy + deposit without arming live trades). `execute` does, because
// it actually broadcasts a vault LP action that spends real 0G.

export const LP_MAINNET_CHAIN_ID = 16661;

export type LpEnvGateOk = { ok: true };
export type LpEnvGateErr = {
  ok: false;
  code:
    | "network_not_mainnet"
    | "chain_id_mismatch"
    | "mainnet_deploy_disabled"
    | "real_adapter_disabled"
    | "mock_adapter_enabled"
    | "mock_lp_adapter_enabled"
    | "live_trading_disabled";
  message: string;
};
export type LpEnvGateResult = LpEnvGateOk | LpEnvGateErr;

type Mode = "deploy" | "execute";

export function requireLpMainnetEnv(mode: Mode): LpEnvGateResult {
  const network = (process.env.OG_NETWORK ?? "").toLowerCase();
  if (network !== "mainnet") {
    return {
      ok: false,
      code: "network_not_mainnet",
      message: "LP Agent requires OG_NETWORK=mainnet (currently " + (network || "unset") + ").",
    };
  }

  const chainIdRaw = process.env.OG_CHAIN_ID?.trim();
  const chainId = chainIdRaw === undefined ? NaN : Number(chainIdRaw);
  if (!Number.isFinite(chainId) || chainId !== LP_MAINNET_CHAIN_ID) {
    return {
      ok: false,
      code: "chain_id_mismatch",
      message: `LP Agent requires OG_CHAIN_ID=${LP_MAINNET_CHAIN_ID} (currently ${chainIdRaw || "unset"}). Set OG_CHAIN_ID=${LP_MAINNET_CHAIN_ID} in .env.local.`,
    };
  }

  const flagChecks: Array<{ name: string; expected: boolean; code: LpEnvGateErr["code"] }> = [
    { name: "ENABLE_MAINNET_DEPLOY", expected: true, code: "mainnet_deploy_disabled" },
    { name: "ENABLE_REAL_DEX_ADAPTER", expected: true, code: "real_adapter_disabled" },
    { name: "ENABLE_MOCK_DEX_ADAPTER", expected: false, code: "mock_adapter_enabled" },
    { name: "MAINNET_ALLOW_MOCK_LP_ADAPTER", expected: false, code: "mock_lp_adapter_enabled" },
  ];
  for (const { name, expected, code } of flagChecks) {
    const actual = (process.env[name] ?? "false").toLowerCase() === "true";
    if (actual !== expected) {
      return { ok: false, code, message: `${name} must be ${String(expected)} (currently ${String(actual)}).` };
    }
  }

  if (mode === "execute") {
    const live = (process.env.AGENT_TRADE_LIVE_ENABLED ?? "false").toLowerCase() === "true";
    if (!live) {
      return {
        ok: false,
        code: "live_trading_disabled",
        message: "Live LP execution requires AGENT_TRADE_LIVE_ENABLED=true (currently false).",
      };
    }
  }

  return { ok: true };
}

/** Throw on failure — preserves the executor's existing throw-based control flow. */
export function assertLpMainnetEnv(mode: Mode): void {
  const result = requireLpMainnetEnv(mode);
  if (!result.ok) {
    throw new Error(result.message);
  }
}