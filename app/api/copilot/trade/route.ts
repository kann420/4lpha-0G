import { NextResponse } from "next/server";
import { createPublicClient, formatUnits, getAddress, http, isAddress, type Address } from "viem";
import { z } from "zod";
import { canAgentUseTradeRoute, getAgentTradeRoute } from "@/lib/agent/trade-catalog";
import { agentKeyForDeployment, loadOgAgentWorkspace } from "@/lib/agent/single-agent-server";
import {
  AgentTradeError,
  buildAgentTradePreview,
  executeAgentTrade,
} from "@/lib/agent/trade-service";
import { validateCopilotWalletGate } from "@/lib/copilot/wallet-gate";
import { policyVaultAbi, policyVaultAgentKeyAbi } from "@/lib/contracts/policy-vault";
import { getOgNetwork, isOgNetworkId } from "@/lib/og/networks";
import type { AgentTradeRequest, AgentTradeResponse, OgNetworkId } from "@/lib/types";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 24_000;

const walletSchema = z.object({
  address: z.string().trim().min(1).max(80),
  chainId: z.number().int().positive(),
  message: z.string().trim().min(1).max(600),
  signature: z.string().trim().min(1).max(200),
});

const erc20DecimalsAbi = [
  {
    inputs: [],
    name: "decimals",
    outputs: [{ internalType: "uint8", name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const tradeRequestSchema = z.object({
  agentId: z.string().trim().min(1).max(96),
  amountIn: z.string().trim().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/).optional(),
  auditId: z.string().trim().min(1).max(96).optional(),
  networkId: z.string().trim(),
  routeId: z.string().trim().min(1).max(128),
  side: z.enum(["buy", "sell"]),
  sellPercent: z.number().min(0.0001).max(100).optional(),
  slippageBps: z.number().int().min(1).max(500),
});

const requestSchema = z.object({
  intent: z.enum(["preview", "execute"]),
  request: tradeRequestSchema,
  wallet: walletSchema.optional(),
});

export async function POST(request: Request) {
  const body = await readJson(request);
  if (body === "body_too_large") {
    return tradeError("request_too_large", "Copilot trade request body is too large.", 413);
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return tradeError("invalid_request", "Copilot trade request was not valid.", 400);
  }

  const networkId = parseNetworkId(parsed.data.request.networkId);
  if (!networkId) {
    return tradeError("invalid_network", "Unsupported 0G network.", 400);
  }

  const network = getOgNetwork(networkId);
  const walletError = await validateCopilotWalletGate(parsed.data.wallet, networkId, network.chainId);
  if (walletError) {
    return tradeError(walletError.code, walletError.message, walletError.status, networkId);
  }
  if (!parsed.data.wallet) {
    return tradeError("wallet_required", "Connect a wallet before using 0G Copilot trade commands.", 401, networkId);
  }

  const ownerAddress = parseWalletAddress(parsed.data.wallet.address);
  if (!ownerAddress) {
    return tradeError("invalid_wallet", "Connected wallet address is not valid.", 400, networkId);
  }

  const ownerError = await validateVaultOwnerAccess(ownerAddress, networkId);
  if (ownerError) {
    return tradeError(ownerError.code, ownerError.message, ownerError.status, networkId);
  }

  try {
    const tradeRequest = await resolveTradeRequestAmount(parsed.data.request, parsed.data.intent, networkId, ownerAddress);

    if (parsed.data.intent === "preview") {
      const preview = await buildAgentTradePreview(tradeRequest);
      return NextResponse.json(agentTradeResponse(networkId, { preview }));
    }

    const { execution, preview } = await executeAgentTrade(tradeRequest);
    const status = execution.status === "blocked" ? 409 : 202;
    return NextResponse.json(agentTradeResponse(networkId, { execution, preview }), { status });
  } catch (error) {
    if (error instanceof AgentTradeError) {
      return tradeError(error.code, error.message, error.status, networkId);
    }

    return tradeError("executor_unavailable", "Copilot trade route is unavailable.", 502, networkId);
  }
}

async function resolveTradeRequestAmount(
  request: z.infer<typeof tradeRequestSchema>,
  intent: "preview" | "execute",
  networkId: OgNetworkId,
  ownerAddress: Address,
): Promise<AgentTradeRequest> {
  if (request.amountIn) {
    return {
      agentId: request.agentId,
      amountIn: request.amountIn,
      auditId: request.auditId,
      intent,
      networkId,
      ownerAddress,
      routeId: request.routeId,
      side: request.side,
      slippageBps: request.slippageBps,
    };
  }

  if (request.sellPercent === undefined) {
    throw new AgentTradeError("Trade amount is required.", "invalid_amount", 400);
  }

  if (request.side !== "sell") {
    throw new AgentTradeError("Percentage sizing is only supported for sell commands.", "invalid_amount", 400);
  }

  const route = getAgentTradeRoute(request.routeId);
  if (!route || route.networkId !== networkId || !canAgentUseTradeRoute(route, request.agentId)) {
    throw new AgentTradeError("Selected route is not in the server allowlist.", "route_not_allowed", 404);
  }

  const amountIn = await resolveSellPercentAmount(
    networkId,
    ownerAddress,
    request.agentId,
    request.sellPercent,
    route.tokenAddress,
    route.defaultAmountIn,
  );
  if (amountIn === "0") {
    throw new AgentTradeError("The Policy Vault does not hold a sellable balance for that token.", "empty_position", 409);
  }

  return {
    agentId: request.agentId,
    amountIn,
    auditId: request.auditId,
    intent,
    networkId,
    ownerAddress,
    routeId: request.routeId,
    side: "sell",
    slippageBps: request.slippageBps,
  };
}

async function resolveSellPercentAmount(
  networkId: OgNetworkId,
  ownerAddress: Address,
  agentId: string,
  percent: number,
  tokenAddress: Address | undefined,
  fallbackAmount: string,
): Promise<string> {
  const numerator = BigInt(Math.round(Math.max(0, Math.min(100, percent)) * 10_000));
  if (numerator <= 0n) {
    return "0";
  }

  if (networkId !== "mainnet") {
    return scaleDecimalAmount(fallbackAmount, percent);
  }

  if (!tokenAddress) {
    throw new AgentTradeError("Selected route does not expose a token address for percentage sell.", "route_not_allowed", 409);
  }

  const workspace = await loadOgAgentWorkspace({ agentId, ownerAddress });
  const vault = workspace.vault.vault;
  if (!vault) {
    throw new AgentTradeError("Policy Vault address is required for percentage sell.", "vault_not_ready", 409);
  }
  const deployment = workspace.agent.deployment;
  if (!deployment) {
    throw new AgentTradeError("Agentic ID deployment is required for percentage sell.", "agent_not_ready", 409);
  }

  const network = getOgNetwork(networkId);
  const publicClient = createPublicClient({ transport: http(network.rpcUrl) });
  const [units, decimals] = await Promise.all([
    (workspace.vault.vaultVersion ?? 1) >= 2
      ? publicClient.readContract({
          address: vault,
          abi: policyVaultAgentKeyAbi,
          functionName: "agentPositionUnits",
          args: [deployment.agentKey ?? agentKeyForDeployment(deployment), tokenAddress],
        })
      : publicClient.readContract({
          address: vault,
          abi: policyVaultAbi,
          functionName: "positionUnits",
          args: [tokenAddress],
        }),
    publicClient.readContract({
      address: tokenAddress,
      abi: erc20DecimalsAbi,
      functionName: "decimals",
    }),
  ]);
  const resolved = (units * numerator) / 1_000_000n;
  return formatDecimalString(formatUnits(resolved, decimals));
}

async function validateVaultOwnerAccess(
  walletAddress: Address,
  networkId: OgNetworkId,
): Promise<{ code: string; message: string; status: number } | undefined> {
  if (networkId !== "mainnet") {
    return undefined;
  }

  const workspace = await loadOgAgentWorkspace({ ownerAddress: walletAddress }).catch(() => null);
  const owner = workspace?.vault.owner;
  if (!owner) {
    return {
      code: "vault_owner_unavailable",
      message: "Mainnet vault owner could not be verified before Copilot trade execution.",
      status: 409,
    };
  }

  if (owner.toLowerCase() !== walletAddress.toLowerCase()) {
    return {
      code: "vault_owner_required",
      message: "Connect the Policy Vault owner wallet before using Copilot mainnet trade commands.",
      status: 403,
    };
  }

  return undefined;
}

function parseWalletAddress(value: string): Address | undefined {
  return isAddress(value) ? getAddress(value) : undefined;
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

function scaleDecimalAmount(value: string, percent: number): string {
  const parsed = Number(value);
  const scaled = Number.isFinite(parsed) ? parsed * Math.max(0, Math.min(100, percent)) / 100 : 0;
  return formatDecimalString(scaled.toFixed(18));
}

function formatDecimalString(value: string): string {
  const normalized = value.trim();
  if (!normalized.includes(".")) {
    return normalized;
  }

  return normalized.replace(/(\.\d*?)0+$/u, "$1").replace(/\.$/u, "");
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
