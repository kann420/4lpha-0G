import "server-only";

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  formatEther,
  formatUnits,
  getAddress,
  http,
  isAddress,
  isHex,
  keccak256,
  parseAbiItem,
  toBytes,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { agenticIdAbi, agentMintedEvent, type AgenticIdIntelligentData } from "@/lib/contracts/agentic-id";
import { CURATED_MAINNET_POLICY_VAULT_ROUTES } from "@/lib/contracts/curated-routes";
import { policyVaultAbi, policyVaultAgentKeyAbi } from "@/lib/contracts/policy-vault";
import {
  readConfiguredMainnetVaultAddress,
  readMainnetOwnerAddress,
  resolveMainnetVaultForOwner,
  resolveMainnetVaultVersionsForOwner,
} from "@/lib/agent/mainnet-vault-resolver";
import { getOgNetwork } from "@/lib/og/networks";
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
  type OgAgentWorkspace,
  type OgAgentVaultSnapshot,
} from "@/lib/agent/single-agent";
import { readOgAgentRuns } from "@/lib/agent/runtime/store";
import type { OgAgentRuntimeRunRecord } from "@/lib/agent/runtime/types";

const MAINNET_CHAIN_ID = 16661;
const AGENT_REGISTRY_PATH = join(".data", "agents", "mainnet-agents.json");
const LEGACY_AGENT_DEPLOYMENT_PATH = join(".data", "agents", "mainnet-single-agent.json");
const LEGACY_AGENT_DEPLOY_RESPONSE_PATH = join(".data", "agents", "deploy-response.json");
const AGENT_STORAGE_PENDING_PATH = join(".data", "agents", "mainnet-agent-storage-pending.json");
const AGENT_TRADE_ARTIFACT_DIR = join(".data", "agents", "trades");
const LEGACY_AGENT_TRADE_EXECUTION_PATH = join(".data", "agents", "trade-execution-response.json");
const LEGACY_AGENT_SELL_EXECUTION_PATH = join(".data", "agents", "sell-execution-response.json");
const AGENTIC_ID_DEPLOYMENT_PATH = join(".data", "deployments", "mainnet-agentic-id.json");
const MAX_STORAGE_SYNC_LAG_BLOCKS = 120n;
const STORAGE_SNAPSHOT_CACHE_TTL_MS = 60_000;
const WORKSPACE_READ_TIMEOUT_MS = 6_000;
const AUXILIARY_READ_TIMEOUT_MS = 2_500;
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

const erc20DecimalsAbi = [
  {
    inputs: [],
    name: "decimals",
    outputs: [{ internalType: "uint8", name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export class OgAgentDeployError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface DeploySingleOgAgentInput {
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

export async function loadOgAgentWorkspace(input?: string | LoadOgAgentWorkspaceInput): Promise<OgAgentWorkspace> {
  const { agentId, live, ownerAddress } = normalizeWorkspaceInput(input);
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
  let roster = await readAgentDeploymentRoster(identity.address, {
    includeOnChain: live,
    ownerAddress: vault.owner ?? ownerAddress,
  });
  let deployments = roster.active;
  let removedDeployments = roster.removed;
  let deployment = selectAgentDeployment(deployments, agentId);
  let removedDeployment = selectRemovedAgentDeployment(removedDeployments, agentId);
  if (!ownerAddress && deployment && vault.owner?.toLowerCase() !== deployment.owner.toLowerCase()) {
    vault = await withTimeout(
      readVaultSnapshot(undefined, { ownerAddress: deployment.owner }),
      workspaceTimeoutMs,
      "Policy Vault state",
    ).catch((error): OgAgentVaultSnapshot => ({
      owner: deployment?.owner,
      ready: false,
      warnings: [error instanceof Error ? error.message : "Unable to read Policy Vault state."],
    }));
    roster = await readAgentDeploymentRoster(identity.address, {
      includeOnChain: live,
      ownerAddress: vault.owner ?? deployment.owner,
    });
    deployments = roster.active;
    removedDeployments = roster.removed;
    deployment = selectAgentDeployment(deployments, agentId);
    removedDeployment = selectRemovedAgentDeployment(removedDeployments, agentId);
  }
  const selectedDeployment = deployment ?? removedDeployment ?? null;
  const selectedAgentKeyEnabled = live && selectedDeployment && vault.vault && (vault.vaultVersion ?? 1) >= 2
    ? await withTimeout(
        readAgentKeyEnabled(vault.vault, selectedDeployment),
        AUXILIARY_READ_TIMEOUT_MS,
        "Agent key status",
      ).catch(() => undefined)
    : undefined;
  const status = removedDeployment
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
      vault = {
        ...vault,
        sellablePositions: await withTimeout(
          readSellablePositions(publicClient, vault.vault, { agentKey }),
          AUXILIARY_READ_TIMEOUT_MS,
          "sellable positions",
        ).catch(() => []),
      };
    }
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
      readiness: removedDeployment ? "blocked" : deployment && vault.ready ? "ready" : vault.ready ? "review" : "blocked",
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

  const vault = await readVaultSnapshot(publicClient, { ownerAddress: input.ownerAddress });
  if (!vault.ready || !vault.vault || !vault.executor || !vault.owner || !vault.policy) {
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
    runtime: normalizeRuntimeSettings(input.runtime),
  } satisfies OgAgentDeploymentRecord;

  await upsertAgentDeploymentRecord(record);
  return record;
}

export async function removeSingleOgAgentRecord(
  agentId: string,
  knownRecord?: OgAgentDeploymentRecord,
  removedBy?: Address,
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
    buildRemovedAgentRecords(registry, deployments),
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

export function agentKeyForDeployment(deployment: Pick<OgAgentDeploymentRecord, "identityAddress" | "tokenId">): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { name: "identityAddress", type: "address" },
        { name: "tokenId", type: "uint256" },
      ],
      [deployment.identityAddress, BigInt(deployment.tokenId)],
    ),
  );
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
  const versionedVaults = options.ownerAddress
    ? await resolveMainnetVaultVersionsForOwner(options.ownerAddress, publicClient).catch(() => [])
    : [];
  const activeVault = versionedVaults.at(-1);
  const vault = activeVault?.vault ?? (
    options.ownerAddress
      ? await resolveMainnetVaultForOwner(options.ownerAddress, publicClient).catch(() => null)
      : readConfiguredMainnetVaultAddress()
  );
  const vaultVersion = activeVault?.version;
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

  const [
    owner,
    executor,
    adapter,
    proofRegistry,
    mockAdapterAllowed,
    paused,
    executorRevoked,
    policy,
    dailySpent0G,
    openExposure0G,
    balance,
  ] = await Promise.all([
    publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "owner" }),
    publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "executor" }),
    publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "adapter" }),
    publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "proofRegistry" }),
    publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "mockAdapterAllowed" }),
    publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "paused" }),
    publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "executorRevoked" }),
    publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "policy" }),
    publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "dailySpent0G" }),
    publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "openExposure0G" }),
    publicClient.getBalance({ address: vault }),
  ]);
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
    mockAdapterAllowed,
    openExposure0G: formatEther(openExposure0G),
    owner,
    paused,
    policy: {
      cooldownSeconds: policy[3].toString(),
      dailyCap0G: formatEther(policy[1]),
      defaultMinOutBps: Number(policy[5]),
      maxDeadlineWindowSeconds: policy[4].toString(),
      maxExposure0G: formatEther(policy[2]),
      perTradeCap0G: formatEther(policy[0]),
    },
    proofRegistry,
    ready: warnings.length === 0,
    sellablePositions,
    vault,
    vaultVersion,
    warnings,
  };
}

async function readAgentKeyEnabled(vault: Address, deployment: OgAgentDeploymentRecord): Promise<boolean> {
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
    Array.from(routesByToken.values()).map(async (route) => {
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

      const decimals = await publicClient.readContract({
        address: route.tokenOut,
        abi: erc20DecimalsAbi,
        functionName: "decimals",
      }).catch(() => 18);

      return {
        amount: trimDecimal(formatUnits(amountRaw, decimals)),
        amountRaw: amountRaw.toString(),
        decimals,
        label: route.label,
        routeId: route.id,
        symbol: route.symbol.replace(/-direct|-oku/u, ""),
        tokenAddress: route.tokenOut,
      } satisfies OgAgentVaultPosition;
    }),
  );

  return positions.filter((position): position is OgAgentVaultPosition => position !== null);
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
  const logs: OgAgentLogEntry[] = [];

  for (const run of runtimeRuns) {
    logs.push(buildRuntimeLogEntry(run));
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
  const v2Logs = await publicClient.getLogs({
    address: deployment.vault,
    event: tradeExecutedV2Event,
    args: { agentKey },
    fromBlock,
    toBlock: "latest",
  }).catch(() => []);
  const sourceEvent = v2Logs.length > 0 ? "TradeExecutedV2" : "TradeExecuted";
  const logs = v2Logs.length > 0 ? v2Logs : await publicClient.getLogs({
    address: deployment.vault,
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
    maxPositions: clampInteger(input?.maxPositions, 1, 8, 2),
    signalConfidence: clampInteger(input?.signalConfidence, 1, 100, 75),
    slippageBps: clampInteger(input?.slippageBps, 1, 1000, 75),
  };
}

function sanitizeDecimalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/u.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function clampInteger(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function create0GPublicClient(rpcUrl: string): PublicClient {
  return createPublicClient({
    chain: make0GMainnetChain(rpcUrl),
    transport: http(rpcUrl, {
      retryCount: 0,
      timeout: OG_RPC_TIMEOUT_MS,
    }),
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
  filter: { includeOnChain?: boolean; ownerAddress?: Address; vaultAddress?: Address } = {},
): Promise<{ active: OgAgentDeploymentRecord[]; removed: OgRemovedAgentRecord[] }> {
  const registry = await readAgentDeploymentRegistryArtifact();
  const [onChainRecords, legacyDeployResponse, legacySingleRecord] = await Promise.all([
    filter.includeOnChain
      ? withTimeout(
          readOnChainAgentDeploymentRecords(identityAddress),
          AUXILIARY_READ_TIMEOUT_MS,
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
  const appDeploymentIds = new Set(appDeployments.map((deployment) => deployment.id));
  const deploymentCandidates = mergeAgentDeploymentRecords([
    ...((filter.ownerAddress || filter.vaultAddress) ? onChainRecords : []),
    ...appDeployments,
  ]);
  const removedCandidates = mergeAgentDeploymentRecords([...onChainRecords, ...appDeployments]);
  const removedAgents = buildRemovedAgentRecords(registry, removedCandidates, readEnvRemovedAgentIds())
    .filter((deployment) => deploymentMatchesFilter(deployment, filter));
  const removedAgentIds = new Set(removedAgents.map((deployment) => deployment.id));

  const activeCandidates = deploymentCandidates.filter((deployment) => {
    if (removedAgentIds.has(deployment.id)) return false;
    return deploymentMatchesFilter(deployment, filter);
  });
  const activeDeployments = await filterActiveOnChainAgentRecords(activeCandidates, appDeploymentIds, filter);
  return { active: activeDeployments, removed: removedAgents };
}

async function filterActiveOnChainAgentRecords(
  deployments: OgAgentDeploymentRecord[],
  appDeploymentIds: Set<string>,
  filter: { includeOnChain?: boolean; ownerAddress?: Address; vaultAddress?: Address },
): Promise<OgAgentDeploymentRecord[]> {
  if (!filter.includeOnChain || (!filter.ownerAddress && !filter.vaultAddress)) {
    return deployments;
  }

  const vault = filter.vaultAddress ?? (
    filter.ownerAddress ? await resolveMainnetVaultForOwner(filter.ownerAddress).catch(() => null) : null
  );
  if (!vault) {
    return deployments;
  }

  const filtered = await Promise.all(
    deployments.map(async (deployment): Promise<OgAgentDeploymentRecord | null> => {
      if (appDeploymentIds.has(deployment.id)) {
        return deployment;
      }
      const enabled = await withTimeout(
        readAgentKeyEnabled(vault, deployment),
        AUXILIARY_READ_TIMEOUT_MS,
        "Agent key status",
      ).catch(() => undefined);
      return enabled === false ? null : deployment;
    }),
  );
  return filtered.filter((deployment): deployment is OgAgentDeploymentRecord => deployment !== null);
}

function deploymentMatchesFilter(
  deployment: OgAgentDeploymentRecord,
  filter: { ownerAddress?: Address; vaultAddress?: Address },
): boolean {
  if (filter.ownerAddress && deployment.owner.toLowerCase() !== filter.ownerAddress.toLowerCase()) return false;
  if (filter.vaultAddress && deployment.vault.toLowerCase() !== filter.vaultAddress.toLowerCase()) return false;
  return true;
}

async function readAgentDeploymentRegistryArtifact(): Promise<AgentDeploymentRegistryArtifact | null> {
  return readJsonArtifact<AgentDeploymentRegistryArtifact>(AGENT_REGISTRY_PATH);
}

async function readLegacyDeployResponseRecord(): Promise<OgAgentDeploymentRecord | null> {
  const artifact = await readJsonArtifact<LegacyDeployResponseArtifact>(LEGACY_AGENT_DEPLOY_RESPONSE_PATH);
  return artifact?.data?.deployment ?? null;
}

async function upsertAgentDeploymentRecord(record: OgAgentDeploymentRecord) {
  const registry = await readAgentDeploymentRegistryArtifact();
  const deployments = mergeAgentDeploymentRecords([...(registry?.agents ?? []), record]);
  const removedAgents = buildRemovedAgentRecords(registry, deployments).filter((deployment) => deployment.id !== record.id);
  await writeAgentDeploymentRegistry(deployments, removedAgents);
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

function mergeAgentDeploymentRecords(records: Array<OgAgentDeploymentRecord | null | undefined>): OgAgentDeploymentRecord[] {
  const byIdentityToken = new Map<string, OgAgentDeploymentRecord>();
  for (const record of records) {
    const normalized = normalizeAgentDeploymentRecord(record);
    if (!normalized) continue;
    byIdentityToken.set(`${normalized.identityAddress.toLowerCase()}:${normalized.tokenId}`, normalized);
  }
  return Array.from(byIdentityToken.values()).sort((left, right) => compareTokenIds(left.tokenId, right.tokenId));
}

function buildRemovedAgentRecords(
  registry: AgentDeploymentRegistryArtifact | null,
  candidateRecords: OgAgentDeploymentRecord[],
  extraRemovedIds: Set<string> = new Set(),
): OgRemovedAgentRecord[] {
  const candidatesById = new Map(candidateRecords.map((deployment) => [deployment.id, deployment]));
  const removedRecords = (registry?.removedAgents ?? [])
    .map((record) => normalizeRemovedAgentRecord(record))
    .filter((record): record is OgRemovedAgentRecord => record !== null);
  const removedById = new Map(removedRecords.map((record) => [record.id, record]));
  const registryUpdatedAt = registry?.updatedAt;
  const removedAt = registryUpdatedAt && isValidDateString(registryUpdatedAt) ? registryUpdatedAt : new Date().toISOString();

  for (const removedId of [...(registry?.removedAgentIds ?? []), ...extraRemovedIds]) {
    if (removedById.has(removedId)) continue;
    const candidate = candidatesById.get(removedId);
    if (!candidate) continue;
    const tombstone = normalizeRemovedAgentRecord({ ...candidate, removedAt });
    if (tombstone) removedById.set(tombstone.id, tombstone);
  }

  return mergeRemovedAgentRecords(Array.from(removedById.values()));
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
  record: (OgAgentDeploymentRecord & { removedAt?: string; removedBy?: string }) | null | undefined,
): OgRemovedAgentRecord | null {
  const normalized = normalizeAgentDeploymentRecord(record);
  if (!normalized) return null;
  const removedBy = readAddress(record?.removedBy);
  const removedAt = record?.removedAt;
  return {
    ...normalized,
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
  const metadata = await readStoredAgentMetadata(storageRoot).catch(() => null);
  const block = log.blockNumber
    ? await publicClient.getBlock({ blockNumber: log.blockNumber }).catch(() => null)
    : null;
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
