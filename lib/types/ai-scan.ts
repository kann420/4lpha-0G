import type { OgNetworkId, TradeRouteDescriptor } from "@/lib/types";

export type AiScanMode = "risk" | "honeypot" | "research" | "wallet-risk" | "approvals" | "behavior";
export type AiScanTargetType = "token" | "wallet";
export type AiScanState = "idle" | "running" | "complete";
export type AiScanReportTone = "clean" | "info" | "warning" | "danger";
export type AiScanVerdict = "High risk" | "Watch" | "Safe" | "Verified";

export interface AiScanVerifiedTokenComparisonRow {
  label: string;
  native: string;
  verified: string;
}

export interface AiScanVerifiedTokenProfile {
  address: string;
  badgeLabel: string;
  category: string;
  comparison?: {
    nativeLabel: string;
    rows: AiScanVerifiedTokenComparisonRow[];
    verifiedLabel: string;
  };
  name: string;
  notes: string[];
  protocol: string;
  recommendation: string;
  summary: string;
  symbol: string;
  verificationSource: string;
}

export interface AiScanReportItem {
  detail?: string;
  metrics?: string[];
  status: AiScanReportTone;
  title: string;
}

export interface AiScanReportSection {
  action?: string;
  items: AiScanReportItem[];
  title: string;
}

export interface AiScanEvidenceRow {
  label: string;
  value: string;
}

export interface AiScanAgentLogEntry {
  detail: string;
  label: string;
  time: string;
  tone: AiScanReportTone;
}

export interface AiScanRouteRecommendation {
  liveQuote?: {
    amountIn: string;
    amountOut: string;
    amountOutMin: string;
    direction: "buy" | "sell";
    provider: string;
  };
  matchedRoutes: TradeRouteDescriptor[];
  status: "recommended" | "review" | "blocked";
  summary: string;
}

export interface AiScanReport {
  address: string;
  agentLogs: AiScanAgentLogEntry[];
  ai?: {
    model: string;
    provider: "0g-compute-router";
    trace?: {
      billingTotalCost?: string;
      provider?: string;
      requestId?: string;
      teeVerified?: boolean;
    };
  };
  evidence: AiScanEvidenceRow[];
  mode: AiScanMode;
  network: {
    chainId: 16602 | 16661;
    id: OgNetworkId;
    label: string;
  };
  recommendation: string;
  routeRecommendation?: AiScanRouteRecommendation;
  scanId: string;
  score: number;
  sections: AiScanReportSection[];
  summary: string;
  targetLabel: string;
  targetType: AiScanTargetType;
  verdict: AiScanVerdict;
  verifiedToken?: AiScanVerifiedTokenProfile;
}

export interface AiScanRequest {
  address: string;
  model?: string;
  mode: AiScanMode;
  networkId: OgNetworkId;
  targetType: AiScanTargetType;
}

export interface AiScanResponse {
  data?: {
    report: AiScanReport;
  };
  error?: {
    code: string;
    message: string;
  };
  meta?: {
    network: {
      chainId: 16602 | 16661;
      id: OgNetworkId;
      label: string;
    };
    provider: "4lpha-ai-scan";
    rpcSource?: string;
  };
}

export interface AiScanModelCatalogResponse {
  data?: {
    defaultModel?: string;
    models: string[];
  };
  error?: {
    code: string;
    message: string;
  };
  meta?: {
    network: {
      chainId: 16602 | 16661;
      id: OgNetworkId;
      label: string;
    };
    provider: "0g-compute-router";
  };
}
