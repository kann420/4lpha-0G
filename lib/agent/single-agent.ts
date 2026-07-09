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

export type OgAgentFilterId = "capital-guard" | "blue-chip-rotation" | "stable-route" | "proof-strict" | "lp-zia";

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
  // v2 -> v3 migration: the prior V2 vault this agent was moved off of, and when.
  // Present only after a successful migrate-vault round; the active `vault` field
  // above is the V3 singleton the agent now trades through.
  migratedFromVault?: Address;
  migratedAt?: string;
  vaultVersion?: number;
  v4SwapVault?: Address;
  v4LpEntryVault?: Address;
  v4LpExitVault?: Address;
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
  minAprPct?: number;
  maxAprPct?: number | null;
  // Agent-enforced per-position cap (create-form "Max 0G/position"). The brain
  // clamps each mint's amount0G to this value server-side; the vault is NOT
  // tightened — the owner's on-chain caps stay as the hard backstop. Decimal
  // string (0G, not wei).
  maxPerPosition0G?: string;
  signalConfidence: number;
  slippageBps: number;
  // LP automation. autoMint=true opts the agent into the autonomous LP mint
  // loop (scripts/og-agent-lp-worker.ts), which mints positions within the
  // vault's on-chain fence when the agent has idle balance and is off cooldown.
  // Defaults to true for LP agents at deploy (lib/agent/lp/lp-deploy.ts passes
  // runtime.automation.autoMint=true); the worker mints when idle balance +
  // cooldown allow. The owner can toggle it off via the detail-page toggle /
  // POST /api/agents/lp/[id]/automation.
  automation?: {
    autoMint?: boolean;
  };
}

export type OgAgentLogAction =
  | "buy"
  | "sell"
  | "proof"
  | "quote"
  | "none"
  | "lp-mint"
  | "lp-stake"
  | "lp-unstake"
  | "lp-zap-out"
  | "withdraw-native";
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
  v4SwapVault?: Address;
  v4LpEntryVault?: Address;
  v4LpExitVault?: Address;
  v4SwapBalance0G?: string;
  v4LpEntryBalance0G?: string;
  v4LpExitBalance0G?: string;
  warnings: string[];
  // LP fields. Present when vaultVersion >= 3 and the resolved vault has an LP adapter.
  lpAdapter?: Address;
  lpPolicy?: {
    perLpActionCap0G: string;
    lpDailyCap0G: string;
    maxLpExposure0G: string;
    cooldownSecondsLp: string;
    lpMinOutBps: number;
    minLiquidityFloor: string;
    allowStaking: boolean;
    lpMaxPositions?: number;
    // Vault-wide per-action ceiling. Agent-level Max 0G/position lives in
    // deployment.runtime.maxPerPosition0G and may be stricter.
    lpMaxPerPosition0G?: string;
  };
  lpDailySpent0G?: string;
  openLpExposure0G?: string;
  sellableLpPositions?: OgAgentVaultLpPosition[];
}

export interface OgAgentVaultPosition {
  amount: string;
  amountRaw: string;
  decimals: number;
  label: string;
  routeId: Hex;
  symbol: string;
  tokenAddress: Address;
  // Absolute https logo URL for the position avatar, or null when Zia has no
  // usable logo for that token (falls back to an initials avatar in the UI).
  logoUrl?: string | null;
}

export interface OgAgentVaultLpPosition {
  tokenId: string;
  poolId: Hex;
  poolAddress: Address;
  poolLabel: string;
  tickLower: number;
  tickUpper: number;
  deployedNative0G: string;
  liquidity: string;
  staked: boolean;
  stakeVault?: Address;
  // Real per-position accounting (populated for V3 vaults with a live Zia pool
  // read). All optional — when absent the UI shows "—" rather than fake numbers.
  token0Symbol?: string;
  token1Symbol?: string;
  // Absolute https logo URL for the pair icon, or null when Zia has no usable
  // logo for that token (falls back to an initials avatar in the UI).
  token0LogoUrl?: string | null;
  token1LogoUrl?: string | null;
  token0Decimals?: number;
  token1Decimals?: number;
  // Human-readable leg amounts from getAmountsForLiquidity (decimal string).
  amount0?: string;
  amount1?: string;
  // Unclaimed fees from NFPM positions() tokensOwed0/1 (honest on-chain value;
  // may be 0 for staked positions — shown as the real number, no caveat).
  unclaimedFee0?: string;
  unclaimedFee1?: string;
  // Per-leg USD value (for the Assets % breakdown). Null when prices are missing.
  leg0USD?: number | null;
  leg1USD?: number | null;
  // USD-denominated current value + entry cost (deployedNative0G × W0G price).
  valueUSD?: number;
  entryUSD?: number;
  unrealizedPnlUSD?: number;
  unrealizedPnlPct?: number;
  unrealizedPnlTone?: "success" | "danger" | "neutral";
  // APR presentation. staked → stakingAprPct (earning staking rewards); !staked
  // → tradingAprPct (trading fees only). aprStatus "unknown" when the Zia APR
  // fields are missing; aprPct is null and the UI shows "—".
  aprPct?: number | null;
  stakingAprPct?: number | null;
  tradingAprPct?: number | null;
  aprStatus?: "staked-earning" | "unstaked-trading-only" | "unknown";
  // User-facing price range (task 2): USD bounds at tickLower/tickUpper for the
  // non-stable leg. priceLabelSymbol is the leg chosen for display.
  priceLowerUSD?: number | null;
  priceUpperUSD?: number | null;
  priceLabelSymbol?: string;
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
  {
    // LP Agent filter. The LP path uses the vault's LpPolicy (lpMinOutBps,
    // perLpActionCap0G, maxLpExposure0G) rather than the swap-path fields below,
    // but the preset shape is shared with swap filters so the swap-path values
    // are vestigial defaults here. routeSymbols lists the LP leg (W0G) so the
    // metadata payload is honest about what this agent touches.
    defaultAmount0G: "0.05",
    description: "0G-native Zia Uniswap v3 LP agent. Single-sided 0G zap-in mints through the Policy Vault V3 LP adapter; the vault enforces the LP fence on-chain.",
    id: "lp-zia",
    label: "LP · Zia v3",
    maxSlippageBps: 50,
    minOutBps: 9950,
    routeSymbols: ["W0G"],
    tone: "neutral",
  },
];

export function getAgentFilterPreset(id: string): OgAgentFilterPreset | undefined {
  return OG_AGENT_FILTER_PRESETS.find((filter) => filter.id === id);
}
