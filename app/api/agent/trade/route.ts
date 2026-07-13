import { NextResponse } from "next/server";
import { getAddress, isAddress, keccak256, parseUnits, stringToHex, type Address } from "viem";
import { z } from "zod";
import {
  AgentTradeError,
  buildAgentTradePreview,
  executeAgentTrade,
} from "@/lib/agent/trade-service";
import { resolveGalileoTradeRouteBoundary } from "@/lib/galileo/route-boundary";
import { assertGalileoRequestBoundary } from "@/lib/galileo/consent";
import { resolveGalileoTradeReadConfig } from "@/lib/galileo/config";
import { assertGalileoExecutionQuota } from "@/lib/galileo/abuse";
import { GalileoLedgerError } from "@/lib/galileo/ledger";
import { galileoTradePayloadDigest, type GalileoPreparedTrade } from "@/lib/galileo/ledger";
import { GALILEO_AGENT_TRADE_ROUTE } from "@/lib/galileo/trade-route";
import { getOgNetwork, isOgNetworkId } from "@/lib/og/networks";
import type { AgentTradeRequest, AgentTradeResponse, OgNetworkId } from "@/lib/types";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 24_000;

const requestSchema = z.object({
  agentId: z.string().trim().min(1).max(96),
  amountIn: z.string().trim().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/),
  auditId: z.string().trim().min(1).max(96).optional(),
  chainId: z.number().int().positive().optional(),
  intent: z.enum(["preview", "execute"]),
  networkId: z.string().trim().optional(),
  operatorKey: z.string().trim().min(1).max(256).optional(),
  ownerAddress: z.string().trim().optional(),
  routeId: z.string().trim().min(1).max(128),
  side: z.enum(["buy", "sell"]),
  slippageBps: z.number().int().min(1).max(500),
  vaultAddress: z.string().trim().optional(),
});

// This schema is deliberately separate from the legacy/mainnet request shape.
// Galileo cannot be admitted to a generic/stub executor by a permissive parse.
const galileoRequestSchema = z.object({
  agentId: z.string().trim().min(1).max(96),
  amountIn: z.string().trim().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/),
  auditId: z.string().trim().min(1).max(96).optional(),
  chainId: z.literal(16602),
  clientRequestId: z.string().trim().regex(/^[A-Za-z0-9_-]{8,96}$/u).optional(),
  galileoConsent: z.object({
    nonce: z.string().regex(/^[a-f0-9]{64}$/iu),
    prepareId: z.string().uuid(),
    wallet: z.object({ address: z.string().regex(/^0x[0-9a-fA-F]{40}$/u), chainId: z.literal(16602), message: z.string().min(1).max(4096), signature: z.string().regex(/^0x[0-9a-fA-F]+$/u) }),
  }).optional(),
  intent: z.enum(["preview", "execute"]),
  networkId: z.literal("testnet"),
  ownerAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/u),
  routeId: z.string().trim().min(1).max(128),
  side: z.enum(["buy", "sell"]),
  slippageBps: z.number().int().min(1).max(100),
  vaultAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/u),
}).strict();

export async function POST(request: Request) {
  const body = await readJson(request);
  if (body === "body_too_large") {
    return tradeError("request_too_large", "Trade request body is too large.", 413);
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return tradeError("invalid_request", "Trade request was not valid.", 400);
  }

  const networkId = parseNetworkId(parsed.data.networkId);
  if (!networkId) {
    return tradeError("invalid_network", "Unsupported 0G network.", 400);
  }

  // Galileo must never reach the generic preview/stub executor. Validate its
  // explicit chain tuple before any route lookup, signer, or mainnet module.
  if (networkId === "testnet") {
    const boundary = resolveGalileoTradeRouteBoundary({
      networkId: parsed.data.networkId,
      chainId: parsed.data.chainId,
    });
    if (!boundary.ok && boundary.status === 400) {
      return tradeError(boundary.code, boundary.message, boundary.status, networkId);
    }

    const galileo = galileoRequestSchema.safeParse(body);
    if (!galileo.success) return tradeError("invalid_galileo_request", "Galileo trade request was not valid.", 400, networkId);
    try {
      assertGalileoRequestBoundary(request, galileo.data);
      const readConfig = resolveGalileoTradeReadConfig();
      const { previewGalileoTrade } = await import("@/lib/galileo/executor");
      const amountIn = parseUnits(galileo.data.amountIn, galileo.data.side === "buy" ? 18 : 6);
      const owner = getAddress(galileo.data.ownerAddress);
      const vault = getAddress(galileo.data.vaultAddress);
      const initialPreview = await previewGalileoTrade({ agentRef: galileo.data.agentId, amountIn, clientRequestId: galileo.data.clientRequestId ?? `preview-${galileo.data.agentId}`, owner, side: galileo.data.side, userMinOut: 1n, vault }, readConfig);
      const calculatedUserMinOut = initialPreview.quote * BigInt(10_000 - galileo.data.slippageBps) / 10_000n;
      const userMinOut = calculatedUserMinOut > 0n ? calculatedUserMinOut : 1n;
      const preview = { ...initialPreview, amountOutMin: initialPreview.vaultMinOut > userMinOut ? initialPreview.vaultMinOut : userMinOut, userMinOut };
      const wirePreview = galileoPreview(preview, galileo.data, owner, vault, readConfig.addresses.adapter);
      if (galileo.data.intent === "preview") return NextResponse.json(galileoTradeResponse({ preview: wirePreview as never }), { headers: { "Cache-Control": "no-store" } });
      if (!galileo.data.galileoConsent || !galileo.data.clientRequestId) return tradeError("galileo_consent_required", "A current Galileo action consent and client request ID are required.", 401, networkId);
      assertGalileoExecutionQuota(request, owner);
      const boundary = resolveGalileoTradeRouteBoundary({ networkId: galileo.data.networkId, chainId: galileo.data.chainId });
      if (!boundary.ok) return tradeError(boundary.code, boundary.message, boundary.status, networkId);
      const { executeGalileoTrade } = await import("@/lib/galileo/executor");
      const execution = await executeGalileoTrade({ agentRef: galileo.data.agentId, amountIn, clientRequestId: galileo.data.clientRequestId, owner, side: galileo.data.side, userMinOut, vault }, galileo.data.galileoConsent, boundary.config, preview);
      return NextResponse.json(galileoTradeResponse({ execution: galileoExecution(execution) as never, preview: wirePreview as never }), { status: 202, headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      if (error instanceof GalileoLedgerError || (error instanceof Error && "code" in error)) {
        const coded = error as GalileoLedgerError & { code?: string; status?: number };
        return tradeError(coded.code ?? "galileo_unavailable", coded.message, coded.status ?? 503, networkId);
      }
      return tradeError("galileo_unavailable", "Galileo trade path is unavailable.", 503, networkId);
    }
  }

  const tradeRequest: AgentTradeRequest = {
    agentId: parsed.data.agentId,
    amountIn: parsed.data.amountIn,
    auditId: parsed.data.auditId,
    intent: parsed.data.intent,
    networkId,
    ownerAddress: parseAddress(parsed.data.ownerAddress),
    routeId: parsed.data.routeId,
    side: parsed.data.side,
    slippageBps: parsed.data.slippageBps,
    vaultAddress: networkId === "mainnet" ? undefined : parseAddress(parsed.data.vaultAddress),
  };

  try {
    if (tradeRequest.intent === "preview") {
      const preview = await buildAgentTradePreview(tradeRequest);
      return NextResponse.json(agentTradeResponse(networkId, { preview }));
    }

    if (networkId === "mainnet" && !isAuthorizedOperator(parsed.data.operatorKey)) {
      return tradeError("unauthorized", "Operator trade key is required for live mainnet execution.", 401, networkId);
    }

    const { execution, preview } = await executeAgentTrade(tradeRequest);
    const status = execution.status === "blocked" ? 409 : 202;
    return NextResponse.json(agentTradeResponse(networkId, { execution, preview }), { status });
  } catch (error) {
    if (error instanceof AgentTradeError) {
      return tradeError(error.code, error.message, error.status, networkId);
    }

    return tradeError("executor_unavailable", "Agent executor route is unavailable.", 502, networkId);
  }
}

function galileoPreview(preview: import("@/lib/galileo/executor").GalileoTradePreview, request: z.infer<typeof galileoRequestSchema>, owner: Address, vault: Address, adapter: Address) {
  const quoteExpiry = Math.floor(Date.now() / 1000) + 60;
  const poolId = keccak256(stringToHex("4LPHA_GALILEO_0G_MUSDC_V1"));
  const tradeBase: Omit<GalileoPreparedTrade, "payloadDigest"> | undefined = preview.agentKey ? {
    adapter, agentKey: preview.agentKey, agentRef: request.agentId, amountIn: request.side === "buy" ? parseUnits(request.amountIn, 18).toString() : parseUnits(request.amountIn, 6).toString(), chainId: 16602, clientRequestId: request.clientRequestId ?? `preview-${request.agentId}`, minOut: preview.amountOutMin.toString(), networkId: "testnet", policyHash: preview.policyHash, poolId, quoteBlock: preview.pool.quoteBlock.toString(), quoteExpiry, reserveNative: preview.pool.nativeReserve.toString(), reserveToken: preview.pool.tokenReserve.toString(), side: request.side, trustedQuote: preview.quote.toString(), vault,
  } : undefined;
  const trade = tradeBase ? { ...tradeBase, payloadDigest: galileoTradePayloadDigest(owner, tradeBase) } : undefined;
  return {
    galileo: {
      adapter, agentKey: preview.agentKey, agentKeyEnabled: preview.state.agentKeyEnabled, agentRef: request.agentId, amountOutMin: preview.amountOutMin.toString(), consentRequest: trade ? { action: "trade", chainId: 16602, clientRequestId: trade.clientRequestId, networkId: "testnet", owner, trade } : undefined, cooldownReady: !preview.blockedReason?.includes("cooldown"), dailyCapRemaining: (preview.policy.dailyCap0G - preview.dailySpent0G).toString(), decisionReason: preview.blockedReason, executorRevoked: preview.state.executorRevoked, feeBps: preview.feeBps, poolId, policyHash: preview.policyHash, poolNativeReserve: preview.pool.nativeReserve.toString(), poolTokenReserve: preview.pool.tokenReserve.toString(), priceImpactBps: preview.priceImpactBps.toString(), quoteBlock: preview.pool.quoteBlock.toString(), sellableInventory: preview.sellableInventory.toString(), storageAvailable: true, trustedQuote: preview.quote.toString(), userMinOut: preview.userMinOut.toString(), vault, vaultBalance: preview.vaultBalance.toString(), vaultMinOut: preview.vaultMinOut.toString(), vaultPaused: preview.state.paused,
    },
    proofBundle: { policyDecision: preview.decision, storageRoot: "pending", proofTxHash: undefined },
    quote: { amountIn: request.amountIn, amountOut: preview.quote.toString(), routeHash: preview.policyHash, quoteHash: preview.policyHash },
    route: { ...GALILEO_AGENT_TRADE_ROUTE, agentId: request.agentId, id: request.routeId, inputToken: request.side === "buy" ? "0G" : "mUSDC", outputToken: request.side === "buy" ? "mUSDC" : "0G", readiness: preview.decision === "allow" ? "ready" : "blocked" }, vaultAddress: vault,
  };
}

function galileoExecution(execution: import("@/lib/galileo/executor").GalileoTradeExecution) {
  return { id: execution.actionHash, status: "submitted", galileo: { proofTxHash: execution.proofTxHash, storageRef: execution.storageRef, storageRoot: execution.storageRoot, tradeTxHash: execution.tradeTxHash }, proofBundle: { policyDecision: "allow", proofTxHash: execution.proofTxHash, storageRoot: execution.storageRoot } };
}

function galileoTradeResponse(data: NonNullable<AgentTradeResponse["data"]>): AgentTradeResponse {
  return { ...agentTradeResponse("testnet", data), meta: { ...agentTradeResponse("testnet", data).meta!, backend: "wired" } };
}

function isAuthorizedOperator(value: string | undefined): boolean {
  const expected = process.env.AGENT_TRADE_OPERATOR_KEY?.trim();
  return Boolean(expected && value === expected);
}

function parseAddress(value: string | undefined): Address | undefined {
  return value && isAddress(value) ? getAddress(value) : undefined;
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
  return isOgNetworkId(value) ? value : undefined;
}

function agentTradeResponse(
  networkId: OgNetworkId,
  data: NonNullable<AgentTradeResponse["data"]>,
): AgentTradeResponse {
  const network = getOgNetwork(networkId);
  return {
    data,
    meta: {
      backend: networkId === "mainnet" ? "wired" : "unavailable",
      network: {
        chainId: network.chainId,
        id: network.id,
        label: network.networkName,
      },
      provider: "4lpha-agent-executor",
    },
  };
}

function tradeError(code: string, message: string, status: number, networkId?: OgNetworkId) {
  const response: AgentTradeResponse = {
    error: {
      code,
      message,
    },
    meta: networkId
      ? {
          backend: networkId === "mainnet" ? "wired" : "unavailable",
          network: {
            chainId: getOgNetwork(networkId).chainId,
            id: networkId,
            label: getOgNetwork(networkId).networkName,
          },
          provider: "4lpha-agent-executor",
        }
      : undefined,
  };

  return NextResponse.json(response, { status });
}
