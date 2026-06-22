import { NextResponse } from "next/server";
import { z } from "zod";
import { buildCopilotPolicyContext, createCopilotAuditBundle } from "@/lib/copilot/audit";
import {
  callOgComputeRouter,
  OgComputeRouterError,
  resolveOgComputeRouterConfig,
} from "@/lib/copilot/router";
import { validateCopilotWalletGate } from "@/lib/copilot/wallet-gate";
import { isOgNetworkId } from "@/lib/og/networks";
import type { CopilotChatResponse, CopilotContextItem, OgNetworkId } from "@/lib/types";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 32_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = toPositiveInteger(process.env.COPILOT_RATE_LIMIT_PER_MINUTE, 12);
const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();

const requestSchema = z.object({
  context: z
    .array(
      z.object({
        kind: z.enum(["audit", "policy", "proof", "quote", "route", "trade"]),
        label: z.string().trim().min(1).max(80),
        value: z.string().trim().min(1).max(240),
      }),
    )
    .max(12)
    .optional(),
  messages: z
    .array(
      z.object({
        content: z.string().trim().min(1).max(4_000),
        role: z.enum(["operator", "assistant"]),
      }),
    )
    .min(1)
    .max(16),
  model: z.string().trim().min(1).max(160).regex(/^[a-zA-Z0-9._:/-]+$/).optional(),
  networkId: z.string().optional(),
  wallet: z
    .object({
      address: z.string().trim().min(1).max(80),
      chainId: z.number().int().positive(),
      message: z.string().trim().min(1).max(600),
      signature: z.string().trim().min(1).max(200),
    })
    .optional(),
});

export async function POST(request: Request) {
  const limited = checkRateLimit(request);
  if (!limited.allowed) {
    return copilotError("rate_limited", "Copilot request rate limit reached.", 429);
  }

  const body = await readJson(request);
  if (body === "body_too_large") {
    return copilotError("request_too_large", "Copilot request body is too large.", 413);
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return copilotError("invalid_request", "Copilot request was not valid.", 400);
  }

  const requestedNetworkId = parseNetworkId(parsed.data.networkId);
  if (parsed.data.networkId && !requestedNetworkId) {
    return copilotError("invalid_network", "Unsupported 0G network.", 400);
  }

  const config = resolveOgComputeRouterConfig(requestedNetworkId);
  if ("error" in config) {
    return copilotError(config.error.code, config.error.message, config.error.status);
  }

  const walletError = await validateCopilotWalletGate(
    parsed.data.wallet,
    requestedNetworkId ?? config.network.id,
    config.network.chainId,
  );
  if (walletError) {
    return copilotError(walletError.code, walletError.message, walletError.status);
  }

  const latestPrompt = [...parsed.data.messages].reverse().find((message) => message.role === "operator")?.content;
  if (!latestPrompt) {
    return copilotError("missing_operator_prompt", "Copilot needs an operator prompt.", 400);
  }

  const policyContext = buildCopilotPolicyContext(config.network);
  const operatorContext = sanitizeCopilotContext(parsed.data.context);

  try {
    const routerResult = await callOgComputeRouter({
      config,
      messages: parsed.data.messages,
      operatorContext: serializeCopilotContext(operatorContext),
      policyContext: JSON.stringify(policyContext),
      selectedModel: parsed.data.model,
    });
    const auditBundle = createCopilotAuditBundle({
      model: routerResult.model,
      network: config.network,
      operatorContext,
      policyContext,
      prompt: latestPrompt,
      response: routerResult.message,
      routerBaseUrl: config.auditBaseUrl,
      trace: routerResult.trace,
    });
    const response: CopilotChatResponse = {
      data: {
        auditBundle,
        message: {
          content: routerResult.message,
          role: "assistant",
        },
      },
      meta: {
        provider: "0g-compute-router",
      },
    };

    return NextResponse.json(response);
  } catch (error) {
    if (error instanceof OgComputeRouterError) {
      return copilotError(error.code, error.message, error.status);
    }

    return copilotError("router_unavailable", "0G Compute Router is unavailable or misconfigured.", 502);
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

function parseNetworkId(value: string | undefined): OgNetworkId | undefined {
  return isOgNetworkId(value) ? value : undefined;
}

function copilotError(code: string, message: string, status: number) {
  const response: CopilotChatResponse = {
    error: {
      code,
      message,
    },
    meta: {
      provider: "0g-compute-router",
    },
  };

  return NextResponse.json(response, { status });
}

function sanitizeCopilotContext(context: CopilotContextItem[] | undefined): CopilotContextItem[] | undefined {
  const sanitized = context
    ?.map((item) => ({
      kind: item.kind,
      label: collapseWhitespace(item.label).slice(0, 80),
      value: collapseWhitespace(item.value).slice(0, 240),
    }))
    .filter((item) => item.label.length > 0 && item.value.length > 0)
    .slice(0, 12);

  return sanitized && sanitized.length > 0 ? sanitized : undefined;
}

function serializeCopilotContext(context: CopilotContextItem[] | undefined): string | undefined {
  return context?.map((item) => `${item.kind}:${item.label}=${item.value}`).join("; ");
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function toPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
