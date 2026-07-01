import { z } from "zod";
import { getAgentFilterPreset, type OgAgentDeploymentRecord, type OgAgentWorkspace } from "@/lib/agent/single-agent";
import { callOgComputeRouter, resolveOgComputeRouterConfig } from "@/lib/copilot/router";
import type { OgAgentWorkerConfig } from "@/lib/agent/runtime/config";
import type { OgAgentBrainDecision, OgAgentTradeCandidate } from "@/lib/agent/runtime/types";

const decisionSchema = z.object({
  action: z.enum(["buy", "sell", "hold"]),
  amount0G: emptyStringToUndefined(z.string()),
  confidence: z.number().min(0).max(100).catch(50),
  reasons: z.array(z.string()).min(1).max(5).catch(["Policy and route context reviewed."]),
  routeId: emptyStringToUndefined(z.string()),
  sellPercent: emptyStringToUndefined(z.coerce.number().min(1).max(100)),
  slippageBps: z.number().int().min(1).max(1000).catch(75),
  summary: z.string().min(1).max(500).catch("Reviewed the current 0G Policy Vault context."),
});

export async function decideOgAgentAction({
  candidates,
  config,
  deployment,
  workspace,
}: {
  candidates: OgAgentTradeCandidate[];
  config: OgAgentWorkerConfig;
  deployment: OgAgentDeploymentRecord;
  workspace: OgAgentWorkspace;
}): Promise<OgAgentBrainDecision> {
  const routerConfig = resolveOgComputeRouterConfig("mainnet");
  if ("error" in routerConfig) {
    throw routerConfig.error;
  }

  const preferredAction = choosePreferredAction(workspace, candidates);
  const policyContext = [
    "Autonomous 0G trading worker. The vault enforces caps, min-out, cooldown, proof anchoring, and allowlisted routes.",
    "The LLM may select only one allowlisted candidate from the supplied JSON. It must not invent routes, wallets, keys, calldata, or recipients.",
    "Prefer buy candidates while the worker supplies entry candidates. Prefer sell only when the worker supplies exit candidates under the agent position and holding-time policy.",
  ].join(" ");

  const message = JSON.stringify(
    {
      agent: {
        agentRef: deployment.agentRef,
        filters: deployment.filters.map((id) => getAgentFilterPreset(id)?.label ?? id),
        id: deployment.id,
        name: deployment.name,
        owner: deployment.owner,
        runtime: deployment.runtime,
        standard: deployment.standard,
      },
      candidates: candidates.map((candidate) => ({
        action: candidate.action,
        amountIn: candidate.amountIn,
        inputToken: candidate.inputToken,
        outputToken: candidate.outputToken,
        policyDecision: candidate.policyDecision,
        quoteStatus: candidate.quoteStatus,
        reason: candidate.reason,
        routeId: candidate.routeId,
        routeLabel: candidate.routeLabel,
        slippageBps: candidate.slippageBps,
        warnings: candidate.preview?.quote.warnings ?? [],
      })),
      output_contract: {
        action: "buy | sell | hold",
        amount0G: "decimal string only for buy",
        confidence: "0-100 number",
        reasons: "1-5 short audit-safe rationale lines, no hidden chain-of-thought",
        routeId: "must match one candidate when action is buy or sell",
        sellPercent: "1-100 only for sell",
        slippageBps: "integer bps",
        summary: "one audit-safe sentence",
      },
      preferredAction,
      positions: workspace.vault.sellablePositions ?? [],
      readiness: {
        agentStatus: workspace.agent.status,
        storageUploadReady: workspace.storage.uploadReady,
        vaultReady: workspace.vault.ready,
        vaultWarnings: workspace.vault.warnings,
      },
      risk: {
        buyAmount0G: config.buyAmount0G,
        dryRun: config.dryRun,
        maxRouteCandidates: config.maxRouteCandidates,
        sellPercent: config.sellPercent,
        slippageBps: config.slippageBps,
        vaultPolicy: workspace.vault.policy,
      },
      task:
        "Return JSON only. Pick exactly one action. Prefer the preferredAction when its candidate is ready. Never include markdown.",
    },
    null,
    2,
  );

  const systemPrompt = [
    "You are the 4lpha 0G autonomous trading agent brain running inside a server-side worker on 0G mainnet.",
    "You receive one JSON message with allowlisted trade candidates, vault policy, and readiness state.",
    'Return JSON only that matches the output_contract in the message. No markdown, no prose, no chain-of-thought.',
    "Select at most one allowlisted candidate. Never invent routes, wallets, keys, calldata, recipients, or amounts outside the supplied candidates and policy.",
    "If no candidate is ready or policy blocks the action, return action: hold.",
    `Worker policy: ${policyContext}`,
    "Autonomous worker cycle context is redacted and server-side only.",
  ].join("\n");

  const response = await callOgComputeRouter({
    config: routerConfig,
    messages: [{ content: message, role: "operator" }],
    systemPrompt,
    selectedModel: config.selectedModel,
  });

  return normalizeDecision({
    candidates,
    config,
    model: response.model,
    rawMessage: response.message,
    trace: response.trace,
  });
}

function choosePreferredAction(workspace: OgAgentWorkspace, candidates: OgAgentTradeCandidate[]): "buy" | "sell" | "hold" {
  if ((workspace.vault.sellablePositions?.length ?? 0) > 0 && candidates.some((candidate) => candidate.action === "sell")) {
    return "sell";
  }
  if (candidates.some((candidate) => candidate.action === "buy" && candidate.policyDecision === "allow")) {
    return "buy";
  }
  return "hold";
}

function normalizeDecision({
  candidates,
  config,
  model,
  rawMessage,
  trace,
}: {
  candidates: OgAgentTradeCandidate[];
  config: OgAgentWorkerConfig;
  model: string;
  rawMessage: string;
  trace?: OgAgentBrainDecision["trace"];
}): OgAgentBrainDecision {
  let extracted: unknown;
  try {
    extracted = extractJsonObject(rawMessage);
  } catch {
    return {
      action: "hold",
      confidence: 0,
      model,
      normalized: true,
      rawMessage: truncate(rawMessage, 2000),
      reasons: ["0G Compute Router response did not contain a JSON object."],
      slippageBps: config.slippageBps,
      source: "0g-compute-router",
      summary: "Held because the LLM response could not be parsed safely.",
      trace,
    };
  }

  const parsed = decisionSchema.safeParse(extracted);
  if (!parsed.success) {
    return {
      action: "hold",
      confidence: 0,
      model,
      normalized: true,
      rawMessage: truncate(rawMessage, 2000),
      reasons: ["0G Compute Router response was not valid decision JSON."],
      slippageBps: config.slippageBps,
      source: "0g-compute-router",
      summary: "Held because the LLM response could not be parsed safely.",
      trace,
    };
  }

  const decision = parsed.data;
  if (decision.action === "hold") {
    return {
      action: "hold",
      confidence: decision.confidence,
      model,
      normalized: false,
      rawMessage: truncate(rawMessage, 2000),
      reasons: decision.reasons.map(sanitizeReason),
      slippageBps: clamp(decision.slippageBps, 1, 1000),
      source: "0g-compute-router",
      summary: sanitizeReason(decision.summary),
      trace,
    };
  }

  const usableCandidates = candidates.filter(
    (candidate) => candidate.action === decision.action && candidate.policyDecision === "allow",
  );
  if (usableCandidates.length === 0) {
    return {
      action: "hold",
      confidence: decision.confidence,
      model,
      normalized: true,
      rawMessage: truncate(rawMessage, 2000),
      reasons: [
        ...decision.reasons.map(sanitizeReason),
        `No execution-ready ${decision.action} candidate was available after policy validation.`,
      ],
      slippageBps: config.slippageBps,
      source: "0g-compute-router",
      summary: `Held because no ${decision.action} candidate passed the vault policy checks.`,
      trace,
    };
  }

  const selected =
    usableCandidates.find((candidate) => candidate.routeId === decision.routeId) ??
    usableCandidates[0];
  return {
    action: decision.action,
    amount0G: decision.action === "buy" ? config.buyAmount0G : undefined,
    confidence: decision.confidence,
    model,
    normalized: selected.routeId !== decision.routeId,
    rawMessage: truncate(rawMessage, 2000),
    reasons: [
      ...decision.reasons.map(sanitizeReason),
      ...(selected.routeId !== decision.routeId ? [`Normalized route to allowlisted ${selected.routeLabel}.`] : []),
    ].slice(0, 5),
    routeId: selected.routeId,
    sellPercent: decision.action === "sell" ? clamp(decision.sellPercent ?? config.sellPercent, 1, 100) : undefined,
    slippageBps: selected.slippageBps,
    source: "0g-compute-router",
    summary: sanitizeReason(decision.summary),
    trace,
  };
}

function extractJsonObject(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return JSON.parse(trimmed);
  }

  const match = trimmed.match(/\{[\s\S]*\}/u);
  if (!match) {
    throw new Error("No JSON object found.");
  }
  return JSON.parse(match[0]);
}

function sanitizeReason(value: string): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, 500);
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function emptyStringToUndefined<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => {
    if (value === null || value === undefined || value === "") {
      return undefined;
    }
    return value;
  }, schema.optional());
}
