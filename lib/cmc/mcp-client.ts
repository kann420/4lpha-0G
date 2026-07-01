import "server-only";

/**
 * Minimal stateless client for the CoinMarketCap MCP HTTP endpoint.
 *
 * The CMC MCP server (https://mcp.coinmarketcap.com/mcp) is effectively
 * stateless: a single `tools/call` JSON-RPC POST returns the full tool result
 * without an initialize/handshake or session id. That lets the Copilot chat
 * route fetch real market data server-side with one short round-trip and reuse
 * the exact same `CMC_API_KEY` already wired for the Claude Code MCP server —
 * no second key, no REST credential, no browser exposure.
 *
 * This is a DATA LAYER integration only (Hướng B): CMC provides grounded market
 * context that is injected into the 0G Compute Router system prompt. The 0G
 * Compute Router remains the sole reasoning/LLM path, so the response stays
 * auditable and anchorable. CMC never produces the final answer.
 *
 * Secrets: `CMC_API_KEY` is read from the server environment only and sent as
 * the `X-CMC-MCP-API-KEY` header. It is never logged, returned to the client,
 * or persisted in audit bundles.
 */

const DEFAULT_CMC_MCP_BASE_URL = "https://mcp.coinmarketcap.com/mcp";
const CMC_MCP_TIMEOUT_MS = 8_000;

export class CmcMcpError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

/** True when a CMC API key is present in the server environment. */
export function isCmcConfigured(): boolean {
  return Boolean(process.env.CMC_API_KEY?.trim());
}

function resolveCmcEndpoint(): { apiKey: string; baseUrl: string } | { error: CmcMcpError } {
  const apiKey = process.env.CMC_API_KEY?.trim();
  if (!apiKey) {
    return { error: new CmcMcpError("CMC_API_KEY is not configured.", "cmc_not_configured") };
  }

  const baseUrl = (process.env.CMC_MCP_BASE_URL?.trim() || DEFAULT_CMC_MCP_BASE_URL).replace(/\/+$/, "");
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:") {
      return { error: new CmcMcpError("CMC MCP base URL must use HTTPS.", "cmc_base_url_rejected") };
    }
    // Reject obvious internal/loopback targets even if an operator misconfigures
    // CMC_MCP_BASE_URL, so the server never smuggles a request to an internal host.
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host === "0.0.0.0" || /^169\.254\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^127\./.test(host)) {
      return { error: new CmcMcpError("CMC MCP base URL must be a public host.", "cmc_base_url_rejected") };
    }
  } catch {
    return { error: new CmcMcpError("CMC MCP base URL is not a valid URL.", "cmc_base_url_rejected") };
  }

  return { apiKey, baseUrl };
}

/**
 * Call a CMC MCP tool by name with the given arguments and return the parsed
 * JSON payload (the server returns `{result:{content:[{type:"text",text:"<json>"}]}}`).
 * Returns null when CMC is not configured, the tool returned no text, or the
 * text is not valid JSON — callers treat null as "no market context available"
 * and the Copilot still answers via the 0G Compute Router.
 *
 * Throws `CmcMcpError` on non-2xx HTTP, JSON-RPC error, timeout, or fetch
 * failure; callers catch and degrade gracefully.
 */
export async function callCmcTool<T = unknown>(
  toolName: string,
  args: Record<string, unknown> = {},
): Promise<T | null> {
  const endpoint = resolveCmcEndpoint();
  if ("error" in endpoint) {
    throw endpoint.error;
  }

  let response: Response;
  try {
    response = await fetch(endpoint.baseUrl, {
      method: "POST",
      headers: {
        "X-CMC-MCP-API-KEY": endpoint.apiKey,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: toolName, arguments: args },
      }),
      signal: AbortSignal.timeout(CMC_MCP_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new CmcMcpError(`CMC MCP ${toolName} timed out.`, "cmc_mcp_timeout");
    }
    throw new CmcMcpError(`CMC MCP ${toolName} fetch failed.`, "cmc_mcp_unavailable");
  }

  if (!response.ok) {
    throw new CmcMcpError(`CMC MCP ${toolName} returned HTTP ${response.status}.`, "cmc_mcp_http");
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new CmcMcpError(`CMC MCP ${toolName} returned a non-JSON body.`, "cmc_mcp_invalid");
  }

  const rpcError = (body as { error?: { message?: string } })?.error;
  if (rpcError) {
    throw new CmcMcpError(
      `CMC MCP ${toolName} error: ${rpcError.message ?? "unknown"}.`,
      "cmc_mcp_rpc",
    );
  }

  const text = (body as { result?: { content?: Array<{ type?: string; text?: string }> } })?.result?.content?.[0]?.text;
  if (typeof text !== "string" || !text) {
    return null;
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}