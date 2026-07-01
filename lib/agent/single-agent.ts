import type { Address, Hex } from "viem";
import type { AgentTradeReadiness } from "@/lib/types";

export const SINGLE_OG_AGENT_ID = "agent-0g-mainnet";
export const SINGLE_OG_AGENT_NAME = "4lpha 0G Vault Agent";

export function ogAgentIdFromTokenId(tokenId: string): string {
  return `${SINGLE_OG_AGENT_ID}-${tokenId}`;
}

export function isOgMainnetAgentId(agentId: string): boolean {
  return agentId === SINGLE_OG_AGENT_ID || /^agent-0g-mainnet-\d+$/u.test(agentId);
}

export type OgAgentFilterId = "capital-guard" | "blue-chip-rotation" | "stable-route" | "proof-strict";

export interface OgAgentFilterPreset {
  defaultAmount0G: string;
  description: string;
  id: OgAgentFilterId;
  label: string;
  maxSlippageBps: number;
  minOutBps: number;
  routeSymbols: string[];
  tone: "positive" | "neutral" | "warning";
}

export interface OgAgentDeploymentRecord {
  agentRef: string;
  createdAt: string;
  deployTxHash: Hex;
  filters: OgAgentFilterId[];
  id: string;
  identityAddress: Address;
  name: string;
  owner: Address;
  standard: "ERC-7857";
  standardNote: string;
  storageRef: string;
  storageRoot: Hex;
  tokenId: string;
  vault: Address;
  executor: Address;
  agentKey?: Hex;
  paused?: boolean;
  // Tx hash of the vault.setAgentKeyEnabled(agentKey, true) call that authorizes
  // this agent to trade on the Policy Vault. mintAgent only records the
  // vault/executor refs — it does NOT flip vault.agentKeyEnabled — so the key
  // must be enabled separately (the vault reverts any trade whose agentKey is
  // not enabled). Undefined when the deployer key is not the vault owner and
  // therefore cannot authorize the key (multi-user case: owner enables it).
  agentKeyEnableTxHash?: Hex;
  runtime?: OgAgentRuntimeSettings;
}

export interface OgRemovedAgentRecord extends OgAgentDeploymentRecord {
  agentKeyDisabledAt?: string;
  agentKeyDisableTxHash?: Hex;
  removeMode?: "soft-retire";
  removedAt: string;
  removedBy?: Address;
}

export interface OgAgentRuntimeSettings {
  maxCapitalPerTrade0G?: string;
  maxHoldingMinutes: number;
  maxPositions: number;
  signalConfidence: number;
  slippageBps: number;
}

export type OgAgentLogAction = "buy" | "sell" | "proof" | "quote" | "none";
export type OgAgentLogFilter = "blocked" | "executed" | "reasoning" | "skipped";
export type OgAgentLogStatus = "blocked" | "executed" | "ready" | "skipped";

export interface OgAgentLogEntry {
  action: OgAgentLogAction;
  createdAt: string;
  filter: OgAgentLogFilter;
  id: string;
  label?: string;
  notes: string[];
  proofTxHash?: string;
  quoteHash?: string;
  reason?: string;
  routeHash?: string;
  status: OgAgentLogStatus;
  storageRoot?: string;
  summary: string;
  txHash?: string;
}

export interface OgAgentVaultSnapshot {
  adapter?: Address;
  balance0G?: string;
  dailySpent0G?: string;
  executor?: Address;
  executorRevoked?: boolean;
  mockAdapterAllowed?: boolean;
  openExposure0G?: string;
  owner?: Address;
  paused?: boolean;
  policy?: {
    cooldownSeconds: string;
    dailyCap0G: string;
    defaultMinOutBps: number;
    maxDeadlineWindowSeconds: string;
    maxExposure0G: string;
    perTradeCap0G: string;
  };
  proofRegistry?: Address;
  ready: boolean;
  sellablePositions?: OgAgentVaultPosition[];
  vault?: Address;
  vaultVersion?: number;
  warnings: string[];
}

export interface OgAgentVaultPosition {
  amount: string;
  amountRaw: string;
  decimals: number;
  label: string;
  routeId: Hex;
  symbol: string;
  tokenAddress: Address;
}

export interface OgAgentStorageSnapshot {
  chainBlockNumber?: string;
  indexerUrl?: string;
  lagBlocks?: string;
  latestLogSyncHeight?: string;
  nodesChecked: number;
  ready: boolean;
  uploadReady: boolean;
  warnings: string[];
}

export interface OgAgentWorkspace {
  agent: {
    deployment: OgAgentDeploymentRecord | null;
    id: string;
    name: string;
    readiness: AgentTradeReadiness;
    status: "draft" | "armed" | "paused" | "blocked" | "removed";
  };
  agents: OgAgentDeploymentRecord[];
  filters: OgAgentFilterPreset[];
  identity: {
    address?: Address;
    configured: boolean;
    deployArtifact: boolean;
    label: "ERC-7857";
    note: string;
  };
  multiAgent: {
    enabled: false;
    label: "Coming soon";
  };
  logs: OgAgentLogEntry[];
  removedAgents: OgRemovedAgentRecord[];
  storage: OgAgentStorageSnapshot;
  vault: OgAgentVaultSnapshot;
}

export const OG_AGENT_FILTER_PRESETS: OgAgentFilterPreset[] = [
  {
    defaultAmount0G: "0.001",
    description: "Small live orders only; best first deployment profile for funded mainnet testing.",
    id: "capital-guard",
    label: "Capital guard",
    maxSlippageBps: 75,
    minOutBps: 9950,
    routeSymbols: ["USDC.e", "WETH", "WBTC"],
    tone: "positive",
  },
  {
    defaultAmount0G: "0.001",
    description: "High-confidence ZIA routes across USDC.e, WETH, WBTC, SOL, cbBTC, and LINK.",
    id: "blue-chip-rotation",
    label: "Blue-chip rotation",
    maxSlippageBps: 100,
    minOutBps: 9900,
    routeSymbols: ["USDC.e", "WETH", "WBTC", "SOL", "cbBTC", "LINK"],
    tone: "neutral",
  },
  {
    defaultAmount0G: "0.001",
    description: "Stable quote route for USDC.e only; useful for proof and storage smoke loops.",
    id: "stable-route",
    label: "Stable route",
    maxSlippageBps: 50,
    minOutBps: 9950,
    routeSymbols: ["USDC.e"],
    tone: "positive",
  },
  {
    defaultAmount0G: "0.001",
    description: "Requires storage evidence, policy hash, vault action hash, and Agentic ID ref before trade.",
    id: "proof-strict",
    label: "Proof strict",
    maxSlippageBps: 50,
    minOutBps: 9975,
    routeSymbols: ["USDC.e", "WETH"],
    tone: "warning",
  },
];

export function getAgentFilterPreset(id: string): OgAgentFilterPreset | undefined {
  return OG_AGENT_FILTER_PRESETS.find((filter) => filter.id === id);
}
