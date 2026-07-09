import { randomUUID } from "node:crypto";
import { formatUnits, type Address } from "viem";
import {
  getAgentFilterPreset,
  type OgAgentDeploymentRecord,
  type OgAgentRuntimeSettings,
  type OgAgentVaultPosition,
  type OgAgentWorkspace,
} from "@/lib/agent/single-agent";
import { listAllAgentDeployments, loadOgAgentWorkspace } from "@/lib/agent/single-agent-server";
import { AGENT_TRADE_ROUTES, canAgentUseTradeRoute } from "@/lib/agent/trade-catalog";
import { buildAgentTradePreview, executeAgentTrade } from "@/lib/agent/trade-service";
import { appendOgAgentRun, readOgAgentRuns } from "@/lib/agent/runtime/store";
import { decideOgAgentAction } from "@/lib/agent/runtime/brain";
import type { OgAgentWorkerConfig } from "@/lib/agent/runtime/config";
import type {
  OgAgentBrainDecision,
  OgAgentRuntimeRunRecord,
  OgAgentTradeCandidate,
} from "@/lib/agent/runtime/types";
import type { AgentTradeRequest, AgentTradeRouteOption } from "@/lib/types";

export interface OgAgentWorkerRunSummary {
  agentsErrored: number;
  agentsProcessed: number;
  blocked: number;
  buysExecuted: number;
  dryRun: boolean;
  dryRuns: number;
  finishedAt: string;
  held: number;
  selectedAgentIds: string[];
  sellsExecuted: number;
  startedAt: string;
}

interface ResolvedAgentRuntimeSettings extends OgAgentRuntimeSettings {
  maxHoldingSeconds: number;
}

export async function runOgAgentWorkerOnce(config: OgAgentWorkerConfig): Promise<OgAgentWorkerRunSummary> {
  const startedAt = new Date().toISOString();
  const selected = config.killSwitchEnabled ? [] : await selectDeploymentsForCycle(config);
  const summary: OgAgentWorkerRunSummary = {
    agentsErrored: 0,
    agentsProcessed: 0,
    blocked: 0,
    buysExecuted: 0,
    dryRun: config.dryRun,
    dryRuns: 0,
    finishedAt: startedAt,
    held: 0,
    selectedAgentIds: selected.map((deployment) => deployment.id),
    sellsExecuted: 0,
    startedAt,
  };

  for (const deployment of selected) {
    const result = await processDeployment(config, deployment);
    summary.agentsProcessed += 1;
    if (result.status === "errored") summary.agentsErrored += 1;
    if (result.status === "blocked") summary.blocked += 1;
    if (result.status === "dry_run") summary.dryRuns += 1;
    if (result.status === "held") summary.held += 1;
    if (result.status === "executed" && result.decision.action === "buy") summary.buysExecuted += 1;
    if (result.status === "executed" && result.decision.action === "sell") summary.sellsExecuted += 1;
  }

  summary.finishedAt = new Date().toISOString();
  return summary;
}

async function selectDeploymentsForCycle(config: OgAgentWorkerConfig): Promise<OgAgentDeploymentRecord[]> {
  const workspace = await loadOgAgentWorkspace({
    agentId: config.agentId,
    live: true,
    ownerAddress: config.ownerAddress,
  });
  if (config.agentId) {
    if (!config.allowConfiguredAgent) {
      return [];
    }
    if (workspace.agent.status !== "armed" || !workspace.agent.deployment) {
      return [];
    }
    return [workspace.agent.deployment];
  }

  // Community default: with no specific owner configured, enumerate agents across ALL owners so every
  // user's trading agents run (not just the env-configured owner's). When an owner IS configured, keep
  // the single-owner roster + honor --all-agents for operator targeting.
  const communityMode = !config.ownerAddress;
  const rosterSource = communityMode ? await listAllAgentDeployments() : workspace.agents;
  const armed = rosterSource.filter((deployment) => !deployment.paused);
  if (config.processAllAgents || communityMode) {
    return selectReadyAllAgentDeployments(armed, config.ownerAddress);
  }

  const selected = workspace.agent.deployment ?? armed.at(-1);
  return selected ? [selected] : [];
}

async function selectReadyAllAgentDeployments(
  armed: OgAgentDeploymentRecord[],
  ownerAddress?: Address,
): Promise<OgAgentDeploymentRecord[]> {
  const ready: OgAgentDeploymentRecord[] = [];
  for (const deployment of armed) {
    const workspace = await loadOgAgentWorkspace({
      agentId: deployment.id,
      live: true,
      ownerAddress: ownerAddress ?? deployment.owner,
    });
    if ((workspace.vault.vaultVersion ?? 1) < 2) {
      continue;
    }
    if (workspace.agent.status !== "armed" || !workspace.agent.deployment || !isVaultRunnable(workspace)) {
      continue;
    }
    ready.push(workspace.agent.deployment);
  }
  return ready;
}

async function processDeployment(
  config: OgAgentWorkerConfig,
  deployment: OgAgentDeploymentRecord,
): Promise<OgAgentRuntimeRunRecord> {
  const startedAt = new Date().toISOString();
  let workspace: OgAgentWorkspace | null = null;
  let candidates: OgAgentTradeCandidate[] = [];
  let decision: OgAgentBrainDecision = holdDecision("Cycle did not reach the 0G Compute Router.");
  let request: AgentTradeRequest | undefined;

  try {
    workspace = await loadOgAgentWorkspace({
      agentId: deployment.id,
      live: true,
      ownerAddress: config.ownerAddress ?? deployment.owner,
    });
    if (config.killSwitchEnabled) {
      decision = holdDecision("Worker kill switch is enabled.");
      return appendAndReturn(buildRunRecord({ candidates, decision, deployment, request, startedAt, status: "blocked" }));
    }
    if (workspace.agent.status !== "armed") {
      decision = holdDecision(`Agent is ${workspace.agent.status}, not armed.`);
      return appendAndReturn(buildRunRecord({ candidates, decision, deployment, request, startedAt, status: "blocked" }));
    }
    if (!isVaultRunnable(workspace)) {
      decision = holdDecision(vaultBlockedReason(workspace));
      return appendAndReturn(buildRunRecord({ candidates, decision, deployment, request, startedAt, status: "blocked" }));
    }
    if (!workspace.storage.uploadReady) {
      decision = holdDecision(
        workspace.storage.warnings.join(" ") || "0G Storage upload is not ready for audit bundles.",
      );
      return appendAndReturn(buildRunRecord({ candidates, decision, deployment, request, startedAt, status: "blocked" }));
    }
    const settings = resolveRuntimeSettings(deployment, config);
    const positionHoldReason = await getPositionHoldReason(settings, deployment.id, workspace);
    if ((workspace.vault.sellablePositions?.length ?? 0) >= settings.maxPositions && positionHoldReason) {
      decision = holdDecision(positionHoldReason);
      return appendAndReturn(buildRunRecord({ candidates, decision, deployment, request, startedAt, status: "held" }));
    }
    candidates = await buildCandidates({ config, deployment, workspace });
    if (candidates.length === 0) {
      decision = holdDecision(positionHoldReason ?? "No quote-ready 0G route candidates were available.");
      return appendAndReturn(buildRunRecord({ candidates, decision, deployment, request, startedAt, status: "held" }));
    }

    decision = await decideOgAgentAction({ candidates, config, deployment, workspace });
    if (decision.action === "hold" || !decision.routeId) {
      return appendAndReturn(buildRunRecord({ candidates, decision, deployment, request, startedAt, status: "held" }));
    }

    const selectedCandidate = candidates.find(
      (candidate) => candidate.action === decision.action && candidate.routeId === decision.routeId,
    );
    if (!selectedCandidate) {
      decision = {
        ...decision,
        action: "hold",
        normalized: true,
        reasons: [...decision.reasons, "Selected route was not present in the prepared candidate set."].slice(0, 5),
        routeId: undefined,
        summary: "Held because the selected route could not be reconciled with the prepared candidates.",
      };
      return appendAndReturn(buildRunRecord({ candidates, decision, deployment, request, startedAt, status: "held" }));
    }

    request = selectedCandidate.request;
    if (config.dryRun) {
      return appendAndReturn(buildRunRecord({ candidates, decision, deployment, request, startedAt, status: "dry_run" }));
    }

    const { execution } = await executeAgentTrade({
      ...request,
      intent: "execute",
    });
    const status = execution.status === "submitted" ? "executed" : "blocked";
    return appendAndReturn(
      buildRunRecord({ candidates, decision, deployment, execution, request, startedAt, status }),
    );
  } catch (error) {
    const message = sanitizeError(error);
    decision = {
      ...decision,
      action: "hold",
      reasons: [message],
      summary: "Worker cycle failed before a trade could be submitted.",
    };
    return appendAndReturn(
      buildRunRecord({ candidates, decision, deployment, error: message, request, startedAt, status: "errored" }),
    );
  }
}

function isVaultRunnable(workspace: OgAgentWorkspace): boolean {
  return workspace.vault.ready && !workspace.vault.paused && !workspace.vault.executorRevoked;
}

function vaultBlockedReason(workspace: OgAgentWorkspace): string {
  if (!workspace.vault.ready) {
    return workspace.vault.warnings.join(" ") || "Policy Vault is not ready for autonomous execution.";
  }
  if (workspace.vault.paused) {
    return "Policy Vault is paused.";
  }
  if (workspace.vault.executorRevoked) {
    return "Policy Vault executor is revoked.";
  }
  return "Policy Vault is not ready for autonomous execution.";
}

async function getPositionHoldReason(
  settings: ResolvedAgentRuntimeSettings,
  agentId: string,
  workspace: OgAgentWorkspace,
): Promise<string | undefined> {
  if ((workspace.vault.sellablePositions?.length ?? 0) === 0) {
    return undefined;
  }
  const latestBuy = (await readOgAgentRuns(agentId, 12)).find(
    (run) => run.status === "executed" && run.decision.action === "buy",
  );
  if (!latestBuy) {
    return undefined;
  }
  const ageSeconds = Math.max(0, Math.floor((Date.now() - Date.parse(latestBuy.completedAt)) / 1000));
  if (ageSeconds >= settings.maxHoldingSeconds) {
    return undefined;
  }
  return `Position hold policy active: ${ageSeconds}s elapsed, max holding window ${settings.maxHoldingSeconds}s.`;
}

async function buildCandidates({
  config,
  deployment,
  workspace,
}: {
  config: OgAgentWorkerConfig;
  deployment: OgAgentDeploymentRecord;
  workspace: OgAgentWorkspace;
}): Promise<OgAgentTradeCandidate[]> {
  const settings = resolveRuntimeSettings(deployment, config);
  const positions = workspace.vault.sellablePositions ?? [];
  const holdReason = await getPositionHoldReason(settings, deployment.id, workspace);

  if (positions.length < settings.maxPositions) {
    const buyCandidates = await buildBuyCandidates({ config, deployment, settings, workspace });
    if (buyCandidates.length > 0) {
      return buyCandidates;
    }
  }

  if (positions.length > 0 && !holdReason) {
    return buildSellCandidates({ config, deployment, settings, workspace });
  }

  return [];
}

// The trade (buy/sell) vault is the Swap third for V4 agents. deployment.vault points
// at the LpEntry third for V4, which has no buy/sell entrypoint and reverts the V3
// adapter() read — passing it would force a permanent hold. Legacy agents keep their
// single vault.
function tradeVaultAddressOf(deployment: OgAgentDeploymentRecord): Address {
  return (deployment.vaultVersion ?? 1) >= 4 && deployment.v4SwapVault
    ? deployment.v4SwapVault
    : deployment.vault;
}

async function buildBuyCandidates({
  config,
  deployment,
  settings,
  workspace,
}: {
  config: OgAgentWorkerConfig;
  deployment: OgAgentDeploymentRecord;
  settings: ResolvedAgentRuntimeSettings;
  workspace: OgAgentWorkspace;
}): Promise<OgAgentTradeCandidate[]> {
  const symbols = selectedRouteSymbols(deployment);
  const activeRouteIds = new Set((workspace.vault.sellablePositions ?? []).map((position) => position.routeId.toLowerCase()));
  const routeLimit = Math.min(config.maxRouteCandidates, Math.max(0, settings.maxPositions - activeRouteIds.size));
  const routes = AGENT_TRADE_ROUTES.filter(
    (route) =>
      route.networkId === "mainnet" &&
      route.readiness === "ready" &&
      canAgentUseTradeRoute(route, deployment.id) &&
      !activeRouteIds.has(route.id.toLowerCase()) &&
      (symbols.size === 0 || symbols.has(route.outputToken)),
  ).slice(0, routeLimit);

  return previewCandidates(
    routes.map((route) => ({
      agentId: deployment.id,
      amountIn: settings.maxCapitalPerTrade0G ?? config.buyAmount0G,
      auditId: route.auditId,
      intent: "preview",
      networkId: "mainnet",
      ownerAddress: deployment.owner,
      routeId: route.id,
      side: "buy",
      slippageBps: settings.slippageBps,
      vaultAddress: tradeVaultAddressOf(deployment),
    })),
  );
}

async function buildSellCandidates({
  config,
  deployment,
  settings,
  workspace,
}: {
  config: OgAgentWorkerConfig;
  deployment: OgAgentDeploymentRecord;
  settings: ResolvedAgentRuntimeSettings;
  workspace: OgAgentWorkspace;
}): Promise<OgAgentTradeCandidate[]> {
  const positions = workspace.vault.sellablePositions ?? [];
  if (positions.length === 0) {
    return [];
  }

  const requests = positions
    .filter((position) => canSellPosition(position))
    .slice(0, config.maxRouteCandidates)
    .map((position) => {
      const route = AGENT_TRADE_ROUTES.find((candidate) => candidate.id === position.routeId);
      return {
        agentId: deployment.id,
        amountIn: formatSellAmount(position, config.sellPercent),
        auditId: route?.auditId,
        intent: "preview" as const,
        networkId: "mainnet" as const,
        ownerAddress: deployment.owner,
        routeId: position.routeId,
        side: "sell" as const,
        slippageBps: settings.slippageBps,
        vaultAddress: tradeVaultAddressOf(deployment),
      };
    });

  return previewCandidates(requests);
}

async function previewCandidates(requests: AgentTradeRequest[]): Promise<OgAgentTradeCandidate[]> {
  const candidates: OgAgentTradeCandidate[] = [];
  for (const request of requests) {
    try {
      const preview = await buildAgentTradePreview(request);
      candidates.push({
        action: request.side,
        amountIn: request.amountIn,
        inputToken: preview.quote.inputToken,
        outputToken: preview.quote.outputToken,
        policyDecision: preview.proofBundle.policyDecision,
        preview,
        quoteStatus: preview.quote.status,
        request,
        routeId: preview.quote.routeId,
        routeLabel: preview.quote.routeLabel,
        slippageBps: preview.quote.slippageBps,
      });
    } catch (error) {
      candidates.push({
        action: request.side,
        amountIn: request.amountIn,
        inputToken: request.side === "buy" ? "0G" : "token",
        outputToken: request.side === "buy" ? "token" : "0G",
        policyDecision: "reject",
        quoteStatus: "unavailable",
        reason: sanitizeError(error),
        request,
        routeId: request.routeId,
        routeLabel: routeLabel(request.routeId),
        slippageBps: request.slippageBps,
      });
    }
  }
  return candidates;
}

function selectedRouteSymbols(deployment: OgAgentDeploymentRecord): Set<string> {
  const symbols = new Set<string>();
  for (const filterId of deployment.filters) {
    const preset = getAgentFilterPreset(filterId);
    for (const symbol of preset?.routeSymbols ?? []) {
      symbols.add(symbol);
    }
  }
  return symbols;
}

function canSellPosition(position: OgAgentVaultPosition): boolean {
  try {
    return BigInt(position.amountRaw) > 0n;
  } catch {
    return false;
  }
}

function formatSellAmount(position: OgAgentVaultPosition, sellPercent: number): string {
  const raw = BigInt(position.amountRaw);
  const sellRaw = (raw * BigInt(sellPercent)) / 100n;
  return formatUnits(sellRaw > 0n ? sellRaw : raw, position.decimals);
}

function routeLabel(routeId: string): string {
  return AGENT_TRADE_ROUTES.find((route: AgentTradeRouteOption) => route.id === routeId)?.label ?? routeId;
}

function resolveRuntimeSettings(
  deployment: OgAgentDeploymentRecord,
  config: OgAgentWorkerConfig,
): ResolvedAgentRuntimeSettings {
  const maxHoldingMinutes = clampInteger(deployment.runtime?.maxHoldingMinutes, 1, 24 * 60, 30);
  return {
    maxCapitalPerTrade0G: deployment.runtime?.maxCapitalPerTrade0G ?? config.buyAmount0G,
    maxHoldingMinutes,
    maxHoldingSeconds: maxHoldingMinutes * 60,
    maxPositions: clampInteger(deployment.runtime?.maxPositions, 1, 8, 2),
    signalConfidence: clampInteger(deployment.runtime?.signalConfidence, 1, 100, 75),
    slippageBps: clampInteger(deployment.runtime?.slippageBps, 1, 1000, config.slippageBps),
  };
}

function clampInteger(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function holdDecision(summary: string): OgAgentBrainDecision {
  return {
    action: "hold",
    confidence: 0,
    normalized: false,
    reasons: [summary],
    slippageBps: 75,
    source: "0g-compute-router",
    summary,
  };
}

function buildRunRecord({
  candidates,
  decision,
  deployment,
  error,
  execution,
  request,
  startedAt,
  status,
}: {
  candidates: OgAgentTradeCandidate[];
  decision: OgAgentBrainDecision;
  deployment: OgAgentDeploymentRecord;
  error?: string;
  execution?: OgAgentRuntimeRunRecord["execution"];
  request?: AgentTradeRequest;
  startedAt: string;
  status: OgAgentRuntimeRunRecord["status"];
}): OgAgentRuntimeRunRecord {
  return {
    agentId: deployment.id,
    agentName: deployment.name,
    agentRef: deployment.agentRef,
    candidates,
    completedAt: new Date().toISOString(),
    cycleId: randomUUID(),
    decision,
    error,
    execution,
    request,
    startedAt,
    status,
  };
}

async function appendAndReturn(record: OgAgentRuntimeRunRecord): Promise<OgAgentRuntimeRunRecord> {
  await appendOgAgentRun(record).catch(() => undefined);
  return record;
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/(?:sk|mk)-[a-zA-Z0-9._-]+/gu, "[redacted-key]").slice(0, 500);
}
