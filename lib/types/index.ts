import type { Address, Hex } from "viem";

export type OgNetworkId = "testnet" | "mainnet";

export interface OgNetworkConfig {
  chainId: 16602 | 16661;
  explorerUrl: string;
  faucetUrl?: string;
  id: OgNetworkId;
  label: string;
  networkName: string;
  nativeToken: "0G";
  readinessLabel: string;
  rpcUrl: string;
  storageIndexerUrl?: string;
}

export type EvidenceStatus = "verified" | "pending" | "mock";

export interface AuditEvidence {
  id: string;
  label: string;
  promptHash: string;
  responseHash: string;
  storageRoot: string;
  proofTxHash: string;
  status: EvidenceStatus;
  updatedAt: string;
}

export interface VaultPolicyPreview {
  arbitraryTarget: "denied";
  executorWithdrawal: "denied";
  maxSlippageBps: number;
  minAmountOutRequired: boolean;
  productionMockAdapter: "blocked";
  rawCalldataPassThrough: "denied";
  replayProtection: string;
}

export interface AgentRunPreview {
  action: "buy-review" | "sell-review" | "observe" | "blocked";
  agentId: string;
  evidenceId: string;
  id: string;
  policyDecision: string;
  status: EvidenceStatus;
  summary: string;
  timestamp: string;
}

export interface SignalCandidate {
  auditId: string;
  chainLabel: string;
  confidence: number;
  exposure: string;
  id: string;
  name: string;
  policyFit: "high" | "medium" | "blocked";
  signal: string;
  source: string;
}

export interface CopilotMessage {
  content: string;
  role: "operator" | "assistant";
}

export type CopilotContextKind = "audit" | "policy" | "proof" | "quote" | "route" | "trade";

export interface CopilotContextItem {
  kind: CopilotContextKind;
  label: string;
  value: string;
}

export interface CopilotAuditBundle {
  id: string;
  model: string;
  network: {
    chainId: 16602 | 16661;
    id: OgNetworkId;
    label: string;
  };
  operatorContextHash?: string;
  policyContextHash: string;
  promptHash: string;
  responseHash: string;
  routerBaseUrl: string;
  timestamp: string;
  trace?: {
    billingTotalCost?: string;
    provider?: string;
    requestId?: string;
    teeVerified?: boolean;
  };
}

export interface CopilotModelOption {
  id: string;
  label: string;
  source: "catalog" | "configured";
}

export interface CopilotChatResponse {
  data?: {
    auditBundle: CopilotAuditBundle;
    message: CopilotMessage;
  };
  error?: {
    code: string;
    message: string;
  };
  meta?: {
    provider: "0g-compute-router";
  };
}

export interface CopilotModelsResponse {
  data?: {
    defaultModel?: string;
    models: CopilotModelOption[];
    network: {
      chainId: 16602 | 16661;
      id: OgNetworkId;
      label: string;
    };
  };
  error?: {
    code: string;
    message: string;
  };
  meta?: {
    provider: "0g-compute-router";
  };
}

export type TradeRouteVenue = "ZIA" | "Oku";
export type TradeRouteConfidence = "high" | "medium" | "experimental";
export type TradeRouteDirection = "buy" | "sell";
export type TradeRouteQuoteProvider = "zia-quoter-v2" | "oku-quoter-v2";

export interface TradeRouteDescriptor {
  confidence: TradeRouteConfidence;
  factory: Address;
  fees: number[];
  id: Hex;
  label: string;
  path: Address[];
  pools: Address[];
  router: Address;
  symbol: string;
  tokenIn: Address;
  tokenOut: Address;
  venue: TradeRouteVenue;
}

export interface TradeRouteQuote {
  amountInFormatted: string;
  amountInRaw: string;
  amountOutFormatted: string;
  amountOutMinFormatted: string;
  amountOutMinRaw: string;
  amountOutRaw: string;
  blockNumber: string;
  direction: TradeRouteDirection;
  execution: {
    submitsTransaction: false;
    type: "quote-only";
  };
  gasEstimate?: string;
  quoteProvider: TradeRouteQuoteProvider;
  route: TradeRouteDescriptor;
  slippageBps: number;
}

export interface TradeRouteQuoteCandidate {
  error?: {
    code: string;
    message: string;
  };
  quote?: TradeRouteQuote;
  route: TradeRouteDescriptor;
  status: "quoted" | "unavailable";
}

export interface TradeRouteQuoteRequestEcho {
  amountInMode: "decimal" | "raw";
  direction: TradeRouteDirection;
  routeId?: Hex;
  slippageBps: number;
  symbol?: string;
  tokenOut?: Address;
  venue?: TradeRouteVenue;
}

export interface AgentTradeRouteCatalogResponse {
  data?: {
    execution: {
      submitsTransaction: false;
      type: "catalog-only";
    };
    network: {
      chainId: 16661;
      id: "mainnet";
      label: string;
    };
    routes: TradeRouteDescriptor[];
  };
  error?: {
    code: string;
    message: string;
  };
  meta?: {
    provider: "0g-mainnet-curated-routes";
    routeCount: number;
  };
}

export interface AgentTradeRouteQuoteResponse {
  data?: {
    alternates: TradeRouteQuoteCandidate[];
    execution: {
      submitsTransaction: false;
      type: "quote-only";
    };
    network: {
      blockNumber: string;
      chainId: 16661;
      id: "mainnet";
      label: string;
    };
    request: TradeRouteQuoteRequestEcho;
    selectedQuote: TradeRouteQuote;
  };
  error?: {
    code: string;
    message: string;
  };
  meta?: {
    provider: "0g-mainnet-curated-routes";
    rpcSource: "OG_MAINNET_RPC_URL" | "OG_RPC_URL" | "official-0g-mainnet-rpc";
  };
}

export type AgentTradeSide = "buy" | "sell";
export type AgentTradeIntent = "preview" | "execute";
export type AgentTradeBackendMode = "stub" | "wired";
export type AgentTradeReadiness = "ready" | "review" | "blocked";
export type AgentTradeExecutionStatus = "blocked" | "queued" | "stubbed" | "submitted";

export interface AgentTradeRouteOption {
  agentId: string;
  auditId: string;
  defaultAmountIn: string;
  defaultSide: AgentTradeSide;
  id: string;
  inputToken: string;
  label: string;
  maxAmountIn: string;
  minAmountOutRequired: boolean;
  networkId: OgNetworkId;
  outputToken: string;
  readiness: AgentTradeReadiness;
  tokenAddress?: Address;
  venue: string;
}

export interface AgentTradeRequest {
  agentId: string;
  amountIn: string;
  auditId?: string;
  intent: AgentTradeIntent;
  networkId: OgNetworkId;
  routeId: string;
  side: AgentTradeSide;
  slippageBps: number;
}

export interface AgentRouteQuote {
  amountIn: string;
  amountOutMin: string;
  expiresAt: string;
  expectedAmountOut: string;
  inputToken: string;
  outputToken: string;
  priceImpactBps: number;
  quoteHash: string;
  routeHash: string;
  routeId: string;
  routeLabel: string;
  side: AgentTradeSide;
  slippageBps: number;
  status: AgentTradeReadiness;
  venue: string;
  warnings: string[];
}

export interface AgentAuditProofPreview {
  auditId: string;
  generatedAt: string;
  policyDecision: "allow" | "review" | "reject";
  policyDecisionHash: string;
  proofTxHash: string;
  quoteHash: string;
  responseHash: string;
  routeHash: string;
  storageRoot: string;
  verificationStatus: EvidenceStatus;
}

export interface AgentTradePreview {
  backend: {
    message: string;
    mode: AgentTradeBackendMode;
    status: "available" | "stubbed";
  };
  policy: {
    deadlineRequired: true;
    executorScope: "bounded-vault-methods";
    minAmountOutRequired: true;
    recipient: "vault-owner";
  };
  proofBundle: AgentAuditProofPreview;
  quote: AgentRouteQuote;
  route: AgentTradeRouteOption;
}

export interface AgentTradeExecution {
  id: string;
  proofBundle: AgentAuditProofPreview;
  reason?: string;
  status: AgentTradeExecutionStatus;
  submittedAt: string;
  txHash?: string;
}

export interface AgentTradeResponse {
  data?: {
    execution?: AgentTradeExecution;
    preview: AgentTradePreview;
  };
  error?: {
    code: string;
    message: string;
  };
  meta?: {
    backend: AgentTradeBackendMode;
    network: {
      chainId: 16602 | 16661;
      id: OgNetworkId;
      label: string;
    };
    provider: "4lpha-agent-executor";
  };
}
