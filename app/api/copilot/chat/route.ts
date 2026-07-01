import { z } from "zod";
import { buildCmcMarketContext } from "@/lib/cmc/market-context";
import {
  buildCopilotPolicyContext,
  createCopilotAuditBundle,
  type CopilotPolicyContext,
} from "@/lib/copilot/audit";
import {
  buildDeterministicCopilotResponse,
  classifyCopilotIntent,
} from "@/lib/copilot/intent";
import {
  callOgComputeRouter,
  mapRouterStreamTrace,
  OgComputeRouterError,
  resolveOgComputeRouterConfig,
  streamOgComputeRouter,
  type OgComputeRouterConfig,
} from "@/lib/copilot/router";
import { buildCopilotSystemPrompt } from "@/lib/copilot/system-prompt";
import { validateCopilotWalletGate } from "@/lib/copilot/wallet-gate";
import { isOgNetworkId } from "@/lib/og/networks";
import type {
  CopilotAuditBundle,
  CopilotChatStreamEvent,
  CopilotContextItem,
  CopilotMessage,
  CopilotSessionMode,
  OgNetworkId,
} from "@/lib/types";

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
  mode: z.enum(["saved", "privacy"]).optional(),
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
  // Privacy mode: ephemeral. The route is already stateless per-request, so
  // "RAM only, cleared on session close" is satisfied by not returning or
  // persisting an audit bundle. The 0G Compute Router is still called.
  const mode: CopilotSessionMode = parsed.data.mode ?? "saved";

  // Deterministic short-circuit: off-topic prompts and a small set of product
  // FAQs are answered without calling the 0G Compute Router, saving real tokens
  // (the original 4alpha project used the same pattern). The audit bundle records
  // the policy model so saved sessions stay honest about provenance.
  const intent = classifyCopilotIntent(latestPrompt);
  const deterministic = buildDeterministicCopilotResponse(intent, latestPrompt);

  // Market-overview prompts fetch grounded CMC market data (data-layer-only,
  // Hướng B) before streaming, then inject it into the 0G Compute Router system
  // prompt as context. CMC is never the reasoning path — the Router is — so the
  // response stays auditable and anchorable. On any fetch failure the context
  // is null and the framework prompt tells the model to say data is unavailable
  // rather than invent numbers.
  const marketContext =
    intent === "market_analysis" ? await buildCmcMarketContext() : null;

  return streamCopilotResponse({
    config,
    deterministic,
    latestPrompt,
    marketAnalysis: intent === "market_analysis",
    marketContext: marketContext?.context ?? undefined,
    messages: parsed.data.messages,
    mode,
    operatorContext,
    policyContext,
    selectedModel: parsed.data.model,
  });
}

/**
 * Build the Server-Sent Events response for a Copilot chat turn. The route
 * always responds with `text/event-stream` — deterministic short-circuits emit
 * one delta + done, real turns bridge the 0G Compute Router's SSE stream, and
 * errors emit a single error event — so the client has one uniform consumption
 * path. The system prompt (with policy + redacted operator context) is consumed
 * server-side and never streamed to the client; only answer/reasoning deltas
 * and the final audit bundle (saved mode) leave the server.
 */
function streamCopilotResponse({
  config,
  deterministic,
  latestPrompt,
  marketAnalysis,
  marketContext,
  messages,
  mode,
  operatorContext,
  policyContext,
  selectedModel,
}: {
  config: OgComputeRouterConfig;
  deterministic: { content: string; model: string } | null;
  latestPrompt: string;
  marketAnalysis?: boolean;
  marketContext?: string;
  messages: CopilotMessage[];
  mode: CopilotSessionMode;
  operatorContext: CopilotContextItem[] | undefined;
  policyContext: CopilotPolicyContext;
  selectedModel: string | undefined;
}): Response {
  const encoder = new TextEncoder();

  const buildAuditBundle = (
    model: string,
    response: string,
    trace: Parameters<typeof createCopilotAuditBundle>[0]["trace"],
  ): CopilotAuditBundle =>
    createCopilotAuditBundle({
      model,
      network: config.network,
      operatorContext,
      policyContext,
      prompt: latestPrompt,
      response,
      routerBaseUrl: config.auditBaseUrl,
      trace,
    });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Swallow enqueue errors: once the client disconnects, the controller is
      // closed and enqueue would throw — we just stop sending rather than
      // rejecting the stream.
      const send = (event: CopilotChatStreamEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          // controller already closed — ignore.
        }
      };

      // Hoisted stream state so a fallback can finalize a partial answer.
      let content = "";
      let streamedModel = "";
      let trace: Parameters<typeof buildAuditBundle>[2];
      let emittedDeltas = false;

      const finalize = (): boolean => {
        const normalized = normalizeCopilotMessage(content);
        if (!normalized) {
          send({ type: "error", code: "empty_router_response", message: "0G Compute Router returned an empty response." });
          return false;
        }
        send({
          type: "done",
          content: normalized,
          model: streamedModel,
          mode,
          ...(mode === "saved" ? { auditBundle: buildAuditBundle(streamedModel, normalized, trace) } : {}),
        });
        return true;
      };

      const systemPrompt = buildCopilotSystemPrompt({
        network: config.network,
        policyContext,
        operatorContext: serializeCopilotContext(operatorContext),
        marketAnalysis,
        marketContext,
      });

      try {
        if (deterministic) {
          content = deterministic.content;
          streamedModel = deterministic.model;
          send({ type: "delta", content: deterministic.content });
          finalize();
          return;
        }

        // Preferred path: stream the 0G Compute Router response token-by-token.
        // If the Router rejects `stream: true` or the body cannot be read as an
        // SSE stream in this runtime, we fall back to the non-streaming path
        // (which is known to work) so the user still gets an answer.
        try {
          const { response: routerResponse, model } = await streamOgComputeRouter({
            config,
            messages,
            systemPrompt,
            selectedModel,
          });
          streamedModel = model;

          const reader = routerResponse.body!.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let sawDone = false;

          while (!sawDone) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }
            buffer += decoder.decode(value, { stream: true });

            let separator: number;
            while ((separator = buffer.indexOf("\n\n")) !== -1) {
              const rawEvent = buffer.slice(0, separator);
              buffer = buffer.slice(separator + 2);
              const dataStr = rawEvent
                .split("\n")
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).replace(/^\s/, ""))
                .join("");
              if (!dataStr) {
                continue;
              }
              if (dataStr === "[DONE]") {
                sawDone = true;
                break;
              }
              let chunk: {
                choices?: Array<{ delta?: { content?: string; reasoning_content?: string; reasoning?: string } }>;
                model?: string;
                x_0g_trace?: Parameters<typeof mapRouterStreamTrace>[0];
              };
              try {
                chunk = JSON.parse(dataStr);
              } catch {
                continue;
              }
              const delta = chunk?.choices?.[0]?.delta;
              if (delta) {
                if (typeof delta.content === "string" && delta.content) {
                  content += delta.content;
                  emittedDeltas = true;
                  send({ type: "delta", content: delta.content });
                }
                const reasoning = delta.reasoning_content ?? delta.reasoning;
                if (typeof reasoning === "string" && reasoning) {
                  send({ type: "reasoning", content: reasoning });
                }
              }
              if (typeof chunk.model === "string" && chunk.model) {
                streamedModel = chunk.model;
              }
              if (chunk.x_0g_trace) {
                trace = mapRouterStreamTrace(chunk.x_0g_trace);
              }
            }
          }

          finalize();
        } catch (streamError) {
          // OgComputeRouterError means the Router itself rejected the request
          // (auth, model, status) — surface that verbatim, no fallback.
          if (streamError instanceof OgComputeRouterError) {
            throw streamError;
          }
          // Generic streaming failure (stream unsupported, body reader issue,
          // mid-stream reset). Log server-side for diagnosis (no secrets here)
          // and recover gracefully.
          console.error("[copilot/chat] streaming failed:", streamError);

          if (emittedDeltas && content) {
            // Already streamed a partial answer to the client — keep it and
            // finalize with what we have rather than discarding it.
            finalize();
            return;
          }
          // No tokens streamed yet — fall back to the non-streaming path.
          const routerResult = await callOgComputeRouter({
            config,
            messages,
            systemPrompt,
            selectedModel,
          });
          content = routerResult.message;
          streamedModel = routerResult.model;
          trace = routerResult.trace;
          send({ type: "delta", content: routerResult.message });
          finalize();
        }
      } catch (error) {
        if (error instanceof OgComputeRouterError) {
          send({ type: "error", code: error.code, message: error.message });
          return;
        }
        console.error("[copilot/chat] router call failed:", error);
        // A timeout/abort is an upstream transient issue, not a config bug —
        // surface it as such so the user knows to retry rather than reconfigure.
        const isTimeout =
          error instanceof Error &&
          (error.name === "TimeoutError" || error.name === "AbortError" || /timeout|abort/i.test(error.message));
        send({
          type: "error",
          code: isTimeout ? "router_timeout" : "router_unavailable",
          message: isTimeout
            ? "0G Compute Router took too long to respond. Please try again."
            : "0G Compute Router is unavailable or misconfigured.",
        });
      } finally {
        try {
          controller.close();
        } catch {
          // controller already closed — ignore.
        }
      }
    },
  });

  return new Response(stream, { headers: copilotStreamHeaders() });
}

function copilotStreamHeaders(): HeadersInit {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  };
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
  // Errors are emitted as a single SSE error event so the client uses the same
  // consumption path it uses for streaming turns.
  const body = `data: ${JSON.stringify({ type: "error", code, message } satisfies CopilotChatStreamEvent)}\n\n`;
  return new Response(body, { status, headers: copilotStreamHeaders() });
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

/**
 * Strip markdown the 0G Compute Router may emit despite the plain-prose system
 * prompt: header prefixes (###), bold (** / __), leading bullet asterisks (* ),
 * and backtick spans. Numbered steps (1.) and "- " bullets are left intact, and
 * single-asterisk italics are intentionally not stripped to avoid damaging math
 * expressions like "a * b". Keeps the chat UI output clean and scannable.
 */
function normalizeCopilotMessage(content: string): string {
  return content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      let out = line.replace(/^\s{0,3}#{1,6}\s+/, "");
      out = out.replace(/\*\*(.+?)\*\*/g, "$1");
      out = out.replace(/__(.+?)__/g, "$1");
      out = out.replace(/^\s*\*\s+/, "");
      out = out.replace(/`([^`\n]+)`/g, "$1");
      return out;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function toPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}