import { NextResponse } from "next/server";
import { z } from "zod";
import { DEFAULT_OG_NETWORK_ID, getOgNetwork, isOgNetworkId } from "@/lib/og/networks";
import { AiScanError, runAiScan } from "@/lib/trading/ai-scan";
import { enhanceAiScanReportWithLlm, listAiScanModels } from "@/lib/trading/ai-scan-research";
import { OgComputeRouterError } from "@/lib/copilot/router";
import type { AiScanMode, AiScanModelCatalogResponse, AiScanResponse, AiScanTargetType } from "@/lib/types/ai-scan";
import type { OgNetworkId } from "@/lib/types";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 16_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = toPositiveInteger(process.env.AI_SCAN_RATE_LIMIT_PER_MINUTE, 20);
const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();

const requestSchema = z.object({
  address: z.string().trim().regex(/^0x[a-fA-F0-9]{40}$/u),
  model: z.string().trim().min(1).max(160).regex(/^[a-zA-Z0-9._:/-]+$/u).optional(),
  mode: z.enum(["risk", "honeypot", "research", "wallet-risk", "approvals", "behavior"]),
  networkId: z.string().trim().optional(),
  targetType: z.enum(["token", "wallet"]),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const networkId = parseNetworkId(url.searchParams.get("networkId") ?? undefined);
  if (!networkId) {
    return modelError("invalid_network", "Unsupported 0G network.", 400);
  }

  try {
    const catalog = await listAiScanModels(networkId);
    const network = getOgNetwork(networkId);
    const response: AiScanModelCatalogResponse = {
      data: {
        defaultModel: catalog.defaultModel,
        models: catalog.models,
      },
      meta: {
        network: {
          chainId: network.chainId,
          id: network.id,
          label: network.networkName,
        },
        provider: "0g-compute-router",
      },
    };

    return NextResponse.json(response);
  } catch (error) {
    if (error instanceof OgComputeRouterError) {
      return modelError(error.code, error.message, error.status, networkId);
    }

    return modelError("model_catalog_unavailable", "AI Scan model catalog is unavailable.", 502, networkId);
  }
}

export async function POST(request: Request) {
  const limited = checkRateLimit(request);
  if (!limited.allowed) {
    return scanError("rate_limited", "AI Scan rate limit reached.", 429);
  }

  const body = await readJson(request);
  if (body === "body_too_large") {
    return scanError("request_too_large", "AI Scan request body is too large.", 413);
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return scanError("invalid_request", "AI Scan request was not valid.", 400);
  }

  const networkId = parseNetworkId(parsed.data.networkId);
  if (!networkId) {
    return scanError("invalid_network", "Unsupported 0G network.", 400);
  }

  try {
    const { report, rpcSource } = await runAiScan({
      address: parsed.data.address,
      model: parsed.data.model,
      mode: parsed.data.mode as AiScanMode,
      networkId,
      targetType: parsed.data.targetType as AiScanTargetType,
    });
    const enhanced = await enhanceAiScanReportWithLlm({
      model: parsed.data.model,
      networkId,
      report,
    });
    const network = getOgNetwork(networkId);
    const response: AiScanResponse = {
      data: {
        report: enhanced.report,
      },
      meta: {
        network: {
          chainId: network.chainId,
          id: network.id,
          label: network.networkName,
        },
        provider: "4lpha-ai-scan",
        rpcSource,
      },
    };

    return NextResponse.json(response);
  } catch (error) {
    if (error instanceof AiScanError || error instanceof OgComputeRouterError) {
      return scanError(error.code, error.message, error.status, networkId);
    }

    return scanError("scan_unavailable", "AI Scan backend is unavailable.", 502, networkId);
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

function parseNetworkId(value: string | undefined): OgNetworkId | undefined {
  if (value === undefined || value === "") {
    return DEFAULT_OG_NETWORK_ID;
  }
  return isOgNetworkId(value) ? value : undefined;
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

function scanError(code: string, message: string, status: number, networkId?: OgNetworkId) {
  const network = networkId ? getOgNetwork(networkId) : undefined;
  const response: AiScanResponse = {
    error: {
      code,
      message,
    },
    meta: network
      ? {
          network: {
            chainId: network.chainId,
            id: network.id,
            label: network.networkName,
          },
          provider: "4lpha-ai-scan",
        }
      : undefined,
  };

  return NextResponse.json(response, { status });
}

function modelError(code: string, message: string, status: number, networkId?: OgNetworkId) {
  const network = networkId ? getOgNetwork(networkId) : undefined;
  const response: AiScanModelCatalogResponse = {
    error: {
      code,
      message,
    },
    meta: network
      ? {
          network: {
            chainId: network.chainId,
            id: network.id,
            label: network.networkName,
          },
          provider: "0g-compute-router",
        }
      : undefined,
  };

  return NextResponse.json(response, { status });
}

function toPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
