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
    auditBundle?: CopilotAuditBundle;
    message: CopilotMessage;
  };
  error?: {
    code: string;
    message: string;
  };
  meta?: {
    mode?: CopilotSessionMode;
    provider: "0g-compute-router";
  };
}

/**
 * Server-Sent Events emitted by the Copilot chat route while streaming a 0G
 * Compute Router response. The route always responds with `text/event-stream`
 * (even for deterministic short-circuits and errors) so the client has one
 * uniform consumption path. Each event is one `data: <json>\n\n` line.
 *
 * - `delta`: an incremental answer chunk — append to the streamed answer.
 * - `reasoning`: an incremental reasoning/thinking chunk (only when the model
 *   emits one, e.g. via `reasoning_content`/`reasoning`) — append to the
 *   thinking block.
 * - `done`: the stream finished. `content` is the final, markdown-normalized
 *   answer (the client replaces the streamed text with it); `auditBundle` is
 *   present only in saved mode.
 * - `error`: the stream failed; the client surfaces `message`.
 */
export type CopilotChatStreamEvent =
  | { type: "delta"; content: string }
  | { type: "reasoning"; content: string }
  | {
      type: "done";
      content: string;
      model: string;
      mode: CopilotSessionMode;
      auditBundle?: CopilotAuditBundle;
    }
  | { type: "error"; code: string; message: string };

/**
 * Copilot chat session storage mode.
 * - "saved" (default): the session transcript is encrypted client-side with a
 *   wallet-derived AES-256-GCM key, uploaded as one ciphertext file to 0G
 *   Storage, anchored on-chain via ProofRegistry.acceptProof (DEPLOYER pays
 *   gas), and recorded in a per-wallet registry so the user can retrieve it.
 * - "privacy": ephemeral. No 0G Storage upload, no on-chain proof, no audit
 *   bundle returned to the client. Messages live in RAM only and are cleared
 *   when the session closes. The 0G Compute Router is still called for the LLM
 *   response, but nothing is retained.
 */
export type CopilotSessionMode = "saved" | "privacy";

/**
 * A single message in a saved Copilot session transcript. Mirrors the
 * component-local EmbeddedCopilotMessage shape but with an opaque card field so
 * the storage layer does not depend on the component module.
 */
export interface CopilotSessionMessage {
  content: string;
  role: "operator" | "assistant";
  status?: "error" | "pending";
  card?: unknown;
  reasoning?: string;
}

/**
 * Plaintext Copilot session bundle, before client-side encryption. This is the
 * shape that gets serialized (stable JSON) and AES-GCM encrypted before upload
 * to 0G Storage. The server only ever sees the ciphertext.
 */
export interface CopilotSessionBundle {
  schemaVersion: 1;
  kind: "copilot-session";
  sessionId: string;
  wallet: { address: string; chainId: number; networkId: OgNetworkId };
  createdAt: string;
  updatedAt: string;
  mode: Extract<CopilotSessionMode, "saved">;
  model: string;
  networkLabel: string;
  messages: CopilotSessionMessage[];
  auditBundles: CopilotAuditBundle[];
}

/**
 * Per-wallet registry record for a saved Copilot session. Stored as JSON at
 * `.data/copilot-sessions/<wallet-lowercase>.json`. The 0G Storage upload itself
 * is immutable; deleting a record only unlists it from the local registry.
 */
export interface CopilotSessionRegistryRecord {
  sessionId: string;
  wallet: string;
  networkId: OgNetworkId;
  chainId: 16661;
  createdAt: string;
  updatedAt: string;
  mode: Extract<CopilotSessionMode, "saved">;
  model: string;
  rootHash: Hex;
  storageRef: string;
  proofTxHash: Hex;
  actionHash: Hex;
  messageCount: number;
  label?: string;
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
export type AgentTradeBackendMode = "stub" | "unavailable" | "wired";
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

/** Public, redacted record returned by the Galileo-only roster endpoint. */
export interface GalileoPublicAgentRecord {
  agentKey: Hex;
  agentRef: string;
  chainId: 16602;
  createdAt: string;
  storageRef: string;
  storageRoot: Hex;
  storageVerified: true;
  vault: Address;
}

export interface GalileoAgentRosterResponse {
  data?: {
    agents: GalileoPublicAgentRecord[];
    chainId: 16602;
    networkId: "testnet";
  };
  error?: {
    code: string;
    message: string;
  };
}

/**
 * Server-normalized tuple that is prepared before a Galileo owner signs. It
 * deliberately contains no signature or service-wallet material.
 */
export interface GalileoTradeConsentRequest {
  action: "trade";
  chainId: 16602;
  clientRequestId: string;
  networkId: "testnet";
  owner: Address;
  trade: {
    adapter: Address;
    agentKey: Hex;
    agentRef: string;
    amountIn: string;
    minOut: string;
    payloadDigest: Hex;
    policyHash: Hex;
    poolId: Hex;
    quoteBlock: string;
    quoteExpiry: number;
    reserveNative: string;
    reserveToken: string;
    side: AgentTradeSide;
    trustedQuote: string;
    vault: Address;
  };
}

export interface GalileoTradeConsentIssue {
  consentMessage: string;
  expiresAt: number;
  nonce: string;
  prepareId: string;
}

export interface GalileoTradeConsentSubmission extends GalileoTradeConsentIssue {
  wallet: {
    address: Address;
    chainId: 16602;
    message: string;
    signature: Hex;
  };
}

export interface GalileoTradePreviewDetails {
  adapter: Address;
  agentKey: Hex;
  agentKeyEnabled: boolean;
  agentRef: string;
  amountOutMin: string;
  consentRequest?: GalileoTradeConsentRequest;
  cooldownReady: boolean;
  dailyCapRemaining: string;
  decisionReason?: string;
  executorRevoked: boolean;
  feeBps: number;
  poolId: Hex;
  priceImpactBps: string;
  policyHash: Hex;
  poolNativeReserve: string;
  poolTokenReserve: string;
  quoteBlock: string;
  sellableInventory: string;
  storageAvailable: boolean;
  trustedQuote: string;
  userMinOut: string;
  vault: Address;
  vaultBalance: string;
  vaultMinOut: string;
  vaultPaused: boolean;
}

export interface GalileoTradeEvidence {
  proofTxHash?: Hex;
  storageRef?: string;
  storageRoot?: Hex;
  storageTxHash?: Hex;
  tradeTxHash?: Hex;
}

export interface AgentTradeRequest {
  agentId: string;
  amountIn: string;
  auditId?: string;
  chainId?: 16602;
  clientRequestId?: string;
  galileoConsent?: GalileoTradeConsentSubmission;
  intent: AgentTradeIntent;
  networkId: OgNetworkId;
  ownerAddress?: Address;
  routeId: string;
  side: AgentTradeSide;
  slippageBps: number;
  vaultAddress?: Address;
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
  galileo?: GalileoTradePreviewDetails;
  quote: AgentRouteQuote;
  route: AgentTradeRouteOption;
  vaultAddress?: Address;
}

export interface AgentTradeExecution {
  galileo?: GalileoTradeEvidence;
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
