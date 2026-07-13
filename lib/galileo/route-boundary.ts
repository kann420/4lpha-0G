import "server-only";

import {
  GALILEO_CHAIN_ID,
  GALILEO_NETWORK_ID,
  assertGalileoRoute,
  resolveGalileoWriteConfig,
  type GalileoWriteConfig,
} from "@/lib/galileo/config";

export type GalileoTradeRouteBoundary =
  | { ok: true; mode: "execute"; config: GalileoWriteConfig }
  | { ok: false; mode: "preview_only" | "unavailable"; status: 400 | 503; code: string; message: string };

/**
 * Fail-closed boundary for POST /api/agent/trade. It deliberately validates
 * the caller's explicit network tuple before reading any configuration or
 * resolving a signer, so testnet-shaped requests cannot fall into mainnet.
 */
export function resolveGalileoTradeRouteBoundary(input: {
  networkId: unknown;
  chainId: unknown;
}, env: Readonly<Record<string, string | undefined>> = process.env): GalileoTradeRouteBoundary {
  try {
    assertGalileoRoute(input.networkId, input.chainId);
  } catch {
    return {
      ok: false,
      mode: "unavailable",
      status: 400,
      code: "invalid_galileo_network",
      message: `Galileo trades require networkId=${GALILEO_NETWORK_ID} and chainId=${GALILEO_CHAIN_ID}.`,
    };
  }

  let config: GalileoWriteConfig;
  try {
    config = resolveGalileoWriteConfig(env);
  } catch {
    // Do not leak which secret, endpoint, or deployment address is absent.
    return {
      ok: false,
      mode: "unavailable",
      status: 503,
      code: "galileo_trade_unavailable",
      message: "Galileo trade execution is not configured.",
    };
  }

  if (!config.tradeEnabled) {
    return {
      ok: false,
      mode: "preview_only",
      status: 503,
      code: "galileo_trade_disabled",
      message: "Galileo trade execution is disabled; preview only.",
    };
  }

  return { ok: true, mode: "execute", config };
}
