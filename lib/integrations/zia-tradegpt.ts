import "server-only";

import { getAddress, isAddress, type Address } from "viem";
import { z } from "zod";

// Zia / TradeGPT partner API client — server-only.
//
// Wraps pool discovery, token metadata, and swap-route planning on 0G mainnet
// (chainId 16661). The real partner-only base URL lives in
// ZIA_TRADEGPT_API_BASE_URL (.env.local / deployment secrets). Never expose it
// through NEXT_PUBLIC_*, client bundles, logs, or docs. The partner endpoint
// currently needs no auth key, but may enforce an IP allowlist (operator task).
//
// All upstream responses are zod-validated before use. Errors are sanitized so
// the host, path, query, and any Authorization header never reach the client.

const ZIA_CHAIN_ID = 16661;
const DEFAULT_TIMEOUT_MS = 10_000;
const RETRY_429_DELAY_MS = 250;

export class ZiaApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface ZiaBaseUrlConfig {
  baseUrl: string;
  timeoutMs: number;
}

export type ZiaBaseUrlResult = ZiaBaseUrlConfig | { error: ZiaApiError };

/// Resolve and validate the partner base URL. Refuses non-HTTPS, empty host,
/// localhost, and userinfo-bearing URLs. Strips the search/hash before any
/// logging so the full request URL is never materialized in error text.
export function resolveZiaBaseUrl(): ZiaBaseUrlResult {
  const raw = (process.env.ZIA_TRADEGPT_API_BASE_URL ?? "").trim();
  if (!raw) {
    return {
      error: new ZiaApiError(
        "Zia partner API is not configured (ZIA_TRADEGPT_API_BASE_URL unset).",
        "partner_api_unconfigured",
      ),
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { error: new ZiaApiError("ZIA_TRADEGPT_API_BASE_URL is not a valid URL.", "invalid_base_url") };
  }

  if (parsed.protocol !== "https:") {
    return { error: new ZiaApiError("ZIA_TRADEGPT_API_BASE_URL must use HTTPS.", "invalid_base_url") };
  }
  if (!parsed.hostname) {
    return { error: new ZiaApiError("ZIA_TRADEGPT_API_BASE_URL has no hostname.", "invalid_base_url") };
  }
  if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1") {
    return { error: new ZiaApiError("ZIA_TRADEGPT_API_BASE_URL must not point at localhost.", "invalid_base_url") };
  }
  if (parsed.username || parsed.password) {
    return { error: new ZiaApiError("ZIA_TRADEGPT_API_BASE_URL must not carry credentials.", "invalid_base_url") };
  }

  // Normalize: base URL is origin + pathname without a trailing slash; the search
  // string is never retained so partner query params do not leak via toString().
  const baseUrl = `${parsed.origin}${parsed.pathname.replace(/\/$/, "")}`;
  const timeoutMs = readPositiveInt("ZIA_TRADEGPT_API_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
  return { baseUrl, timeoutMs };
}

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const addressSchema = z
  .string()
  .transform((v) => getAddress(v))
  .refine((v) => isAddress(v), { message: "invalid address" });

const aprSchema = z
  .object({
    total: z.number().nullable().optional(),
    trading: z.number().nullable().optional(),
    staking: z.number().nullable().optional(),
  })
  .passthrough();

const metricsSchema = z
  .object({
    tvlUSD: z.number().nullable().catch(null),
    volume24h: z.number().nullable().catch(null),
    volume30d: z.number().nullable().catch(null),
    liquidity: z.number().nullable().catch(null),
    token0Amount: z.string().nullable().catch(null),
    token1Amount: z.string().nullable().catch(null),
  })
  .passthrough();

const tokenLegSchema = z
  .object({
    symbol: z.string().min(1),
    address: addressSchema,
    decimals: z.number().int().nonnegative().catch(18),
    priceUSD: z.number().nullable().catch(null),
  })
  .passthrough();

export const ziaPoolSchema = z
  .object({
    id: z.string().min(1).catch("unknown"),
    name: z.string().min(1).catch("unknown"),
    poolAddress: addressSchema,
    npmAddress: addressSchema.nullable().catch(null),
    chainId: z.literal(ZIA_CHAIN_ID),
    feeTier: z.number().int().nonnegative(),
    isActive: z.boolean().catch(true),
    token0: tokenLegSchema,
    token1: tokenLegSchema,
    metrics: metricsSchema,
    apr: aprSchema,
  })
  .passthrough();

export const ziaTokenSchema = z
  .object({
    address: addressSchema,
    decimals: z.number().int().nonnegative().catch(18),
    symbol: z.string().min(1),
    name: z.string().nullable().catch(null),
    slug: z.string().nullable().catch(null),
    chainId: z.literal(ZIA_CHAIN_ID),
    aliases: z.array(z.string()).catch([]),
    logoUrl: z.string().nullable().catch(null),
    isNative: z.boolean().catch(false),
    price: z.number().nullable().catch(null),
    priceChange24h: z.number().nullable().catch(null),
  })
  .passthrough();

const routeRequestSchema = z
  .object({
    inTokenAddress: addressSchema,
    outTokenAddress: addressSchema,
    amount: z.string().regex(/^\d+(\.\d+)?$/),
    amountTokenSide: z.enum(["INPUT", "OUTPUT"]),
    recipient: addressSchema,
    slippageTolerance: z.number().min(0).max(1).optional(),
    chainId: z.literal(ZIA_CHAIN_ID),
  })
  .strict();

export const ziaRouteSchema = z.preprocess(
  (value) => {
    if (!value || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    return {
      ...record,
      inToken: record.inToken ?? record.inTokenAddress ?? null,
      outToken: record.outToken ?? record.outTokenAddress ?? null,
    };
  },
  z
    .object({
      chainId: z.literal(ZIA_CHAIN_ID),
      inToken: addressSchema.nullable().catch(null),
      outToken: addressSchema.nullable().catch(null),
      amount: z.string().nullable().catch(null),
      amountTokenSide: z.string().nullable().catch(null),
      amountIn: z.string().nullable().catch(null),
      amountOut: z.string().nullable().catch(null),
      amountOutMin: z.string().nullable().catch(null),
      expectedOutAmount: z.string().nullable().catch(null),
      slippageTolerance: z.number().nullable().catch(null),
      isMultiHop: z.boolean().nullable().catch(null),
      encodedPath: z.string().nullable().catch(null),
      intermediateTokens: z.array(addressSchema).catch([]),
      fee: z.number().nullable().catch(null),
      fees: z.array(z.any()).catch([]),
      priceImpact: z.number().nullable().catch(null),
      routingSource: z.string().nullable().catch(null),
      fallbackReason: z.string().nullable().catch(null),
    })
    .passthrough(),
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ZiaPool = z.infer<typeof ziaPoolSchema>;
export type ZiaToken = z.infer<typeof ziaTokenSchema>;
export type ZiaRoute = z.infer<typeof ziaRouteSchema>;
export type ZiaRouteRequest = z.infer<typeof routeRequestSchema>;

// ---------------------------------------------------------------------------
// Fetch + sanitize
// ---------------------------------------------------------------------------

function sanitizeForClient(message: string): string {
  // Strip anything that looks like a URL, path, query, or key so the partner
  // host / request path / Authorization never reach the browser. Conservative:
  // also redacts anything after "Authorization:".
  return message
    .replace(/https?:\/\/[^\s"']+/g, "[url]")
    .replace(/\/[a-z0-9\-_/{}.:]+/gi, (m) => (m.startsWith("/api") || m.includes("?") ? "[path]" : m))
    .replace(/[?&][^\s"']+/g, "[query]")
    .replace(/Authorization:[^\s,]+/gi, "Authorization:[redacted]")
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, "[key]")
    .replace(/mk-[A-Za-z0-9_-]{6,}/g, "[key]");
}

function ziaError(message: string, code: string, status?: number): ZiaApiError {
  return new ZiaApiError(sanitizeForClient(message), code, status);
}

function chainIdQuery(): string {
  return `chainId=${ZIA_CHAIN_ID}`;
}

async function ziaFetch(pathAndQuery: string, init?: RequestInit): Promise<unknown> {
  const base = resolveZiaBaseUrl();
  if ("error" in base) throw base.error;

  const url = `${base.baseUrl}${pathAndQuery}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), base.timeoutMs);

  const doFetch = (attempt: number): Promise<Response> =>
    fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
    }).then(async (res) => {
      if (res.status === 429 && attempt === 0) {
        // Single short retry on rate-limit, then surface a sanitized error.
        await new Promise((r) => setTimeout(r, RETRY_429_DELAY_MS));
        return doFetch(1);
      }
      return res;
    });

  try {
    const res = await doFetch(0);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw ziaError(`Zia API responded ${res.status}. ${body.slice(0, 200)}`, "zia_api_status", res.status);
    }
    return await res.json();
  } catch (err) {
    if (err instanceof ZiaApiError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw ziaError("Zia API request timed out.", "zia_api_timeout");
    }
    throw ziaError(`Zia API request failed: ${(err as Error).message}`, "zia_api_network");
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export async function listZiaPools(): Promise<ZiaPool[]> {
  const data = await ziaFetch(`/pools?${chainIdQuery()}`);
  const arr = Array.isArray(data) ? data : (data as { pools?: unknown[] }).pools;
  if (!Array.isArray(arr)) throw ziaError("Zia /pools response was not an array.", "invalid_zia_response", 502);
  const parsed = z.array(ziaPoolSchema).safeParse(arr);
  if (!parsed.success) throw ziaError("Zia /pools response failed validation.", "invalid_zia_response", 502);
  return parsed.data;
}

export async function getZiaPool(poolAddress: Address): Promise<ZiaPool> {
  const addr = getAddress(poolAddress);
  const data = await ziaFetch(`/pools/${addr}?${chainIdQuery()}`);
  const parsed = ziaPoolSchema.safeParse(data);
  if (!parsed.success) throw ziaError("Zia /pools/{address} response failed validation.", "invalid_zia_response", 502);
  return parsed.data;
}

export async function getZiaToken(query: { symbol?: string; address?: Address }): Promise<ZiaToken> {
  if (!query.symbol && !query.address) {
    throw ziaError("getZiaToken requires either symbol or address.", "invalid_argument");
  }
  const qs = query.address
    ? `address=${getAddress(query.address)}&${chainIdQuery()}`
    : `symbol=${encodeURIComponent(query.symbol!)}&${chainIdQuery()}`;
  const data = await ziaFetch(`/token?${qs}`);
  const parsed = ziaTokenSchema.safeParse(data);
  if (!parsed.success) throw ziaError("Zia /token response failed validation.", "invalid_zia_response", 502);
  return parsed.data;
}

// Token logos are static enough to cache far longer than pool metadata (price,
// APR). Cached per address so N positions sharing a pool/token only pay for one
// /token fetch per cache window.
const TOKEN_LOGO_CACHE_TTL_MS = 15 * 60 * 1000;
const tokenLogoCache = new Map<string, { url: string | null; expiresAt: number }>();

/// Best-effort logo lookup for LP position pair icons. Returns null (never
/// throws) when the Zia /token fetch fails OR logoUrl is missing/relative — some
/// native/wrapped tokens (e.g. W0G) return a bare relative path like
/// "tokens/0g.png" with no documented host. Passing a relative path through, or
/// naively resolving it against ZIA_TRADEGPT_API_BASE_URL, would leak the
/// partner API's secret host to the browser; callers must fall back to a local
/// icon instead. Only absolute http(s) URLs (the common case — trustwallet,
/// coinstats, oklink CDNs observed in practice) are returned.
export async function getZiaTokenLogoUrl(address: Address): Promise<string | null> {
  const key = address.toLowerCase();
  const now = Date.now();
  const cached = tokenLogoCache.get(key);
  if (cached && cached.expiresAt > now) return cached.url;
  let url: string | null = null;
  try {
    const token = await getZiaToken({ address });
    url = token.logoUrl && /^https:\/\//i.test(token.logoUrl) ? token.logoUrl : null;
  } catch {
    url = null;
  }
  tokenLogoCache.set(key, { url, expiresAt: now + TOKEN_LOGO_CACHE_TTL_MS });
  return url;
}

export async function planZiaRoute(input: {
  inToken: Address;
  outToken: Address;
  amount: string;
  recipient: Address;
  slippageTolerance?: number;
}): Promise<ZiaRoute> {
  if (input.recipient && getAddress(input.recipient) === "0x0000000000000000000000000000000000000000") {
    throw ziaError("Route recipient must not be the zero address.", "invalid_argument");
  }
  const body = routeRequestSchema.parse({
    inTokenAddress: getAddress(input.inToken),
    outTokenAddress: getAddress(input.outToken),
    amount: input.amount,
    amountTokenSide: "INPUT",
    recipient: getAddress(input.recipient),
    // Internal callers pass bps to match the vault policy; the partner API
    // validates slippageTolerance as a decimal fraction in [0, 1].
    slippageTolerance: input.slippageTolerance === undefined ? undefined : input.slippageTolerance / 10_000,
    chainId: ZIA_CHAIN_ID,
  });
  const data = await ziaFetch("/route", { method: "POST", body: JSON.stringify(body) });
  const parsed = ziaRouteSchema.safeParse(data);
  if (!parsed.success) throw ziaError("Zia /route response failed validation.", "invalid_zia_response", 502);
  return parsed.data;
}
