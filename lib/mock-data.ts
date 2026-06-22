import type {
  AgentRunPreview,
  AuditEvidence,
  SignalCandidate,
  VaultPolicyPreview,
} from "@/lib/types";

export const auditEvidence: AuditEvidence[] = [
  {
    id: "audit-042",
    label: "Galileo Run",
    promptHash: "0x9b31f2a4c98d5b44c3e870f013d04a7f2e1c88bc798b2f4d85bfc9721200a11a",
    proofTxHash: "0xe50f6aab28f421ca89dca3204f72893ef45114cd23003b920c40b14a03ff9912",
    responseHash: "0x38db43e51ff8f904a3a1002d3d9d1df2436f581a2b91ea0a719f04dc9e582311",
    status: "mock",
    storageRoot: "0x7a684a33f07c58bd9176c014355f698e1b30ddadc5e847a90406c2a421c01a44",
    updatedAt: "2m ago",
  },
  {
    id: "audit-041",
    label: "Policy Bundle",
    promptHash: "0x1e88a03c06ea335f83c86f88647b756fb12b3f839f9b1e40971206244d4d83b5",
    proofTxHash: "0x49d705133ea751a0e316f2ad9f43ceacfed728a4bb7c28c93498fcfbdb95ad62",
    responseHash: "0xa229d88b1e98310854e0c385f98d608f1294413f6f440f54a615b22a01fdbe76",
    status: "pending",
    storageRoot: "0x804bb4bc5b6f7c1e5e2747749f943a652a83b1d11374e0595f8c96268ff42e19",
    updatedAt: "11m ago",
  },
  {
    id: "audit-040",
    label: "Vault Hash",
    promptHash: "0x6813a4debc2e3d5b0b6e3c8ec27007ced5ad3e542ccdf516bce3805125e5da22",
    proofTxHash: "0x905eca391f8a3c715e02c0c1af057cc7d83e6ba5d15ed27b4d7c65b870a4ed14",
    responseHash: "0x15bed40895df457a6d777b6f4a71dedad4076a5642d548d80efa65f703dc9d63",
    status: "mock",
    storageRoot: "0x323844365b5c0f47c202f386094dc443bdfa7d11e4bfdb6e5b71e9c33e53b501",
    updatedAt: "26m ago",
  },
];

export const signalCandidates: SignalCandidate[] = [
  {
    auditId: "audit-042",
    chainLabel: "Galileo",
    confidence: 84,
    exposure: "0.18 0G",
    id: "sig-orion",
    name: "Orion",
    policyFit: "high",
    signal: "Storage-backed trend and amount-out guard clear",
    source: "0G Storage replay bundle",
  },
  {
    auditId: "audit-041",
    chainLabel: "Galileo",
    confidence: 73,
    exposure: "0.11 0G",
    id: "sig-helix",
    name: "Helix",
    policyFit: "medium",
    signal: "Compute review passed, slippage guard tight",
    source: "0G Compute Router mock",
  },
  {
    auditId: "audit-040",
    chainLabel: "Galileo",
    confidence: 51,
    exposure: "blocked",
    id: "sig-vector",
    name: "Vector",
    policyFit: "blocked",
    signal: "Amount-out guard unavailable",
    source: "Vault policy simulator",
  },
];

export const vaultPolicy: VaultPolicyPreview = {
  arbitraryTarget: "denied",
  executorWithdrawal: "denied",
  maxSlippageBps: 75,
  minAmountOutRequired: true,
  productionMockAdapter: "blocked",
  rawCalldataPassThrough: "denied",
  replayProtection: "nonce + deadline",
};

export const agentRuns: AgentRunPreview[] = [
  {
    action: "buy-review",
    agentId: "agent-aura",
    evidenceId: "audit-042",
    id: "run-187",
    policyDecision: "allow mock buy",
    status: "mock",
    summary: "Buy path stayed proof-bound with nonzero min-out.",
    timestamp: "09:41",
  },
  {
    action: "observe",
    agentId: "agent-aura",
    evidenceId: "audit-041",
    id: "run-186",
    policyDecision: "observe only",
    status: "pending",
    summary: "Signal score rose, but daily exposure is near review threshold.",
    timestamp: "09:29",
  },
  {
    action: "blocked",
    agentId: "agent-kepler",
    evidenceId: "audit-040",
    id: "run-185",
    policyDecision: "reject",
    status: "mock",
    summary: "Rejected because the route did not provide amount-out protection.",
    timestamp: "09:12",
  },
];
