import "server-only";

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  createPublicClient,
  createWalletClient,
  formatEther,
  formatUnits,
  getAddress,
  http,
  isAddress,
  isHex,
  keccak256,
  parseAbiItem,
  toBytes,
  zeroAddress,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { agenticIdAbi, agentMintedEvent, type AgenticIdIntelligentData } from "@/lib/contracts/agentic-id";
import { agentKeyForDeployment, OgAgentDeployError } from "@/lib/agent/agent-deploy-common";
import { CURATED_MAINNET_POLICY_VAULT_ROUTES } from "@/lib/contracts/curated-routes";
import { policyVaultAbi, policyVaultAgentKeyAbi } from "@/lib/contracts/policy-vault";
import { LP_ACTION_TYPE, normalizePolicyVaultV3Policy, policyVaultV3Abi, policyVaultV3LpAbi } from "@/lib/contracts/policy-vault-v3";
import { deriveMaxPositions } from "@/lib/agent/lp/lp-fence";
import { computeLpPositionAccounting, type LpPoolMeta } from "@/lib/agent/lp/lp-position-accounting";
import { readLpPositionRegistry } from "@/lib/agent/lp/lp-position-registry";
import { ZIA_LP_VAULTS, findZiaLpVaultByPool, poolIdFromAddress, ziaNonfungiblePositionManagerAbi, uniswapV3PoolAbi, ZIA_LP_MAINNET } from "@/lib/contracts/zia-lp";
import { getZiaPool, getZiaTokenLogoUrl } from "@/lib/integrations/zia-tradegpt";
import {
  readConfiguredMainnetVaultAddress,
  readConfiguredMainnetV3VaultAddress,
  readMainnetOwnerAddress,
  resolveMainnetVaultForOwner,
  resolveMainnetVaultVersionsForOwner,
  resolveMainnetV3VaultForOwner,
  resolveMainnetV4VaultForOwner,
} from "@/lib/agent/mainnet-vault-resolver";
import { policyVaultV4LpEntryAbi, policyVaultV4LpExitAbi, policyVaultV4SwapAbi } from "@/lib/contracts/policy-vault-v4";
import { getOgNetwork } from "@/lib/og/networks";
import { makeMainnetTransport } from "@/lib/og/mainnet-rpc";
import { downloadBytesFrom0GStorage } from "@/lib/og/storage-download";
import { uploadBytesTo0GStorage, type ZeroGStorageProgress } from "@/lib/og/storage-upload";
import {
  getAgentFilterPreset,
  OG_AGENT_FILTER_PRESETS,
  SINGLE_OG_AGENT_ID,
  SINGLE_OG_AGENT_NAME,
  ogAgentIdFromTokenId,
  type OgAgentDeploymentRecord,
  type OgAgentFilterId,
  type OgAgentLogEntry,
  type OgRemovedAgentRecord,
  type OgAgentRuntimeSettings,
  type OgAgentStorageSnapshot,
  type OgAgentVaultPosition,
  type OgAgentVaultLpPosition,
  type OgAgentWorkspace,
  type OgAgentVaultSnapshot,
} from "@/lib/agent/single-agent";
import { readOgAgentRuns } from "@/lib/agent/runtime/store";
import { readOgAgentLpRuns } from "@/lib/agent/runtime/lp-store";
import type { OgAgentLpRunRecord, OgAgentRuntimeRunRecord } from "@/lib/agent/runtime/types";

const MAINNET_CHAIN_ID = 16661;
const AGENT_DATA_DIR = resolveAgentDataDir();
const AGENT_REGISTRY_PATH = join(AGENT_DATA_DIR, "mainnet-agents.json");
const LEGACY_AGENT_DEPLOYMENT_PATH = join(AGENT_DATA_DIR, "mainnet-single-agent.json");
const LEGACY_AGENT_DEPLOY_RESPONSE_PATH = join(AGENT_DATA_DIR, "deploy-response.json");
const AGENT_STORAGE_PENDING_PATH = join(AGENT_DATA_DIR, "mainnet-agent-storage-pending.json");
const AGENT_TRADE_ARTIFACT_DIR = join(AGENT_DATA_DIR, "trades");
const LEGACY_AGENT_TRADE_EXECUTION_PATH = join(AGENT_DATA_DIR, "trade-execution-response.json");
const LEGACY_AGENT_SELL_EXECUTION_PATH = join(AGENT_DATA_DIR, "sell-execution-response.json");
const AGENTIC_ID_DEPLOYMENT_PATH = join(".data", "deployments", "mainnet-agentic-id.json");
const MAX_STORAGE_SYNC_LAG_BLOCKS = 120n;
const STORAGE_SNAPSHOT_CACHE_TTL_MS = 60_000;
const WORKSPACE_READ_TIMEOUT_MS = 6_000;
const AUXILIARY_READ_TIMEOUT_MS = 2_500;
// LP listing (public-RPC getLogs + ~7 scalar reads per position + pool meta) is
// heavier than a single scalar read. The public 0G RPC does 10 positions in
// ~1.4s idle, but under load it can exceed the 2.5s auxiliary budget — and the
// caller's `.catch(() => [])` then silently drops ALL positions (Bug 1
// flicker). Give the LP listing its own budget so it does not get starved by the
// generic auxiliary timeout.
const LP_LISTING_TIMEOUT_MS = 12_000;
const ON_CHAIN_ROSTER_READ_TIMEOUT_MS = WORKSPACE_READ_TIMEOUT_MS;
const AGENT_METADATA_READ_TIMEOUT_MS = 3_000;
const OG_RPC_TIMEOUT_MS = 4_000;
const STANDARD_LABEL = "ERC-7857" as const;
const STANDARD_NOTE =
  "Implements the canonical ERC-7857 Agentic ID: identity minting, encrypted metadata hash anchoring, and authorized usage are real on-chain identity anchored to the policy vault and audit root. Re-key transfer (iTransfer/iClone) requires a real TEE/ZKP verifier producing TransferValidityProofs; it is intentionally disabled in the server path until such a verifier is wired.";

// TRANSFER PATH GUARD: do NOT call AgenticID.iTransfer/iClone from this server.
// They require real TEE/ZKP TransferValidityProofs; no such verifier is wired and
// MockAgentDataVerifier must never be used as the live mainnet verifier (see
// AGENTS.md). These functions remain callable on-chain but are not part of any
// production write path here. Any future verifier wiring must route through
// assertMainnetDeployEnv / chainId === 16661.

function resolveAgentDataDir(): string {
  const configured = process.env.OG_AGENT_DATA_DIR?.trim();
  if (configured) return configured;

  const railwayVolumeMount = process.env.RAILWAY_VOLUME_MOUNT_PATH?.trim();
  return railwayVolumeMount ? join(railwayVolumeMount, "agents") : join(".data", "agents");
}

let storageSnapshotCache:
  | {
      expiresAt: number;
      key: string;
      promise: Promise<OgAgentStorageSnapshot>;
    }
  | null = null;

const tradeExecutedEvent = parseAbiItem(
  "event TradeExecuted(bytes32 indexed actionHash, bool indexed isBuy, address indexed token, uint256 amountIn, uint256 amountOut, bytes32 auditRoot, bytes32 policySnapshotHash)",
);
const tradeExecutedV2Event = parseAbiItem(
  "event TradeExecutedV2(bytes32 indexed actionHash, bytes32 indexed agentKey, bool indexed isBuy, address token, uint256 amountIn, uint256 amountOut, bytes32 auditRoot, bytes32 policySnapshotHash)",
);
const lpActionExecutedV3Event = parseAbiItem(
  "event LpActionExecutedV3(bytes32 indexed actionHash, bytes32 indexed agentKey, uint8 indexed actionType, bytes32 poolId, uint256 tokenId, uint256 amountIn0G, uint256 amountOut, int256 liquidityDelta, bytes32 auditRoot, bytes32 policySnapshotHash)",
);

// LP listing reads (getLogs + per-token scalar reads) go through the PUBLIC
// 0G RPC, not quiknode. The quiknode RPC (OG_RPC_URL) caps eth_getLogs at a
// 5-block range on the discover plan AND rate-limits to ~52 reads/min — so the
// LP listing (one getLogs + ~7 reads per position) 429s/times out on quiknode
// and the UI flickers empty (Bug 1). The public 0G RPC (the documented mainnet
// endpoint in AGENTS.md, not a secret) has no getLogs cap, but IT also rate-
// limits: ~50 requests per burst. 10 positions × 7 per-token reads = 70 reads
// fired in parallel exceed that burst cap → "request rate exceeded" → the
// caller's .catch(()=>[]) silently drops ALL positions (Bug 1 under load).
// Mitigation: the per-token reads are chunked (LP_LISTING_CHUNK_SIZE) AND the
// lpClient has a generous retryCount so viem backs off transient 429s.
// Configurable via OG_PUBLIC_RPC_URL.
let lpListingClient: PublicClient | null = null;
function getLpListingClient(): PublicClient {
  if (lpListingClient) return lpListingClient;
  const rpcUrl = process.env.OG_PUBLIC_RPC_URL?.trim() || "https://evmrpc.0g.ai";
  const retryCount = Number(process.env.OG_PUBLIC_RPC_RETRY_COUNT ?? 6);
  const retryDelay = Number(process.env.OG_PUBLIC_RPC_RETRY_DELAY_MS ?? 250);
  lpListingClient = createPublicClient({
    chain: make0GMainnetChain(rpcUrl),
    transport: http(rpcUrl, {
      retryCount: Number.isFinite(retryCount) && retryCount >= 0 ? retryCount : 6,
      retryDelay: Number.isFinite(retryDelay) && retryDelay >= 0 ? retryDelay : 250,
      timeout: OG_RPC_TIMEOUT_MS,
    }),
  });
  return lpListingClient;
}
// Max positions read per parallel chunk. Each position fires 7 readContract
// calls in parallel, and the public 0G RPC bursts at ~50 reqs — 3 positions =
// 21 parallel reqs per chunk, safely under the cap. Chunks run sequentially.
const LP_LISTING_CHUNK_SIZE = 3;

// Vault deploy block cache — the getLogs fallback narrows the range to
// [deployBlock, latest] so the public RPC getLogs stays small + fast even for
// agents deployed days ago. Cached per deployTxHash so the 30s UI poll does not
// re-fetch the receipt every cycle.
const lpDeployBlockCache = new Map<Hex, bigint>();
async function getLpDeployBlock(client: PublicClient, deployTxHash: Hex): Promise<bigint | undefined> {
  const cached = lpDeployBlockCache.get(deployTxHash);
  if (cached !== undefined) return cached;
  const receipt = await client.getTransactionReceipt({ hash: deployTxHash }).catch(() => null);
  if (!receipt) return undefined;
  lpDeployBlockCache.set(deployTxHash, receipt.blockNumber);
  return receipt.blockNumber;
}

const erc20DecimalsAbi = [
  {
    inputs: [],
    name: "decimals",
    outputs: [{ internalType: "uint8", name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export { agentKeyForDeployment, OgAgentDeployError } from "@/lib/agent/agent-deploy-common";

export interface DeploySingleOgAgentInput {
  allowZeroVaultBalance?: boolean;
  filterIds: OgAgentFilterId[];
  name: string;
  ownerAddress?: Address;
  runtime?: Partial<OgAgentRuntimeSettings>;
}

export interface LoadOgAgentWorkspaceInput {
  agentId?: string;
  live?: boolean;
  ownerAddress?: Address | string | null;
}

interface AgenticIdDeploymentArtifact {
  agenticId?: Address;
  address?: Address;
  chainId?: number;
  txHash?: Hex;
}

interface AgentDeploymentRegistryArtifact {
  agents: OgAgentDeploymentRecord[];
  removedAgentIds?: string[];
  removedAgents?: OgRemovedAgentRecord[];
  updatedAt: string;
}

interface LegacyDeployResponseArtifact {
  data?: {
    deployment?: OgAgentDeploymentRecord;
  };
}

interface PendingAgentStorageArtifact {
  agentRef: string;
  createdAt: string;
  payload: unknown;
  rootHash: Hex;
  status: "prepared" | "submitted" | "uploaded";
  txHash?: Hex;
  txSeq?: number;
}

export interface StoredAgentTradeArtifact {
  data?: {
    execution?: {
      id?: string;
      proofBundle?: {
        policyDecision?: "allow" | "review" | "reject";
        policyDecisionHash?: string;
        proofTxHash?: string;
        quoteHash?: string;
        routeHash?: string;
        storageRoot?: string;
        verificationStatus?: string;
      };
      reason?: string;
      status?: string;
      submittedAt?: string;
      txHash?: string;
    };
    preview?: {
      backend?: {
        message?: string;
      };
      proofBundle?: {
        policyDecision?: "allow" | "review" | "reject";
        policyDecisionHash?: string;
      };
      quote?: {
        amountIn?: string;
        amountOutMin?: string;
        expectedAmountOut?: string;
        inputToken?: string;
        outputToken?: string;
        quoteHash?: string;
        routeHash?: string;
        routeLabel?: string;
        side?: "buy" | "sell";
        slippageBps?: number;
        venue?: string;
        warnings?: string[];
      };
    };
  };
}

export type StoredAgentTradeSide = "buy" | "sell";

// Short-TTL cache + in-flight de-dup for live workspace reads. A single page
// visit can otherwise trigger several near-simultaneous identical loads (the
// wallet-hydration mount race, list-page-then-detail-page navigation, the 30s
// UI poll) each re-running the full RPC/roster/LP-position fan-out. Callers
// that mutate agent state (mint/stake/unstake/zap-out/pause/resume/remove/
// policy/automation) MUST call invalidateOgAgentWorkspaceCache() after a
// successful write so the client's immediate follow-up refresh is never
// served stale pre-mutation data.
const AGENT_WORKSPACE_CACHE_TTL_MS = 4_000;
const agentWorkspaceCache = new Map<string, { expiresAt: number; promise: Promise<OgAgentWorkspace> }>();

function agentWorkspaceCacheKey(agentId: string | undefined, ownerAddress: Address | undefined, live: boolean): string {
  return `${agentId ?? ""}:${ownerAddress?.toLowerCase() ?? ""}:${live ? "1" : "0"}`;
}

export function invalidateOgAgentWorkspaceCache(): void {
  agentWorkspaceCache.clear();
}

export async function loadOgAgentWorkspace(input?: string | LoadOgAgentWorkspaceInput): Promise<OgAgentWorkspace> {
  const normalized = normalizeWorkspaceInput(input);
  if (!normalized.live) {
    return loadOgAgentWorkspaceUncached(normalized);
  }
  const key = agentWorkspaceCacheKey(normalized.agentId, normalized.ownerAddress, normalized.live);
  const cached = agentWorkspaceCache.get(key);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.promise;
  }
  const promise = loadOgAgentWorkspaceUncached(normalized).catch((error: unknown) => {
    // Never let a failed load poison the cache for the next (retried) call.
    if (agentWorkspaceCache.get(key)?.promise === promise) {
      agentWorkspaceCache.delete(key);
    }
    throw error;
  });
  agentWorkspaceCache.set(key, { expiresAt: now + AGENT_WORKSPACE_CACHE_TTL_MS, promise });
  return promise;
}

async function loadOgAgentWorkspaceUncached(
  normalized: { agentId?: string; live: boolean; ownerAddress?: Address },
): Promise<OgAgentWorkspace> {
  const { agentId, live, ownerAddress } = normalized;
  const identity = await resolveAgenticIdAddress();
  const workspaceTimeoutMs = live ? WORKSPACE_READ_TIMEOUT_MS : AUXILIARY_READ_TIMEOUT_MS;
  let [vault, storage] = await Promise.all([
    withTimeout(readVaultSnapshot(undefined, { ownerAddress }), workspaceTimeoutMs, "Policy Vault state").catch((error): OgAgentVaultSnapshot => ({
      owner: ownerAddress,
      ready: false,
      warnings: [error instanceof Error ? error.message : "Unable to read Policy Vault state."],
    })),
    live ? withTimeout(readStorageSnapshot(), WORKSPACE_READ_TIMEOUT_MS, "0G Storage state").catch((error): OgAgentStorageSnapshot => ({
      nodesChecked: 0,
      ready: false,
      uploadReady: false,
      warnings: [error instanceof Error ? error.message : "Unable to read 0G Storage state."],
    })) : Promise.resolve({
      nodesChecked: 0,
      ready: false,
      uploadReady: false,
      warnings: ["Live 0G Storage check deferred for fast UI load."],
    } satisfies OgAgentStorageSnapshot),
  ]);
  // Do NOT scope by vaultAddress here. A V4 owner can have multiple agents
  // each on their own dedicated Swap/LpEntry/LpExit trio (e.g. one predating
  // a registry redeploy, one after) — `vault.vault` is only ONE resolved
  // trio, and the on-chain V4 registry stores a single vaultOf(owner) slot
  // that the most recent registration overwrites. Filtering the roster to
  // that one resolved vault silently drops every other legitimate agent for
  // this owner. `assertAgentTypeQuota` already relies on ownerAddress-only
  // scoping + filterActiveOnChainAgentRecords' per-deployment vault check for
  // exactly this reason — match that pattern here.
  let roster = await readAgentDeploymentRoster(identity.address, {
    agentId,
    includeOnChain: live,
    ownerAddress: vault.owner ?? ownerAddress,
  });
  debugAgentWorkspaceSelection({
    agentId,
    live,
    ownerAddress,
    rosterActiveIds: roster.active.map((deployment) => deployment.id),
    vaultAddress: vault.vault,
    vaultOwner: vault.owner,
    vaultReady: vault.ready,
    vaultVersion: vault.vaultVersion,
    v4LpEntryVault: vault.v4LpEntryVault,
    v4SwapVault: vault.v4SwapVault,
  });
  let deployments = roster.active;
  let removedDeployments = roster.removed;
  let deployment = selectAgentDeployment(deployments, agentId);
  let removedDeployment = deployment ? null : selectRemovedAgentDeployment(removedDeployments, agentId);
  const selectedVaultMatchesDeployment = deployment && vault.vault
    ? deploymentMatchesVaultAddress(deployment, vault.vault)
    : false;
  if (deployment && !selectedVaultMatchesDeployment) {
    // `vault` was resolved generically for the owner (vaultOf(owner) — a
    // SINGLE on-chain registry slot), but this deployment's own vault trio
    // does not match it. A V4 owner can have multiple agents, each on its own
    // dedicated Swap/LpEntry/LpExit trio registered at different times — the
    // registry slot only ever reflects the MOST RECENTLY registered one, so
    // re-resolving via readVaultSnapshot(ownerAddress) would just return that
    // SAME wrong trio again. Read directly from THIS deployment's own known
    // vault addresses instead (roster/deployment selection above is already
    // owner-scoped and unaffected by this — only `vault` itself is stale).
    if (deployment.v4SwapVault && deployment.vault && deployment.v4LpExitVault) {
      // Use the public RPC (getLpListingClient), not quiknode. This read fires
      // ~24 parallel calls across 3 contracts — quiknode's ~52 reads/min cap
      // makes that batch time out under load (confirmed: 6s timeout wipes
      // `vault.vault`, which then silently skips the LP-position read below).
      // The public RPC already proves reliable for LP listing's own bursts.
      vault = await withTimeout(
        readV4LpVaultSnapshot(
          getLpListingClient(),
          { swapVault: deployment.v4SwapVault, lpEntryVault: deployment.vault, lpExitVault: deployment.v4LpExitVault },
          { ownerAddress: deployment.owner },
        ),
        LP_LISTING_TIMEOUT_MS,
        "Policy Vault state",
      ).catch((error): OgAgentVaultSnapshot => ({
        owner: deployment?.owner,
        ready: false,
        warnings: [error instanceof Error ? error.message : "Unable to read Policy Vault state."],
      }));
    } else {
      vault = await withTimeout(
        readVaultSnapshot(undefined, { ownerAddress: deployment.owner }),
        workspaceTimeoutMs,
        "Policy Vault state",
      ).catch((error): OgAgentVaultSnapshot => ({
        owner: deployment?.owner,
        ready: false,
        warnings: [error instanceof Error ? error.message : "Unable to read Policy Vault state."],
      }));
    }
  }
  const selectedDeployment = deployment ?? removedDeployment ?? null;
  const selectedAgentKeyEnabled = live && selectedDeployment && vault.vault && (vault.vaultVersion ?? 1) >= 2
    ? await withTimeout(
        readAgentKeyEnabled(vault.vault, selectedDeployment),
        AUXILIARY_READ_TIMEOUT_MS,
        "Agent key status",
      ).catch(() => undefined)
    : undefined;
  let status: OgAgentWorkspace["agent"]["status"] = removedDeployment
    ? "removed"
    : deployment
      ? deployment.paused || selectedAgentKeyEnabled === false
        ? "paused"
        : vault.ready
          ? "armed"
          : "blocked"
      : "draft";
  if (live && selectedDeployment && vault.vault && (vault.vaultVersion ?? 1) >= 2) {
    const rpcUrl = process.env.OG_RPC_URL?.trim();
    if (rpcUrl) {
      const publicClient = create0GPublicClient(rpcUrl);
      const agentKey = selectedDeployment.agentKey ?? agentKeyForDeployment(selectedDeployment);
      // B5/H2 FIX: swap positions (agentPositionUnits) live on the Swap third for V4.
      const swapVaultAddr =
        (vault.vaultVersion ?? 1) >= 4 && vault.v4SwapVault ? vault.v4SwapVault : vault.vault;
      // LP NFT accounting lives on the LpEntry third (= vault.vault for V4), NOT the Swap third.
      // Reading LP positions from swapVaultAddr returns nothing → "blind hold" even when the agent
      // holds a position (regression guard for the B5/H2 swap-read change).
      const lpVaultAddr = vault.vault;
      vault = {
        ...vault,
        sellablePositions: await withTimeout(
          readSellablePositions(publicClient, swapVaultAddr, { agentKey }),
          AUXILIARY_READ_TIMEOUT_MS,
          "sellable positions",
        ).catch(() => []),
      };
      // V3-only: also surface the agent's LP NFT positions (unstaked + staked).
      if ((vault.vaultVersion ?? 1) >= 3) {
        vault = {
          ...vault,
          sellableLpPositions: await withTimeout(
            readSellableLpPositions(publicClient, lpVaultAddr, {
              agentKey,
              deployTxHash: selectedDeployment.deployTxHash,
            }),
            LP_LISTING_TIMEOUT_MS,
            "sellable LP positions",
          ).catch(() => []),
        };
      }
    }
  }
  const hasManagedLpPosition = (vault.sellableLpPositions?.length ?? 0) > 0;
  const zeroBalanceOnlyWithLpPosition = Boolean(deployment && hasManagedLpPosition && isOnlyZeroBalanceWarning(vault));
  if (status === "blocked" && zeroBalanceOnlyWithLpPosition) {
    status = "armed";
  }
  const logs = await withTimeout(
    readAgentLogEntries({ deployment: selectedDeployment, includeOnChain: live, storage, vault }),
    workspaceTimeoutMs,
    "agent logs",
  ).catch(() => []);

  return {
    agent: {
      deployment: selectedDeployment,
      id: selectedDeployment?.id ?? agentId ?? SINGLE_OG_AGENT_ID,
      name: selectedDeployment?.name ?? SINGLE_OG_AGENT_NAME,
      readiness: removedDeployment
        ? "blocked"
        : deployment && (vault.ready || zeroBalanceOnlyWithLpPosition)
          ? "ready"
          : vault.ready
            ? "review"
            : "blocked",
      status,
    },
    agents: deployments,
    filters: OG_AGENT_FILTER_PRESETS,
    identity: {
      address: identity.address,
      configured: identity.address !== undefined,
      deployArtifact: identity.fromArtifact,
      label: STANDARD_LABEL,
      note: STANDARD_NOTE,
    },
    multiAgent: {
      enabled: false,
      label: "Coming soon",
    },
    logs,
    removedAgents: removedDeployments,
    storage,
    vault,
  };
}

function normalizeWorkspaceInput(input?: string | LoadOgAgentWorkspaceInput): {
  agentId?: string;
  live: boolean;
  ownerAddress?: Address;
} {
  if (typeof input === "string") {
    return { agentId: input, live: false };
  }

  return {
    agentId: input?.agentId,
    live: input?.live === true,
    ownerAddress: readMainnetOwnerAddress(input?.ownerAddress ?? undefined),
  };
}

function debugAgentWorkspaceSelection(payload: unknown): void {
  if (process.env.OG_AGENT_WORKSPACE_DEBUG !== "true") return;
  console.info(JSON.stringify({ payload, timestamp: new Date().toISOString(), type: "agent-workspace-selection" }));
}

export async function deploySingleOgAgent(input: DeploySingleOgAgentInput): Promise<OgAgentDeploymentRecord> {
  const name = input.name.trim();
  if (name.length < 3 || name.length > 80) {
    throw new OgAgentDeployError("Agent name must be between 3 and 80 characters.", "invalid_agent_name", 400);
  }
  const filters = uniqueFilters(input.filterIds);
  if (filters.length === 0) {
    throw new OgAgentDeployError("Select at least one 0G route filter.", "missing_filters", 400);
  }

  assertMainnetDeployEnv();
  const identity = await resolveAgenticIdAddress();
  if (!identity.address) {
    throw new OgAgentDeployError(
      "Agentic ID contract is not configured. Deploy AgenticID first or set AGENT_IDENTITY_ADDRESS.",
      "identity_not_configured",
      409,
    );
  }

  const rpcUrl = requireEnv("OG_RPC_URL");
  const deployer = privateKeyToAccount(readPrivateKeyEnv("DEPLOYER_PRIVATE_KEY"));
  const chain = make0GMainnetChain(rpcUrl);
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account: deployer, chain, transport: http(rpcUrl) });
  const chainId = await publicClient.getChainId();
  if (chainId !== MAINNET_CHAIN_ID) {
    throw new OgAgentDeployError(`RPC chain mismatch: expected ${MAINNET_CHAIN_ID}, got ${chainId}.`, "chain_mismatch", 500);
  }

  const bytecode = await publicClient.getBytecode({ address: identity.address });
  if (!bytecode || bytecode === "0x") {
    throw new OgAgentDeployError("Configured Agentic ID address has no bytecode.", "identity_not_deployed", 409);
  }
  // Fail-closed if the pinned identity address is not the canonical ERC-7857
  // AgenticID. A non-empty bytecode alone is not enough — a stale proxy or wrong
  // contract could pass the bytecode check. Require ERC-165 + IERC7857 +
  // IERC7857Metadata support on-chain before any agent mint proceeds.
  await assertAgenticIdInterfaces(publicClient, identity.address);

  const vault = await readVaultSnapshot(publicClient, { ownerAddress: input.ownerAddress });
  const vaultReadyForDeploy = vault.ready || (input.allowZeroVaultBalance === true && isOnlyZeroBalanceWarning(vault));
  if (!vaultReadyForDeploy || !vault.vault || !vault.executor || !vault.owner || !vault.policy) {
    throw new OgAgentDeployError(
      vault.warnings.join(" ") || "Policy Vault is not ready for agent deployment.",
      "vault_not_ready",
      409,
    );
  }
  const readyVault = {
    ...vault,
    executor: vault.executor,
    owner: vault.owner,
    policy: vault.policy,
    vault: vault.vault,
  };
  const storageStatus = await readStorageSnapshot(publicClient);
  if (!storageStatus.uploadReady) {
    throw new OgAgentDeployError(
      storageStatus.warnings.join(" ") || "0G Storage is not ready for agent metadata upload.",
      "storage_not_ready",
      409,
    );
  }

  const expectedTokenId = await publicClient.readContract({
    address: identity.address,
    abi: agenticIdAbi,
    functionName: "nextTokenId",
  });
  const agentRef = `agentic-id:${identity.address}:${expectedTokenId.toString()}`;
  const pendingStorage = await readReusablePendingAgentStorage(agentRef, name, filters);
  const metadataPayload =
    pendingStorage?.payload ??
    buildAgentMetadataPayload({
      agentRef,
      filters,
      name,
      vault: readyVault,
    });
  const storage = await uploadAgentMetadata(metadataPayload);
  const intelligentData = buildIntelligentData({
    agentRef,
    filters,
    policyHash: await readPolicyHash(publicClient, readyVault.vault),
    storageRoot: storage.rootHash,
    vault: readyVault,
  });

  const simulation = await publicClient.simulateContract({
    account: deployer.address,
    address: identity.address,
    abi: agenticIdAbi,
    functionName: "mintAgent",
    args: [
      readyVault.owner,
      intelligentData,
      storage.storageRef,
      agentRef,
      readyVault.vault,
      readyVault.executor,
    ],
  });
  const txHash = await walletClient.writeContract({
    ...simulation.request,
    account: deployer,
    chain,
  });
  await waitForReceipt(publicClient, txHash, "Agentic ID mint");

  // Enable the agent's key on the Policy Vault so the bounded executor can
  // actually trade for this agent. mintAgent only records the vault/executor
  // refs and emits AgentMinted — it does NOT flip vault.agentKeyEnabled, and
  // there is no other app path that does (only the manual smoke script enables
  // keys). Without this step a freshly minted agent can never trade: the vault
  // reverts any trade whose agentKey is not enabled (PolicyVaultV2 trade guard).
  // setAgentKeyEnabled is onlyOwner on the vault, so the on-chain enable is only
  // possible when the server deployer key IS the vault owner (the single-user
  // demo case). When they differ (multi-user), skip on-chain enable and leave
  // agentKeyEnableTxHash undefined so the UI can tell the owner to enable the
  // key themselves. This does not loosen vault policy — it authorizes an agent
  // the owner just explicitly created, which is the intended lifecycle.
  const agentKey = agentKeyForDeployment({
    identityAddress: identity.address,
    tokenId: expectedTokenId.toString(),
  });
  const deployerIsVaultOwner =
    deployer.address.toLowerCase() === readyVault.owner.toLowerCase();
  let agentKeyEnableTxHash: Hex | undefined;
  if (deployerIsVaultOwner) {
    const enableVaults = uniqueAddresses(
      (readyVault.vaultVersion ?? 1) >= 4
        ? [readyVault.vault, readyVault.v4LpExitVault, readyVault.v4SwapVault]
        : [readyVault.vault],
    );
    for (const enableVault of enableVaults) {
      const enableSimulation = await publicClient.simulateContract({
        account: deployer.address,
        address: enableVault,
        abi: policyVaultAgentKeyAbi,
        functionName: "setAgentKeyEnabled",
        args: [agentKey, true],
      });
      const enableTxHash = await walletClient.writeContract({
        ...enableSimulation.request,
        account: deployer,
        chain,
      });
      await waitForReceipt(publicClient, enableTxHash, `Agent key enable ${enableVault}`);
      agentKeyEnableTxHash ??= enableTxHash;
    }
  }

  const record = {
    agentRef,
    createdAt: new Date().toISOString(),
    deployTxHash: txHash,
    executor: readyVault.executor,
    filters: filters.map((filter) => filter.id),
    id: ogAgentIdFromTokenId(expectedTokenId.toString()),
    identityAddress: identity.address,
    name,
    owner: readyVault.owner,
    standard: STANDARD_LABEL,
    standardNote: STANDARD_NOTE,
    storageRef: storage.storageRef,
    storageRoot: storage.rootHash,
    tokenId: expectedTokenId.toString(),
    vault: readyVault.vault,
    agentKey,
    agentKeyEnableTxHash,
    runtime: normalizeRuntimeSettings(input.runtime),
    vaultVersion: readyVault.vaultVersion,
    v4SwapVault: readyVault.v4SwapVault,
    v4LpEntryVault: readyVault.v4LpEntryVault,
    v4LpExitVault: readyVault.v4LpExitVault,
  } satisfies OgAgentDeploymentRecord;

  await upsertAgentDeploymentRecord(record);
  return record;
}

export async function removeSingleOgAgentRecord(
  agentId: string,
  knownRecord?: OgAgentDeploymentRecord,
  removedBy?: Address,
  agentKeyDisableTxHash?: Hex,
): Promise<OgAgentDeploymentRecord | null> {
  const registry = await readAgentDeploymentRegistryArtifact();
  const deployments = mergeAgentDeploymentRecords([
    ...(registry?.agents ?? []),
    ...(knownRecord ? [knownRecord] : []),
  ]);
  const current = deployments.find((deployment) => deployment.id === agentId) ?? knownRecord ?? null;
  const removedAgents = buildRemovedAgentRecords(registry, deployments);
  const tombstone = current
    ? normalizeRemovedAgentRecord({
        ...current,
        agentKeyDisabledAt: new Date().toISOString(),
        agentKeyDisableTxHash,
        removeMode: "soft-retire",
        removedAt: new Date().toISOString(),
        removedBy,
      })
    : null;
  await writeAgentDeploymentRegistry(
    deployments.filter((deployment) => deployment.id !== agentId),
    tombstone
      ? [...removedAgents.filter((deployment) => deployment.id !== agentId), tombstone]
      : removedAgents,
  );
  return current;
}

export async function setSingleOgAgentPaused(
  agentId: string,
  paused: boolean,
  knownRecord?: OgAgentDeploymentRecord,
): Promise<OgAgentDeploymentRecord | null> {
  const registry = await readAgentDeploymentRegistryArtifact();
  const deployments = mergeAgentDeploymentRecords([
    ...(registry?.agents ?? []),
    ...(knownRecord ? [knownRecord] : []),
  ]);
  const removedAgents = buildRemovedAgentRecords(registry, deployments);
  if (removedAgents.some((deployment) => deployment.id === agentId)) {
    return null;
  }
  const current = deployments.find((deployment) => deployment.id === agentId) ?? knownRecord ?? null;
  if (!current) {
    return null;
  }
  const updated = {
    ...current,
    paused,
  } satisfies OgAgentDeploymentRecord;
  await writeAgentDeploymentRegistry(
    deployments.map((deployment) => (deployment.id === agentId ? updated : deployment)),
    removedAgents,
  );
  return updated;
}

export async function storeAgentTradeArtifact(
  agentId: string,
  side: StoredAgentTradeSide,
  artifact: StoredAgentTradeArtifact,
) {
  await writeJsonArtifact(agentTradeArtifactPath(agentId, side), artifact);
}

async function readPolicyHash(
  publicClient: PublicClient,
  vault: Address,
): Promise<Hex> {
  return publicClient.readContract({
    address: vault,
    abi: policyVaultAbi,
    functionName: "policyHash",
  }) as Promise<Hex>;
}

type SwapPolicyFields = {
  perTradeCap0G: bigint;
  dailyCap0G: bigint;
  maxExposure0G: bigint;
  cooldownSeconds: bigint;
  maxDeadlineWindowSeconds: bigint;
  defaultMinOutBps: number;
};

type LpPolicyFields = {
  perLpActionCap0G: bigint;
  lpDailyCap0G: bigint;
  maxLpExposure0G: bigint;
  cooldownSecondsLp: bigint;
  lpMinOutBps: number;
  minLiquidityFloor: bigint;
  allowStaking: boolean;
};

async function readVaultSnapshot(
  client?: PublicClient,
  options: { ownerAddress?: Address } = {},
): Promise<OgAgentVaultSnapshot> {
  const rpcUrl = process.env.OG_RPC_URL?.trim();
  if (!rpcUrl) {
    return {
      owner: options.ownerAddress,
      ready: false,
      warnings: ["OG_RPC_URL is missing."],
    };
  }

  const publicClient = client ?? create0GPublicClient(rpcUrl);
  // V4 wins: the split trio is the active LP surface after migration. If no V4
  // trio exists for the owner, keep the prior V3 > V2 fallback order.
  const v4Vault = options.ownerAddress
    ? await resolveMainnetV4VaultForOwner(options.ownerAddress, undefined, publicClient).catch(() => null)
    : null;
  if (v4Vault !== null) {
    const chainId = await publicClient.getChainId();
    if (chainId !== MAINNET_CHAIN_ID) {
      return {
        ready: false,
        owner: options.ownerAddress,
        vault: v4Vault.lpEntryVault,
        vaultVersion: 4,
        v4SwapVault: v4Vault.swapVault,
        v4LpEntryVault: v4Vault.lpEntryVault,
        v4LpExitVault: v4Vault.lpExitVault,
        warnings: [`RPC chain mismatch: expected ${MAINNET_CHAIN_ID}, got ${chainId}.`],
      };
    }
    return readV4LpVaultSnapshot(publicClient, v4Vault, options);
  }

  // V3 wins over any V2 factory vault because V3 is the legacy superset surface
  // (swap + LP). V2 coexistence is allowed; if no V3 entry exists for the owner
  // we fall back to the latest V2 factory vault.
  const v3Vault = options.ownerAddress
    ? await resolveMainnetV3VaultForOwner(options.ownerAddress, publicClient).catch(() => null)
    : (readConfiguredMainnetVaultAddress() ?? null);
  const versionedVaults = v3Vault === null && options.ownerAddress
    ? await resolveMainnetVaultVersionsForOwner(options.ownerAddress, publicClient).catch(() => [])
    : [];
  const activeV2Vault = versionedVaults.at(-1);
  const vault = v3Vault ?? activeV2Vault?.vault ?? (
    options.ownerAddress
      ? await resolveMainnetVaultForOwner(options.ownerAddress, publicClient).catch(() => null)
      : readConfiguredMainnetVaultAddress()
  );
  const vaultVersion = v3Vault !== null ? 3 : activeV2Vault?.version;
  if (!vault) {
    return {
      owner: options.ownerAddress,
      ready: false,
      warnings: options.ownerAddress
        ? ["No mainnet Policy Vault exists for the connected wallet yet."]
        : ["Mainnet Policy Vault address is missing."],
    };
  }

  const chainId = await publicClient.getChainId();
  if (chainId !== MAINNET_CHAIN_ID) {
    return {
      ready: false,
      owner: options.ownerAddress,
      vault,
      vaultVersion,
      warnings: [`RPC chain mismatch: expected ${MAINNET_CHAIN_ID}, got ${chainId}.`],
    };
  }

  const isV3 = vaultVersion === 3;
  // The 10 shared state selectors are identical between V2 and V3 (same signatures), so the V2
  // ABI decodes them correctly on a V3 vault. `policy` differs (V3 adds a nested LpPolicy tuple),
  // so it is read separately below with the version-correct ABI to keep viem's tuple typing exact.
  const [
    owner,
    executor,
    adapter,
    proofRegistry,
    mockAdapterAllowed,
    paused,
    executorRevoked,
    dailySpent0G,
    openExposure0G,
    balance,
  ] = await Promise.all([
    publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "owner" }) as Promise<Address>,
    publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "executor" }) as Promise<Address>,
    publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "adapter" }) as Promise<Address>,
    publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "proofRegistry" }) as Promise<Address>,
    publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "mockAdapterAllowed" }) as Promise<boolean>,
    publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "paused" }) as Promise<boolean>,
    publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "executorRevoked" }) as Promise<boolean>,
    publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "dailySpent0G" }) as Promise<bigint>,
    publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "openExposure0G" }) as Promise<bigint>,
    publicClient.getBalance({ address: vault }),
  ]);

  // V3-only LP state: lpAdapter + LP spend/exposure + nested LpPolicy. Swap-only V3 vaults
  // (lpAdapter == address(0)) report no LP fields.
  let lpAdapter: Address | undefined;
  let lpDailySpent0G: string | undefined;
  let openLpExposure0G: string | undefined;
  let lpPolicy: OgAgentVaultSnapshot["lpPolicy"];
  let swapPolicy: SwapPolicyFields;
  if (isV3) {
    const [v3PolicyRaw, v3LpAdapter, v3LpDailySpent, v3OpenLpExposure] = await Promise.all([
      publicClient.readContract({ address: vault, abi: policyVaultV3Abi, functionName: "policy" }) as Promise<unknown>,
      publicClient.readContract({ address: vault, abi: policyVaultV3Abi, functionName: "lpAdapter" }) as Promise<Address>,
      publicClient.readContract({ address: vault, abi: policyVaultV3Abi, functionName: "lpDailySpent0G" }) as Promise<bigint>,
      publicClient.readContract({ address: vault, abi: policyVaultV3Abi, functionName: "openLpExposure0G" }) as Promise<bigint>,
    ]);
    const v3Policy = normalizePolicyVaultV3Policy(v3PolicyRaw);
    swapPolicy = {
      perTradeCap0G: v3Policy.perTradeCap0G,
      dailyCap0G: v3Policy.dailyCap0G,
      maxExposure0G: v3Policy.maxExposure0G,
      cooldownSeconds: v3Policy.cooldownSeconds,
      maxDeadlineWindowSeconds: v3Policy.maxDeadlineWindowSeconds,
      defaultMinOutBps: v3Policy.defaultMinOutBps,
    };
    lpAdapter = v3LpAdapter;
    if (v3LpAdapter !== zeroAddress) {
      const lp = v3Policy.lp;
      lpDailySpent0G = formatEther(v3LpDailySpent);
      openLpExposure0G = formatEther(v3OpenLpExposure);
      lpPolicy = {
        perLpActionCap0G: formatEther(lp.perLpActionCap0G),
        lpDailyCap0G: formatEther(lp.lpDailyCap0G),
        maxLpExposure0G: formatEther(lp.maxLpExposure0G),
        cooldownSecondsLp: lp.cooldownSecondsLp.toString(),
        lpMinOutBps: lp.lpMinOutBps,
        minLiquidityFloor: lp.minLiquidityFloor.toString(),
        allowStaking: lp.allowStaking,
        // UI-derived (NOT on-chain): effective max positions = floor(total / per).
        // Labeled "effective max positions (exposure-bounded)" in the UI — a
        // compromised executor could still open many small NFTs summing under
        // the cap; the on-chain guarantee is total 0G, not NFT count.
        lpMaxPositions: deriveMaxPositions({ perLpActionCap0G: lp.perLpActionCap0G, maxLpExposure0G: lp.maxLpExposure0G }),
        lpMaxPerPosition0G: formatEther(lp.perLpActionCap0G),
      };
    }
  } else {
    const v2Policy = await publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "policy" }) as readonly [bigint, bigint, bigint, bigint, bigint, number];
    swapPolicy = {
      perTradeCap0G: v2Policy[0],
      dailyCap0G: v2Policy[1],
      maxExposure0G: v2Policy[2],
      cooldownSeconds: v2Policy[3],
      maxDeadlineWindowSeconds: v2Policy[4],
      defaultMinOutBps: v2Policy[5],
    };
  }

  const warnings: string[] = [];
  if (options.ownerAddress && owner.toLowerCase() !== options.ownerAddress.toLowerCase()) {
    warnings.push("Resolved Policy Vault owner does not match the connected wallet.");
  }
  if (paused) warnings.push("Policy Vault is paused.");
  if (executorRevoked) warnings.push("Policy Vault executor is revoked.");
  if (mockAdapterAllowed) warnings.push("Policy Vault allows a mock adapter.");
  if (balance <= 0n) warnings.push("Policy Vault has no 0G balance.");
  const configuredExecutor = readAddress(process.env.NEXT_PUBLIC_VAULT_EXECUTOR_MAINNET_ADDRESS);
  if (configuredExecutor && configuredExecutor.toLowerCase() !== executor.toLowerCase()) {
    warnings.push("Vault executor does not match NEXT_PUBLIC_VAULT_EXECUTOR_MAINNET_ADDRESS.");
  }
  const sellablePositions = await readSellablePositions(publicClient, vault).catch(() => []);

  return {
    adapter,
    balance0G: formatEther(balance),
    dailySpent0G: formatEther(dailySpent0G),
    executor,
    executorRevoked,
    lpAdapter,
    lpDailySpent0G,
    lpPolicy,
    mockAdapterAllowed,
    openExposure0G: formatEther(openExposure0G),
    openLpExposure0G,
    owner,
    paused,
    policy: {
      cooldownSeconds: swapPolicy.cooldownSeconds.toString(),
      dailyCap0G: formatEther(swapPolicy.dailyCap0G),
      defaultMinOutBps: swapPolicy.defaultMinOutBps,
      maxDeadlineWindowSeconds: swapPolicy.maxDeadlineWindowSeconds.toString(),
      maxExposure0G: formatEther(swapPolicy.maxExposure0G),
      perTradeCap0G: formatEther(swapPolicy.perTradeCap0G),
    },
    proofRegistry,
    ready: warnings.length === 0,
    sellablePositions,
    vault,
    vaultVersion,
    warnings,
  };
}

async function readV4LpVaultSnapshot(
  publicClient: PublicClient,
  v4Vault: { swapVault: Address; lpEntryVault: Address; lpExitVault: Address },
  options: { ownerAddress?: Address } = {},
): Promise<OgAgentVaultSnapshot> {
  const { swapVault, lpEntryVault, lpExitVault } = v4Vault;
  const [
    owner,
    executor,
    lpAdapter,
    proofRegistry,
    paused,
    executorRevoked,
    lpDailySpentRaw,
    openLpExposureRaw,
    lpPolicyRaw,
    balance,
    linkedLpExit,
    exitOwner,
    exitExecutor,
    exitProofRegistry,
    exitPaused,
    exitExecutorRevoked,
    swapOwner,
    swapExecutor,
    swapAdapter,
    swapProofRegistry,
    swapPaused,
    swapExecutorRevoked,
    swapDailySpentRaw,
    swapOpenExposureRaw,
    swapPolicyRaw,
    swapBalance,
    exitBalance,
  ] = await Promise.all([
    publicClient.readContract({ address: lpEntryVault, abi: policyVaultV4LpEntryAbi, functionName: "owner" }) as Promise<Address>,
    publicClient.readContract({ address: lpEntryVault, abi: policyVaultV4LpEntryAbi, functionName: "executor" }) as Promise<Address>,
    publicClient.readContract({ address: lpEntryVault, abi: policyVaultV4LpEntryAbi, functionName: "lpAdapter" }) as Promise<Address>,
    publicClient.readContract({ address: lpEntryVault, abi: policyVaultV4LpEntryAbi, functionName: "proofRegistry" }) as Promise<Address>,
    publicClient.readContract({ address: lpEntryVault, abi: policyVaultV4LpEntryAbi, functionName: "paused" }) as Promise<boolean>,
    publicClient.readContract({ address: lpEntryVault, abi: policyVaultV4LpEntryAbi, functionName: "executorRevoked" }) as Promise<boolean>,
    publicClient.readContract({ address: lpEntryVault, abi: policyVaultV4LpEntryAbi, functionName: "lpDailySpent0G" }) as Promise<bigint>,
    publicClient.readContract({ address: lpEntryVault, abi: policyVaultV4LpEntryAbi, functionName: "openLpExposure0G" }) as Promise<bigint>,
    publicClient.readContract({ address: lpEntryVault, abi: policyVaultV4LpEntryAbi, functionName: "policy" }),
    publicClient.getBalance({ address: lpEntryVault }),
    publicClient.readContract({ address: lpEntryVault, abi: policyVaultV4LpEntryAbi, functionName: "lpExitVault" }) as Promise<Address>,
    publicClient.readContract({ address: lpExitVault, abi: policyVaultV4LpExitAbi, functionName: "owner" }) as Promise<Address>,
    publicClient.readContract({ address: lpExitVault, abi: policyVaultV4LpExitAbi, functionName: "executor" }) as Promise<Address>,
    publicClient.readContract({ address: lpExitVault, abi: policyVaultV4LpExitAbi, functionName: "proofRegistry" }) as Promise<Address>,
    publicClient.readContract({ address: lpExitVault, abi: policyVaultV4LpExitAbi, functionName: "paused" }) as Promise<boolean>,
    publicClient.readContract({ address: lpExitVault, abi: policyVaultV4LpExitAbi, functionName: "executorRevoked" }) as Promise<boolean>,
    publicClient.readContract({ address: swapVault, abi: policyVaultV4SwapAbi, functionName: "owner" }) as Promise<Address>,
    publicClient.readContract({ address: swapVault, abi: policyVaultV4SwapAbi, functionName: "executor" }) as Promise<Address>,
    publicClient.readContract({ address: swapVault, abi: policyVaultV4SwapAbi, functionName: "swapAdapter" }) as Promise<Address>,
    publicClient.readContract({ address: swapVault, abi: policyVaultV4SwapAbi, functionName: "proofRegistry" }) as Promise<Address>,
    publicClient.readContract({ address: swapVault, abi: policyVaultV4SwapAbi, functionName: "paused" }) as Promise<boolean>,
    publicClient.readContract({ address: swapVault, abi: policyVaultV4SwapAbi, functionName: "executorRevoked" }) as Promise<boolean>,
    publicClient.readContract({ address: swapVault, abi: policyVaultV4SwapAbi, functionName: "dailySpent0G" }) as Promise<bigint>,
    publicClient.readContract({ address: swapVault, abi: policyVaultV4SwapAbi, functionName: "openExposure0G" }) as Promise<bigint>,
    publicClient.readContract({ address: swapVault, abi: policyVaultV4SwapAbi, functionName: "policy" }),
    publicClient.getBalance({ address: swapVault }),
    publicClient.getBalance({ address: lpExitVault }),
  ]);

  const swapPolicy = normalizeV4SwapPolicySnapshot(swapPolicyRaw);
  const lpPolicyFields = normalizeV4LpPolicySnapshot(lpPolicyRaw);
  const warnings: string[] = [];
  if (options.ownerAddress && owner.toLowerCase() !== options.ownerAddress.toLowerCase()) {
    warnings.push("Resolved V4 Policy Vault owner does not match the connected wallet.");
  }
  if (swapOwner.toLowerCase() !== owner.toLowerCase() || exitOwner.toLowerCase() !== owner.toLowerCase()) {
    warnings.push("V4 Policy Vault trio owner mismatch.");
  }
  if (swapExecutor.toLowerCase() !== executor.toLowerCase() || exitExecutor.toLowerCase() !== executor.toLowerCase()) {
    warnings.push("V4 Policy Vault trio executor mismatch.");
  }
  if (swapProofRegistry.toLowerCase() !== proofRegistry.toLowerCase() || exitProofRegistry.toLowerCase() !== proofRegistry.toLowerCase()) {
    warnings.push("V4 Policy Vault trio proof registry mismatch.");
  }
  if (linkedLpExit.toLowerCase() !== lpExitVault.toLowerCase()) {
    warnings.push("V4 LP Entry is not wired to the registered LP Exit vault.");
  }
  if (paused) warnings.push("Policy Vault is paused.");
  if (executorRevoked) warnings.push("Policy Vault executor is revoked.");
  if (exitPaused) warnings.push("V4 LP Exit is paused.");
  if (exitExecutorRevoked) warnings.push("V4 LP Exit executor is revoked.");
  if (swapPaused) warnings.push("V4 Swap vault is paused.");
  if (swapExecutorRevoked) warnings.push("V4 Swap vault executor is revoked.");
  if (balance <= 0n) {
    warnings.push(
      swapBalance > 0n
        ? "LP Entry has no 0G balance; V4 Swap has native 0G available for transfer."
        : "Policy Vault has no 0G balance.",
    );
  }
  const configuredExecutor = readAddress(process.env.NEXT_PUBLIC_VAULT_EXECUTOR_MAINNET_ADDRESS);
  if (configuredExecutor && configuredExecutor.toLowerCase() !== executor.toLowerCase()) {
    warnings.push("Vault executor does not match NEXT_PUBLIC_VAULT_EXECUTOR_MAINNET_ADDRESS.");
  }

  // B5/T8 FIX: swap positions live on the Swap third (agentPositionUnits/positionUnits), NOT LpEntry.
  // Read them from swapVault so V4 agents expose sellable positions (previously hardcoded []).
  const sellablePositions = await readSellablePositions(publicClient, swapVault).catch(() => []);

  return {
    adapter: swapAdapter,
    balance0G: formatEther(balance),
    dailySpent0G: formatEther(swapDailySpentRaw),
    executor,
    executorRevoked: executorRevoked || exitExecutorRevoked || swapExecutorRevoked,
    lpAdapter,
    lpDailySpent0G: formatEther(lpDailySpentRaw),
    lpPolicy: {
      perLpActionCap0G: formatEther(lpPolicyFields.perLpActionCap0G),
      lpDailyCap0G: formatEther(lpPolicyFields.lpDailyCap0G),
      maxLpExposure0G: formatEther(lpPolicyFields.maxLpExposure0G),
      cooldownSecondsLp: lpPolicyFields.cooldownSecondsLp.toString(),
      lpMinOutBps: lpPolicyFields.lpMinOutBps,
      minLiquidityFloor: lpPolicyFields.minLiquidityFloor.toString(),
      allowStaking: lpPolicyFields.allowStaking,
      lpMaxPositions: deriveMaxPositions({
        perLpActionCap0G: lpPolicyFields.perLpActionCap0G,
        maxLpExposure0G: lpPolicyFields.maxLpExposure0G,
      }),
      lpMaxPerPosition0G: formatEther(lpPolicyFields.perLpActionCap0G),
    },
    openExposure0G: formatEther(swapOpenExposureRaw),
    openLpExposure0G: formatEther(openLpExposureRaw),
    owner,
    paused: paused || exitPaused || swapPaused,
    policy: {
      cooldownSeconds: swapPolicy.cooldownSeconds.toString(),
      dailyCap0G: formatEther(swapPolicy.dailyCap0G),
      defaultMinOutBps: swapPolicy.defaultMinOutBps,
      maxDeadlineWindowSeconds: swapPolicy.maxDeadlineWindowSeconds.toString(),
      maxExposure0G: formatEther(swapPolicy.maxExposure0G),
      perTradeCap0G: formatEther(swapPolicy.perTradeCap0G),
    },
    proofRegistry,
    ready: warnings.length === 0,
    sellablePositions,
    vault: lpEntryVault,
    vaultVersion: 4,
    v4SwapVault: swapVault,
    v4LpEntryVault: lpEntryVault,
    v4LpExitVault: lpExitVault,
    v4SwapBalance0G: formatEther(swapBalance),
    v4LpEntryBalance0G: formatEther(balance),
    v4LpExitBalance0G: formatEther(exitBalance),
    warnings,
  };
}

function isOnlyZeroBalanceWarning(vault: OgAgentVaultSnapshot): boolean {
  return Boolean(
    vault.vault &&
      vault.paused !== true &&
      vault.executorRevoked !== true &&
      vault.warnings.length > 0 &&
      vault.warnings.every(isLpFundingWarning),
  );
}

function isLpFundingWarning(warning: string): boolean {
  return warning === "Policy Vault has no 0G balance." || warning.startsWith("LP Entry has no 0G balance;");
}

function uniqueAddresses(addresses: Array<Address | undefined>): Address[] {
  const seen = new Set<string>();
  const unique: Address[] = [];
  for (const address of addresses) {
    if (!address) continue;
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(address);
  }
  return unique;
}

function normalizeV4SwapPolicySnapshot(raw: unknown): SwapPolicyFields {
  return {
    perTradeCap0G: readPolicyBigIntField(raw, 0, "perTradeCap0G"),
    dailyCap0G: readPolicyBigIntField(raw, 1, "dailyCap0G"),
    maxExposure0G: readPolicyBigIntField(raw, 2, "maxExposure0G"),
    cooldownSeconds: readPolicyBigIntField(raw, 3, "cooldownSeconds"),
    maxDeadlineWindowSeconds: readPolicyBigIntField(raw, 4, "maxDeadlineWindowSeconds"),
    defaultMinOutBps: Number(readPolicyBigIntField(raw, 5, "defaultMinOutBps")),
  };
}

function normalizeV4LpPolicySnapshot(raw: unknown): LpPolicyFields {
  return {
    perLpActionCap0G: readPolicyBigIntField(raw, 0, "perLpActionCap0G"),
    lpDailyCap0G: readPolicyBigIntField(raw, 1, "lpDailyCap0G"),
    maxLpExposure0G: readPolicyBigIntField(raw, 2, "maxLpExposure0G"),
    cooldownSecondsLp: readPolicyBigIntField(raw, 3, "cooldownSecondsLp"),
    lpMinOutBps: Number(readPolicyBigIntField(raw, 4, "lpMinOutBps")),
    minLiquidityFloor: readPolicyBigIntField(raw, 5, "minLiquidityFloor"),
    allowStaking: readPolicyBoolField(raw, 6, "allowStaking"),
  };
}

function readPolicyBigIntField(raw: unknown, index: number, key: string): bigint {
  const record = raw as Record<string, unknown>;
  const list = raw as readonly unknown[];
  const value = record?.[key] ?? list?.[index];
  if (typeof value === "bigint") return value;
  if (typeof value === "number" || typeof value === "string") return BigInt(value);
  throw new Error(`Missing bigint policy field ${key}.`);
}

function readPolicyBoolField(raw: unknown, index: number, key: string): boolean {
  const record = raw as Record<string, unknown>;
  const list = raw as readonly unknown[];
  const value = record?.[key] ?? list?.[index];
  if (typeof value === "boolean") return value;
  throw new Error(`Missing boolean policy field ${key}.`);
}

export async function readAgentKeyEnabled(vault: Address, deployment: OgAgentDeploymentRecord): Promise<boolean> {
  const rpcUrl = process.env.OG_RPC_URL?.trim();
  if (!rpcUrl) {
    return false;
  }
  const publicClient = create0GPublicClient(rpcUrl);
  return publicClient.readContract({
    address: vault,
    abi: policyVaultAgentKeyAbi,
    functionName: "agentKeyEnabled",
    args: [deployment.agentKey ?? agentKeyForDeployment(deployment)],
  }) as Promise<boolean>;
}

async function readSellablePositions(
  publicClient: PublicClient,
  vault: Address,
  options: { agentKey?: Hex } = {},
): Promise<OgAgentVaultPosition[]> {
  const routesByToken = new Map<string, (typeof CURATED_MAINNET_POLICY_VAULT_ROUTES)[number]>();
  for (const route of CURATED_MAINNET_POLICY_VAULT_ROUTES) {
    const tokenKey = route.tokenOut.toLowerCase();
    if (!routesByToken.has(tokenKey)) {
      routesByToken.set(tokenKey, route);
    }
  }

  const positions = await Promise.all(
    Array.from(routesByToken.values()).map(async (route): Promise<OgAgentVaultPosition | null> => {
      const amountRaw = options.agentKey
        ? await publicClient.readContract({
            address: vault,
            abi: policyVaultAgentKeyAbi,
            functionName: "agentPositionUnits",
            args: [options.agentKey, route.tokenOut],
          })
        : await publicClient.readContract({
            address: vault,
            abi: policyVaultAbi,
            functionName: "positionUnits",
            args: [route.tokenOut],
          });
      if (amountRaw <= 0n) {
        return null;
      }

      const [decimals, logoUrl] = await Promise.all([
        publicClient.readContract({
          address: route.tokenOut,
          abi: erc20DecimalsAbi,
          functionName: "decimals",
        }).catch(() => 18),
        getZiaTokenLogoUrl(route.tokenOut).catch(() => null),
      ]);

      return {
        amount: trimDecimal(formatUnits(amountRaw, decimals)),
        amountRaw: amountRaw.toString(),
        decimals,
        label: route.label,
        routeId: route.id,
        symbol: route.symbol.replace(/-direct|-oku/u, ""),
        tokenAddress: route.tokenOut,
        logoUrl,
      } satisfies OgAgentVaultPosition;
    }),
  );

  return positions.filter((position): position is OgAgentVaultPosition => position !== null);
}

/// Read the LP NFTs a V3 vault holds for an agent key (unstaked positions only). Staked NFTs
/// live in agentStakedNfts and are reported with staked=true. Each position carries the pool
/// label from the Zia vault registry, the tick range, deployed native, current liquidity, and
/// real per-position accounting (Balance / Assets / Unclaimed fee / Unrealized PnL / APR + a
/// user-facing USD price range) computed from NFPM positions() tokensOwed, pool slot0, and the
/// Zia pool metadata (prices, APR, symbols, decimals). Accounting fields are optional — when the
/// Zia pool fetch fails they are left undefined and the UI shows "—" rather than fake numbers.
export async function readSellableLpPositions(
  publicClient: PublicClient,
  vault: Address,
  options: { agentKey?: Hex; deployTxHash?: Hex } = {},
): Promise<OgAgentVaultLpPosition[]> {
  if (!options.agentKey) {
    return [];
  }
  const agentKey = options.agentKey;
  // LP reads use the PUBLIC 0G RPC (getLpListingClient) — quiknode caps
  // eth_getLogs at a 5-block range + rate-limits to ~52 reads/min, so the
  // listing flickered empty on quiknode (Bug 1). The public RPC handles the
  // getLogs + ~7 per-token reads for 10 positions in ~1s. The passed
  // publicClient (quiknode) is kept as the fallback param for non-LP reads.
  const lpClient = getLpListingClient();
  // Enumerate minted tokenIds. Primary source = the server-side position
  // registry (lib/agent/lp/lp-position-registry.ts), populated at mint time and
  // by the one-shot backfill script. This works around the deployed V3 vault
  // 0xfd391E... lacking the agentLpNfts array getter (added to source after that
  // vault deployed). Every tokenId here is still re-validated per-token below
  // via lpNftOwner/lpNftPool/NFPM, so a stale or drifted registry entry cannot
  // poison the listing — burned/zapped positions are filtered at the
  // ownerAgent/deployedNative check.
  const registry = await readLpPositionRegistry(agentKey);
  const tokenIds = new Set<string>();
  if (registry) {
    for (const entry of registry.positions) tokenIds.add(entry.tokenId);
  } else if (options.deployTxHash) {
    // Legacy agent: registry file missing (never minted via the new hook, never
    // backfilled). Fall back to public-RPC getLogs narrowed to [deployBlock,
    // latest] so the range is small + fast (the vault deployed hours/days ago,
    // not at block 0). getLogs on quiknode is unusable (5-block cap); the public
    // RPC handles the full range in ~300ms.
    const deployBlock = await getLpDeployBlock(lpClient, options.deployTxHash);
    if (deployBlock !== undefined) {
      const mintLogs = await lpClient.getLogs({
        address: vault,
        event: lpActionExecutedV3Event,
        args: { agentKey },
        fromBlock: deployBlock,
        toBlock: "latest",
      }).catch(() => []);
      for (const log of mintLogs) {
        if (Number(log.args.actionType ?? -1) === 2 && log.args.tokenId !== undefined) {
          tokenIds.add(log.args.tokenId.toString());
        }
      }
    }
  } else {
    // Registry missing AND no deployTxHash on the record (very old deployment):
    // best-effort public-RPC getLogs from block 0. The public RPC has no 5-block
    // cap, so a full-range scan is acceptable here, unlike quiknode.
    const mintLogs = await lpClient.getLogs({
      address: vault,
      event: lpActionExecutedV3Event,
      args: { agentKey },
      fromBlock: 0n,
      toBlock: "latest",
    }).catch(() => []);
    for (const log of mintLogs) {
      if (Number(log.args.actionType ?? -1) === 2 && log.args.tokenId !== undefined) {
        tokenIds.add(log.args.tokenId.toString());
      }
    }
  }

  // First pass: read vault per-token state + NFPM positions()/ownerOf for every
  // minted tokenId. tokensOwed0/1 come from NFPM positions() ([11]/[12]); liquidity
  // from [7]. Staked positions report real liquidity too (the hardcode "staked ? 0"
  // was dropped — NFPM positions() returns real liquidity regardless of NFT owner).
  // Reads are CHUNKED (LP_LISTING_CHUNK_SIZE) — the public 0G RPC bursts at ~50
  // reqs and 10 positions × 7 parallel reads = 70 reqs exceed that cap, so a flat
  // Promise.all hits "request rate exceeded" and the caller drops ALL positions
  // (Bug 1 under load). Chunks run sequentially; each chunk stays under the cap.
  const tokenIdList = [...tokenIds];
  const rawPositions: ({
    tokenId: string;
    poolId: Hex;
    poolAddress: Address;
    poolLabel: string;
    stakeVault: Address | undefined;
    tickLower: number;
    tickUpper: number;
    deployedNative0G: string;
    liquidity: bigint;
    tokensOwed0: bigint;
    tokensOwed1: bigint;
    staked: boolean;
  } | null)[] = [];
  for (let chunkStart = 0; chunkStart < tokenIdList.length; chunkStart += LP_LISTING_CHUNK_SIZE) {
    const chunk = tokenIdList.slice(chunkStart, chunkStart + LP_LISTING_CHUNK_SIZE);
    const chunkResults = await Promise.all(
      chunk.map(async (tokenIdString): Promise<{
        tokenId: string;
        poolId: Hex;
        poolAddress: Address;
        poolLabel: string;
        stakeVault: Address | undefined;
        tickLower: number;
        tickUpper: number;
        deployedNative0G: string;
        liquidity: bigint;
        tokensOwed0: bigint;
        tokensOwed1: bigint;
        staked: boolean;
      } | null> => {
      const tokenId = BigInt(tokenIdString);
      const [ownerAgent, poolId, deployedNative, tickLower, tickUpper, position, nftOwner] = await Promise.all([
        lpClient.readContract({ address: vault, abi: policyVaultV3Abi, functionName: "lpNftOwner", args: [tokenId] }) as Promise<Hex>,
        lpClient.readContract({ address: vault, abi: policyVaultV3Abi, functionName: "lpNftPool", args: [tokenId] }) as Promise<Hex>,
        lpClient.readContract({ address: vault, abi: policyVaultV3Abi, functionName: "lpNftDeployedNative", args: [tokenId] }) as Promise<bigint>,
        lpClient.readContract({ address: vault, abi: policyVaultV3Abi, functionName: "lpNftTickLower", args: [tokenId] }) as Promise<number>,
        lpClient.readContract({ address: vault, abi: policyVaultV3Abi, functionName: "lpNftTickUpper", args: [tokenId] }) as Promise<number>,
        lpClient.readContract({
          address: ZIA_LP_MAINNET.nonfungiblePositionManager,
          abi: ziaNonfungiblePositionManagerAbi,
          functionName: "positions",
          args: [tokenId],
        }).catch(() => null) as Promise<readonly unknown[] | null>,
        lpClient.readContract({
          address: ZIA_LP_MAINNET.nonfungiblePositionManager,
          abi: ziaNonfungiblePositionManagerAbi,
          functionName: "ownerOf",
          args: [tokenId],
        }).catch(() => null) as Promise<Address | null>,
      ]);
      if (ownerAgent.toLowerCase() !== agentKey.toLowerCase() || deployedNative <= 0n || !nftOwner) {
        return null;
      }
      const poolCfg = ZIA_LP_VAULTS.find((item) => poolIdFromAddress(item.poolAddress).toLowerCase() === poolId.toLowerCase());
      if (!poolCfg) {
        return null;
      }
      const poolAddress = getAddress(poolCfg.poolAddress);
      const stakeVault = poolCfg.vaultAddress;
      const nftOwnerLower = nftOwner.toLowerCase();
      const staked = stakeVault ? nftOwnerLower === stakeVault.toLowerCase() : false;
      if (nftOwnerLower !== vault.toLowerCase() && !staked) {
        return null;
      }
      const posTuple = position as readonly bigint[] | null;
      const liquidity = posTuple ? BigInt(posTuple[7]) : 0n;
      // NFPM positions() returns 12 outputs (indices 0-11):
      // [7]=liquidity, [10]=tokensOwed0, [11]=tokensOwed1. Reading [11]/[12]
      // swaps the fees AND makes [12] undefined → BigInt(undefined) throws,
      // rejecting the whole readSellableLpPositions promise (caller's
      // .catch(() => []) then silently drops ALL positions). Use [10]/[11].
      const tokensOwed0 = posTuple ? BigInt(posTuple[10] ?? 0n) : 0n;
      const tokensOwed1 = posTuple ? BigInt(posTuple[11] ?? 0n) : 0n;
      return {
        tokenId: tokenIdString,
        poolId,
        poolAddress,
        poolLabel: poolCfg.label,
        stakeVault: staked ? stakeVault : undefined,
        tickLower,
        tickUpper,
        deployedNative0G: formatEther(deployedNative),
        liquidity,
        tokensOwed0,
        tokensOwed1,
        staked,
      };
      }),
    );
    rawPositions.push(...chunkResults);
  }
  const valid = rawPositions.filter((p): p is NonNullable<typeof p> => p !== null);
  if (valid.length === 0) {
    return [];
  }

  // Second pass: fetch pool meta (slot0 + Zia pool) once per distinct pool, then
  // compute the real accounting fields. Best-effort — if the Zia partner fetch or
  // slot0 fails for a pool, positions in that pool ship without accounting fields
  // (UI shows "—") but still report liquidity/ticks/deployedNative.
  const poolAddresses = [...new Set(valid.map((p) => p.poolAddress.toLowerCase()))];
  const poolMetaMap = await fetchPoolMetaMap(lpClient, poolAddresses);
  const withAccounting: OgAgentVaultLpPosition[] = valid.map((p) => {
    const poolMeta = poolMetaMap.get(p.poolAddress.toLowerCase()) ?? null;
    const base: OgAgentVaultLpPosition = {
      tokenId: p.tokenId,
      poolId: p.poolId,
      poolAddress: p.poolAddress,
      poolLabel: p.poolLabel,
      tickLower: p.tickLower,
      tickUpper: p.tickUpper,
      deployedNative0G: p.deployedNative0G,
      liquidity: p.liquidity.toString(),
      staked: p.staked,
      stakeVault: p.stakeVault,
    };
    if (!poolMeta) {
      return base;
    }
    const accounting = computeLpPositionAccounting({
      pool: poolMeta,
      liquidity: p.liquidity,
      tickLower: p.tickLower,
      tickUpper: p.tickUpper,
      tokensOwed0: p.tokensOwed0,
      tokensOwed1: p.tokensOwed1,
      deployedNative0G: p.deployedNative0G,
      staked: p.staked,
    });
    return {
      ...base,
      token0Symbol: accounting.token0Symbol,
      token1Symbol: accounting.token1Symbol,
      token0LogoUrl: poolMeta.token0LogoUrl,
      token1LogoUrl: poolMeta.token1LogoUrl,
      token0Decimals: accounting.token0Decimals,
      token1Decimals: accounting.token1Decimals,
      amount0: accounting.amount0,
      amount1: accounting.amount1,
      unclaimedFee0: accounting.unclaimedFee0,
      unclaimedFee1: accounting.unclaimedFee1,
      leg0USD: accounting.leg0USD,
      leg1USD: accounting.leg1USD,
      valueUSD: accounting.valueUSD ?? undefined,
      entryUSD: accounting.entryUSD ?? undefined,
      unrealizedPnlUSD: accounting.unrealizedPnlUSD ?? undefined,
      unrealizedPnlPct: accounting.unrealizedPnlPct ?? undefined,
      unrealizedPnlTone: accounting.unrealizedPnlTone,
      aprPct: accounting.aprPct,
      stakingAprPct: accounting.stakingAprPct,
      tradingAprPct: accounting.tradingAprPct,
      aprStatus: accounting.aprStatus,
      priceLowerUSD: accounting.priceLowerUSD,
      priceUpperUSD: accounting.priceUpperUSD,
      priceLabelSymbol: accounting.priceLabelSymbol,
    };
  });
  return withAccounting;
}

/// Pool-meta cache (short TTL) so repeated workspace reads don't refetch the Zia
/// partner API for the same pools. Keyed by lowercased pool address.
const POOL_META_CACHE_TTL_MS = 30_000;
let poolMetaCache: { key: string; expiresAt: number; map: Map<string, LpPoolMeta | null> } | null = null;

export async function fetchPoolMetaMap(
  publicClient: PublicClient,
  poolAddresses: string[],
): Promise<Map<string, LpPoolMeta | null>> {
  const now = Date.now();
  const cacheKey = [...poolAddresses].sort().join("|");
  if (poolMetaCache && poolMetaCache.key === cacheKey && poolMetaCache.expiresAt > now) {
    return poolMetaCache.map;
  }
  const map = new Map<string, LpPoolMeta | null>();
  await Promise.all(
    poolAddresses.map(async (addrLower) => {
      const meta = await fetchPoolMeta(publicClient, addrLower as Address).catch(() => null);
      map.set(addrLower, meta);
    }),
  );
  poolMetaCache = { key: cacheKey, expiresAt: now + POOL_META_CACHE_TTL_MS, map };
  return map;
}

/// Fetch slot0 (sqrtPriceX96 + currentTick) + Zia pool metadata (prices, APR,
/// symbols, decimals) for a single pool. Returns null if either read fails — the
/// caller then ships the position without accounting fields.
async function fetchPoolMeta(publicClient: PublicClient, poolAddress: Address): Promise<LpPoolMeta | null> {
  const [slot0, ziaPool] = await Promise.all([
    publicClient.readContract({
      address: poolAddress,
      abi: uniswapV3PoolAbi,
      functionName: "slot0",
      args: [],
    }).catch(() => null) as Promise<readonly [bigint, number, ...unknown[]] | null>,
    getZiaPool(poolAddress).catch(() => null),
  ]);
  if (!slot0 || !ziaPool) {
    return null;
  }
  // Best-effort pair-icon logos — cached separately (much longer TTL than pool
  // meta) since logos rarely change. A failed/missing logo never blocks the
  // position from rendering; the card falls back to an initials avatar.
  const [token0LogoUrl, token1LogoUrl] = await Promise.all([
    getZiaTokenLogoUrl(ziaPool.token0.address).catch(() => null),
    getZiaTokenLogoUrl(ziaPool.token1.address).catch(() => null),
  ]);
  return {
    poolAddress,
    sqrtPriceX96: slot0[0],
    currentTick: slot0[1],
    token0Symbol: ziaPool.token0.symbol,
    token1Symbol: ziaPool.token1.symbol,
    token0Decimals: ziaPool.token0.decimals,
    token1Decimals: ziaPool.token1.decimals,
    token0PriceUSD: ziaPool.token0.priceUSD,
    token1PriceUSD: ziaPool.token1.priceUSD,
    aprTotal: ziaPool.apr.total,
    aprTrading: ziaPool.apr.trading,
    aprStaking: ziaPool.apr.staking,
    token0LogoUrl,
    token1LogoUrl,
  };
}

async function readStorageSnapshot(client?: PublicClient): Promise<OgAgentStorageSnapshot> {
  if (client) {
    return readFreshStorageSnapshot(client);
  }

  const rpcUrl = process.env.OG_STORAGE_RPC_URL?.trim() || process.env.OG_RPC_URL?.trim();
  const indexerUrl = process.env.OG_STORAGE_INDEXER_URL?.trim();
  const cacheKey = `${rpcUrl ?? ""}|${indexerUrl ?? ""}`;
  const now = Date.now();
  if (storageSnapshotCache?.key === cacheKey && storageSnapshotCache.expiresAt > now) {
    return storageSnapshotCache.promise;
  }

  const promise = readFreshStorageSnapshot(undefined, { indexerUrl, rpcUrl });
  storageSnapshotCache = {
    expiresAt: now + STORAGE_SNAPSHOT_CACHE_TTL_MS,
    key: cacheKey,
    promise,
  };
  return promise;
}

async function readFreshStorageSnapshot(
  client?: PublicClient,
  config: { indexerUrl?: string; rpcUrl?: string } = {},
): Promise<OgAgentStorageSnapshot> {
  const rpcUrl = config.rpcUrl ?? process.env.OG_STORAGE_RPC_URL?.trim() ?? process.env.OG_RPC_URL?.trim();
  const indexerUrl = config.indexerUrl ?? process.env.OG_STORAGE_INDEXER_URL?.trim();
  if (!rpcUrl || !indexerUrl) {
    return {
      nodesChecked: 0,
      ready: false,
      uploadReady: false,
      warnings: ["0G Storage indexer URL or RPC URL is missing."],
    };
  }

  const publicClient = client ?? create0GPublicClient(rpcUrl);
  const chainId = await publicClient.getChainId();
  if (chainId !== MAINNET_CHAIN_ID) {
    return {
      indexerUrl,
      nodesChecked: 0,
      ready: false,
      uploadReady: false,
      warnings: [`0G Storage RPC chain mismatch: expected ${MAINNET_CHAIN_ID}, got ${chainId}.`],
    };
  }

  const [{ Indexer, StorageNode }, chainBlockNumber] = await Promise.all([
    import("@0gfoundation/0g-storage-ts-sdk"),
    publicClient.getBlockNumber(),
  ]);
  const indexer = new Indexer(indexerUrl);
  const nodes = await indexer.getShardedNodes();
  const trustedNodes = nodes.trusted ?? [];
  if (trustedNodes.length === 0) {
    return {
      chainBlockNumber: chainBlockNumber.toString(),
      indexerUrl,
      nodesChecked: 0,
      ready: false,
      uploadReady: false,
      warnings: ["0G Storage indexer returned no trusted storage nodes."],
    };
  }

  const statuses = await Promise.all(
    trustedNodes.map(async (node: { url: string }) => {
      try {
        const status = await new StorageNode(node.url).getStatus();
        return status?.logSyncHeight !== undefined ? BigInt(status.logSyncHeight) : null;
      } catch {
        return null;
      }
    }),
  );
  const syncedHeights = statuses.filter((height): height is bigint => height !== null);
  if (syncedHeights.length === 0) {
    return {
      chainBlockNumber: chainBlockNumber.toString(),
      indexerUrl,
      nodesChecked: trustedNodes.length,
      ready: false,
      uploadReady: false,
      warnings: ["0G Storage trusted nodes did not return log sync status."],
    };
  }

  const latestLogSyncHeight = syncedHeights.reduce((max, height) => (height > max ? height : max), syncedHeights[0]);
  const lagBlocks = chainBlockNumber > latestLogSyncHeight ? chainBlockNumber - latestLogSyncHeight : 0n;
  const ready = lagBlocks <= MAX_STORAGE_SYNC_LAG_BLOCKS;
  const uploadReady = syncedHeights.length > 0;
  return {
    chainBlockNumber: chainBlockNumber.toString(),
    indexerUrl,
    lagBlocks: lagBlocks.toString(),
    latestLogSyncHeight: latestLogSyncHeight.toString(),
    nodesChecked: trustedNodes.length,
    ready,
    uploadReady,
    warnings: ready
      ? []
      : [`0G Storage indexer retrieval is ${lagBlocks.toString()} blocks behind the chain RPC; direct txSeq upload remains available.`],
  };
}

function buildAgentMetadataPayload({
  agentRef,
  filters,
  name,
  vault,
}: {
  agentRef: string;
  filters: ReturnType<typeof uniqueFilters>;
  name: string;
  vault: OgAgentVaultSnapshot & { executor: Address; owner: Address; policy: NonNullable<OgAgentVaultSnapshot["policy"]>; vault: Address };
}) {
  return {
    agentRef,
    app: "4lpha-0g",
    chainId: MAINNET_CHAIN_ID,
    createdAt: new Date().toISOString(),
    filters: filters.map((filter) => ({
      id: filter.id,
      label: filter.label,
      maxSlippageBps: filter.maxSlippageBps,
      minOutBps: filter.minOutBps,
      routeSymbols: filter.routeSymbols,
    })),
    kind: "single-trading-agent-identity",
    name,
    redacted: true,
    standard: STANDARD_LABEL,
    vault: {
      executor: vault.executor,
      owner: vault.owner,
      policy: vault.policy,
      vault: vault.vault,
      // V3-only LP fence. Present when vaultVersion >= 3 and the vault has an LP
      // adapter. Anchored on-chain via the sixth buildIntelligentData entry
      // (LP policy fence hash) so the fence is bound to the agent identity.
      ...(vault.lpPolicy ? { lpPolicy: vault.lpPolicy, vaultVersion: vault.vaultVersion } : {}),
    },
  };
}

function buildIntelligentData({
  agentRef,
  filters,
  policyHash,
  storageRoot,
  vault,
}: {
  agentRef: string;
  filters: ReturnType<typeof uniqueFilters>;
  policyHash: Hex;
  storageRoot: Hex;
  vault: OgAgentVaultSnapshot & { executor: Address; owner: Address; vault: Address };
}): AgenticIdIntelligentData[] {
  return [
    { dataDescription: "0G Storage metadata root", dataHash: storageRoot },
    { dataDescription: "Policy Vault policy hash", dataHash: policyHash },
    { dataDescription: "Agent route filter hash", dataHash: hashJson(filters.map((filter) => filter.id)) },
    { dataDescription: "Agent owner/vault/executor hash", dataHash: hashJson({ owner: vault.owner, vault: vault.vault, executor: vault.executor }) },
    { dataDescription: "Agent reference hash", dataHash: hashJson({ agentRef }) },
    // V3-only sixth entry: LP policy fence hash. Anchors the LP caps
    // (perLpActionCap0G, lpDailyCap0G, maxLpExposure0G, cooldownSecondsLp,
    // lpMinOutBps, minLiquidityFloor, allowStaking) to the agent identity via
    // the existing ERC-7857 IntelligentData path. Absent on V2 vaults.
    ...(vault.lpPolicy
      ? [{ dataDescription: "LP policy fence hash", dataHash: hashJson(vault.lpPolicy) }]
      : []),
  ];
}

async function uploadAgentMetadata(payload: unknown): Promise<{ rootHash: Hex; storageRef: string }> {
  const encoded = new TextEncoder().encode(`${stableJson(payload)}\n`);
  const agentRef = readAgentRefFromPayload(payload);
  const pending = await readJsonArtifact<PendingAgentStorageArtifact>(AGENT_STORAGE_PENDING_PATH);
  const expectedRootHash = await computeAgentPayloadStorageRoot(payload);
  if (pending?.agentRef === agentRef && pending.status === "uploaded" && pending.txHash) {
    if (expectedRootHash.toLowerCase() === pending.rootHash.toLowerCase()) {
      return {
        rootHash: pending.rootHash,
        storageRef: `0g-storage:${pending.rootHash}:tx:${pending.txHash}${pending.txSeq !== undefined ? `:seq:${pending.txSeq}` : ""}`,
      };
    }
  }
  const upload = await uploadBytesTo0GStorage(encoded, async (progress) => {
    await writeAgentStorageProgress(payload, progress);
  });
  return {
    rootHash: upload.rootHash,
    storageRef: upload.storageRef,
  };
}

async function readReusablePendingAgentStorage(
  agentRef: string,
  name: string,
  filters: ReturnType<typeof uniqueFilters>,
): Promise<PendingAgentStorageArtifact | null> {
  const pending = await readJsonArtifact<PendingAgentStorageArtifact>(AGENT_STORAGE_PENDING_PATH);
  if (!pending || pending.agentRef !== agentRef) {
    return null;
  }
  if (!isHex(pending.rootHash, { strict: true }) || pending.rootHash.length !== 66) {
    return null;
  }
  const payload = pending.payload;
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const record = payload as {
    agentRef?: unknown;
    filters?: Array<{ id?: unknown }>;
    kind?: unknown;
    name?: unknown;
  };
  const filterIds = filters.map((filter) => filter.id).join(",");
  const pendingFilterIds = Array.isArray(record.filters)
    ? record.filters.map((filter) => String(filter.id ?? "")).join(",")
    : "";
  if (
    record.agentRef !== agentRef ||
    record.kind !== "single-trading-agent-identity" ||
    record.name !== name ||
    pendingFilterIds !== filterIds
  ) {
    return null;
  }
  if ((await computeAgentPayloadStorageRoot(payload)).toLowerCase() !== pending.rootHash.toLowerCase()) {
    return null;
  }
  return pending;
}

function readAgentRefFromPayload(payload: unknown): string {
  if (payload && typeof payload === "object" && "agentRef" in payload) {
    const agentRef = (payload as { agentRef?: unknown }).agentRef;
    if (typeof agentRef === "string") {
      return agentRef;
    }
  }
  return "unknown";
}

async function computeAgentPayloadStorageRoot(payload: unknown): Promise<Hex> {
  const { MemData } = await import("@0gfoundation/0g-storage-ts-sdk");
  const encoded = new TextEncoder().encode(`${stableJson(payload)}\n`);
  const file = new MemData(encoded);
  const [tree, treeError] = await file.merkleTree();
  if (treeError !== null || tree === null) {
    throw treeError ?? new Error("Failed to compute 0G Storage root.");
  }
  const rootHash = tree.rootHash();
  if (!isHex(rootHash, { strict: true }) || rootHash.length !== 66) {
    throw new Error("0G Storage returned an invalid local root.");
  }
  return rootHash as Hex;
}

async function writeAgentStorageProgress(payload: unknown, progress: ZeroGStorageProgress) {
  await writeJsonArtifact(AGENT_STORAGE_PENDING_PATH, {
    agentRef: readAgentRefFromPayload(payload),
    createdAt: new Date().toISOString(),
    payload,
    rootHash: progress.rootHash,
    status: progress.status,
    txHash: progress.txHash,
    txSeq: progress.txSeq,
  } satisfies PendingAgentStorageArtifact);
}

async function readAgentLogEntries({
  deployment,
  includeOnChain = false,
  storage,
  vault,
}: {
  deployment: OgAgentDeploymentRecord | null;
  includeOnChain?: boolean;
  storage: OgAgentStorageSnapshot;
  vault: OgAgentVaultSnapshot;
}): Promise<OgAgentLogEntry[]> {
  const [buyArtifact, sellArtifact] = deployment
    ? await readAgentTradeArtifacts(deployment)
    : [null, null];
  const runtimeRuns = deployment ? await readOgAgentRuns(deployment.id, 12).catch(() => []) : [];
  const lpRuns = deployment ? await readOgAgentLpRuns(deployment.id, 30).catch(() => []) : [];
  const logs: OgAgentLogEntry[] = [];

  for (const run of runtimeRuns) {
    logs.push(buildRuntimeLogEntry(run));
  }
  for (const run of lpRuns) {
    logs.push(buildLpRunLogEntry(run));
  }
  const runtimeTradeTxHashes = new Set(logs.map((log) => log.txHash).filter((hash): hash is string => Boolean(hash)));

  const buyLog = buildTradeLogEntry(buyArtifact, "buy");
  if (buyLog && (!buyLog.txHash || !runtimeTradeTxHashes.has(buyLog.txHash))) logs.push(buyLog);
  const sellLog = buildTradeLogEntry(sellArtifact, "sell");
  if (sellLog && (!sellLog.txHash || !runtimeTradeTxHashes.has(sellLog.txHash))) logs.push(sellLog);
  const knownTradeTxHashes = new Set(logs.map((log) => log.txHash).filter((hash): hash is string => Boolean(hash)));
  const onChainTradeLogs = includeOnChain && deployment ? await readOnChainTradeLogEntries(deployment).catch(() => []) : [];
  for (const log of onChainTradeLogs) {
    if (!log.txHash || !knownTradeTxHashes.has(log.txHash)) {
      logs.push(log);
    }
  }
  const knownLpTxHashes = new Set(logs.map((log) => log.txHash).filter((hash): hash is string => Boolean(hash)));
  const onChainLpLogs = includeOnChain && deployment ? await readOnChainLpLogEntries(deployment).catch(() => []) : [];
  for (const log of onChainLpLogs) {
    if (!log.txHash || !knownLpTxHashes.has(log.txHash)) {
      logs.push(log);
    }
  }

  if (deployment) {
    logs.push({
      action: "proof",
      createdAt: deployment.createdAt,
      filter: "executed",
      id: `identity-${deployment.tokenId}`,
      label: `Agentic ID #${deployment.tokenId}`,
      notes: [
        `Agent identity is bound to ${deployment.agentRef}.`,
        `Metadata root ${shortHash(deployment.storageRoot)} is stored on 0G Storage.`,
        `Vault ${shortHash(deployment.vault)} and executor ${shortHash(deployment.executor)} are included in the identity record.`,
        "LLM rationale digest: future trade decisions can cite this agentRef instead of an off-chain bot name.",
      ],
      proofTxHash: deployment.deployTxHash,
      reason: "Agentic ID minted and linked to the Policy Vault.",
      status: "executed",
      storageRoot: deployment.storageRoot,
      summary: `Minted 0G Agentic ID for ${deployment.name}.`,
      txHash: deployment.deployTxHash,
    });
  }

  logs.push({
    action: "none",
    createdAt: new Date().toISOString(),
    filter: vault.ready && storage.uploadReady ? "reasoning" : "blocked",
    id: "readiness-cycle",
    label: "Policy review",
    notes: [
      vault.ready
        ? "Policy Vault is ready: paused=false, executor revoked=false, mock adapter blocked."
        : `Policy Vault is not ready: ${vault.warnings.join(" ") || "missing vault readiness data."}`,
      storage.uploadReady
        ? "0G Storage upload path is available for redacted audit bundles."
        : `0G Storage upload is unavailable: ${storage.warnings.join(" ") || "missing storage readiness data."}`,
      vault.policy
        ? `LLM rationale digest: trade sizing must stay below ${vault.policy.perTradeCap0G} 0G per trade, ${vault.policy.dailyCap0G} 0G daily cap, and min-out ${vault.policy.defaultMinOutBps} bps.`
        : "LLM rationale digest: no vault policy snapshot was available for sizing.",
    ],
    reason: vault.ready && storage.uploadReady ? "Agent can evaluate mainnet routes." : "Readiness blockers remain.",
    status: vault.ready && storage.uploadReady ? "ready" : "blocked",
    summary: "Reviewed vault policy, storage readiness, and executor scope.",
  });

  return logs.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

function buildRuntimeLogEntry(run: OgAgentRuntimeRunRecord): OgAgentLogEntry {
  const action = run.decision.action === "buy" || run.decision.action === "sell" ? run.decision.action : "none";
  const status: OgAgentLogEntry["status"] =
    run.status === "executed" ? "executed" : run.status === "blocked" || run.status === "errored" ? "blocked" : "skipped";
  const filter: OgAgentLogEntry["filter"] =
    run.status === "executed"
      ? "executed"
      : run.status === "blocked" || run.status === "errored"
        ? "blocked"
        : run.status === "held"
          ? "skipped"
          : "reasoning";
  const selected = run.request
    ? run.candidates.find(
        (candidate) => candidate.routeId === run.request?.routeId && candidate.action === run.request?.side,
      )
    : undefined;
  const candidateDigest = run.candidates.length
    ? run.candidates
        .slice(0, 3)
        .map((candidate) => `${candidate.action} ${candidate.routeLabel}: ${candidate.policyDecision}`)
        .join("; ")
    : "No route candidate was prepared.";
  const model = run.decision.model ? `0G Compute model ${run.decision.model}.` : "0G Compute decision metadata unavailable.";
  const executionNote = run.execution
    ? `Execution status ${run.execution.status}${run.execution.txHash ? `, tx ${shortHash(run.execution.txHash)}` : ""}.`
    : run.status === "dry_run"
      ? "Dry-run only: no vault transaction was submitted."
      : "No vault transaction was submitted.";

  return {
    action,
    createdAt: run.completedAt,
    filter,
    id: `runtime-${run.cycleId}`,
    label:
      selected?.routeLabel ??
      (run.decision.action === "hold" ? "Position review" : `${run.decision.action.toUpperCase()} route review`),
    notes: [
      `${model} Confidence ${run.decision.confidence}%.`,
      `LLM rationale digest: ${sanitizeRuntimeLogText(run.decision.summary)}`,
      ...run.decision.reasons.slice(0, 4).map((reason) => `Reason: ${sanitizeRuntimeLogText(reason)}`),
      `Candidates: ${candidateDigest}`,
      executionNote,
      ...(run.error ? [`Worker error: ${sanitizeRuntimeLogText(run.error)}`] : []),
    ],
    proofTxHash: run.execution?.proofBundle.proofTxHash,
    quoteHash: run.execution?.proofBundle.quoteHash,
    reason: sanitizeRuntimeLogText(run.decision.summary),
    routeHash: run.execution?.proofBundle.routeHash,
    status,
    storageRoot: run.execution?.proofBundle.storageRoot,
    summary: sanitizeRuntimeLogText(runtimeSummary(run, selected?.routeLabel)),
    txHash: run.execution?.txHash,
  };
}

function sanitizeRuntimeLogText(value: string): string {
  return value
    .replace(/Holding sellable position for demo visibility:/gu, "Position hold policy active:")
    .replace(/,?\s*75s minimum before sell\.?/gu, ".")
    .replace(/\s+/gu, " ")
    .trim();
}

function runtimeSummary(run: OgAgentRuntimeRunRecord, routeLabel?: string): string {
  if (run.status === "executed") {
    return `${run.decision.action === "sell" ? "Sold" : "Bought"} through ${routeLabel ?? "curated route"} after LLM policy review.`;
  }
  if (run.status === "dry_run") {
    return `LLM would ${run.decision.action} through ${routeLabel ?? "the selected route"}; dry-run blocked submission.`;
  }
  if (run.status === "errored") {
    return `Worker cycle failed: ${run.error ?? run.decision.summary}`;
  }
  return run.decision.summary;
}

function buildLpRunLogEntry(run: OgAgentLpRunRecord): OgAgentLogEntry {
  const status: OgAgentLogEntry["status"] =
    run.status === "executed" ? "executed" : run.status === "blocked" || run.status === "errored" ? "blocked" : "skipped";
  const filter: OgAgentLogEntry["filter"] =
    run.status === "executed"
      ? "executed"
      : run.status === "blocked" || run.status === "errored"
        ? "blocked"
        : run.status === "held"
          ? "skipped"
          : "reasoning";
  const action = lpDecisionToLogAction(run.decision);
  const label = run.tokenId ? `LP #${run.tokenId}` : run.poolAddress ? lpPoolLabelForAddress(run.poolAddress) : "LP action";
  const amountNote = run.amount0G
    ? run.decision === "withdraw-native"
      ? `Withdrew ${run.amount0G} 0G from ${run.vault ? shortHash(run.vault) : "the vault"}.`
      : `Amount ${run.amount0G} 0G.`
    : undefined;

  return {
    action,
    createdAt: run.finishedAt,
    filter,
    id: `lp-run-${run.cycleId}`,
    label,
    notes: [
      run.tokenId ? `Position tokenId #${run.tokenId}.` : undefined,
      run.poolAddress ? `Pool ${lpPoolLabelForAddress(run.poolAddress)} (${shortHash(run.poolAddress)}).` : undefined,
      run.tickLower !== undefined && run.tickUpper !== undefined ? `Tick range [${run.tickLower}, ${run.tickUpper}].` : undefined,
      amountNote,
      run.balanceBefore0G !== undefined && run.balanceAfter0G !== undefined
        ? `Vault balance ${run.balanceBefore0G} 0G -> ${run.balanceAfter0G} 0G.`
        : undefined,
      run.proofTxHash ? `Proof tx ${shortHash(run.proofTxHash)}.` : undefined,
      run.brainSummary ? `Reason: ${sanitizeRuntimeLogText(run.brainSummary)}` : undefined,
      run.error ? `Error: ${sanitizeRuntimeLogText(run.error)}` : undefined,
    ].filter((note): note is string => Boolean(note)),
    proofTxHash: run.proofTxHash,
    reason: run.brainSummary,
    status,
    summary: lpDecisionSummary(run.decision, status, run.tokenId),
    txHash: run.lpTxHash,
  };
}

function lpDecisionToLogAction(decision: OgAgentLpRunRecord["decision"]): OgAgentLogEntry["action"] {
  switch (decision) {
    case "mint":
      return "lp-mint";
    case "stake":
      return "lp-stake";
    case "unstake":
      return "lp-unstake";
    case "zap-out":
      return "lp-zap-out";
    case "withdraw-native":
      return "withdraw-native";
    case "hold":
    default:
      return "none";
  }
}

function lpDecisionSummary(decision: OgAgentLpRunRecord["decision"], status: OgAgentLogEntry["status"], tokenId?: string): string {
  if (status !== "executed") {
    return `LP ${decision} did not execute.`;
  }
  switch (decision) {
    case "mint":
      return `Minted LP NFT${tokenId ? ` #${tokenId}` : ""} via Policy Vault.`;
    case "stake":
      return `Staked LP NFT${tokenId ? ` #${tokenId}` : ""} into Zia vault.`;
    case "unstake":
      return `Unstaked LP NFT${tokenId ? ` #${tokenId}` : ""} back to Policy Vault.`;
    case "zap-out":
      return `Zapped out LP NFT${tokenId ? ` #${tokenId}` : ""} back to native 0G.`;
    case "withdraw-native":
      return "Withdrew native 0G from Policy Vault.";
    case "hold":
    default:
      return "LP worker held position.";
  }
}

function buildTradeLogEntry(
  artifact: StoredAgentTradeArtifact | null,
  fallbackSide: "buy" | "sell",
): OgAgentLogEntry | null {
  const execution = artifact?.data?.execution;
  const preview = artifact?.data?.preview;
  const quote = preview?.quote;
  if (!execution || !quote) {
    return null;
  }
  const side = quote.side ?? fallbackSide;
  const status = execution.status === "submitted" ? "executed" : execution.status === "blocked" ? "blocked" : "ready";
  const filter = status === "blocked" ? "blocked" : "executed";
  const output = quote.expectedAmountOut && quote.outputToken ? `${quote.expectedAmountOut} ${quote.outputToken}` : "quoted output";
  const minOut = quote.amountOutMin && quote.outputToken ? `${quote.amountOutMin} ${quote.outputToken}` : "nonzero min-out";
  const warnings = quote.warnings?.length ? quote.warnings : [];

  return {
    action: side,
    createdAt: execution.submittedAt ?? new Date().toISOString(),
    filter,
    id: execution.id ?? `${side}-${quote.quoteHash ?? Date.now().toString()}`,
    label: quote.routeLabel ?? `${quote.inputToken ?? "input"} / ${quote.outputToken ?? "output"}`,
    notes: [
      `Route ${quote.routeLabel ?? "selected route"} used ${quote.venue ?? "configured"} liquidity with ${quote.slippageBps ?? "--"} bps slippage.`,
      `Quote expected ${output}; vault min-out was ${minOut}.`,
      `Proof bundle stored route hash ${shortHash(execution.proofBundle?.routeHash ?? quote.routeHash ?? "--")} and quote hash ${shortHash(execution.proofBundle?.quoteHash ?? quote.quoteHash ?? "--")}.`,
      `LLM rationale digest: ${preview?.backend?.message ?? "route passed the available policy and proof checks."}`,
      ...warnings.map((warning) => `Warning: ${warning}`),
    ],
    proofTxHash: execution.proofBundle?.proofTxHash,
    quoteHash: execution.proofBundle?.quoteHash ?? quote.quoteHash,
    reason: execution.reason,
    routeHash: execution.proofBundle?.routeHash ?? quote.routeHash,
    status,
    storageRoot: execution.proofBundle?.storageRoot,
    summary:
      status === "executed"
        ? `${side === "buy" ? "Bought through" : "Sold through"} ${quote.routeLabel ?? "curated route"} via Policy Vault.`
        : execution.reason ?? `${side} route did not submit.`,
    txHash: execution.txHash,
  };
}

async function readOnChainTradeLogEntries(deployment: OgAgentDeploymentRecord): Promise<OgAgentLogEntry[]> {
  const rpcUrl = process.env.OG_RPC_URL?.trim();
  if (!rpcUrl) return [];

  const publicClient = create0GPublicClient(rpcUrl);
  const chainId = await publicClient.getChainId();
  if (chainId !== MAINNET_CHAIN_ID) return [];

  const deployReceipt = await publicClient.getTransactionReceipt({ hash: deployment.deployTxHash }).catch(() => null);
  const fromBlock = deployReceipt?.blockNumber ?? 0n;
  const agentKey = deployment.agentKey ?? agentKeyForDeployment(deployment);
  // B5/T7 FIX: swap trades are emitted by the Swap third for V4, not the LpEntry (deployment.vault).
  const tradeVault =
    (deployment.vaultVersion ?? 1) >= 4 && deployment.v4SwapVault ? deployment.v4SwapVault : deployment.vault;
  const v2Logs = await publicClient.getLogs({
    address: tradeVault,
    event: tradeExecutedV2Event,
    args: { agentKey },
    fromBlock,
    toBlock: "latest",
  }).catch(() => []);
  const sourceEvent = v2Logs.length > 0 ? "TradeExecutedV2" : "TradeExecuted";
  const logs = v2Logs.length > 0 ? v2Logs : await publicClient.getLogs({
    address: tradeVault,
    event: tradeExecutedEvent,
    fromBlock,
    toBlock: "latest",
  });

  const blockTimestamps = new Map<bigint, string>();
  const entries = await Promise.all(
    logs.map(async (log): Promise<OgAgentLogEntry | null> => {
      const args = log.args as {
        actionHash?: Hex;
        amountIn?: bigint;
        amountOut?: bigint;
        auditRoot?: Hex;
        isBuy?: boolean;
        policySnapshotHash?: Hex;
        token?: Address;
      };
      if (
        args.actionHash === undefined ||
        args.amountIn === undefined ||
        args.amountOut === undefined ||
        args.auditRoot === undefined ||
        args.isBuy === undefined ||
        !args.token ||
        !log.transactionHash
      ) {
        return null;
      }

      const blockNumber = log.blockNumber ?? undefined;
      let createdAt = new Date().toISOString();
      if (blockNumber !== undefined) {
        const cached = blockTimestamps.get(blockNumber);
        if (cached) {
          createdAt = cached;
        } else {
          const block = await publicClient.getBlock({ blockNumber }).catch(() => null);
          if (block?.timestamp) {
            createdAt = new Date(Number(block.timestamp) * 1000).toISOString();
            blockTimestamps.set(blockNumber, createdAt);
          }
        }
      }

      const symbol = tokenSymbolForAddress(args.token);
      const side = args.isBuy ? "buy" : "sell";
      const amount = trimDecimal(formatUnits(args.isBuy ? args.amountOut : args.amountIn, decimalsForToken(symbol)));
      return {
        action: side,
        createdAt,
        filter: "executed",
        id: `vault-trade-${log.transactionHash}-${log.logIndex ?? 0}`,
        label: symbol,
        notes: [
          `${side === "buy" ? "Bought" : "Sold"} ${amount} ${symbol} through the Policy Vault.`,
          `Vault action ${shortHash(args.actionHash)} was accepted with audit root ${shortHash(args.auditRoot)}.`,
          `Source: on-chain PolicyVault ${sourceEvent} event.`,
        ],
        proofTxHash: undefined,
        reason: `${side === "buy" ? "Buy" : "Sell"} submitted on-chain by the agent executor.`,
        status: "executed",
        storageRoot: args.auditRoot,
        summary: `${side === "buy" ? "Bought" : "Sold"} ${symbol} via Policy Vault.`,
        txHash: log.transactionHash,
      };
    }),
  );

  return entries.filter((entry): entry is OgAgentLogEntry => entry !== null);
}

async function readOnChainLpLogEntries(deployment: OgAgentDeploymentRecord): Promise<OgAgentLogEntry[]> {
  const rpcUrl = process.env.OG_RPC_URL?.trim();
  if (!rpcUrl) return [];

  const publicClient = create0GPublicClient(rpcUrl);
  const chainId = await publicClient.getChainId();
  if (chainId !== MAINNET_CHAIN_ID) return [];

  const deployReceipt = await publicClient.getTransactionReceipt({ hash: deployment.deployTxHash }).catch(() => null);
  const fromBlock = deployReceipt?.blockNumber ?? 0n;
  const agentKey = deployment.agentKey ?? agentKeyForDeployment(deployment);
  const logs = await publicClient.getLogs({
    address: deployment.vault,
    event: lpActionExecutedV3Event,
    args: { agentKey },
    fromBlock,
    toBlock: "latest",
  });

  const blockTimestamps = new Map<bigint, string>();
  const entries = await Promise.all(
    logs.map(async (log): Promise<OgAgentLogEntry | null> => {
      const args = log.args as {
        actionHash?: Hex;
        actionType?: number;
        amountIn0G?: bigint;
        amountOut?: bigint;
        auditRoot?: Hex;
        liquidityDelta?: bigint;
        policySnapshotHash?: Hex;
        poolId?: Hex;
        tokenId?: bigint;
      };
      if (
        args.actionHash === undefined ||
        args.actionType === undefined ||
        args.auditRoot === undefined ||
        args.policySnapshotHash === undefined ||
        args.poolId === undefined ||
        args.tokenId === undefined ||
        !log.transactionHash
      ) {
        return null;
      }

      const decision = lpDecisionFromActionType(Number(args.actionType));
      if (!decision) return null;

      const blockNumber = log.blockNumber ?? undefined;
      let createdAt = new Date().toISOString();
      if (blockNumber !== undefined) {
        const cached = blockTimestamps.get(blockNumber);
        if (cached) {
          createdAt = cached;
        } else {
          const block = await publicClient.getBlock({ blockNumber }).catch(() => null);
          if (block?.timestamp) {
            createdAt = new Date(Number(block.timestamp) * 1000).toISOString();
            blockTimestamps.set(blockNumber, createdAt);
          }
        }
      }

      const tokenId = args.tokenId.toString();
      const poolLabel = lpPoolLabelForPoolId(args.poolId);
      const amountNote =
        decision === "mint" && args.amountIn0G !== undefined && args.amountIn0G > 0n
          ? `Input ${trimDecimal(formatEther(args.amountIn0G))} 0G.`
          : decision === "zap-out" && args.amountOut !== undefined && args.amountOut > 0n
            ? `Returned ${trimDecimal(formatEther(args.amountOut))} 0G to the vault.`
            : undefined;

      return {
        action: lpDecisionToLogAction(decision),
        createdAt,
        filter: "executed",
        id: `vault-lp-${log.transactionHash}-${log.logIndex ?? 0}`,
        label: `LP #${tokenId}`,
        notes: [
          `Pool ${poolLabel}; tokenId #${tokenId}.`,
          amountNote,
          `Vault action ${shortHash(args.actionHash)} emitted LpActionExecutedV3.`,
          `Audit root ${shortHash(args.auditRoot)}; policy snapshot ${shortHash(args.policySnapshotHash)}.`,
        ].filter((note): note is string => Boolean(note)),
        reason: `${lpDecisionSummary(decision, "executed", tokenId)} Source: on-chain PolicyVaultV3 event.`,
        status: "executed",
        storageRoot: args.auditRoot,
        summary: lpDecisionSummary(decision, "executed", tokenId),
        txHash: log.transactionHash,
      };
    }),
  );

  return entries.filter((entry): entry is OgAgentLogEntry => entry !== null);
}

function lpDecisionFromActionType(actionType: number): OgAgentLpRunRecord["decision"] | null {
  switch (actionType) {
    case LP_ACTION_TYPE.ZAP_IN_MINT_LP:
      return "mint";
    case LP_ACTION_TYPE.STAKE_LP:
      return "stake";
    case LP_ACTION_TYPE.UNSTAKE_LP:
      return "unstake";
    case LP_ACTION_TYPE.ZAP_OUT:
      return "zap-out";
    default:
      return null;
  }
}

function lpPoolLabelForPoolId(poolId: Hex): string {
  const match = ZIA_LP_VAULTS.find((vault) => poolIdFromAddress(vault.poolAddress).toLowerCase() === poolId.toLowerCase());
  return match?.label ?? shortHash(poolId);
}

function lpPoolLabelForAddress(poolAddress: Address): string {
  const match = ZIA_LP_VAULTS.find((vault) => vault.poolAddress.toLowerCase() === poolAddress.toLowerCase());
  return match?.label ?? shortHash(poolAddress);
}

function tokenSymbolForAddress(token: Address): string {
  const route = CURATED_MAINNET_POLICY_VAULT_ROUTES.find(
    (candidate) => candidate.tokenOut.toLowerCase() === token.toLowerCase(),
  );
  return route?.symbol.replace(/-direct|-oku/u, "") ?? "TOKEN";
}

function decimalsForToken(symbol: string): number {
  return symbol === "USDC.e" || symbol === "oUSDT" ? 6 : symbol === "WBTC" || symbol === "cbBTC" ? 8 : 18;
}

function shortHash(value: string): string {
  if (!value.startsWith("0x") || value.length <= 14) {
    return value;
  }
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function trimDecimal(value: string): string {
  return value
    .replace(/(\.\d*?[1-9])0+$/u, "$1")
    .replace(/\.0+$/u, "")
    .replace(/\.$/u, "");
}

function normalizeRuntimeSettings(input: Partial<OgAgentRuntimeSettings> | undefined): OgAgentRuntimeSettings {
  return {
    maxCapitalPerTrade0G: sanitizeDecimalString(input?.maxCapitalPerTrade0G),
    maxHoldingMinutes: clampInteger(input?.maxHoldingMinutes, 1, 24 * 60, 30),
    maxPositions: clampInteger(input?.maxPositions, 1, 10, 2),
    minAprPct: normalizeOptionalNumber(input?.minAprPct, 0, 1000),
    maxAprPct: normalizeOptionalNullableNumber(input?.maxAprPct, 0, 1000),
    maxPerPosition0G: sanitizeDecimalString(input?.maxPerPosition0G),
    signalConfidence: clampInteger(input?.signalConfidence, 1, 100, 75),
    slippageBps: clampInteger(input?.slippageBps, 1, 1000, 75),
    // Preserve automation as-is. Only autoMint is defined today; it is a
    // boolean the owner sets via the automation route. sanitizeDecimalString
    // and clampInteger do not apply, so we pass the value through untouched.
    automation: input?.automation,
  };
}

function sanitizeDecimalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/u.test(trimmed) || /^0+(?:\.0+)?$/u.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function normalizeOptionalNumber(value: number | undefined, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.min(max, Math.max(min, value));
}

function normalizeOptionalNullableNumber(value: number | null | undefined, min: number, max: number): number | null | undefined {
  if (value === null) return null;
  return normalizeOptionalNumber(value, min, max);
}

function clampInteger(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function create0GPublicClient(rpcUrl: string): PublicClient {
  // Prefer quiknode (OG_MAINNET_RPC_URL) with the public RPC as fallback, and
  // batch read bursts to stay under quiknode's ~15 req/s ceiling. 429/5xx/network
  // errors back off via OG_RPC_RETRY_COUNT/MS; contract reverts never retry.
  return createPublicClient({
    chain: make0GMainnetChain(rpcUrl),
    transport: makeMainnetTransport(),
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function resolveAgenticIdAddress(): Promise<{ address?: Address; fromArtifact: boolean }> {
  // Prefer the mainnet-scoped env vars; keep the legacy names as a fallback so
  // existing setups keep working. Agentic ID is mainnet-only (chain 16661);
  // there is no Galileo/testnet Agentic ID path.
  const fromEnv = readAddress(process.env.AGENT_IDENTITY_MAINNET_ADDRESS)
    ?? readAddress(process.env.NEXT_PUBLIC_AGENT_IDENTITY_MAINNET_ADDRESS)
    ?? readAddress(process.env.AGENT_IDENTITY_ADDRESS)
    ?? readAddress(process.env.NEXT_PUBLIC_AGENT_IDENTITY_ADDRESS);
  if (fromEnv) {
    return { address: fromEnv, fromArtifact: false };
  }
  const artifact = await readJsonArtifact<AgenticIdDeploymentArtifact>(AGENTIC_ID_DEPLOYMENT_PATH);
  // Reject any artifact that is not anchored to mainnet. A non-mainnet artifact
  // must never be presented as a configured Agentic ID.
  if (artifact?.chainId !== undefined && artifact.chainId !== MAINNET_CHAIN_ID) {
    return { address: undefined, fromArtifact: false };
  }
  const fromArtifact = readAddress(artifact?.agenticId) ?? readAddress(artifact?.address);
  return { address: fromArtifact ?? undefined, fromArtifact: Boolean(fromArtifact) };
}

// ERC-165 / ERC-7857 interface IDs the canonical AgenticID must implement.
// IERC7857 (0xee5a526e) + IERC7857Metadata (0xaa18b754) are computed from the
// canonical contract ABIs via scripts/print-erc7857-ids.ts (viem
// getFunctionSelector + XOR, matching Solidity `type(IERC7857).interfaceId`).
// AgenticID does NOT implement IERC7857DataVerifier (0xdf630116) — that is the
// separate verifier contract wired per AGENTS.md. Pinning these lets the deploy
// path fail-closed if AGENT_IDENTITY_MAINNET_ADDRESS points at a non-AgenticID
// contract (stale proxy, wrong token, wrong chain artifact), so a misconfigured
// identity never silently backs an agent mint.
const ERC165_INTERFACE_ID = "0x01ffc9a7" as const;
const IERC7857_INTERFACE_ID = "0xee5a526e" as const;
const IERC7857_METADATA_INTERFACE_ID = "0xaa18b754" as const;

const erc165Abi = [
  {
    type: "function",
    name: "supportsInterface",
    inputs: [{ name: "interfaceId", type: "bytes4" }],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
] as const;

async function assertAgenticIdInterfaces(publicClient: PublicClient, address: Address): Promise<void> {
  const required = [
    { id: ERC165_INTERFACE_ID, label: "ERC-165" },
    { id: IERC7857_INTERFACE_ID, label: "IERC7857" },
    { id: IERC7857_METADATA_INTERFACE_ID, label: "IERC7857Metadata" },
  ];
  for (const { id, label } of required) {
    const supported = await publicClient.readContract({
      address,
      abi: erc165Abi,
      functionName: "supportsInterface",
      args: [id],
    });
    if (!supported) {
      throw new OgAgentDeployError(
        `Configured Agentic ID address does not implement ${label} (${id}); it is not the canonical ERC-7857 AgenticID contract.`,
        "identity_not_agentic_id",
        409,
      );
    }
  }
}

function selectAgentDeployment(
  deployments: OgAgentDeploymentRecord[],
  agentId?: string,
): OgAgentDeploymentRecord | null {
  if (agentId && agentId !== SINGLE_OG_AGENT_ID) {
    return deployments.find((deployment) => deployment.id === agentId) ?? null;
  }
  return deployments.at(-1) ?? null;
}

function selectRemovedAgentDeployment(
  deployments: OgRemovedAgentRecord[],
  agentId?: string,
): OgRemovedAgentRecord | null {
  if (!agentId || agentId === SINGLE_OG_AGENT_ID) {
    return null;
  }
  return deployments.find((deployment) => deployment.id === agentId) ?? null;
}

async function readAgentDeploymentRoster(
  identityAddress?: Address,
  filter: { agentId?: string; includeOnChain?: boolean; ownerAddress?: Address; vaultAddress?: Address } = {},
): Promise<{ active: OgAgentDeploymentRecord[]; removed: OgRemovedAgentRecord[] }> {
  const registry = await readAgentDeploymentRegistryArtifact();
  const [onChainRecords, legacyDeployResponse, legacySingleRecord] = await Promise.all([
    filter.includeOnChain
      ? withTimeout(
          readOnChainAgentDeploymentRecords(identityAddress),
          ON_CHAIN_ROSTER_READ_TIMEOUT_MS,
          "Agentic ID on-chain roster",
        ).catch(() => [])
      : Promise.resolve([]),
    readLegacyDeployResponseRecord(),
    readJsonArtifact<OgAgentDeploymentRecord>(LEGACY_AGENT_DEPLOYMENT_PATH),
  ]);
  const appDeployments = mergeAgentDeploymentRecords([
    ...(legacyDeployResponse ? [legacyDeployResponse] : []),
    ...(legacySingleRecord ? [legacySingleRecord] : []),
    ...(registry?.agents ?? []),
  ]);
  const deploymentCandidates = mergeAgentDeploymentRecords([
    ...((filter.ownerAddress || filter.vaultAddress) ? onChainRecords : []),
    ...appDeployments,
  ]);
  // Tombstone lookup by string id (registry.removedAgentIds) must resolve
  // against the app registry ONLY, not onChainRecords. A removedId like
  // "agent-0g-mainnet-9" is not unique across AgenticID identity contracts —
  // an old, already-dead identity contract can have minted its own tokenId 9,
  // and mixing that on-chain record into the id-keyed lookup Map lets it
  // silently overwrite the real (current-identity) candidate, so the real
  // agent never gets tombstoned and keeps showing as active.
  const removedAgents = buildRemovedAgentRecords(
    registry,
    appDeployments,
    readEnvRemovedAgentIds(),
    readEnvRemovedAgentKeys(),
  )
    .filter((deployment) => deploymentMatchesFilter(deployment, filter));
  // Match removed vs active by (identityAddress, tokenId), not by deployment.id
  // alone. The agent id is `agent-0g-mainnet-${tokenId}` and does NOT encode the
  // identity contract, so a removed agent minted on one AgenticID contract
  // (e.g. a dead V1-vault agent on 0x7a968138…) would otherwise shadow a live
  // agent with the same tokenId on a different contract (e.g. a freshly minted
  // agent on 0x058c5F4C…) and silently exclude it from the active roster.
  const removedIdentityTokenKeys = new Set(removedAgents.map((deployment) => identityTokenKey(deployment)));

  const activeCandidates = deploymentCandidates.filter((deployment) => {
    if (removedIdentityTokenKeys.has(identityTokenKey(deployment))) {
      return false;
    }
    return deploymentMatchesFilter(deployment, filter);
  });
  const activeDeployments = await filterActiveOnChainAgentRecords(activeCandidates, filter);
  return { active: activeDeployments, removed: removedAgents };
}

async function filterActiveOnChainAgentRecords(
  deployments: OgAgentDeploymentRecord[],
  filter: { agentId?: string; includeOnChain?: boolean; ownerAddress?: Address; vaultAddress?: Address },
): Promise<OgAgentDeploymentRecord[]> {
  if (!filter.includeOnChain || (!filter.ownerAddress && !filter.vaultAddress)) {
    return deployments;
  }

  // Each deployment's agentKeyEnabled/open-position state must be read from
  // ITS OWN vault, not a single vault shared across every deployment for this
  // owner. A V4 owner can have multiple agents, each with its own dedicated
  // Swap/LpEntry/LpExit trio (e.g. one deployed before a registry redeploy,
  // one after) — `resolveMainnetVaultForOwner`/`filter.vaultAddress` only
  // resolves whichever ONE trio the on-chain registry currently returns for
  // that owner. Checking every deployment against that single resolved vault
  // silently drops any agent whose own vault differs from it (agentKeyEnabled
  // reads false on a vault where the key was never registered, and it has no
  // open positions there either, so it gets filtered out entirely).
  const filtered = await Promise.all(
    deployments.map(async (deployment): Promise<OgAgentDeploymentRecord | null> => {
      const enabled = await withTimeout(
        readAgentKeyEnabled(deployment.vault, deployment),
        AUXILIARY_READ_TIMEOUT_MS,
        "Agent key status",
      ).catch(() => undefined);
      if (enabled !== false) {
        return deployment;
      }

      // Any agent that isn't removed stays visible as "paused" once its key
      // is disabled — regardless of whether it ever held a position. Hiding
      // disabled-with-no-position agents entirely (the prior behavior) meant
      // a paused-but-not-removed agent could silently vanish from the roster,
      // which contradicts the UI's "paused, not removed, still shows" contract.
      return { ...deployment, paused: true } satisfies OgAgentDeploymentRecord;
    }),
  );
  return filtered.filter((deployment): deployment is OgAgentDeploymentRecord => deployment !== null);
}

function deploymentMatchesFilter(
  deployment: OgAgentDeploymentRecord,
  filter: { ownerAddress?: Address; vaultAddress?: Address },
): boolean {
  if (filter.ownerAddress && deployment.owner.toLowerCase() !== filter.ownerAddress.toLowerCase()) return false;
  if (filter.vaultAddress && !deploymentMatchesVaultAddress(deployment, filter.vaultAddress)) return false;
  return true;
}

function deploymentMatchesVaultAddress(deployment: OgAgentDeploymentRecord, vaultAddress: Address): boolean {
  const target = vaultAddress.toLowerCase();
  return [
    deployment.vault,
    deployment.v4SwapVault,
    deployment.v4LpEntryVault,
    deployment.v4LpExitVault,
  ].some((address) => address?.toLowerCase() === target);
}

async function readAgentDeploymentRegistryArtifact(): Promise<AgentDeploymentRegistryArtifact | null> {
  return readJsonArtifact<AgentDeploymentRegistryArtifact>(AGENT_REGISTRY_PATH);
}

// Multi-owner enumeration: every active (non-tombstoned) agent across ALL owners. Reuses the roster
// reader with NO ownerAddress filter, so the community workers process every user's agents, not just
// the env-configured owner's. Each record carries its own `owner`, so downstream per-agent workspace
// loads resolve the correct owner (lp-worker.ts:141 / worker.ts:107 use `deployment.owner`).
export async function listAllAgentDeployments(): Promise<OgAgentDeploymentRecord[]> {
  const identity = await resolveAgenticIdAddress();
  const roster = await readAgentDeploymentRoster(identity.address, { includeOnChain: false });
  return roster.active;
}

// An LP agent is identified by the "lp-zia" filter (mirrors lp-worker.ts isLpDeployment).
export function isLpAgentFilters(filters: readonly string[] | undefined): boolean {
  return (filters ?? []).some((filterId) => filterId.toLowerCase() === "lp-zia");
}

// Product limit: each wallet may have at most ONE active LP agent and ONE active trading agent.
// Enforced at deploy time (before the irreversible AgenticID mint) so a duplicate fails fast.
//
// Count only agents the roster treats as ACTIVE for this owner — the same source
// of truth the /agents UI uses (readAgentDeploymentRoster). Reading raw
// `registry.agents` was wrong: it also counted tombstoned/env-removed records and
// stale agents left on a migrated-away vault (their on-chain agent key is no
// longer enabled), which the UI hides and the user can't remove through the UI.
// Such an invisible record must never block a fresh deploy.
export async function assertAgentTypeQuota(owner: Address, kind: "lp" | "trade"): Promise<void> {
  const identity = await resolveAgenticIdAddress();
  const roster = await readAgentDeploymentRoster(identity.address, {
    ownerAddress: owner,
    includeOnChain: true,
  });
  const sameType = roster.active.filter((agent) =>
    kind === "lp" ? isLpAgentFilters(agent.filters) : !isLpAgentFilters(agent.filters),
  );
  if (sameType.length >= 1) {
    const label = kind === "lp" ? "LP" : "trading";
    throw new OgAgentDeployError(
      `This wallet already has an active ${label} agent. Each wallet may create at most one ${label} agent — remove the existing one first.`,
      "agent_quota_exceeded",
      409,
    );
  }
}

async function readLegacyDeployResponseRecord(): Promise<OgAgentDeploymentRecord | null> {
  const artifact = await readJsonArtifact<LegacyDeployResponseArtifact>(LEGACY_AGENT_DEPLOY_RESPONSE_PATH);
  return artifact?.data?.deployment ?? null;
}

async function upsertAgentDeploymentRecord(record: OgAgentDeploymentRecord) {
  const registry = await readAgentDeploymentRegistryArtifact();
  const deployments = mergeAgentDeploymentRecords([...(registry?.agents ?? []), record]);
  const removedAgents = buildRemovedAgentRecords(registry, deployments);
  await writeAgentDeploymentRegistry(deployments, removedAgents);
}

/// Re-point every active agent record for `owner` from its current (V2) vault to the resolved
/// V3 singleton. Records the prior vault address + migration timestamp on each record so the UI
/// can show the migration provenance. Does NOT move funds (the owner withdraws V2 / deposits V3
/// via the existing manual controls). The on-chain setAgentKeyEnabled step on V3 is performed by
/// the caller (`migrateOwnerVaultToV3`) and passed in as `enableTxHashByAgentKey` so each record
/// keeps a verified V3 enable tx hash.
export async function migrateAgentRecordsToVault(
  owner: Address,
  v3Vault: Address,
  enableTxHashByAgentKey: Map<string, Hex> = new Map(),
): Promise<OgAgentDeploymentRecord[]> {
  const registry = await readAgentDeploymentRegistryArtifact();
  const deployments = mergeAgentDeploymentRecords([...(registry?.agents ?? [])]);
  const ownerLower = owner.toLowerCase();
  const v3Lower = v3Vault.toLowerCase();
  const migratedAt = new Date().toISOString();
  let changed = false;
  for (const record of deployments) {
    if (record.owner.toLowerCase() !== ownerLower) continue;
    if (record.vault.toLowerCase() === v3Lower) continue;
    record.migratedFromVault = record.vault;
    record.migratedAt = migratedAt;
    record.vault = v3Vault;
    const enableTx = record.agentKey ? enableTxHashByAgentKey.get(record.agentKey.toLowerCase()) : undefined;
    record.agentKeyEnableTxHash = enableTx;
    changed = true;
  }
  if (changed) {
    const removedAgents = buildRemovedAgentRecords(registry, deployments);
    await writeAgentDeploymentRegistry(deployments, removedAgents);
  }
  return deployments.filter((record) => record.owner.toLowerCase() === ownerLower);
}

/// Set the `runtime.automation.autoMint` flag on a single agent deployment
/// record. Mirrors the migrateAgentRecordsToVault pattern: read the registry,
/// find the record by `id === agentId && owner === owner`, mutate only that
/// record's automation field, re-run normalizeRuntimeSettings (which preserves
/// `automation`), and write the registry back. Throws `agent_not_found` when no
/// record matches, and `owner_mismatch` when a record with the id exists but
/// belongs to a different owner. Returns the updated record.
export async function setAgentAutomation(
  agentId: string,
  owner: Address,
  autoMint: boolean,
): Promise<OgAgentDeploymentRecord> {
  const registry = await readAgentDeploymentRegistryArtifact();
  const deployments = mergeAgentDeploymentRecords([...(registry?.agents ?? [])]);
  let target: OgAgentDeploymentRecord | undefined;
  let ownerConflict = false;
  for (const record of deployments) {
    if (record.id !== agentId) continue;
    if (record.owner.toLowerCase() !== owner.toLowerCase()) {
      ownerConflict = true;
      continue;
    }
    target = record;
    break;
  }
  if (!target) {
    throw new Error(ownerConflict ? "owner_mismatch" : "agent_not_found");
  }
  const current = target.runtime ?? normalizeRuntimeSettings(undefined);
  target.runtime = normalizeRuntimeSettings({
    ...current,
    automation: { ...(current.automation ?? {}), autoMint },
  });
  const removedAgents = buildRemovedAgentRecords(registry, deployments);
  await writeAgentDeploymentRegistry(deployments, removedAgents);
  return target;
}

export async function setAgentLpRuntimePolicy(
  agentId: string,
  owner: Address,
  input: {
    maxAprPct: number | null;
    maxPerPosition0G: string;
    maxPositions: number;
    minAprPct: number;
  },
): Promise<OgAgentDeploymentRecord> {
  const registry = await readAgentDeploymentRegistryArtifact();
  const deployments = mergeAgentDeploymentRecords([...(registry?.agents ?? [])]);
  let target: OgAgentDeploymentRecord | undefined;
  let ownerConflict = false;
  for (const record of deployments) {
    if (record.id !== agentId) continue;
    if (record.owner.toLowerCase() !== owner.toLowerCase()) {
      ownerConflict = true;
      continue;
    }
    target = record;
    break;
  }
  if (!target) {
    throw new Error(ownerConflict ? "owner_mismatch" : "agent_not_found");
  }
  const current = target.runtime ?? normalizeRuntimeSettings(undefined);
  target.runtime = normalizeRuntimeSettings({
    ...current,
    maxAprPct: input.maxAprPct,
    maxPerPosition0G: input.maxPerPosition0G,
    maxPositions: input.maxPositions,
    minAprPct: input.minAprPct,
  });
  const removedAgents = buildRemovedAgentRecords(registry, deployments);
  await writeAgentDeploymentRegistry(deployments, removedAgents);
  return target;
}

export interface VaultMigrationResult {
  owner: Address;
  v3Vault: Address;
  migratedFromVault: Address | null;
  agents: Array<{ id: string; agentKey: Hex; enableTxHash?: Hex; migrated: boolean }>;
}

/// Orchestrator for the v2 -> v3 migrate button. Resolves the owner's V3 singleton from the
/// off-chain registry (the V3 vault must already exist — deploy it via
/// `npm run vault:mainnet:create:v3`), re-enables each of the owner's agent keys on the V3 vault
/// (DEPLOYER pays gas; only possible when the deployer key IS the V3 owner), and re-points the
/// agent records to V3. Funds movement (V2 withdraw / V3 deposit) is left to the manual controls.
export async function migrateOwnerVaultToV3(
  owner: Address,
  /// Optional explicit allowlist of agent IDs to migrate. When set, ONLY records
  /// whose `id` is in this set are key-enabled + re-pointed. Omit to migrate ALL
  /// of the owner's active agents (the API-route behavior). Scripts that must
  /// bound the authorization blast radius pass an explicit list here. Removed
  /// agents are not in the active registry, so a removed id in this set is simply
  /// not matched (the caller reports it as skipped).
  targetAgentIds?: readonly string[],
): Promise<VaultMigrationResult> {
  assertMainnetDeployEnv();
  const v3Vault = await resolveMainnetV3VaultForOwner(owner);
  if (v3Vault === null) {
    throw new OgAgentDeployError(
      "No V3 Policy Vault found for this owner. Deploy one first via `npm run vault:mainnet:create:v3`.",
      "v3_vault_not_found",
      409,
    );
  }
  const rpcUrl = requireEnv("OG_RPC_URL");
  const deployer = privateKeyToAccount(readPrivateKeyEnv("DEPLOYER_PRIVATE_KEY"));
  const chain = make0GMainnetChain(rpcUrl);
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account: deployer, chain, transport: http(rpcUrl) });

  const [v3Owner, v3Executor, v3Paused, v3ExecutorRevoked] = await Promise.all([
    publicClient.readContract({ address: v3Vault, abi: policyVaultV3Abi, functionName: "owner" }) as Promise<Address>,
    publicClient.readContract({ address: v3Vault, abi: policyVaultV3Abi, functionName: "executor" }) as Promise<Address>,
    publicClient.readContract({ address: v3Vault, abi: policyVaultV3Abi, functionName: "paused" }) as Promise<boolean>,
    publicClient.readContract({ address: v3Vault, abi: policyVaultV3Abi, functionName: "executorRevoked" }) as Promise<boolean>,
  ]);
  if (v3Owner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new OgAgentDeployError(
      "DEPLOYER_PRIVATE_KEY must be the V3 vault owner to re-enable agent keys during migration.",
      "deployer_not_vault_owner",
      403,
    );
  }
  if (v3Paused) {
    throw new OgAgentDeployError("V3 vault is paused; unpause it before migrating agents.", "vault_paused", 409);
  }
  if (v3ExecutorRevoked) {
    throw new OgAgentDeployError("V3 vault executor is revoked; re-enable it before migrating agents.", "executor_revoked", 409);
  }
  void v3Executor;

  // Load the owner's current agent records (still pointing at V2).
  const registry = await readAgentDeploymentRegistryArtifact();
  const ownerLower = owner.toLowerCase();
  const targetSet = targetAgentIds ? new Set(targetAgentIds) : null;
  const ownerAgents = mergeAgentDeploymentRecords([...(registry?.agents ?? [])]).filter(
    (record) =>
      record.owner.toLowerCase() === ownerLower &&
      (targetSet === null || targetSet.has(record.id)),
  );

  const enableTxHashByAgentKey = new Map<string, Hex>();
  const agentResults: VaultMigrationResult["agents"] = [];
  for (const record of ownerAgents) {
    const agentKey = record.agentKey ?? agentKeyForDeployment(record);
    if (!agentKey) continue;
    const enableSimulation = await publicClient.simulateContract({
      account: deployer.address,
      address: v3Vault,
      abi: policyVaultV3Abi,
      functionName: "setAgentKeyEnabled",
      args: [agentKey, true],
    });
    const enableTxHash = await walletClient.writeContract({
      ...enableSimulation.request,
      account: deployer,
      chain,
    });
    await waitForReceipt(publicClient, enableTxHash, `V3 agent key enable ${record.id}`);
    enableTxHashByAgentKey.set(agentKey.toLowerCase(), enableTxHash);
    agentResults.push({ id: record.id, agentKey, enableTxHash, migrated: true });
  }

  // Determine the prior V2 vault (the first migrated record's pre-migration vault).
  const migratedFromVault = ownerAgents.length > 0 ? ownerAgents[0].vault : null;

  await migrateAgentRecordsToVault(owner, v3Vault, enableTxHashByAgentKey);

  return {
    owner,
    v3Vault,
    migratedFromVault,
    agents: agentResults,
  };
}

async function writeAgentDeploymentRegistry(
  deployments: OgAgentDeploymentRecord[],
  removedAgents: OgRemovedAgentRecord[] = [],
) {
  const normalizedRemovedAgents = mergeRemovedAgentRecords(removedAgents);
  await writeJsonArtifact(AGENT_REGISTRY_PATH, {
    agents: mergeAgentDeploymentRecords(deployments),
    removedAgentIds: normalizedRemovedAgents.map((deployment) => deployment.id).sort(),
    removedAgents: normalizedRemovedAgents,
    updatedAt: new Date().toISOString(),
  } satisfies AgentDeploymentRegistryArtifact);
}

function identityTokenKey(deployment: { identityAddress: Address; tokenId: string }): string {
  return `${deployment.identityAddress.toLowerCase()}:${deployment.tokenId}`;
}

function mergeAgentDeploymentRecords(records: Array<OgAgentDeploymentRecord | null | undefined>): OgAgentDeploymentRecord[] {
  const byIdentityToken = new Map<string, OgAgentDeploymentRecord>();
  for (const record of records) {
    const normalized = normalizeAgentDeploymentRecord(record);
    if (!normalized) continue;
    byIdentityToken.set(identityTokenKey(normalized), normalized);
  }
  return Array.from(byIdentityToken.values()).sort((left, right) => compareTokenIds(left.tokenId, right.tokenId));
}

function buildRemovedAgentRecords(
  registry: AgentDeploymentRegistryArtifact | null,
  candidateRecords: OgAgentDeploymentRecord[],
  extraRemovedIds: Set<string> = new Set(),
  extraRemovedAgentKeys: Set<string> = new Set(),
): OgRemovedAgentRecord[] {
  const candidatesById = new Map(candidateRecords.map((deployment) => [deployment.id, deployment]));
  const candidatesByAgentKey = new Map(
    candidateRecords.map((deployment) => [
      (deployment.agentKey ?? agentKeyForDeployment(deployment)).toLowerCase(),
      deployment,
    ]),
  );
  const removedRecords = (registry?.removedAgents ?? [])
    .map((record) => normalizeRemovedAgentRecord(record))
    .filter((record): record is OgRemovedAgentRecord => record !== null);
  // Key by (identityAddress, tokenId), not by the bare `.id` string. The id
  // "agent-0g-mainnet-{tokenId}" does not encode which AgenticID contract
  // minted it — a stale tombstone persisted for an old/dead identity contract
  // (e.g. from a prior V1 cleanup) must not block a fresh removal for the
  // SAME tokenId once it gets reused on the current identity contract.
  const removedByKey = new Map(removedRecords.map((record) => [identityTokenKey(record), record]));
  const registryUpdatedAt = registry?.updatedAt;
  const removedAt = registryUpdatedAt && isValidDateString(registryUpdatedAt) ? registryUpdatedAt : new Date().toISOString();

  for (const removedId of [...(registry?.removedAgentIds ?? []), ...extraRemovedIds]) {
    const candidate = candidatesById.get(removedId);
    if (!candidate || removedByKey.has(identityTokenKey(candidate))) continue;
    const tombstone = normalizeRemovedAgentRecord({ ...candidate, removedAt });
    if (tombstone) removedByKey.set(identityTokenKey(tombstone), tombstone);
  }

  for (const removedAgentKey of extraRemovedAgentKeys) {
    const candidate = candidatesByAgentKey.get(removedAgentKey);
    if (!candidate || removedByKey.has(identityTokenKey(candidate))) continue;
    const tombstone = normalizeRemovedAgentRecord({
      ...candidate,
      agentKeyDisabledAt: removedAt,
      removedAt,
    });
    if (tombstone) removedByKey.set(identityTokenKey(tombstone), tombstone);
  }

  return mergeRemovedAgentRecords(Array.from(removedByKey.values()));
}

function readEnvRemovedAgentIds(): Set<string> {
  const raw = [process.env.OG_AGENT_REMOVED_AGENT_IDS, process.env.OG_AGENT_DISABLED_AGENT_IDS]
    .filter((value): value is string => Boolean(value?.trim()))
    .join(",");
  return new Set(
    raw
      .split(/[\s,]+/u)
      .map((value) => value.trim())
      .filter((value) => /^agent-0g-mainnet-\d+$/u.test(value)),
  );
}

function readEnvRemovedAgentKeys(): Set<string> {
  const raw = [process.env.OG_AGENT_REMOVED_AGENT_KEYS, process.env.OG_AGENT_DISABLED_AGENT_KEYS]
    .filter((value): value is string => Boolean(value?.trim()))
    .join(",");
  return new Set(
    raw
      .split(/[\s,]+/u)
      .map((value) => value.trim().toLowerCase())
      .filter((value) => isHex(value, { strict: true }) && value.length === 66),
  );
}

function mergeRemovedAgentRecords(records: Array<OgRemovedAgentRecord | null | undefined>): OgRemovedAgentRecord[] {
  const byIdentityToken = new Map<string, OgRemovedAgentRecord>();
  for (const record of records) {
    const normalized = normalizeRemovedAgentRecord(record);
    if (!normalized) continue;
    byIdentityToken.set(`${normalized.identityAddress.toLowerCase()}:${normalized.tokenId}`, normalized);
  }
  return Array.from(byIdentityToken.values()).sort((left, right) => compareTokenIds(left.tokenId, right.tokenId));
}

function normalizeAgentDeploymentRecord(
  record: OgAgentDeploymentRecord | null | undefined,
): OgAgentDeploymentRecord | null {
  if (!record) return null;
  const tokenId = String(record.tokenId ?? "").trim();
  if (!/^\d+$/u.test(tokenId)) return null;
  const identityAddress = readAddress(record.identityAddress);
  const owner = readAddress(record.owner);
  const vault = readAddress(record.vault);
  const executor = readAddress(record.executor);
  const deployTxHash = isHex(record.deployTxHash, { strict: true }) ? record.deployTxHash : null;
  const storageRoot = isHex(record.storageRoot, { strict: true })
    ? record.storageRoot
    : extractStorageRoot(record.storageRef);
  if (!identityAddress || !owner || !vault || !executor || !deployTxHash || !storageRoot) {
    return null;
  }
  const filters = (Array.isArray(record.filters) ? record.filters : []).filter((filter): filter is OgAgentFilterId =>
    Boolean(getAgentFilterPreset(filter)),
  );
  return {
    ...record,
    createdAt: isValidDateString(record.createdAt) ? record.createdAt : new Date().toISOString(),
    deployTxHash,
    executor,
    filters: filters.length ? filters : ["capital-guard", "proof-strict"],
    agentKey: agentKeyForDeployment({ identityAddress, tokenId }),
    id: ogAgentIdFromTokenId(tokenId),
    identityAddress,
    name: record.name.trim() || `Agentic ID #${tokenId}`,
    owner,
    standard: STANDARD_LABEL,
    standardNote: record.standardNote || STANDARD_NOTE,
    storageRoot,
    tokenId,
    vault,
  };
}

function normalizeRemovedAgentRecord(
  record:
    | (OgAgentDeploymentRecord & {
        agentKeyDisabledAt?: string;
        agentKeyDisableTxHash?: string;
        removeMode?: string;
        removedAt?: string;
        removedBy?: string;
      })
    | null
    | undefined,
): OgRemovedAgentRecord | null {
  const normalized = normalizeAgentDeploymentRecord(record);
  if (!normalized) return null;
  const removedBy = readAddress(record?.removedBy);
  const removedAt = record?.removedAt;
  const agentKeyDisabledAt = record?.agentKeyDisabledAt;
  const agentKeyDisableTxHash = isHex(record?.agentKeyDisableTxHash, { strict: true })
    ? record.agentKeyDisableTxHash
    : undefined;
  return {
    ...normalized,
    ...(agentKeyDisabledAt && isValidDateString(agentKeyDisabledAt) ? { agentKeyDisabledAt } : {}),
    ...(agentKeyDisableTxHash ? { agentKeyDisableTxHash } : {}),
    removeMode: "soft-retire",
    removedAt: removedAt && isValidDateString(removedAt) ? removedAt : new Date().toISOString(),
    ...(removedBy ? { removedBy } : {}),
  };
}

async function readOnChainAgentDeploymentRecords(identityAddress?: Address): Promise<OgAgentDeploymentRecord[]> {
  if (!identityAddress) return [];
  const rpcUrl = process.env.OG_RPC_URL?.trim();
  if (!rpcUrl) return [];
  const publicClient = create0GPublicClient(rpcUrl);
  const chainId = await publicClient.getChainId();
  if (chainId !== MAINNET_CHAIN_ID) return [];
  const fromBlock = await readAgenticIdDeploymentBlock(publicClient).catch(() => 0n);
  const logs = await publicClient.getLogs({
    address: identityAddress,
    event: agentMintedEvent,
    fromBlock,
    toBlock: "latest",
  });
  const records = await Promise.all(logs.map((log) => agentMintedLogToDeploymentRecord(publicClient, identityAddress, log)));
  return records.filter((record): record is OgAgentDeploymentRecord => record !== null);
}

async function agentMintedLogToDeploymentRecord(
  publicClient: PublicClient,
  identityAddress: Address,
  log: {
    args?: unknown;
    blockNumber?: bigint | null;
    transactionHash?: Hex | null;
  },
): Promise<OgAgentDeploymentRecord | null> {
  const args = log.args as {
    executor?: Address;
    owner?: Address;
    tokenId?: bigint;
    vault?: Address;
    agentRef?: string;
    storageRef?: string;
  };
  if (
    args.tokenId === undefined ||
    !args.owner ||
    !args.vault ||
    !args.executor ||
    !args.agentRef ||
    !args.storageRef ||
    !log.transactionHash
  ) {
    return null;
  }
  const tokenId = args.tokenId.toString();
  const storageRoot = extractStorageRoot(args.storageRef);
  if (!storageRoot) return null;
  const [metadata, block] = await Promise.all([
    withTimeout(readStoredAgentMetadata(storageRoot), AGENT_METADATA_READ_TIMEOUT_MS, "agent metadata").catch(() => null),
    log.blockNumber
      ? withTimeout(publicClient.getBlock({ blockNumber: log.blockNumber }), AGENT_METADATA_READ_TIMEOUT_MS, "agent mint block").catch(() => null)
      : Promise.resolve(null),
  ]);
  return {
    agentRef: args.agentRef,
    createdAt: block?.timestamp ? new Date(Number(block.timestamp) * 1000).toISOString() : new Date().toISOString(),
    deployTxHash: log.transactionHash,
    executor: args.executor,
    filters: metadata?.filters ?? ["capital-guard", "proof-strict"],
    id: ogAgentIdFromTokenId(tokenId),
    identityAddress,
    name: metadata?.name ?? `Agentic ID #${tokenId}`,
    owner: args.owner,
    standard: STANDARD_LABEL,
    standardNote: STANDARD_NOTE,
    storageRef: args.storageRef,
    storageRoot,
    tokenId,
    vault: args.vault,
  };
}

async function readStoredAgentMetadata(storageRoot: Hex): Promise<{ filters?: OgAgentFilterId[]; name?: string }> {
  const bytes = await downloadBytesFrom0GStorage(storageRoot);
  const text = new TextDecoder().decode(bytes).trim();
  const payload = JSON.parse(text) as unknown;
  if (!payload || typeof payload !== "object") {
    return {};
  }
  const record = payload as {
    filters?: Array<{ id?: unknown }>;
    kind?: unknown;
    name?: unknown;
    standard?: unknown;
  };
  if (record.kind !== "single-trading-agent-identity" || record.standard !== STANDARD_LABEL) {
    return {};
  }
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const filters = Array.isArray(record.filters)
    ? record.filters
        .map((filter) => String(filter.id ?? ""))
        .filter((filter): filter is OgAgentFilterId => Boolean(getAgentFilterPreset(filter)))
    : [];
  return {
    ...(name ? { name } : {}),
    ...(filters.length ? { filters: Array.from(new Set(filters)) } : {}),
  };
}

async function readAgenticIdDeploymentBlock(publicClient: PublicClient): Promise<bigint> {
  const artifact = await readJsonArtifact<AgenticIdDeploymentArtifact>(AGENTIC_ID_DEPLOYMENT_PATH);
  if (!artifact?.txHash) return 0n;
  const receipt = await publicClient.getTransactionReceipt({ hash: artifact.txHash });
  return receipt.blockNumber;
}

function extractStorageRoot(storageRef: string | undefined): Hex | null {
  const root = storageRef?.match(/0g-storage:(0x[a-fA-F0-9]{64})(?::|$)/u)?.[1];
  return root && isHex(root, { strict: true }) ? root : null;
}

function compareTokenIds(left: string, right: string): number {
  const leftId = BigInt(left);
  const rightId = BigInt(right);
  if (leftId < rightId) return -1;
  if (leftId > rightId) return 1;
  return 0;
}

function isValidDateString(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

async function readAgentTradeArtifacts(
  deployment: OgAgentDeploymentRecord,
): Promise<[StoredAgentTradeArtifact | null, StoredAgentTradeArtifact | null]> {
  const [buyArtifact, sellArtifact, legacyBuyArtifact, legacySellArtifact] = await Promise.all([
    readJsonArtifact<StoredAgentTradeArtifact>(agentTradeArtifactPath(deployment.id, "buy")),
    readJsonArtifact<StoredAgentTradeArtifact>(agentTradeArtifactPath(deployment.id, "sell")),
    deployment.tokenId === "1" ? readJsonArtifact<StoredAgentTradeArtifact>(LEGACY_AGENT_TRADE_EXECUTION_PATH) : null,
    deployment.tokenId === "1" ? readJsonArtifact<StoredAgentTradeArtifact>(LEGACY_AGENT_SELL_EXECUTION_PATH) : null,
  ]);
  return [buyArtifact ?? legacyBuyArtifact, sellArtifact ?? legacySellArtifact];
}

function agentTradeArtifactPath(agentId: string, side: StoredAgentTradeSide): string {
  return join(AGENT_TRADE_ARTIFACT_DIR, `${safeArtifactName(agentId)}-${side}.json`);
}

function safeArtifactName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/gu, "_").slice(0, 96);
}

async function readJsonArtifact<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw.replace(/^\uFEFF/, "")) as T;
  } catch {
    return null;
  }
}

async function writeJsonArtifact(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function uniqueFilters(ids: OgAgentFilterId[]) {
  const result = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const preset = getAgentFilterPreset(id);
    if (preset && !seen.has(preset.id)) {
      seen.add(preset.id);
      result.push(preset);
    }
  }
  return result;
}

function assertMainnetDeployEnv() {
  if ((process.env.OG_NETWORK ?? "").toLowerCase() !== "mainnet") {
    throw new OgAgentDeployError("Deploy Agent requires OG_NETWORK=mainnet.", "mainnet_required", 409);
  }
  if (Number(requireEnv("OG_CHAIN_ID")) !== MAINNET_CHAIN_ID) {
    throw new OgAgentDeployError(`Deploy Agent requires OG_CHAIN_ID=${MAINNET_CHAIN_ID}.`, "mainnet_required", 409);
  }
  requireFlag("ENABLE_MAINNET_DEPLOY", true);
  requireFlag("ENABLE_REAL_DEX_ADAPTER", true);
  requireFlag("ENABLE_MOCK_DEX_ADAPTER", false);
}

function requireFlag(name: string, expected: boolean) {
  const actual = (process.env[name] ?? "false").toLowerCase() === "true";
  if (actual !== expected) {
    throw new OgAgentDeployError(`${name} must be ${String(expected)}.`, "flag_mismatch", 409);
  }
}

async function waitForReceipt(
  publicClient: ReturnType<typeof createPublicClient>,
  hash: Hex,
  label: string,
) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const receipt = await publicClient.getTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        throw new Error(`${label} transaction reverted: ${hash}`);
      }
      return receipt;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.toLowerCase().includes("receipt") || !message.toLowerCase().includes("not")) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error(`Timed out waiting for ${label} receipt: ${hash}`);
}

function make0GMainnetChain(rpcUrl: string): Chain {
  const network = getOgNetwork("mainnet");
  return {
    id: network.chainId,
    name: network.networkName,
    nativeCurrency: {
      decimals: 18,
      name: network.nativeToken,
      symbol: network.nativeToken,
    },
    rpcUrls: {
      default: { http: [rpcUrl] },
    },
  };
}

function readPrivateKeyEnv(name: string): Hex {
  const value = requireEnv(name);
  if (!isHex(value, { strict: true }) || value.length !== 66) {
    throw new Error(`${name} must be a 32-byte private key hex string.`);
  }
  return value as Hex;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function readAddress(value: string | undefined): Address | null {
  return value && isAddress(value) ? getAddress(value) : null;
}

function hashJson(value: unknown): Hex {
  return keccak256(toBytes(stableJson(value)));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  if (typeof value === "bigint") {
    return JSON.stringify(value.toString());
  }
  return JSON.stringify(value);
}
