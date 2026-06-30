import { NextResponse } from "next/server";
import { getAddress, isAddress, type Address } from "viem";
import { z } from "zod";
import {
  AgentTradeError,
  buildAgentTradePreview,
  executeAgentTrade,
} from "@/lib/agent/trade-service";
import { getOgNetwork, isOgNetworkId } from "@/lib/og/networks";
import type { AgentTradeRequest, AgentTradeResponse, OgNetworkId } from "@/lib/types";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 24_000;

const requestSchema = z.object({
  agentId: z.string().trim().min(1).max(96),
  amountIn: z.string().trim().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/),
  auditId: z.string().trim().min(1).max(96).optional(),
  intent: z.enum(["preview", "execute"]),
  networkId: z.string().trim().optional(),
  operatorKey: z.string().trim().min(1).max(256).optional(),
  ownerAddress: z.string().trim().optional(),
  routeId: z.string().trim().min(1).max(128),
  side: z.enum(["buy", "sell"]),
  slippageBps: z.number().int().min(1).max(500),
  vaultAddress: z.string().trim().optional(),
});

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
      backend: networkId === "mainnet" ? "wired" : "stub",
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
          backend: networkId === "mainnet" ? "wired" : "stub",
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
