import "server-only";

import { randomUUID } from "node:crypto";
import { type Hex } from "viem";
import {
  executeCuratedTrade,
  quoteCuratedTrade,
} from "@/lib/agent/curated-trade";
import { resolveMainnetVaultForOwner } from "@/lib/agent/mainnet-vault-resolver";
import { loadOgAgentWorkspace, storeAgentTradeArtifact } from "@/lib/agent/single-agent-server";
import { AGENT_TRADE_ROUTES, canAgentUseTradeRoute, getAgentTradeRoute } from "@/lib/agent/trade-catalog";
import { hashText } from "@/lib/copilot/audit";
import { auditEvidence } from "@/lib/mock-data";
import { getOgNetwork } from "@/lib/og/networks";
import type { OgAgentWorkspace } from "@/lib/agent/single-agent";
import type {
  AgentAuditProofPreview,
  AgentRouteQuote,
  AgentTradeExecution,
  AgentTradePreview,
  AgentTradeRequest,
  AgentTradeRouteOption,
  OgNetworkId,
} from "@/lib/types";

export class AgentTradeError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function listAgentTradeRoutes(networkId: OgNetworkId): AgentTradeRouteOption[] {
  return AGENT_TRADE_ROUTES.filter((route) => route.networkId === networkId);
}

export async function buildAgentTradePreview(request: AgentTradeRequest): Promise<AgentTradePreview> {
  const route = validateRouteRequest(request);
  if (request.networkId === "mainnet") {
    return buildMainnetTradePreview(request, route);
  }

  return buildStubAgentTradePreview(request, route);
}

export async function executeAgentTrade(
  request: AgentTradeRequest,
  options?: { workspace?: OgAgentWorkspace },
): Promise<{
  execution: AgentTradeExecution;
  preview: AgentTradePreview;
}> {
  const route = validateRouteRequest(request);
  if (request.networkId !== "mainnet") {
    return executeStubAgentTrade(request, route);
  }

  const preview = await buildMainnetTradePreview(request, route);
  const now = new Date().toISOString();
  const workspace =
    options?.workspace ??
    (await loadOgAgentWorkspace({
      agentId: request.agentId,
      ownerAddress: request.ownerAddress,
    }));
  const resolvedRequest = workspace.agent.deployment
    ? {
        ...request,
        agentId: workspace.agent.deployment.id,
        ownerAddress: workspace.agent.deployment.owner,
        vaultAddress: preview.vaultAddress ?? workspace.agent.deployment.vault,
      }
    : request;
  if (!workspace.agent.deployment) {
    return persistAgentTradeResult(resolvedRequest, preview, {
        id: randomUUID(),
        proofBundle: {
          ...preview.proofBundle,
          policyDecision: "review",
          verificationStatus: "pending",
        },
        reason: "Deploy the Agentic ID before live vault execution so the proof can bind to an agentRef.",
        status: "blocked",
        submittedAt: now,
    });
  }
  if (!workspace.storage.uploadReady) {
    return persistAgentTradeResult(resolvedRequest, preview, {
        id: randomUUID(),
        proofBundle: {
          ...preview.proofBundle,
          policyDecision: "review",
          verificationStatus: "pending",
        },
        reason:
          workspace.storage.warnings.join(" ") ||
          "0G Storage is not ready for live audit upload, so execution is blocked.",
        status: "blocked",
        submittedAt: now,
    });
  }
  if (preview.proofBundle.policyDecision !== "allow") {
    return persistAgentTradeResult(resolvedRequest, preview, {
        id: randomUUID(),
        proofBundle: preview.proofBundle,
        reason: preview.quote.warnings.join(" ") || "Policy requires review before live trade submission.",
        status: "blocked",
        submittedAt: now,
    });
  }

  const execution = await executeCuratedTrade({
    agentRef: workspace.agent.deployment?.agentRef,
    amount: request.amountIn,
    networkId: "mainnet",
    routeId: route.id as Hex,
    side: request.side,
    slippageBps: request.slippageBps,
    vaultAddress: preview.vaultAddress,
  });
  const proofBundle: AgentAuditProofPreview = {
    ...preview.proofBundle,
    generatedAt: new Date().toISOString(),
    proofTxHash: execution.proofTxHash,
    quoteHash: execution.actionHash,
    routeHash: execution.vaultActionHash,
    storageRoot: execution.auditRoot,
    verificationStatus: "verified",
  };

  return persistAgentTradeResult(resolvedRequest, {
    ...preview,
    proofBundle,
  }, {
      id: randomUUID(),
      proofBundle,
      reason: `Submitted through ${execution.quote.route.venue} route ${execution.quote.route.label}.`,
      status: "submitted",
      submittedAt: now,
      txHash: execution.executionTxHash,
  });
}

async function persistAgentTradeResult(
  request: AgentTradeRequest,
  preview: AgentTradePreview,
  execution: AgentTradeExecution,
): Promise<{
  execution: AgentTradeExecution;
  preview: AgentTradePreview;
}> {
  if (request.networkId === "mainnet") {
    await storeAgentTradeArtifact(request.agentId, request.side, {
      data: {
        execution,
        preview,
      },
    }).catch(() => undefined);
  }

  return { execution, preview };
}

function validateRouteRequest(request: AgentTradeRequest): AgentTradeRouteOption {
  const route = getAgentTradeRoute(request.routeId);
  if (!route) {
    throw new AgentTradeError("Selected route is not in the server allowlist.", "route_not_allowed", 404);
  }
  if (route.networkId !== request.networkId) {
    throw new AgentTradeError("Selected route does not match the active 0G network.", "network_mismatch", 409);
  }
  if (!canAgentUseTradeRoute(route, request.agentId)) {
    throw new AgentTradeError("Selected agent cannot execute this route.", "agent_route_mismatch", 409);
  }
  return route;
}

async function buildMainnetTradePreview(
  request: AgentTradeRequest,
  route: AgentTradeRouteOption,
): Promise<AgentTradePreview> {
  const amountIn = parseAmount(request.amountIn, "amountIn");
  const maxAmountIn = parseAmount(route.maxAmountIn, "maxAmountIn");
  if (amountIn > maxAmountIn) {
    throw new AgentTradeError(
      `Amount exceeds the ${route.maxAmountIn} ${route.inputToken} Copilot route cap.`,
      "amount_exceeds_route_cap",
      400,
    );
  }

  const vaultAddress = request.vaultAddress ?? (
    request.ownerAddress ? await resolveMainnetVaultForOwner(request.ownerAddress).catch(() => null) : null
  );
  const quote = await quoteCuratedTrade({
    amount: request.amountIn,
    networkId: "mainnet",
    routeId: route.id as Hex,
    side: request.side,
    slippageBps: request.slippageBps,
    vaultAddress: vaultAddress ?? undefined,
  });
  const status = quote.canExecute ? "ready" : "review";
  const routeHash = hashJson({
    networkId: request.networkId,
    routeId: quote.route.id,
    side: request.side,
    vaultAddress,
  });
  const quoteHash = hashJson({
    amountIn: quote.amountIn,
    amountOutMin: quote.amountOutMin,
    quotedAmountOut: quote.quotedAmountOut,
    routeHash,
    slippageBps: request.slippageBps,
  });
  const agentQuote: AgentRouteQuote = {
    amountIn: quote.amountInFormatted,
    amountOutMin: quote.amountOutMinFormatted,
    expiresAt: new Date(Date.now() + Math.max(30_000, Number(quote.deadlineSeconds) * 1000)).toISOString(),
    expectedAmountOut: quote.quotedAmountOutFormatted,
    inputToken: quote.inputSymbol,
    outputToken: quote.outputSymbol,
    priceImpactBps: 0,
    quoteHash,
    routeHash,
    routeId: quote.route.id,
    routeLabel: quote.route.label,
    side: request.side,
    slippageBps: request.slippageBps,
    status,
    venue: quote.route.venue,
    warnings: quote.warnings,
  };

  return {
    backend: {
      message: quote.canExecute
        ? "Live mainnet route is quote-ready; execute will upload audit evidence, accept proof, and call the vault executor."
        : "Live route quote succeeded, but execution requires a ready vault with matching adapter, executor, proof registry, and allowlists.",
      mode: "wired",
      status: "available",
    },
    policy: {
      deadlineRequired: true,
      executorScope: "bounded-vault-methods",
      minAmountOutRequired: true,
      recipient: "vault-owner",
    },
    proofBundle: buildProofBundle({
      auditId: request.auditId ?? route.auditId,
      networkId: request.networkId,
      policyDecision: quote.canExecute ? "allow" : "review",
      policyDecisionHash: quote.policySnapshotHash ?? hashJson({ quoteHash, routeHash }),
      quote: agentQuote,
      route,
      storageRoot: "pending",
    }),
    quote: agentQuote,
    route: {
      ...route,
      id: quote.route.id,
      label: quote.route.label,
      outputToken: quote.outputSymbol,
      readiness: status,
      venue: quote.route.venue,
    },
    vaultAddress: quote.vaultAddress,
  };
}

function buildStubAgentTradePreview(request: AgentTradeRequest, route: AgentTradeRouteOption): AgentTradePreview {
  const amountIn = parseAmount(request.amountIn, "amountIn");
  const maxAmountIn = parseAmount(route.maxAmountIn, "maxAmountIn");
  const warnings: string[] = [];

  if (amountIn <= 0) {
    throw new AgentTradeError("Trade amount must be greater than zero.", "invalid_amount", 400);
  }
  if (amountIn > maxAmountIn) {
    warnings.push(`Amount exceeds the ${route.maxAmountIn} ${route.inputToken} route cap.`);
  }
  if (!route.minAmountOutRequired) {
    warnings.push("Route is missing nonzero amount-out protection.");
  }

  const readiness =
    route.readiness === "blocked" || !route.minAmountOutRequired || amountIn > maxAmountIn
      ? "blocked"
      : route.readiness;
  const expectedAmountOut = quoteAmount(amountIn, route, request.side);
  const amountOutMin =
    readiness === "blocked" || !route.minAmountOutRequired
      ? "0"
      : formatAmount(expectedAmountOut * (1 - request.slippageBps / 10_000));
  const routeHash = hashJson({
    networkId: request.networkId,
    routeId: route.id,
    side: request.side,
  });
  const quoteHash = hashJson({
    amountIn: formatAmount(amountIn),
    amountOutMin,
    routeHash,
    slippageBps: request.slippageBps,
  });
  const quote: AgentRouteQuote = {
    amountIn: formatAmount(amountIn),
    amountOutMin,
    expiresAt: new Date(Date.now() + 90_000).toISOString(),
    expectedAmountOut: formatAmount(expectedAmountOut),
    inputToken: route.inputToken,
    outputToken: route.outputToken,
    priceImpactBps: route.readiness === "ready" ? 18 : route.readiness === "review" ? 42 : 0,
    quoteHash,
    routeHash,
    routeId: route.id,
    routeLabel: route.label,
    side: request.side,
    slippageBps: request.slippageBps,
    status: readiness,
    venue: route.venue,
    warnings,
  };
  const proofBundle = buildProofBundle({
    auditId: request.auditId ?? route.auditId,
    networkId: request.networkId,
    policyDecision: quote.status === "blocked" ? "reject" : quote.status === "review" ? "review" : "allow",
    quote,
    route,
  });

  return {
    backend: {
      message:
        "Testnet route is still a typed preview surface. Mainnet ZIA/Oku routes are wired through live quote and executor modules.",
      mode: "stub",
      status: "stubbed",
    },
    policy: {
      deadlineRequired: true,
      executorScope: "bounded-vault-methods",
      minAmountOutRequired: true,
      recipient: "vault-owner",
    },
    proofBundle,
    quote,
    route,
  };
}

function executeStubAgentTrade(
  request: AgentTradeRequest,
  route: AgentTradeRouteOption,
): {
  execution: AgentTradeExecution;
  preview: AgentTradePreview;
} {
  const preview = buildStubAgentTradePreview(request, route);
  const now = new Date().toISOString();

  if (preview.proofBundle.policyDecision !== "allow") {
    return {
      execution: {
        id: randomUUID(),
        proofBundle: preview.proofBundle,
        reason:
          preview.proofBundle.policyDecision === "review"
            ? "Policy requires live mainnet executor review before trade submission."
            : "Policy rejected the route before trade submission.",
        status: "blocked",
        submittedAt: now,
      },
      preview,
    };
  }

  return {
    execution: {
      id: randomUUID(),
      proofBundle: preview.proofBundle,
      reason: "Typed testnet execution stub accepted the request; no vault transaction was broadcast.",
      status: "stubbed",
      submittedAt: now,
    },
    preview,
  };
}

function buildProofBundle({
  auditId,
  networkId,
  policyDecision,
  policyDecisionHash,
  quote,
  route,
  storageRoot,
}: {
  auditId: string;
  networkId: OgNetworkId;
  policyDecision: "allow" | "review" | "reject";
  policyDecisionHash?: string;
  quote: AgentRouteQuote;
  route: AgentTradeRouteOption;
  storageRoot?: string;
}): AgentAuditProofPreview {
  const evidence = auditEvidence.find((item) => item.id === auditId);
  const network = getOgNetwork(networkId);
  const responseHash = evidence?.responseHash ?? hashJson({ auditId, routeId: route.id });

  return {
    auditId,
    generatedAt: new Date().toISOString(),
    policyDecision,
    policyDecisionHash:
      policyDecisionHash ??
      hashJson({
        amountOutMin: quote.amountOutMin,
        chainId: network.chainId,
        policyDecision,
        quoteHash: quote.quoteHash,
        routeHash: quote.routeHash,
      }),
    proofTxHash: evidence?.proofTxHash ?? "pending",
    quoteHash: quote.quoteHash,
    responseHash,
    routeHash: quote.routeHash,
    storageRoot: storageRoot ?? evidence?.storageRoot ?? hashJson({ auditId, quoteHash: quote.quoteHash }),
    verificationStatus: evidence?.status ?? "pending",
  };
}

function quoteAmount(amountIn: number, route: AgentTradeRouteOption, side: "buy" | "sell"): number {
  const baseRate = route.outputToken === "0G" ? 0.96 : route.outputToken === "USDC.e" ? 1.82 : 1.37;
  const sideMultiplier = side === "sell" ? 0.98 : 1;
  const readinessMultiplier = route.readiness === "ready" ? 1 : route.readiness === "review" ? 0.992 : 0;
  return amountIn * baseRate * sideMultiplier * readinessMultiplier;
}

function parseAmount(value: string, field: string): number {
  const trimmed = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(trimmed)) {
    throw new AgentTradeError(`${field} must be a decimal string with up to 18 decimals.`, "invalid_amount", 400);
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    throw new AgentTradeError(`${field} is not finite.`, "invalid_amount", 400);
  }
  return parsed;
}

function formatAmount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0";
  }
  return value.toFixed(6).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

function hashJson(value: unknown): string {
  return hashText(stableJson(value));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}
