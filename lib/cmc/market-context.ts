import "server-only";

import { callCmcTool, CmcMcpError } from "@/lib/cmc/mcp-client";

/**
 * Fetch and normalize a compact market snapshot from the CoinMarketCap MCP
 * `get_global_metrics_latest` tool, for injection into the 0G Compute Router
 * system prompt as grounded context for the Market Decision Framework.
 *
 * Design notes:
 * - DATA LAYER ONLY (Hướng B). This module produces a redacted, compact context
 *   string; it never generates prose or a final answer. The 0G Compute Router
 *   is the sole reasoning path.
 * - Graceful degradation: any fetch/parse/timeout failure returns
 *   `{ context: null, source }`. The chat route still calls the Router — the
 *   framework prompt instructs the model to say market data is unavailable and
 *   reason without inventing numbers.
 * - The raw CMC payload is never logged, returned to the client, or stored in
 *   the audit bundle (AGENTS.md: only redacted/minimal data, never raw provider
 *   payloads). `source` is a short redacted label for provenance.
 */

export interface CmcMarketContext {
  /** Compact multi-line market snapshot, or null when unavailable. */
  context: string | null;
  /** Redacted provenance label (no key, no raw payload). */
  source: string;
}

// The CMC MCP global-metrics payload is deep and loosely typed; read it
// defensively. Every field is optional.
function path(obj: unknown, ...keys: Array<string | number>): unknown {
  let cur: unknown = obj;
  for (const key of keys) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[String(key)];
  }
  return cur;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined;
}

// CMC returns percentages as signed strings like "+57.62%" or "-0.20763%".
// Trim a leading "+" and round numeric percentages to 2 decimals when the
// string looks like a number followed by "%".
function pct(value: unknown): string | undefined {
  const raw = str(value);
  if (!raw) return undefined;
  const match = raw.match(/^([+-]?\d+(?:\.\d+)?)%$/);
  if (!match) return raw.replace(/^\+/, "");
  const num = Number(match[1]);
  if (!Number.isFinite(num)) return raw.replace(/^\+/, "");
  return `${num >= 0 ? "" : ""}${num.toFixed(2)}%`;
}

// Money/size values come as strings like "2.05 T", "395.19 B", "80.29 B".
// Pass them through, stripping a leading "+" where present.
function money(value: unknown): string | undefined {
  const raw = str(value);
  if (!raw) return undefined;
  return raw.replace(/^\+/, "").trim();
}

export async function buildCmcMarketContext(): Promise<CmcMarketContext> {
  const source = "CoinMarketCap MCP (get_global_metrics_latest)";

  let payload: unknown;
  try {
    payload = await callCmcTool("get_global_metrics_latest", {});
  } catch (error) {
    // Not configured, timeout, HTTP error, or RPC error — degrade gracefully.
    if (!(error instanceof CmcMcpError) || error.code !== "cmc_not_configured") {
      console.error("[copilot/market-context] CMC fetch failed:", error);
    }
    return { context: null, source };
  }
  if (!payload || typeof payload !== "object") {
    return { context: null, source };
  }

  const lines: string[] = [];

  const updated = str(path(payload, "last_updated"));
  lines.push(`CMC market snapshot${updated ? ` (${updated})` : ""}:`);

  // Market size
  const mcap = path(payload, "market_size", "total_crypto_market_cap_usd");
  const mcapCurrent = money(path(mcap, "current"));
  const mcap24h = pct(path(mcap, "percent_change", "24h"));
  const mcap7d = pct(path(mcap, "percent_change", "7d"));
  const mcap30d = pct(path(mcap, "percent_change", "30d"));
  const mcapMax = money(path(mcap, "yearly", "max", "value"));
  const mcapMin = money(path(mcap, "yearly", "min", "value"));
  if (mcapCurrent) {
    const trend = [mcap24h && `24h ${mcap24h}`, mcap7d && `7d ${mcap7d}`, mcap30d && `30d ${mcap30d}`]
      .filter(Boolean)
      .join(" | ");
    const range = mcapMin && mcapMax ? ` | 1y ${mcapMin}–${mcapMax}` : "";
    lines.push(`- Total market cap: ${mcapCurrent}${trend ? ` | ${trend}` : ""}${range}`);
  }

  // Liquidity
  const liq = path(payload, "liquidity", "volume24h");
  const volTotal = money(path(liq, "total", "current"));
  const volSpot = money(path(liq, "spot", "current"));
  const volDeriv = money(path(liq, "derivatives", "total", "current"));
  if (volTotal || volSpot || volDeriv) {
    const parts = [
      volTotal && `total ${volTotal}`,
      volSpot && `spot ${volSpot}`,
      volDeriv && `derivatives ${volDeriv}`,
    ].filter(Boolean);
    lines.push(`- 24h volume: ${parts.join(" | ")}`);
  }

  // Dominance
  const dom = path(payload, "dominance");
  const btcDom = str(path(dom, "btc", "current"))?.replace(/^\+/, "");
  const btc1d = str(path(dom, "btc", "history", "yesterday"))?.replace(/^\+/, "");
  const btc1w = str(path(dom, "btc", "history", "last_week"))?.replace(/^\+/, "");
  const btc1mo = str(path(dom, "btc", "history", "last_month"))?.replace(/^\+/, "");
  const ethDom = str(path(dom, "eth", "current"))?.replace(/^\+/, "");
  const othersDom = str(path(dom, "others", "current"))?.replace(/^\+/, "");
  if (btcDom) {
    const hist = [btc1d && `1d ${btc1d}`, btc1w && `1w ${btc1w}`, btc1mo && `1mo ${btc1mo}`].filter(Boolean).join(", ");
    lines.push(`- BTC dominance: ${btcDom}${hist ? ` (${hist})` : ""}`);
  }
  if (ethDom || othersDom) {
    const parts = [ethDom && `ETH ${ethDom}`, othersDom && `Others ${othersDom}`].filter(Boolean);
    lines.push(`- ${parts.join(" | ")}`);
  }

  // Sentiment
  const fg = path(payload, "sentiment", "fear_greed");
  const fgVal = str(path(fg, "current", "value"));
  const fgIdx = path(fg, "current", "index");
  const fg1d = path(fg, "history", "yesterday", "index");
  const fg1w = path(fg, "history", "last_week", "index");
  const fg1mo = path(fg, "history", "last_month", "index");
  const fgMax = path(fg, "yearly", "max", "index");
  const fgMin = path(fg, "yearly", "min", "index");
  const fgCurrent = fgVal ? `${fgIdx} ${fgVal}` : str(fgIdx);
  if (fgCurrent) {
    const hist = [fg1d != null && `1d ${fg1d}`, fg1w != null && `1w ${fg1w}`, fg1mo != null && `1mo ${fg1mo}`]
      .filter(Boolean)
      .join(", ");
    const range = fgMin != null && fgMax != null ? ` | 1y ${fgMin}–${fgMax}` : "";
    lines.push(`- Fear & Greed: ${fgCurrent}${hist ? ` (${hist})` : ""}${range}`);
  }

  // Rotation / altcoin season
  const as = path(payload, "rotation", "altcoin_season");
  const asIdx = path(as, "current", "index");
  const as24h = pct(path(as, "percent_change", "24h"));
  const as1d = path(as, "history", "yesterday", "index");
  const as1w = path(as, "history", "last_week", "index");
  const as1mo = path(as, "history", "last_month", "index");
  const asMax = path(as, "yearly", "max", "index");
  const asMin = path(as, "yearly", "min", "index");
  if (asIdx != null) {
    const hist = [as1d != null && `1d ${as1d}`, as1w != null && `1w ${as1w}`, as1mo != null && `1mo ${as1mo}`]
      .filter(Boolean)
      .join(", ");
    const range = asMin != null && asMax != null ? ` | 1y ${asMin}–${asMax}` : "";
    lines.push(
      `- Altcoin Season: ${asIdx}${as24h ? ` (24h ${as24h})` : ""}${hist ? ` | ${hist}` : ""}${range}`,
    );
  }

  // Leverage
  const lev = path(payload, "leverage");
  const oiTotal = money(path(lev, "open_interest", "total", "current"));
  const oi24h = pct(path(lev, "open_interest", "total", "percent_change", "24h"));
  const oiPerps = money(path(lev, "open_interest", "perpetuals", "current"));
  if (oiTotal) {
    const parts = [oi24h && `24h ${oi24h}`, oiPerps && `perps ${oiPerps}`].filter(Boolean);
    lines.push(`- Open interest: ${oiTotal}${parts.length ? ` (${parts.join(", ")})` : ""}`);
  }
  const fundAvg = str(path(lev, "funding_rate", "average", "current"));
  const fund24h = pct(path(lev, "funding_rate", "average", "percent_change", "24h"));
  const fundSpread = str(path(lev, "funding_rate", "top_alts_minus_btc_spread_current"));
  if (fundAvg) {
    const parts = [fund24h && `24h ${fund24h}`, fundSpread && `top-alts−BTC spread ${fundSpread}`].filter(Boolean);
    lines.push(`- Funding (avg): ${fundAvg}${parts.length ? ` (${parts.join(", ")})` : ""}`);
  }
  const liqBtc = path(lev, "liquidations", "btc");
  const liq24h = money(path(liqBtc, "total_usd24h"));
  const liq24hChg = pct(path(liqBtc, "percent_change24h"));
  const liq7d = money(path(liqBtc, "total_usd7d"));
  const liq30d = money(path(liqBtc, "total_usd30d"));
  if (liq24h) {
    lines.push(
      `- BTC liquidations: 24h ${liq24h}${liq24hChg ? ` (${liq24hChg})` : ""}${liq7d ? ` | 7d ${liq7d}` : ""}${liq30d ? ` | 30d ${liq30d}` : ""}`,
    );
  }

  // TradFi ETF flows
  const etf = path(payload, "trad_fi_flows", "etf_aum");
  const etfBtc = money(path(etf, "btc", "current"));
  const etfBtc1w = money(path(etf, "btc", "history", "last_week"));
  const etfBtc1mo = money(path(etf, "btc", "history", "last_month"));
  const etfEth = money(path(etf, "eth", "current"));
  if (etfBtc) {
    const hist = [etfBtc1w && `1w ${etfBtc1w}`, etfBtc1mo && `1mo ${etfBtc1mo}`].filter(Boolean).join(", ");
    lines.push(`- ETF AUM: BTC ${etfBtc}${hist ? ` (${hist})` : ""}${etfEth ? ` | ETH ${etfEth}` : ""}`);
  }

  const context = lines.filter(Boolean).join("\n");
  return { context: context || null, source };
}