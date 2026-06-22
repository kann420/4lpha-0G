import { NextResponse } from "next/server";
import { z } from "zod";
import { OG_NETWORKS } from "@/lib/og/networks";
import {
  TradeRouteQuoteError,
  parseRouteQuoteAddress,
  parseRouteQuoteHex32,
  quoteCuratedMainnetRoutes,
} from "@/lib/trading/curated-route-quotes";
import type { AgentTradeRouteQuoteResponse, TradeRouteDirection, TradeRouteVenue } from "@/lib/types";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 16_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = toPositiveInteger(process.env.TRADE_ROUTE_QUOTE_RATE_LIMIT_PER_MINUTE, 30);
const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();

const requestSchema = z
  .object({
    amountIn: z.string().trim().min(1).max(80).optional(),
    amountInRaw: z.string().trim().regex(/^\d+$/).max(120).optional(),
    direction: z.enum(["buy", "sell"]).default("buy"),
    includeAlternates: z.boolean().optional(),
    networkId: z.literal("mainnet").optional(),
    routeId: z.string().trim().optional(),
    slippageBps: z.number().int().min(0).max(1_000).optional(),
    symbol: z.string().trim().min(1).max(32).optional(),
    tokenOut: z.string().trim().optional(),
    venue: z.enum(["ZIA", "Oku"]).optional(),
  })
  .refine((value) => value.amountIn !== undefined || value.amountInRaw !== undefined, {
    message: "amountIn or amountInRaw is required",
  })
  .refine((value) => value.routeId !== undefined || value.tokenOut !== undefined || value.symbol !== undefined, {
    message: "routeId, tokenOut, or symbol is required",
  });

export async function POST(request: Request) {
  const limited = checkRateLimit(request);
  if (!limited.allowed) {
    return tradeRouteError("rate_limited", "Trade route quote rate limit reached.", 429);
  }

  const body = await readJson(request);
  if (body === "body_too_large") {
    return tradeRouteError("request_too_large", "Trade route quote request body is too large.", 413);
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return tradeRouteError("invalid_request", "Trade route quote request was not valid.", 400);
  }

  const routeId = parseRouteQuoteHex32(parsed.data.routeId);
  if (parsed.data.routeId && routeId === undefined) {
    return tradeRouteError("invalid_route_id", "Trade route id must be a bytes32 hex value.", 400);
  }

  const tokenOut = parseRouteQuoteAddress(parsed.data.tokenOut);
  if (parsed.data.tokenOut && tokenOut === undefined) {
    return tradeRouteError("invalid_token_out", "Token out must be a valid EVM address.", 400);
  }

  try {
    const selection = await quoteCuratedMainnetRoutes({
      amountInDecimal: parsed.data.amountIn,
      amountInRaw: parsed.data.amountInRaw === undefined ? undefined : BigInt(parsed.data.amountInRaw),
      direction: parsed.data.direction as TradeRouteDirection,
      includeAlternates: parsed.data.includeAlternates,
      routeId,
      slippageBps: parsed.data.slippageBps,
      symbol: parsed.data.symbol,
      tokenOut,
      venue: parsed.data.venue as TradeRouteVenue | undefined,
    });
    const response: AgentTradeRouteQuoteResponse = {
      data: {
        alternates: selection.alternates,
        execution: {
          submitsTransaction: false,
          type: "quote-only",
        },
        network: {
          blockNumber: selection.blockNumber.toString(),
          chainId: 16661,
          id: "mainnet",
          label: OG_NETWORKS.mainnet.networkName,
        },
        request: selection.request,
        selectedQuote: selection.selectedQuote,
      },
      meta: {
        provider: "0g-mainnet-curated-routes",
        rpcSource: selection.rpcSource,
      },
    };

    return NextResponse.json(response);
  } catch (error) {
    if (error instanceof TradeRouteQuoteError) {
      return tradeRouteError(error.code, error.message, error.status);
    }

    return tradeRouteError("quote_unavailable", "Trade route quote is unavailable.", 502);
  }
}

async function readJson(request: Request): Promise<unknown | "body_too_large"> {
  const contentLength = Number.parseInt(request.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return "body_too_large";
  }

  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
      return "body_too_large";
    }
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function checkRateLimit(request: Request): { allowed: boolean } {
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const key = forwardedFor || request.headers.get("x-real-ip") || "local";
  const now = Date.now();
  const bucket = rateLimitBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { allowed: true };
  }
  if (bucket.count >= RATE_LIMIT_MAX) {
    return { allowed: false };
  }
  bucket.count += 1;
  return { allowed: true };
}

function tradeRouteError(code: string, message: string, status: number) {
  const response: AgentTradeRouteQuoteResponse = {
    error: {
      code,
      message,
    },
    meta: {
      provider: "0g-mainnet-curated-routes",
      rpcSource: "official-0g-mainnet-rpc",
    },
  };

  return NextResponse.json(response, { status });
}

function toPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
