import "server-only";

import { z } from "zod";
import {
  listOgComputeRouterModels,
  OgComputeRouterError,
  resolveOgComputeRouterConfig,
  resolveOgComputeRouterDefaultModel,
  type OgComputeRouterConfig,
  type OgComputeRouterResult,
} from "@/lib/copilot/router";
import type {
  AiScanReport,
  AiScanReportSection,
  AiScanReportTone,
} from "@/lib/types/ai-scan";
import type { OgNetworkId } from "@/lib/types";

const MAX_PACKET_BYTES = 24_000;
const DEFAULT_AI_SCAN_MAX_TOKENS = 1_200;

const toneSchema = z.enum(["clean", "info", "warning", "danger"]);
const verdictSchema = z.enum(["Verified", "Safe", "Watch", "High risk"]);

const llmReportSchema = z.object({
  agentLogs: z
    .array(
      z.object({
        detail: z.string().trim().min(1).max(280),
        label: z.string().trim().min(1).max(42),
        tone: toneSchema,
      }),
    )
    .min(3)
    .max(6),
  missingData: z.array(z.string().trim().min(1).max(180)).max(8).default([]),
  recommendation: z.string().trim().min(1).max(700),
  score: z.number().int().min(0).max(100),
  summary: z.string().trim().min(1).max(700),
  verdict: verdictSchema,
});

export interface AiScanModelCatalog {
  defaultModel?: string;
  models: string[];
  networkId: OgNetworkId;
}

export interface AiScanResearchResult {
  model: string;
  report: AiScanReport;
  trace?: OgComputeRouterResult["trace"];
}

export async function listAiScanModels(networkId: OgNetworkId): Promise<AiScanModelCatalog> {
  const config = resolveAiScanRouterConfig(networkId);
  const models = await listOgComputeRouterModels(config);

  return {
    defaultModel: resolveOgComputeRouterDefaultModel(config, models),
    models,
    networkId: config.network.id,
  };
}

export async function enhanceAiScanReportWithLlm({
  model,
  networkId,
  report,
}: {
  model?: string;
  networkId: OgNetworkId;
  report: AiScanReport;
}): Promise<AiScanResearchResult> {
  const config = resolveAiScanRouterConfig(networkId);
  const models = await listOgComputeRouterModels(config);
  const selectedModel = resolveSelectedAiScanModel(config, models, model);
  const packet = serializeScanPacket(report);

  const response = await fetch(buildRouterUrl(config.baseUrl, "chat/completions"), {
    body: JSON.stringify({
      ...(shouldDisableThinkingMode(selectedModel) ? { chat_template_kwargs: { enable_thinking: false } } : {}),
      max_tokens: resolveAiScanMaxTokens(),
      messages: [
        {
          content: buildAiScanSystemPrompt(report.targetType),
          role: "system",
        },
        {
          content: [
            "Analyze this deterministic scan packet and return strict JSON only.",
            "Do not include markdown fences.",
            packet,
          ].join("\n\n"),
          role: "user",
        },
      ],
      model: selectedModel,
      response_format: { type: "json_object" },
      temperature: 0.1,
      verify_tee: config.verifyTee,
    }),
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    method: "POST",
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    throw new OgComputeRouterError(routerStatusMessage(response.status), "router_request_failed", response.status);
  }

  const raw = await response.json();
  const message = raw?.choices?.[0]?.message?.content;
  if (typeof message !== "string" || message.trim().length === 0) {
    throw new OgComputeRouterError("0G Compute Router returned an empty AI Scan response.", "empty_router_response", 502);
  }

  const parsed = parseLlmReport(message);
  const finalModel = typeof raw?.model === "string" && raw.model.trim() ? raw.model.trim() : selectedModel;
  const trace = parseRouterTrace(raw);
  const enhancedReport = mergeLlmReport(report, parsed, finalModel, trace);

  return {
    model: finalModel,
    report: enhancedReport,
    trace,
  };
}

function resolveAiScanRouterConfig(networkId: OgNetworkId): OgComputeRouterConfig {
  const config = resolveOgComputeRouterConfig(networkId);
  if ("error" in config) {
    throw config.error;
  }
  return config;
}

function resolveSelectedAiScanModel(config: OgComputeRouterConfig, models: string[], requestedModel: string | undefined): string {
  if (requestedModel) {
    const match = models.find((candidate) => modelLookupKey(candidate) === modelLookupKey(requestedModel));
    if (!match) {
      throw new OgComputeRouterError("Selected AI Scan model is not available for this 0G Compute network.", "model_not_available", 400);
    }
    return match;
  }

  const defaultModel = resolveOgComputeRouterDefaultModel(config, models);
  if (!defaultModel) {
    throw new OgComputeRouterError("0G Compute Router model catalog was empty.", "invalid_model_catalog", 502);
  }
  return defaultModel;
}

function buildAiScanSystemPrompt(targetType: AiScanReport["targetType"]): string {
  const base = [
    "You are 4lpha AI Smart Scan, a cautious crypto risk analyst for 0G trading agents.",
    "Analyze only the provided deterministic scan packet. Do not invent facts, balances, labels, holder data, CMC data, source verification, transaction history, or proof state that is not present.",
    "Your job is to convert scanner facts into a clear pre-trade risk report for a token or wallet before it is used by a Policy Vault or autonomous trading agent.",
    "Always distinguish confirmed on-chain facts, deterministic scanner results, AI interpretation, and missing or unverified data.",
    "A storage root or evidence hash in the packet is not proof of a completed 0G Storage upload or Chain anchor. Never say uploaded, stored, anchored, verified, or proven unless the packet explicitly contains a verified upload or proof transaction.",
    "If the packet contains a Vault Filter section, routeRecommendation.status is recommended, and deterministicScore is below 35, treat the token as a reviewed vault-catalog token. Do not mark it High risk unless the packet shows failed sell quote, missing bytecode, explicit blacklist, paused transfers, or zero exit liquidity.",
      "The score is a safety score: 100 means strongest confidence / verified, 0 means do not use.",
      "If verifiedToken is present, treat it as the authoritative 4lpha/TradeGPT allowlist profile. Return score 100, verdict Verified, explain the token profile, and do not classify it as scam, honeypot, or high risk unless the packet explicitly shows no bytecode, failed sell quote with zero exit, paused transfers, blacklist, or other critical exploit evidence.",
      "For verifiedToken reports, missing fork simulation, owner(), proxy hints, CMC gaps, or pending proof anchoring are operational follow-ups, not reasons to downgrade the verified verdict.",
      "Prioritize loss-of-funds risk, sell/exit risk, contract control risk, route quality, wallet behavior, evidence quality, and missing data.",
      "Never provide financial advice. Use cautious language. Return strict JSON only.",
    'JSON shape: {"score": number 0-100, "verdict": "Verified"|"Safe"|"Watch"|"High risk", "summary": string, "recommendation": string, "agentLogs": [{"label": string, "detail": string, "tone": "clean"|"info"|"warning"|"danger"}], "missingData": string[]}.',
  ];

  if (targetType === "token") {
    return [
      ...base,
      "Token-specific focus: bytecode presence, ERC20 metadata, owner/proxy/admin powers, buy route availability, sell route availability, honeypot or sell-lock risk signals, transfer-fee uncertainty, liquidity/route recommendation, and whether vault execution should be allowed, reviewed, or blocked.",
      "For non-verified tokens, if sell-path quote or simulation is missing, do not call the token fully safe. If the token is not in the curated vault route allowlist, recommend blocking vault execution until reviewed.",
    ].join(" ");
  }

  return [
    ...base,
    "Wallet-specific focus: native balance, tracked portfolio holdings, recent activity, transaction count, counterparty diversity, contract wallet vs EOA, smart-money confidence, and whether the wallet is useful for watchlist, research, copy-trade candidate, or should be ignored.",
    "Do not infer PnL, insider status, CEX labels, or smart-money identity unless provided. If historical PnL or labels are missing, say confidence is limited.",
  ].join(" ");
}

function serializeScanPacket(report: AiScanReport): string {
  const packet = JSON.stringify(
    {
      address: report.address,
      deterministicAgentLogs: report.agentLogs,
      deterministicRecommendation: report.recommendation,
      deterministicScore: report.score,
      deterministicSections: report.sections,
      deterministicSummary: report.summary,
      deterministicVerdict: report.verdict,
      evidence: report.evidence,
      mode: report.mode,
      network: report.network,
      routeRecommendation: report.routeRecommendation,
      scanId: report.scanId,
      targetLabel: report.targetLabel,
      targetType: report.targetType,
      verifiedToken: report.verifiedToken,
    },
    null,
    2,
  );

  if (new TextEncoder().encode(packet).length > MAX_PACKET_BYTES) {
    throw new OgComputeRouterError("AI Scan packet is too large for the configured LLM analysis window.", "scan_packet_too_large", 413);
  }

  return packet;
}

function parseLlmReport(message: string): z.infer<typeof llmReportSchema> {
  try {
    const parsed = llmReportSchema.safeParse(JSON.parse(stripJsonFence(message)));
    if (!parsed.success) {
      throw new Error("bad schema");
    }
    return parsed.data;
  } catch {
    throw new OgComputeRouterError("0G Compute Router returned an invalid AI Scan JSON report.", "invalid_ai_scan_report", 502);
  }
}

function mergeLlmReport(
  report: AiScanReport,
  llmReport: z.infer<typeof llmReportSchema>,
  model: string,
  trace: OgComputeRouterResult["trace"] | undefined,
): AiScanReport {
  const verified = isVerifiedTokenReport(report);
  const missingDataSection = verified ? undefined : buildMissingDataSection(llmReport.missingData);
  const finalScore = normalizeScore(report, llmReport.score);

  return {
    ...report,
    agentLogs: verified ? verifiedAgentLogs(report, llmReport) : llmReport.agentLogs.map((entry, index) => ({
      detail: entry.detail,
      label: entry.label,
      time: `AI ${String(index + 1).padStart(2, "0")}`,
      tone: entry.tone,
    })),
    ai: {
      model,
      provider: "0g-compute-router",
      trace,
    },
    evidence: upsertEvidenceRows(report.evidence, [
      { label: "AI model", value: model },
      { label: "AI provider", value: trace?.provider ?? "0G Compute Router" },
      { label: "TEE", value: trace?.teeVerified === undefined ? "not reported" : trace.teeVerified ? "verified" : "not verified" },
    ]),
    recommendation: normalizeRecommendation(report, llmReport.recommendation),
    score: finalScore,
    sections: missingDataSection ? [...report.sections, missingDataSection] : report.sections,
    summary: normalizeSummary(report, llmReport.summary),
    verdict: normalizeVerdict(report, finalScore, llmReport.verdict),
  };
}

function normalizeScore(report: AiScanReport, modelScore: number): number {
  if (isVerifiedTokenReport(report)) {
    return 100;
  }
  return modelScore;
}

function normalizeVerdict(
  report: AiScanReport,
  score: number,
  modelVerdict: AiScanReport["verdict"],
): AiScanReport["verdict"] {
  if (isVerifiedTokenReport(report)) {
    return "Verified";
  }
  if (modelVerdict === "Verified") {
    return score >= 90 ? "Safe" : score >= 50 ? "Watch" : "High risk";
  }
  const scoreVerdict = score >= 85 ? "Safe" : score >= 50 ? "Watch" : "High risk";
  if (scoreVerdict !== modelVerdict) {
    return scoreVerdict;
  }
  return modelVerdict;
}

function isVerifiedTokenReport(report: AiScanReport): boolean {
  return report.targetType === "token" && report.verifiedToken !== undefined;
}

function normalizeSummary(report: AiScanReport, summary: string): string {
  if (!isVerifiedTokenReport(report)) {
    return summary;
  }
  const profile = report.verifiedToken;
  if (!profile) {
    return summary;
  }
  const route = report.routeRecommendation?.matchedRoutes[0];
  const routeText = route ? ` Primary route: ${route.label} via ${route.venue}.` : "";
  return `${profile.summary} ${profile.symbol} is verified by the ${profile.verificationSource}; score is locked to 100/100 for this allowlisted vault token.${routeText}`;
}

function normalizeRecommendation(report: AiScanReport, recommendation: string): string {
  if (!isVerifiedTokenReport(report)) {
    return recommendation;
  }
  const profile = report.verifiedToken;
  if (!profile) {
    return recommendation;
  }
  const route = report.routeRecommendation?.matchedRoutes[0];
  const routeText = route ? ` Use ${route.label} (${route.venue}) only through the Policy Vault.` : "";
  return `${profile.recommendation}${routeText} Keep nonzero amountOutMin, configured slippage limits, and proof anchoring as execution requirements; owner(), proxy hints, or missing CMC enrichment stay as follow-up notes for verified tokens.`;
}

function verifiedAgentLogs(
  report: AiScanReport,
  llmReport: z.infer<typeof llmReportSchema>,
): AiScanReport["agentLogs"] {
  const profile = report.verifiedToken;
  const llmSignal = llmReport.agentLogs[0]?.detail;
  return [
    {
      detail: profile
        ? `${profile.symbol} matched ${profile.verificationSource}; backend guardrails enforce score 100 and verdict Verified.`
        : "Verified token guardrail matched.",
      label: "Registry verified",
      time: "AI 01",
      tone: "clean",
    },
    {
      detail:
        profile?.symbol === "USDC.e"
          ? "USDC.e is explained as bridge-native / wrapped USDC exposure, distinct from Circle-native USDC, not as an unknown unreviewed token."
          : `${profile?.symbol ?? report.targetLabel} is explained as a curated 4lpha vault token, not as an unknown asset.`,
      label: "Token context",
      time: "AI 02",
      tone: "clean",
    },
    {
      detail:
        report.routeRecommendation?.matchedRoutes.length
          ? `${report.routeRecommendation.matchedRoutes.length} Policy Vault route(s) remain the only recommended execution path.`
          : "Execution remains policy-gated because no active route candidate was present in the scan packet.",
      label: "Route reasoning",
      time: "AI 03",
      tone: report.routeRecommendation?.matchedRoutes.length ? "clean" : "warning",
    },
    {
      detail:
        llmSignal && !/(scam|honeypot|high risk)/iu.test(llmSignal)
          ? llmSignal
          : "0G Compute generated the readable report, while deterministic registry and route facts controlled the final verdict.",
      label: "AI summary",
      time: "AI 04",
      tone: "info",
    },
    {
      detail: "Pending 0G Storage upload and proof anchoring are evidence-state tasks, not token safety downgrades for verified assets.",
      label: "Evidence state",
      time: "AI 05",
      tone: "info",
    },
  ];
}

function buildMissingDataSection(missingData: string[]): AiScanReportSection | undefined {
  if (missingData.length === 0) {
    return undefined;
  }

  return {
    action: "Needs enrichment",
    items: missingData.slice(0, 6).map((item) => ({
      detail: item,
      status: "info" as AiScanReportTone,
      title: "Missing data",
    })),
    title: "AI Missing Data",
  };
}

function upsertEvidenceRows(
  rows: AiScanReport["evidence"],
  additions: AiScanReport["evidence"],
): AiScanReport["evidence"] {
  const blockedLabels = new Set(additions.map((row) => row.label.toLowerCase()));
  return [...rows.filter((row) => !blockedLabels.has(row.label.toLowerCase())), ...additions];
}

function parseRouterTrace(raw: unknown): OgComputeRouterResult["trace"] | undefined {
  const trace = (raw as { x_0g_trace?: unknown }).x_0g_trace;
  if (!trace || typeof trace !== "object") {
    return undefined;
  }
  const value = trace as {
    billing?: { total_cost?: unknown };
    provider?: unknown;
    request_id?: unknown;
    tee_verified?: unknown;
  };

  return {
    billingTotalCost: typeof value.billing?.total_cost === "string" ? value.billing.total_cost : undefined,
    provider: typeof value.provider === "string" ? value.provider : undefined,
    requestId: typeof value.request_id === "string" ? value.request_id : undefined,
    teeVerified: typeof value.tee_verified === "boolean" ? value.tee_verified : undefined,
  };
}

function stripJsonFence(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }
  return trimmed.replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "").trim();
}

function buildRouterUrl(baseUrl: string, path: string): string {
  return `${baseUrl}/${path.replace(/^\/+/u, "")}`;
}

function modelLookupKey(value: string): string {
  return value.trim().toLowerCase().replace(/^ogm-/u, "0gm-");
}

function shouldDisableThinkingMode(modelId: string): boolean {
  return modelLookupKey(modelId).startsWith("0gm-");
}

function routerStatusMessage(status: number): string {
  if (status === 401 || status === 403) {
    return "0G Compute Router rejected the server credential.";
  }
  if (status === 402) {
    return "0G Compute Router balance is insufficient for this AI Scan request.";
  }
  if (status === 429) {
    return "0G Compute Router rate limit was reached.";
  }
  return "0G Compute Router rejected the AI Scan request.";
}

function resolveAiScanMaxTokens(): number {
  const parsed = Number.parseInt(process.env.AI_SCAN_LLM_MAX_TOKENS ?? process.env.OG_COMPUTE_MAX_TOKENS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_AI_SCAN_MAX_TOKENS;
}
