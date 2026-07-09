import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  formatEther,
  getAddress,
  isAddress,
  isHex,
  parseAbiItem,
  parseEther,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

import { agentKeyForDeployment, OgAgentDeployError } from "./agent-deploy-common";
import type { DeployerRuntime } from "./lp/lp-deploy";
import type { OgAgentDeploymentRecord, OgRemovedAgentRecord } from "./single-agent";
import {
  canonicalize,
  hashPerNftDecisions,
  LEGACY_V3_VAULTS,
  type PerNftDecision,
  type V4VaultTrio,
} from "./vault-migrate-v4-shared";
import { curatedMainnetRouteIds, uniqueCuratedMainnetTokens } from "../contracts/curated-routes";
import {
  normalizePolicyVaultV3Policy,
  policyVaultV3Abi,
} from "../contracts/policy-vault-v3";
import {
  policyVaultV4LpEntryAbi,
  policyVaultV4LpExitAbi,
  policyVaultV4SwapAbi,
  vaultRegistryV4Abi,
  type PolicyVaultV4LpPolicy,
  type PolicyVaultV4SwapPolicy,
} from "../contracts/policy-vault-v4";
import {
  buildV3LpAllowlists,
  findZiaLpVaultByPool,
  poolIdFromAddress,
  ziaNonfungiblePositionManagerAbi,
  ziaVaultAbi,
  ZIA_LP_MAINNET,
  ZIA_LP_VAULTS,
} from "../contracts/zia-lp";

const CHAIN_ID = 16661;
const STATE_FILE_PATH = join(process.cwd(), ".data", "deployments", "vault-migrate-v4-state.json");
const AGENT_REGISTRY_PATH = join(process.cwd(), ".data", "agents", "mainnet-agents.json");
const SENTINEL_TXHASH = "0x" as Hex;
const ZERO_BYTES32 = `0x${"00".repeat(32)}` as Hex;
const GAS_RESERVE_0G = "0.05";
const WITHDRAW_RESIDUAL_TOLERANCE_0G = "0.0001";
const CAP_PRESET = "1000000";
const CAP_PRESET_WEI = parseEther(CAP_PRESET);
const MAX_UINT256 = 2n ** 256n - 1n;
const DAY_SECONDS = 24n * 60n * 60n;
const DEFAULT_LOG_CHUNK_BLOCKS = 250_000n;

const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)");
const increaseLiquidityEvent = parseAbiItem("event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)");
const depositEvent = parseAbiItem("event Deposit(uint256 indexed tokenId, uint256 amount0, uint256 amount1)");

const erc20BalanceAbi = [
  {
    inputs: [{ internalType: "address", name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

// All three V4 vaults expose `address public immutable executor`. The Swap ABI exports it;
// LpEntry/LpExit ABIs do not, so use this fragment to read the executor getter uniformly
// when verifying an adopted vault's config (Finding #4).
const executorGetterAbi = [
  {
    inputs: [],
    name: "executor",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export type V4VaultSlot = "swapVault" | "lpEntryVault" | "lpExitVault";
export type PerNftStage =
  | "undecided"
  | "preserve_ready"
  | "imported"
  | "preserve_blocked"
  | "unsupported_accounting"
  | "skipped_burned"
  | "unknown_status";

export interface VaultMigrateV4State {
  oldVault: Address;
  v4Trio?: V4VaultTrio;
  v4TrioDeployTxHashes?: Partial<Record<V4VaultSlot, Hex>>;
  v4TrioRegisterTxHashes?: Partial<Record<V4VaultSlot, Hex>>;
  lpExitSetTxHash?: Hex;
  inventory?: V3VaultInventory;
  inventoryHash?: Hex;
  inventoryToBlock?: string;
  phase2Started?: boolean;
  nftStages?: Record<string, PerNftStage>;
  nftTxHashes?: Record<string, Record<string, Hex>>;
  intendedWithdrawWei?: string;
  withdrawnAmount0G?: string;
  withdrawTxHash?: Hex;
  v4SwapBalanceBeforeDepositWei?: string;
  depositAmount0G?: string;
  depositTxHash?: Hex;
  rosterRepointed?: boolean;
  repointedAgents?: string[];
  v3Retired?: boolean;
  v3RetireTxHashes?: { pause?: Hex; revoke?: Hex };
  updatedAt: string;
}

export interface TokenBalanceInventory {
  balance: string;
  token: Address;
}

export interface SelectorProbeResult {
  lpNftDeployedNative: boolean;
  lpNftOwner: boolean;
  lpNftPool: boolean;
  lpNftTickLower: boolean;
  lpNftTickUpper: boolean;
}

export interface PerNftInventory {
  agentId?: string;
  agentKey?: Hex;
  decision: "undecided" | "preserve";
  deployedNative0G?: string;
  deployedNativeSource?: "getter" | "events";
  ownerOf?: Address;
  poolId?: Hex;
  poolLabel?: string;
  stage: PerNftStage;
  stakeVault?: Address;
  statusReason?: string;
  staked: boolean;
  tickLower?: number;
  tickUpper?: number;
  tokenId: string;
}

export interface V3VaultInventory {
  fromBlock: string;
  nativeBalance0G: string;
  nfts: PerNftInventory[];
  oldVault: Address;
  scannedToBlock: string;
  selectorProbe: SelectorProbeResult;
  tokenBalances: TokenBalanceInventory[];
}

interface AgentDeploymentRegistryArtifact {
  agents: OgAgentDeploymentRecord[];
  removedAgentIds?: string[];
  removedAgents?: OgRemovedAgentRecord[];
  updatedAt?: string;
}

interface V3NftGetterValues {
  lpNftDeployedNative?: bigint;
  lpNftOwner?: Hex;
  lpNftPool?: Hex;
  lpNftTickLower?: number;
  lpNftTickUpper?: number;
}

interface V4DeployConfig {
  adapter: Address;
  executor: Address;
  lpAdapter: Address;
  proofRegistry: Address;
  registry: Address;
}

export interface VaultMigrateV4Result {
  phase: "review_required" | "executed";
  oldVault: Address;
  v4Trio: V4VaultTrio;
  inventory: V3VaultInventory;
  inventoryHash: Hex;
  withdrawTxHash?: Hex;
  depositTxHash?: Hex;
  withdrawnAmount0G?: string;
  depositAmount0G?: string;
  preservedTokenIds?: string[];
  repointedAgents?: string[];
  retired?: boolean;
}

export interface WalletOwnedV4FinalizeInput {
  inventoryHash?: Hex;
  owner: Address;
  sourceVault: Address;
  sourceVersion: 1 | 2 | 3;
  v4Trio: V4VaultTrio;
}

export interface WalletOwnedV4FinalizeResult {
  inventoryHash?: Hex;
  oldVault: Address;
  repointedAgents: string[];
  retired: boolean;
  v4Trio: V4VaultTrio;
}

export function buildV4MigrationSwapPolicy(): PolicyVaultV4SwapPolicy {
  return {
    perTradeCap0G: CAP_PRESET_WEI,
    dailyCap0G: CAP_PRESET_WEI,
    maxExposure0G: CAP_PRESET_WEI,
    cooldownSeconds: 0n,
    maxDeadlineWindowSeconds: 3600n,
    defaultMinOutBps: 9500,
  };
}

export function buildV4MigrationLpPolicy(): PolicyVaultV4LpPolicy {
  return {
    perLpActionCap0G: CAP_PRESET_WEI,
    lpDailyCap0G: CAP_PRESET_WEI,
    maxLpExposure0G: MAX_UINT256,
    cooldownSecondsLp: 0n,
    lpMinOutBps: 9500,
    minLiquidityFloor: 1n,
    allowStaking: true,
  };
}

export async function loadV4Artifact(contractName: "PolicyVaultV4Swap" | "PolicyVaultV4LpEntry" | "PolicyVaultV4LpExit"): Promise<{ abi: Abi; bytecode: Hex }> {
  const artifactPath = join(process.cwd(), "artifacts", "contracts", `${contractName}.sol`, `${contractName}.json`);
  let raw: string;
  try {
    raw = await readFile(artifactPath, "utf8");
  } catch {
    throw new OgAgentDeployError(`${contractName} artifact not found at ${artifactPath}. Run \`npx hardhat compile\` first.`, "artifact_missing", 500);
  }
  const parsed = JSON.parse(raw) as { abi?: Abi; bytecode?: Hex };
  if (!parsed.abi || !Array.isArray(parsed.abi) || !parsed.bytecode || !isHex(parsed.bytecode) || parsed.bytecode === "0x") {
    throw new OgAgentDeployError(`${contractName} artifact is missing abi or bytecode.`, "artifact_missing", 500);
  }
  return { abi: parsed.abi, bytecode: parsed.bytecode };
}

export async function deployMainnetV4VaultTrio(
  runtime: DeployerRuntime,
  owner: Address,
  opts: Partial<V4DeployConfig> = {},
  state: VaultMigrateV4State,
): Promise<V4VaultTrio> {
  const config = { ...readV4DeployConfig(), ...opts };
  const registered = await readRegistryTrio(runtime.publicClient, config.registry, owner);
  const deployHashes = { ...(state.v4TrioDeployTxHashes ?? {}) };
  const registerHashes = { ...(state.v4TrioRegisterTxHashes ?? {}) };
  const trio: Partial<V4VaultTrio> = {};

  if (registered.lpEntryVault !== zeroAddress) {
    await verifyV4VaultConfig(runtime.publicClient, registered.lpEntryVault, owner, "lpEntry", config);
    trio.lpEntryVault = registered.lpEntryVault;
  } else if (state.v4Trio?.lpEntryVault) {
    await verifyV4VaultConfig(runtime.publicClient, state.v4Trio.lpEntryVault, owner, "lpEntry", config);
    trio.lpEntryVault = state.v4Trio.lpEntryVault;
  } else {
    const artifact = await loadV4Artifact("PolicyVaultV4LpEntry");
    const { allowedLpPools, allowedStakeVaults, stakeVaultForLpPool } = buildV3LpAllowlists();
    const txHash = await runtime.walletClient.deployContract({
      abi: artifact.abi,
      bytecode: artifact.bytecode,
      args: [
        owner,
        config.executor,
        config.lpAdapter,
        config.proofRegistry,
        false,
        config.registry,
        buildV4MigrationLpPolicy(),
        allowedLpPools,
        allowedStakeVaults,
        stakeVaultForLpPool,
      ],
      account: runtime.deployer,
      chain: runtime.chain,
    });
    const receipt = await waitForReceipt(runtime.publicClient, txHash, "deploy:PolicyVaultV4LpEntry");
    if (!receipt.contractAddress) throw new OgAgentDeployError("PolicyVaultV4LpEntry deploy receipt missing contractAddress.", "tx_reverted", 500);
    trio.lpEntryVault = getAddress(receipt.contractAddress);
    deployHashes.lpEntryVault = txHash;
    await verifyV4VaultConfig(runtime.publicClient, trio.lpEntryVault, owner, "lpEntry", config);
  }

  if (registered.lpExitVault !== zeroAddress) {
    await verifyV4VaultConfig(runtime.publicClient, registered.lpExitVault, owner, "lpExit", config);
    trio.lpExitVault = registered.lpExitVault;
  } else if (state.v4Trio?.lpExitVault) {
    await verifyV4VaultConfig(runtime.publicClient, state.v4Trio.lpExitVault, owner, "lpExit", config);
    trio.lpExitVault = state.v4Trio.lpExitVault;
  } else {
    if (!trio.lpEntryVault) throw new OgAgentDeployError("LpEntry must be deployed before LpExit.", "migration_failed", 500);
    const artifact = await loadV4Artifact("PolicyVaultV4LpExit");
    const { allowedLpPools } = buildV3LpAllowlists();
    const txHash = await runtime.walletClient.deployContract({
      abi: artifact.abi,
      bytecode: artifact.bytecode,
      args: [
        owner,
        config.executor,
        config.lpAdapter,
        config.proofRegistry,
        false,
        config.registry,
        trio.lpEntryVault,
        allowedLpPools,
        uniqueCuratedMainnetTokens(),
      ],
      account: runtime.deployer,
      chain: runtime.chain,
    });
    const receipt = await waitForReceipt(runtime.publicClient, txHash, "deploy:PolicyVaultV4LpExit");
    if (!receipt.contractAddress) throw new OgAgentDeployError("PolicyVaultV4LpExit deploy receipt missing contractAddress.", "tx_reverted", 500);
    trio.lpExitVault = getAddress(receipt.contractAddress);
    deployHashes.lpExitVault = txHash;
    await verifyV4VaultConfig(runtime.publicClient, trio.lpExitVault, owner, "lpExit", config);
  }

  if (registered.swapVault !== zeroAddress) {
    await verifyV4VaultConfig(runtime.publicClient, registered.swapVault, owner, "swap", config);
    trio.swapVault = registered.swapVault;
  } else if (state.v4Trio?.swapVault) {
    await verifyV4VaultConfig(runtime.publicClient, state.v4Trio.swapVault, owner, "swap", config);
    trio.swapVault = state.v4Trio.swapVault;
  } else {
    const artifact = await loadV4Artifact("PolicyVaultV4Swap");
    const txHash = await runtime.walletClient.deployContract({
      abi: artifact.abi,
      bytecode: artifact.bytecode,
      args: [
        owner,
        config.executor,
        config.adapter,
        config.proofRegistry,
        buildV4MigrationSwapPolicy(),
        uniqueCuratedMainnetTokens(),
        curatedMainnetRouteIds(),
        false,
        config.registry,
      ],
      account: runtime.deployer,
      chain: runtime.chain,
    });
    const receipt = await waitForReceipt(runtime.publicClient, txHash, "deploy:PolicyVaultV4Swap");
    if (!receipt.contractAddress) throw new OgAgentDeployError("PolicyVaultV4Swap deploy receipt missing contractAddress.", "tx_reverted", 500);
    trio.swapVault = getAddress(receipt.contractAddress);
    deployHashes.swapVault = txHash;
    await verifyV4VaultConfig(runtime.publicClient, trio.swapVault, owner, "swap", config);
  }

  const complete = requireCompleteTrio(trio);
  const afterDeploy = await readRegistryTrio(runtime.publicClient, config.registry, owner);
  if (afterDeploy.lpEntryVault === zeroAddress) {
    registerHashes.lpEntryVault = await registerV4Slot(runtime, config.registry, "registerLpEntry", complete.lpEntryVault);
  }
  if (afterDeploy.lpExitVault === zeroAddress) {
    registerHashes.lpExitVault = await registerV4Slot(runtime, config.registry, "registerLpExit", complete.lpExitVault);
  }
  if (afterDeploy.swapVault === zeroAddress) {
    registerHashes.swapVault = await registerV4Slot(runtime, config.registry, "registerSwap", complete.swapVault);
  }

  const registeredFinal = await readRegistryTrio(runtime.publicClient, config.registry, owner);
  assertSameAddress(registeredFinal.swapVault, complete.swapVault, "registry swap");
  assertSameAddress(registeredFinal.lpEntryVault, complete.lpEntryVault, "registry lpEntry");
  assertSameAddress(registeredFinal.lpExitVault, complete.lpExitVault, "registry lpExit");

  const currentLpExit = await runtime.publicClient.readContract({
    address: complete.lpEntryVault,
    abi: policyVaultV4LpEntryAbi,
    functionName: "lpExitVault",
  }) as Address;
  if (currentLpExit === zeroAddress) {
    const txHash = await writeVaultContract(runtime, complete.lpEntryVault, policyVaultV4LpEntryAbi, "setLpExitVault", [complete.lpExitVault]);
    state.lpExitSetTxHash = txHash;
  } else {
    assertSameAddress(currentLpExit, complete.lpExitVault, "lpEntry.lpExitVault");
  }

  state.v4Trio = complete;
  state.v4TrioDeployTxHashes = deployHashes;
  state.v4TrioRegisterTxHashes = registerHashes;
  state.updatedAt = new Date().toISOString();
  return complete;
}

export async function setAgentKeyEnabledOnV4Trio(
  runtime: DeployerRuntime,
  trio: V4VaultTrio,
  agentKey: Hex,
  enabled: boolean,
): Promise<Partial<Record<V4VaultSlot, Hex>>> {
  const result: Partial<Record<V4VaultSlot, Hex>> = {};
  for (const [slot, address, abi] of [
    ["swapVault", trio.swapVault, policyVaultV4SwapAbi],
    ["lpEntryVault", trio.lpEntryVault, policyVaultV4LpEntryAbi],
    ["lpExitVault", trio.lpExitVault, policyVaultV4LpExitAbi],
  ] as const) {
    const current = await runtime.publicClient.readContract({ address, abi, functionName: "agentKeyEnabled", args: [agentKey] }) as boolean;
    if (current === enabled) continue;
    result[slot] = await writeVaultContract(runtime, address, abi, "setAgentKeyEnabled", [agentKey, enabled]);
  }
  return result;
}

export async function inventoryV3Vault(runtime: Pick<DeployerRuntime, "publicClient">, oldVault: Address, agentIds: string[] = []): Promise<V3VaultInventory> {
  const old = getAddress(oldVault);
  const latestBlock = await runtime.publicClient.getBlockNumber();
  const fromBlock = await readInventoryFromBlock(runtime.publicClient, old);
  const tokenIds = await scanNfpmTransferTokenIds(runtime.publicClient, old, fromBlock, latestBlock);
  const [nativeBalance, tokenBalances, roster, burnedForm] = await Promise.all([
    runtime.publicClient.getBalance({ address: old }),
    readTokenBalances(runtime.publicClient, old),
    readAgentRegistry(),
    probeNfpmBurnedRevertForm(runtime.publicClient),
  ]);
  const rosterByPinnedToken = buildPinnedRosterIndex(roster, agentIds);
  const selectorProbe: SelectorProbeResult = {
    lpNftOwner: true,
    lpNftPool: true,
    lpNftTickLower: true,
    lpNftTickUpper: true,
    lpNftDeployedNative: true,
  };
  const nfts: PerNftInventory[] = [];
  for (const tokenId of tokenIds) {
    const tokenIdString = tokenId.toString();
    const getters = await readV3NftGetters(runtime.publicClient, old, tokenId);
    for (const key of Object.keys(selectorProbe) as Array<keyof SelectorProbeResult>) {
      if (!getters.ok[key]) selectorProbe[key] = false;
    }
    const ownerKey = getters.values.lpNftOwner;
    const ownerStatus = await readNfpmOwnerStatus(runtime.publicClient, tokenId, burnedForm, ownerKey === ZERO_BYTES32);
    if (ownerStatus.kind === "burned") {
      nfts.push({ tokenId: tokenIdString, decision: "undecided", stage: "skipped_burned", staked: false, statusReason: "burned" });
      continue;
    }
    if (ownerStatus.kind === "unknown") {
      nfts.push({ tokenId: tokenIdString, decision: "undecided", stage: "unknown_status", staked: false, statusReason: ownerStatus.reason });
      continue;
    }
    if (!getters.ok.lpNftOwner || !getters.ok.lpNftPool || !getters.ok.lpNftTickLower || !getters.ok.lpNftTickUpper) {
      nfts.push({ tokenId: tokenIdString, decision: "undecided", stage: "unsupported_accounting", staked: false, statusReason: "required_v3_getter_reverted" });
      continue;
    }
    if (!ownerKey || ownerKey === ZERO_BYTES32 || !getters.values.lpNftPool || getters.values.lpNftTickLower === undefined || getters.values.lpNftTickUpper === undefined) {
      nfts.push({ tokenId: tokenIdString, decision: "undecided", stage: "unknown_status", staked: false, statusReason: "missing_v3_accounting" });
      continue;
    }
    let deployedNative = getters.values.lpNftDeployedNative;
    let deployedNativeSource: PerNftInventory["deployedNativeSource"] = "getter";
    if (!getters.ok.lpNftDeployedNative || deployedNative === undefined) {
      deployedNative = await reconstructDeployedNativeFromEvents(runtime.publicClient, tokenId, fromBlock, latestBlock).catch(() => undefined);
      deployedNativeSource = "events";
    }
    if (deployedNative === undefined) {
      nfts.push({
        tokenId: tokenIdString,
        agentKey: ownerKey,
        decision: "undecided",
        poolId: getters.values.lpNftPool,
        stage: "unsupported_accounting",
        staked: false,
        statusReason: "deployed_native_unverifiable",
      });
      continue;
    }
    const rosterEntry = rosterByPinnedToken.get(tokenIdString);
    if (!rosterEntry) {
      nfts.push({
        tokenId: tokenIdString,
        agentKey: ownerKey,
        decision: "undecided",
        poolId: getters.values.lpNftPool,
        stage: "unsupported_accounting",
        staked: false,
        statusReason: "AgentKeyUnresolvable",
      });
      continue;
    }
    const expectedAgentKey = agentKeyForDeployment(rosterEntry);
    if (expectedAgentKey.toLowerCase() !== ownerKey.toLowerCase()) {
      nfts.push({
        tokenId: tokenIdString,
        agentKey: ownerKey,
        decision: "undecided",
        poolId: getters.values.lpNftPool,
        stage: "unsupported_accounting",
        staked: false,
        statusReason: "AgentKeyUnresolvable",
      });
      continue;
    }
    const custody = classifyNftCustody(old, ownerStatus.owner);
    if (!sameAddress(ownerStatus.owner, old) && !custody.stakeVault) {
      nfts.push({
        agentId: rosterEntry.id,
        agentKey: ownerKey,
        decision: "undecided",
        deployedNative0G: deployedNative.toString(),
        deployedNativeSource,
        ownerOf: ownerStatus.owner,
        poolId: getters.values.lpNftPool,
        poolLabel: poolLabelForPoolId(getters.values.lpNftPool),
        stage: "unknown_status",
        staked: false,
        statusReason: "nft_not_in_old_vault_or_known_stake_vault",
        tickLower: getters.values.lpNftTickLower,
        tickUpper: getters.values.lpNftTickUpper,
        tokenId: tokenIdString,
      });
      continue;
    }
    nfts.push({
      agentId: rosterEntry.id,
      agentKey: ownerKey,
      decision: "undecided",
      deployedNative0G: deployedNative.toString(),
      deployedNativeSource,
      ownerOf: ownerStatus.owner,
      poolId: getters.values.lpNftPool,
      poolLabel: poolLabelForPoolId(getters.values.lpNftPool),
      stage: "undecided",
      stakeVault: custody.stakeVault,
      staked: custody.staked,
      tickLower: getters.values.lpNftTickLower,
      tickUpper: getters.values.lpNftTickUpper,
      tokenId: tokenIdString,
    });
  }
  return {
    fromBlock: fromBlock.toString(),
    nativeBalance0G: formatEther(nativeBalance),
    nfts: nfts.sort((left, right) => compareBigintString(left.tokenId, right.tokenId)),
    oldVault: old,
    scannedToBlock: latestBlock.toString(),
    selectorProbe,
    tokenBalances,
  };
}

export async function rescueLpNftPreserve(
  runtime: DeployerRuntime,
  oldVault: Address,
  v4LpEntry: Address,
  nfpm: Address,
  tokenId: bigint,
  agentKey: Hex,
  poolId: Hex,
  ticks: { tickLower: number; tickUpper: number },
  deployedNative: bigint,
  state: VaultMigrateV4State,
): Promise<{ tokenId: string; stage: "imported"; txHashes: Record<string, Hex> }> {
  const tokenKey = tokenId.toString();
  const trio = state.v4Trio;
  if (!trio) throw new OgAgentDeployError("V4 trio is not available for preserve.", "migration_state_missing", 500);
  await ensurePreservePreflight(runtime, trio, tokenId, agentKey, poolId, deployedNative, true);
  const txHashes = { ...(state.nftTxHashes?.[tokenKey] ?? {}) };
  const custody = await readNfpmOwnerStatus(runtime.publicClient, tokenId, await probeNfpmBurnedRevertForm(runtime.publicClient), false);
  if (custody.kind !== "owner") {
    throw new OgAgentDeployError(`NFT ${tokenKey} ownerOf is not readable for preserve: ${custody.reason}`, "unknown_status", 409);
  }
  const lpOwner = await runtime.publicClient.readContract({
    address: v4LpEntry,
    abi: policyVaultV4LpEntryAbi,
    functionName: "lpNftOwner",
    args: [tokenId],
  }) as Hex;
  if (sameAddress(custody.owner, v4LpEntry) && lpOwner.toLowerCase() === agentKey.toLowerCase()) {
    markNftStage(state, tokenKey, "imported", txHashes);
    return { tokenId: tokenKey, stage: "imported", txHashes };
  }
  if (sameAddress(custody.owner, v4LpEntry) && lpOwner === ZERO_BYTES32) {
    txHashes.import = await importV4LpNft(runtime, v4LpEntry, tokenId, agentKey, poolId, ticks, deployedNative);
    await assertImported(runtime.publicClient, v4LpEntry, nfpm, tokenId, agentKey, poolId, deployedNative);
    markNftStage(state, tokenKey, "imported", txHashes);
    return { tokenId: tokenKey, stage: "imported", txHashes };
  }
  const stakeVault = stakeVaultForOwner(custody.owner);
  if (stakeVault) {
    txHashes.unstake = await writeVaultContract(runtime, oldVault, policyVaultV3Abi, "unstakeLpOwner", [tokenId, stakeVault]);
  }
  const ownerAfterUnstake = await ownerOfNfpm(runtime.publicClient, tokenId);
  if (sameAddress(ownerAfterUnstake, oldVault)) {
    txHashes.rescue = await writeVaultContract(runtime, oldVault, policyVaultV3Abi, "rescueNft", [nfpm, tokenId]);
  }
  const ownerAfterRescue = await ownerOfNfpm(runtime.publicClient, tokenId);
  if (sameAddress(ownerAfterRescue, runtime.deployer.address)) {
    txHashes.transfer = await writeVaultContract(runtime, nfpm, ziaNonfungiblePositionManagerAbi, "safeTransferFrom", [
      runtime.deployer.address,
      v4LpEntry,
      tokenId,
    ]);
  } else if (!sameAddress(ownerAfterRescue, v4LpEntry)) {
    throw new OgAgentDeployError(`NFT ${tokenKey} custody is ${ownerAfterRescue}; preserve halted for manual recovery.`, "preserve_blocked", 409);
  }
  try {
    const lpOwnerAfterTransfer = await runtime.publicClient.readContract({
      address: v4LpEntry,
      abi: policyVaultV4LpEntryAbi,
      functionName: "lpNftOwner",
      args: [tokenId],
    }) as Hex;
    if (lpOwnerAfterTransfer === ZERO_BYTES32) {
      txHashes.import = await importV4LpNft(runtime, v4LpEntry, tokenId, agentKey, poolId, ticks, deployedNative);
    }
    await assertImported(runtime.publicClient, v4LpEntry, nfpm, tokenId, agentKey, poolId, deployedNative);
  } catch (error) {
    const ownerNow = await ownerOfNfpm(runtime.publicClient, tokenId).catch(() => null);
    if (ownerNow && sameAddress(ownerNow, v4LpEntry)) {
      markNftStage(state, tokenKey, "preserve_blocked", txHashes);
      throw new OgAgentDeployError(
        `NFT ${tokenKey} is in V4 LpEntry but import failed. HALT for manual V4 LpEntry rescueNft(tokenId, owner()). ${error instanceof Error ? error.message : String(error)}`,
        "preserve_blocked",
        409,
      );
    }
    throw error;
  }
  markNftStage(state, tokenKey, "imported", txHashes);
  return { tokenId: tokenKey, stage: "imported", txHashes };
}

export async function withdrawOldVaultNative(
  runtime: DeployerRuntime,
  owner: Address,
  oldVault: Address,
  state: VaultMigrateV4State,
): Promise<{ amount0G: string; txHash: Hex; skipped: boolean }> {
  const vaultOwner = await runtime.publicClient.readContract({ address: oldVault, abi: policyVaultV3Abi, functionName: "owner" }) as Address;
  if (!sameAddress(vaultOwner, owner)) {
    throw new OgAgentDeployError(`Old vault ${oldVault} owner is ${vaultOwner}, not ${owner}.`, "owner_required", 403);
  }
  // Idempotency: a prior completed withdraw leaves V3 near-empty. Restore the recorded
  // amount (state.withdrawnAmount0G when the tx hash was persisted, OR state.intendedWithdrawWei
  // when the withdraw mined but the post-tx state write was lost — Finding #1).
  if (state.withdrawTxHash && state.withdrawTxHash !== SENTINEL_TXHASH && state.withdrawnAmount0G) {
    const residual = await runtime.publicClient.getBalance({ address: oldVault });
    if (residual <= parseEther(WITHDRAW_RESIDUAL_TOLERANCE_0G)) {
      return { amount0G: state.withdrawnAmount0G, txHash: state.withdrawTxHash, skipped: true };
    }
  }
  const balanceBefore = await runtime.publicClient.getBalance({ address: oldVault });
  if (balanceBefore <= parseEther(WITHDRAW_RESIDUAL_TOLERANCE_0G)) {
    // V3 is near-empty. If a withdraw was intended (intendedWithdrawWei set) the prior tx
    // mined but the state write was lost — restore the intended amount, do NOT record "0".
    // If no withdraw was ever intended, the vault was empty before migration → 0 is correct.
    const intended = state.intendedWithdrawWei ? BigInt(state.intendedWithdrawWei) : 0n;
    state.withdrawnAmount0G = formatEther(intended);
    state.withdrawTxHash = state.withdrawTxHash ?? SENTINEL_TXHASH;
    return { amount0G: state.withdrawnAmount0G, txHash: state.withdrawTxHash, skipped: true };
  }
  // Persist the intended withdraw amount BEFORE submitting the tx so a crash after the tx
  // mines but before the post-tx state write is recoverable (Finding #1).
  state.intendedWithdrawWei = balanceBefore.toString();
  await writeMigrateState(state);
  const txHash = await writeVaultContract(runtime, oldVault, policyVaultV3Abi, "withdrawNative", [balanceBefore]);
  const balanceAfter = await runtime.publicClient.getBalance({ address: oldVault });
  if (balanceAfter > parseEther(WITHDRAW_RESIDUAL_TOLERANCE_0G)) {
    throw new OgAgentDeployError(`Old vault ${oldVault} still has ${formatEther(balanceAfter)} 0G after withdraw.`, "tx_reverted", 500);
  }
  state.withdrawnAmount0G = formatEther(balanceBefore);
  state.withdrawTxHash = txHash;
  return { amount0G: state.withdrawnAmount0G, txHash, skipped: false };
}

export async function depositV4SwapNative(
  runtime: DeployerRuntime,
  v4Swap: Address,
  amount0G: string,
  state: VaultMigrateV4State,
): Promise<{ amount0G: string; txHash: Hex; skipped: boolean }> {
  const withdrawnWei = parseEther(amount0G.trim());
  const reserveWei = parseEther(GAS_RESERVE_0G);
  const depositWei = withdrawnWei > reserveWei ? withdrawnWei - reserveWei : 0n;
  const depositAmount0G = formatEther(depositWei);
  if (depositWei <= 0n) {
    state.depositAmount0G = "0";
    state.depositTxHash = SENTINEL_TXHASH;
    return { amount0G: "0", txHash: SENTINEL_TXHASH, skipped: true };
  }
  // Idempotency: recognize a completed deposit by balance WITHOUT requiring depositTxHash,
  // so a crash after the deposit tx mines but before the post-tx state write is recoverable
  // (Finding #2). Re-submitting depositNative would revert because the DEPLOYER EOA no longer
  // holds the funds, so we must detect the completed deposit from the V4 Swap balance.
  if (state.v4SwapBalanceBeforeDepositWei && state.depositAmount0G) {
    const expected = BigInt(state.v4SwapBalanceBeforeDepositWei) + parseEther(state.depositAmount0G);
    const current = await runtime.publicClient.getBalance({ address: v4Swap });
    if (current >= expected) {
      state.depositTxHash = state.depositTxHash ?? SENTINEL_TXHASH;
      return { amount0G: state.depositAmount0G, txHash: state.depositTxHash, skipped: true };
    }
  }
  // Persist the pre-deposit balance + intended amount BEFORE the tx so the idempotency guard
  // above can recognize a completed deposit after a crash (Finding #2).
  const balanceBefore = await runtime.publicClient.getBalance({ address: v4Swap });
  state.v4SwapBalanceBeforeDepositWei = balanceBefore.toString();
  state.depositAmount0G = depositAmount0G;
  await writeMigrateState(state);
  const txHash = await writeVaultContract(runtime, v4Swap, policyVaultV4SwapAbi, "depositNative", [], depositWei);
  const balanceAfter = await runtime.publicClient.getBalance({ address: v4Swap });
  if (balanceAfter - balanceBefore < depositWei) {
    throw new OgAgentDeployError(`V4 Swap balance delta < deposit ${depositAmount0G}.`, "tx_reverted", 500);
  }
  state.depositTxHash = txHash;
  return { amount0G: depositAmount0G, txHash, skipped: false };
}

export async function repointRoster(
  oldVault: Address,
  v4Trio: V4VaultTrio,
  runtime: Pick<DeployerRuntime, "publicClient">,
  state: VaultMigrateV4State,
): Promise<string[]> {
  const registry = await readAgentRegistry();
  const affected = affectedRosterEntries(registry, oldVault);
  if (affected.length === 0) {
    // Defense-in-depth (Finding #6): if the roster has no entries for oldVault but the inventory
    // preserved NFTs that resolved to agentIds, the roster is inconsistent with the migration.
    // Do NOT silently mark rosterRepointed=true — that would let retire run and report "success"
    // while the migrated agents are missing from the roster. Throw unless the roster was already
    // repointed in a prior run (legitimate resume: entries now point to v4Swap, not oldVault).
    if (!state.rosterRepointed) {
      const preservedWithAgentId = (state.inventory?.nfts ?? []).filter(
        (nft) => (state.nftStages?.[nft.tokenId] ?? nft.stage) === "imported" && Boolean(nft.agentId),
      );
      if (preservedWithAgentId.length > 0) {
        throw new OgAgentDeployError(
          `Roster has no entries for ${oldVault} but ${preservedWithAgentId.length} preserved NFT(s) resolved to agentIds. Refusing roster repoint — investigate before retire.`,
          "migration_state_missing",
          500,
        );
      }
    }
    state.rosterRepointed = true;
    state.repointedAgents = state.repointedAgents ?? [];
    return state.repointedAgents;
  }
  for (const record of affected) {
    const agentKey = record.agentKey ?? agentKeyForDeployment(record);
    const enabled = await readV4AgentKeyEnabled(runtime.publicClient, v4Trio, agentKey);
    if (!enabled) {
      throw new OgAgentDeployError(`V4 agentKeyEnabled is false for ${record.id}; refusing roster write.`, "agent_key_not_enabled", 409);
    }
  }
  const migratedAt = new Date().toISOString();
  for (const list of [registry.agents ?? [], registry.removedAgents ?? []]) {
    for (const record of list as unknown as Array<Record<string, unknown>>) {
      const vault = typeof record.vault === "string" && isAddress(record.vault) ? getAddress(record.vault) : null;
      if (!vault || !sameAddress(vault, oldVault)) continue;
      record.migratedFromVault = vault;
      record.migratedAt = migratedAt;
      record.vault = v4Trio.swapVault;
      record.vaultVersion = 4;
      record.v4SwapAddress = v4Trio.swapVault;
      record.v4LpEntryAddress = v4Trio.lpEntryVault;
      record.v4LpExitAddress = v4Trio.lpExitVault;
    }
  }
  registry.updatedAt = migratedAt;
  await writeAgentRegistry(registry);
  const ids = affected.map((record) => record.id).sort();
  state.rosterRepointed = true;
  state.repointedAgents = ids;
  return ids;
}

export async function retireV3Vault(runtime: DeployerRuntime, oldVault: Address, state: VaultMigrateV4State): Promise<void> {
  if (state.v3Retired) return;
  if (!state.inventory || !state.v4Trio) {
    throw new OgAgentDeployError("Migration state is missing inventory or V4 trio.", "migration_state_missing", 500);
  }
  // Pause + revoke the V3 executor FIRST, before the retire re-scan, so the executor cannot
  // mint a new LP NFT into V3 in the window between the re-scan and the pause (Finding #3).
  // onlyOwner rescue/unstake are not blocked by pause, so manual NFT recovery still works.
  const txs = { ...(state.v3RetireTxHashes ?? {}) };
  const [paused, revoked] = await Promise.all([
    runtime.publicClient.readContract({ address: oldVault, abi: policyVaultV3Abi, functionName: "paused" }) as Promise<boolean>,
    runtime.publicClient.readContract({ address: oldVault, abi: policyVaultV3Abi, functionName: "executorRevoked" }) as Promise<boolean>,
  ]);
  if (!paused) txs.pause = await writeVaultContract(runtime, oldVault, policyVaultV3Abi, "setPaused", [true]);
  if (!revoked) txs.revoke = await writeVaultContract(runtime, oldVault, policyVaultV3Abi, "revokeExecutor", []);
  // Re-scan for NFTs that arrived after the reviewed inventory. The executor is now revoked,
  // so no new mint can occur during/after this scan; any NFT found arrived before the revoke
  // landed and is handled manually (onlyOwner rescueNft, not blocked by pause).
  const latest = await runtime.publicClient.getBlockNumber();
  const since = BigInt(state.inventory.scannedToBlock) + 1n;
  if (since <= latest) {
    const newTokenIds = await scanNfpmTransferTokenIds(runtime.publicClient, oldVault, since, latest);
    const known = new Set(state.inventory.nfts.map((nft) => nft.tokenId));
    const unknown = newTokenIds.filter((tokenId) => !known.has(tokenId.toString()));
    if (unknown.length > 0) {
      throw new OgAgentDeployError(`New NFT(s) arrived after inventory: ${unknown.map((id) => id.toString()).join(",")}.`, "inventory_stale", 409);
    }
  }
  const unresolved = state.inventory.nfts.filter((nft) => {
    const stage = state.nftStages?.[nft.tokenId] ?? nft.stage;
    return stage === "preserve_blocked" || stage === "unsupported_accounting" || stage === "unknown_status" || stage === "undecided" || stage === "preserve_ready";
  });
  if (unresolved.length > 0) {
    throw new OgAgentDeployError(`Unresolved NFT(s) remain: ${unresolved.map((nft) => nft.tokenId).join(",")}.`, "nfts_unresolved", 409);
  }
  const burnedForm = state.inventory.nfts.some((nft) => (state.nftStages?.[nft.tokenId] ?? nft.stage) === "skipped_burned")
    ? await probeNfpmBurnedRevertForm(runtime.publicClient)
    : null;
  for (const nft of state.inventory.nfts) {
    const stage = state.nftStages?.[nft.tokenId] ?? nft.stage;
    if (stage === "skipped_burned") {
      const status = await readNfpmOwnerStatus(
        runtime.publicClient,
        BigInt(nft.tokenId),
        burnedForm ?? await probeNfpmBurnedRevertForm(runtime.publicClient),
        true,
      );
      if (status.kind !== "burned") {
        throw new OgAgentDeployError(`Burned NFT ${nft.tokenId} is no longer verified as burned.`, "inventory_stale", 409);
      }
      continue;
    }
    if (stage !== "imported") continue;
    if (!nft.agentKey || !nft.poolId || nft.deployedNative0G === undefined) {
      throw new OgAgentDeployError(`Imported NFT ${nft.tokenId} is missing reviewed accounting.`, "migration_state_missing", 500);
    }
    await assertImported(
      runtime.publicClient,
      state.v4Trio.lpEntryVault,
      ZIA_LP_MAINNET.nonfungiblePositionManager,
      BigInt(nft.tokenId),
      nft.agentKey,
      nft.poolId,
      BigInt(nft.deployedNative0G),
    );
  }
  // Aggregate native-hop invariant (Finding #1): always verify the V4 Swap balance covers the
  // intended deposit. For vaults with no native, expected is 0 and this passes trivially — the
  // previous gate (v4SwapBalanceBeforeDepositWei && depositAmount0G) wrongly SKIPPED the check
  // when a crash left depositAmount0G unset, masking a stranded native hop.
  const swapBalanceBefore = state.v4SwapBalanceBeforeDepositWei ? BigInt(state.v4SwapBalanceBeforeDepositWei) : 0n;
  const expectedDeposit = state.depositAmount0G ? parseEther(state.depositAmount0G) : 0n;
  const currentSwap = await runtime.publicClient.getBalance({ address: state.v4Trio.swapVault });
  if (currentSwap < swapBalanceBefore + expectedDeposit) {
    throw new OgAgentDeployError("V4 Swap aggregate native balance is below expected migration deposit.", "migration_verify_failed", 500);
  }
  // V3 residual invariant: if native was withdrawn, V3 must be near-empty after retire.
  if (state.withdrawnAmount0G && parseEther(state.withdrawnAmount0G) > 0n) {
    const v3Residual = await runtime.publicClient.getBalance({ address: oldVault });
    if (v3Residual > parseEther(WITHDRAW_RESIDUAL_TOLERANCE_0G)) {
      throw new OgAgentDeployError(`V3 ${oldVault} still holds ${formatEther(v3Residual)} 0G after retire.`, "migration_verify_failed", 500);
    }
  }
  const [pausedAfter, revokedAfter] = await Promise.all([
    runtime.publicClient.readContract({ address: oldVault, abi: policyVaultV3Abi, functionName: "paused" }) as Promise<boolean>,
    runtime.publicClient.readContract({ address: oldVault, abi: policyVaultV3Abi, functionName: "executorRevoked" }) as Promise<boolean>,
  ]);
  if (!pausedAfter || !revokedAfter) {
    throw new OgAgentDeployError("V3 retire postcondition failed.", "migration_verify_failed", 500);
  }
  state.v3Retired = true;
  state.v3RetireTxHashes = txs;
}

export async function runVaultMigrateV4FullFlow(input: {
  owner: Address;
  oldVault: Address;
  confirmedSteps: string[];
  inventoryHash?: Hex;
  perNftDecisions?: Record<string, PerNftDecision>;
  v4Trio?: V4VaultTrio;
}): Promise<VaultMigrateV4Result> {
  assertMainnetEnvGates();
  const owner = getAddress(input.owner);
  const oldVault = getAddress(input.oldVault);
  assertLegacyVault(oldVault);
  const { makeDeployerRuntime } = await import("./lp/lp-deploy");
  const runtime = makeDeployerRuntime();
  const chainId = await runtime.publicClient.getChainId();
  if (chainId !== CHAIN_ID) {
    throw new OgAgentDeployError(`RPC chain mismatch: expected ${CHAIN_ID}, got ${chainId}.`, "chain_mismatch", 500);
  }
  const state = await loadOrInitState(oldVault);
  const trio = await deployMainnetV4VaultTrio(runtime, owner, {}, state);
  await writeMigrateState(state);
  if (input.v4Trio) assertSameTrio(input.v4Trio, trio);

  const inventory = await inventoryV3Vault(runtime, oldVault, deriveAgentIdsForVault(await readAgentRegistry(), oldVault));
  assertInventoryWithinMigrationCap(inventory);
  const inventoryHash = hashVaultInventory(inventory);
  if (!input.confirmedSteps.includes("migrate-v4-execute")) {
    state.inventory = inventory;
    state.inventoryHash = inventoryHash;
    state.inventoryToBlock = inventory.scannedToBlock;
    state.updatedAt = new Date().toISOString();
    await writeMigrateState(state);
    return { phase: "review_required", oldVault, v4Trio: trio, inventory, inventoryHash };
  }

  if (!input.inventoryHash) {
    throw new OgAgentDeployError("inventoryHash is required for migrate-v4 execute.", "invalid_request", 400);
  }
  if (input.inventoryHash.toLowerCase() !== inventoryHash.toLowerCase() && !state.phase2Started) {
    throw new OgAgentDeployError("Live V3 inventory changed after review; re-run phase 1.", "inventory_stale", 409);
  }
  if (!state.inventory || state.inventoryHash?.toLowerCase() !== input.inventoryHash.toLowerCase()) {
    state.inventory = inventory;
    state.inventoryHash = inventoryHash;
    state.inventoryToBlock = inventory.scannedToBlock;
  }
  const decisions = input.perNftDecisions ?? {};
  for (const [tokenId, decision] of Object.entries(decisions)) {
    if (decision === "exit") {
      throw new OgAgentDeployError(`NFT ${tokenId} exit is not supported in this preserve-only phase.`, "exit_not_supported_this_phase", 409);
    }
  }

  if (!state.phase2Started) {
    await enableAffectedAgentKeys(runtime, trio, oldVault);
    const blocked: string[] = [];
    const reviewedNfts = state.inventory.nfts;
    for (const nft of reviewedNfts) {
      if (nft.stage === "skipped_burned") {
        markNftStage(state, nft.tokenId, "skipped_burned");
        continue;
      }
      if (nft.stage === "unsupported_accounting" || nft.stage === "unknown_status") {
        markNftStage(state, nft.tokenId, nft.stage);
        blocked.push(nft.tokenId);
        continue;
      }
      if (decisions[nft.tokenId] !== "preserve") {
        blocked.push(nft.tokenId);
        continue;
      }
      if (!nft.agentKey || !nft.poolId || nft.deployedNative0G === undefined) {
        markNftStage(state, nft.tokenId, "unsupported_accounting");
        blocked.push(nft.tokenId);
        continue;
      }
      const preflight = await ensurePreservePreflight(runtime, trio, BigInt(nft.tokenId), nft.agentKey, nft.poolId, BigInt(nft.deployedNative0G), false).catch((error) => error);
      if (preflight instanceof Error) {
        markNftStage(state, nft.tokenId, "preserve_blocked");
        blocked.push(nft.tokenId);
      } else {
        markNftStage(state, nft.tokenId, "preserve_ready");
      }
    }
    state.updatedAt = new Date().toISOString();
    await writeMigrateState(state);
    if (blocked.length > 0) {
      throw new OgAgentDeployError(`Unpreservable NFT(s) before native hop: ${blocked.join(",")}.`, "preserve_blocked", 409);
    }
    // Aggregate daily-cap guard (Finding #5): importLpNft accrues to the GLOBAL lpDailySpent0G
    // (no per-agentKey arg). The per-NFT preflight above checks each NFT individually with
    // spent=0; it never sums the preserve-ready NFTs against the shared cap. A multi-NFT vault
    // whose total preserve native exceeds the remaining daily cap would pass the per-NFT gate,
    // move native, then HALT mid-preserve when NFT#2's import reverts in-contract — stranding
    // the migration for the 24h daily window (no on-chain loosen). Sum every preserve_ready
    // NFT and assert the total fits under the LIVE remaining daily cap BEFORE the native hop.
    const block = await runtime.publicClient.getBlock();
    const liveRemaining = await readLiveLpDailyRemaining(runtime.publicClient, trio.lpEntryVault, block.timestamp);
    const preserveReadyNative = reviewedNfts
      .filter((nft) => (state.nftStages?.[nft.tokenId] ?? nft.stage) === "preserve_ready")
      .reduce((sum, nft) => sum + (nft.deployedNative0G ? BigInt(nft.deployedNative0G) : 0n), 0n);
    if (preserveReadyNative > liveRemaining.remaining) {
      throw new OgAgentDeployError(
        `Aggregate preserve native (${formatEther(preserveReadyNative)} 0G) exceeds V4 LP daily cap remaining (${formatEther(liveRemaining.remaining)} 0G). HALT before native hop.`,
        "preserve_blocked",
        409,
      );
    }
    state.phase2Started = true;
    state.updatedAt = new Date().toISOString();
    await writeMigrateState(state);
  }

  const withdraw = await withdrawOldVaultNative(runtime, owner, oldVault, state);
  state.updatedAt = new Date().toISOString();
  await writeMigrateState(state);
  const deposit = await depositV4SwapNative(runtime, trio.swapVault, withdraw.amount0G, state);
  state.updatedAt = new Date().toISOString();
  await writeMigrateState(state);

  const preserved: string[] = [];
  for (const nft of state.inventory.nfts) {
    const stage = state.nftStages?.[nft.tokenId] ?? nft.stage;
    if (stage === "skipped_burned" || stage === "imported") {
      if (stage === "imported") preserved.push(nft.tokenId);
      continue;
    }
    if (!nft.agentKey || !nft.poolId || nft.tickLower === undefined || nft.tickUpper === undefined || nft.deployedNative0G === undefined) {
      markNftStage(state, nft.tokenId, "unsupported_accounting");
      await writeMigrateState(state);
      throw new OgAgentDeployError(`NFT ${nft.tokenId} cannot be preserved; missing accounting.`, "unsupported_accounting", 409);
    }
    const result = await rescueLpNftPreserve(
      runtime,
      oldVault,
      trio.lpEntryVault,
      ZIA_LP_MAINNET.nonfungiblePositionManager,
      BigInt(nft.tokenId),
      nft.agentKey,
      nft.poolId,
      { tickLower: nft.tickLower, tickUpper: nft.tickUpper },
      BigInt(nft.deployedNative0G),
      state,
    );
    preserved.push(result.tokenId);
    state.updatedAt = new Date().toISOString();
    await writeMigrateState(state);
  }

  const repointedAgents = await repointRoster(oldVault, trio, runtime, state);
  state.updatedAt = new Date().toISOString();
  await writeMigrateState(state);
  await retireV3Vault(runtime, oldVault, state);
  state.updatedAt = new Date().toISOString();
  await writeMigrateState(state);

  return {
    phase: "executed",
    oldVault,
    v4Trio: trio,
    inventory: state.inventory,
    inventoryHash: state.inventoryHash ?? inventoryHash,
    withdrawTxHash: state.withdrawTxHash,
    depositTxHash: state.depositTxHash,
    withdrawnAmount0G: state.withdrawnAmount0G,
    depositAmount0G: state.depositAmount0G,
    preservedTokenIds: preserved,
    repointedAgents,
    retired: state.v3Retired === true,
  };
}

export async function finalizeWalletOwnedV4Migration(
  input: WalletOwnedV4FinalizeInput,
  runtime: Pick<DeployerRuntime, "publicClient">,
): Promise<WalletOwnedV4FinalizeResult> {
  assertMainnetEnvGates();
  const owner = getAddress(input.owner);
  const sourceVault = getAddress(input.sourceVault);
  const v4Trio = {
    lpEntryVault: getAddress(input.v4Trio.lpEntryVault),
    lpExitVault: getAddress(input.v4Trio.lpExitVault),
    swapVault: getAddress(input.v4Trio.swapVault),
  };
  const chainId = await runtime.publicClient.getChainId();
  if (chainId !== CHAIN_ID) {
    throw new OgAgentDeployError(`RPC chain mismatch: expected ${CHAIN_ID}, got ${chainId}.`, "chain_mismatch", 500);
  }

  const config = readV4DeployConfig();
  const registered = await readRegistryTrio(runtime.publicClient, config.registry, owner);
  assertSameTrio(v4Trio, registered);
  await Promise.all([
    verifyV4VaultConfig(runtime.publicClient, v4Trio.swapVault, owner, "swap", config),
    verifyV4VaultConfig(runtime.publicClient, v4Trio.lpEntryVault, owner, "lpEntry", config),
    verifyV4VaultConfig(runtime.publicClient, v4Trio.lpExitVault, owner, "lpExit", config),
  ]);

  const sourceOwner = await runtime.publicClient.readContract({
    address: sourceVault,
    abi: policyVaultV3Abi,
    functionName: "owner",
  }).catch(() => null) as Address | null;
  if (!sourceOwner || !sameAddress(sourceOwner, owner)) {
    throw new OgAgentDeployError("Source vault is not owned by the connected wallet.", "owner_required", 403);
  }

  const sourceBalance = await runtime.publicClient.getBalance({ address: sourceVault });
  if (sourceBalance > parseEther(WITHDRAW_RESIDUAL_TOLERANCE_0G)) {
    throw new OgAgentDeployError(
      `Source vault still holds ${formatEther(sourceBalance)} 0G; withdraw it before finalizing V4 migration.`,
      "source_not_drained",
      409,
    );
  }

  const [paused, revoked] = await Promise.all([
    runtime.publicClient.readContract({ address: sourceVault, abi: policyVaultV3Abi, functionName: "paused" }).catch(() => false),
    runtime.publicClient.readContract({ address: sourceVault, abi: policyVaultV3Abi, functionName: "executorRevoked" }).catch(() => false),
  ]) as [boolean, boolean];
  if (!paused || !revoked) {
    throw new OgAgentDeployError("Source vault must be paused and executor-revoked before finalizing V4 migration.", "source_not_retired", 409);
  }

  let inventory: V3VaultInventory | undefined;
  let inventoryHash: Hex | undefined;
  if (input.sourceVersion === 3) {
    const agentIds = deriveAgentIdsForVault(await readAgentRegistry(), sourceVault);
    inventory = await inventoryV3Vault(runtime, sourceVault, agentIds);
    const liveInventoryHash = hashVaultInventory(inventory);
    inventoryHash = input.inventoryHash ?? liveInventoryHash;
    for (const nft of inventory.nfts) {
      if (nft.stage === "skipped_burned") continue;
      if (!nft.agentKey || !nft.poolId || nft.deployedNative0G === undefined) {
        throw new OgAgentDeployError(`NFT ${nft.tokenId} is missing migration accounting; cannot finalize.`, "migration_state_missing", 409);
      }
      await assertImported(
        runtime.publicClient,
        v4Trio.lpEntryVault,
        ZIA_LP_MAINNET.nonfungiblePositionManager,
        BigInt(nft.tokenId),
        nft.agentKey,
        nft.poolId,
        BigInt(nft.deployedNative0G),
      );
    }
  }

  const state: VaultMigrateV4State = {
    inventory,
    inventoryHash,
    oldVault: sourceVault,
    updatedAt: new Date().toISOString(),
    v3Retired: true,
    v4Trio,
  };
  const repointedAgents = await repointRoster(sourceVault, v4Trio, runtime, state);
  return { inventoryHash, oldVault: sourceVault, repointedAgents, retired: true, v4Trio };
}

export function hashVaultInventory(inventory: V3VaultInventory): Hex {
  return sha256Hex(canonicalize(inventory));
}

export function assertLegacyVault(value: Address): void {
  if (!LEGACY_V3_VAULTS.some((vault) => vault.toLowerCase() === value.toLowerCase())) {
    throw new OgAgentDeployError("oldVault is not in the approved legacy V3 migration set.", "not_legacy_vault", 400);
  }
}

function readV4DeployConfig(): V4DeployConfig {
  return {
    adapter: requireAddressEnv("NEXT_PUBLIC_POLICY_VAULT_ADAPTER_MAINNET_ADDRESS", "swap adapter"),
    executor: requireAddressEnv("NEXT_PUBLIC_VAULT_EXECUTOR_MAINNET_ADDRESS", "executor"),
    lpAdapter: requireAddressEnv("NEXT_PUBLIC_POLICY_VAULT_ZIA_LP_ADAPTER_V4_MAINNET_ADDRESS", "Zia LP adapter V4"),
    proofRegistry: requireAddressEnv("NEXT_PUBLIC_PROOF_REGISTRY_MAINNET_ADDRESS", "proof registry"),
    registry: requireAddressEnv("NEXT_PUBLIC_POLICY_VAULT_V4_REGISTRY_MAINNET_ADDRESS", "V4 registry"),
  };
}

function requireAddressEnv(name: string, label: string): Address {
  const value = process.env[name]?.trim();
  if (!value || !isAddress(value) || getAddress(value) === zeroAddress) {
    throw new OgAgentDeployError(`${name} (${label}) is required.`, "env_missing", 500);
  }
  return getAddress(value);
}

function assertMainnetEnvGates(): void {
  if ((process.env.OG_NETWORK ?? "").toLowerCase() !== "mainnet") {
    throw new OgAgentDeployError("Vault migrate-v4 requires OG_NETWORK=mainnet.", "mainnet_required", 409);
  }
  if (Number(process.env.OG_CHAIN_ID ?? "0") !== CHAIN_ID) {
    throw new OgAgentDeployError(`Vault migrate-v4 requires OG_CHAIN_ID=${CHAIN_ID}.`, "mainnet_required", 409);
  }
  requireFlag("ENABLE_MAINNET_DEPLOY", true);
  requireFlag("ENABLE_REAL_DEX_ADAPTER", true);
  requireFlag("ENABLE_MOCK_DEX_ADAPTER", false);
  requireFlag("MAINNET_ALLOW_MOCK_LP_ADAPTER", false);
}

function requireFlag(name: string, expected: boolean): void {
  const actual = (process.env[name] ?? "false").toLowerCase() === "true";
  if (actual !== expected) throw new OgAgentDeployError(`${name} must be ${String(expected)}.`, "flag_mismatch", 409);
}

async function loadOrInitState(oldVault: Address): Promise<VaultMigrateV4State> {
  const state = await readMigrateState();
  if (!state || state.oldVault.toLowerCase() !== oldVault.toLowerCase()) {
    const next = { oldVault, updatedAt: new Date().toISOString() } satisfies VaultMigrateV4State;
    await writeMigrateState(next);
    return next;
  }
  return state;
}

async function readMigrateState(): Promise<VaultMigrateV4State | null> {
  try {
    return JSON.parse(await readFile(STATE_FILE_PATH, "utf8")) as VaultMigrateV4State;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("ENOENT") || message.includes("no such file")) return null;
    throw error;
  }
}

async function writeMigrateState(state: VaultMigrateV4State): Promise<void> {
  await mkdir(dirname(STATE_FILE_PATH), { recursive: true });
  await writeFile(STATE_FILE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function readAgentRegistry(): Promise<AgentDeploymentRegistryArtifact> {
  try {
    const parsed = JSON.parse(await readFile(AGENT_REGISTRY_PATH, "utf8")) as AgentDeploymentRegistryArtifact;
    return {
      agents: Array.isArray(parsed.agents) ? parsed.agents : [],
      removedAgentIds: Array.isArray(parsed.removedAgentIds) ? parsed.removedAgentIds : [],
      removedAgents: Array.isArray(parsed.removedAgents) ? parsed.removedAgents : [],
      updatedAt: parsed.updatedAt,
    };
  } catch (error) {
    // A missing file (ENOENT) is a legitimate first-run state → empty registry. A parse error
    // on an EXISTING file means the roster is corrupt/truncated (e.g. a crashed non-atomic
    // write). Swallowing it would silently wipe the entire roster (Finding #6) — rethrow so the
    // operator restores from the .bak backup instead of proceeding with an empty registry.
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("ENOENT") || message.includes("no such file")) {
      return { agents: [], removedAgents: [], removedAgentIds: [] };
    }
    throw new OgAgentDeployError(
      `Agent registry at ${AGENT_REGISTRY_PATH} is corrupt (${message}). Restore from ${AGENT_REGISTRY_PATH}.bak before retrying.`,
      "migration_state_missing",
      500,
    );
  }
}

async function writeAgentRegistry(registry: AgentDeploymentRegistryArtifact): Promise<void> {
  // Atomic write + backup (Finding #6): the previous non-atomic writeFile could truncate the
  // roster mid-write; a crash left a truncated file, and readAgentRegistry silently returned
  // empty → repointRoster set rosterRepointed=true with [] → retire ran → migration "success"
  // with the entire roster wiped. Write to a tmp file then rename (atomic on POSIX/rename),
  // and back up the existing file to .bak first so a corrupt write is recoverable.
  await mkdir(dirname(AGENT_REGISTRY_PATH), { recursive: true });
  const tmpPath = `${AGENT_REGISTRY_PATH}.tmp`;
  const bakPath = `${AGENT_REGISTRY_PATH}.bak`;
  try {
    await copyFile(AGENT_REGISTRY_PATH, bakPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("ENOENT") && !message.includes("no such file")) throw error;
  }
  await writeFile(tmpPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  await rename(tmpPath, AGENT_REGISTRY_PATH);
}

async function readRegistryTrio(publicClient: PublicClient, registry: Address, owner: Address): Promise<V4VaultTrio> {
  const [swapRaw, lpEntryRaw, lpExitRaw] = await publicClient.readContract({
    address: registry,
    abi: vaultRegistryV4Abi,
    functionName: "vaultOf",
    args: [owner],
  }) as readonly Address[];
  return {
    swapVault: getAddress(swapRaw),
    lpEntryVault: getAddress(lpEntryRaw),
    lpExitVault: getAddress(lpExitRaw),
  };
}

async function verifyV4VaultOwner(publicClient: PublicClient, vault: Address, owner: Address, abi: Abi, label: string): Promise<void> {
  const actual = await publicClient.readContract({ address: vault, abi, functionName: "owner" }) as Address;
  if (!sameAddress(actual, owner)) {
    throw new OgAgentDeployError(`${label} owner mismatch: got ${actual}, expected ${owner}.`, "migrate_verify_failed", 500);
  }
}

// Verify an adopted V4 vault matches the deploy config (Finding #4): a stale or misconfigured
// vault occupying a registry slot (no deregister, AlreadyRegistered one-per-owner) must NOT be
// funded blindly. Check owner + executor + adapter + proofRegistry against readV4DeployConfig.
// The policy caps are checked separately by the preserve preflight + aggregate daily-cap guard.
async function verifyV4VaultConfig(
  publicClient: PublicClient,
  vault: Address,
  owner: Address,
  kind: "swap" | "lpEntry" | "lpExit",
  config: V4DeployConfig,
): Promise<void> {
  const abi = kind === "swap" ? policyVaultV4SwapAbi : kind === "lpEntry" ? policyVaultV4LpEntryAbi : policyVaultV4LpExitAbi;
  await verifyV4VaultOwner(publicClient, vault, owner, abi, kind);
  const adapterName = kind === "swap" ? "swapAdapter" : "lpAdapter";
  const expectedAdapter = kind === "swap" ? config.adapter : config.lpAdapter;
  const [executor, adapter, proofRegistry] = await Promise.all([
    publicClient.readContract({ address: vault, abi: executorGetterAbi, functionName: "executor" }) as Promise<Address>,
    publicClient.readContract({ address: vault, abi, functionName: adapterName }) as Promise<Address>,
    publicClient.readContract({ address: vault, abi, functionName: "proofRegistry" }) as Promise<Address>,
  ]);
  if (!sameAddress(executor, config.executor)) {
    throw new OgAgentDeployError(`${kind} executor mismatch: got ${executor}, expected ${config.executor}.`, "migrate_verify_failed", 500);
  }
  if (!sameAddress(adapter, expectedAdapter)) {
    throw new OgAgentDeployError(`${kind} adapter mismatch: got ${adapter}, expected ${expectedAdapter}.`, "migrate_verify_failed", 500);
  }
  if (!sameAddress(proofRegistry, config.proofRegistry)) {
    throw new OgAgentDeployError(`${kind} proofRegistry mismatch: got ${proofRegistry}, expected ${config.proofRegistry}.`, "migrate_verify_failed", 500);
  }
}

function requireCompleteTrio(trio: Partial<V4VaultTrio>): V4VaultTrio {
  if (!trio.swapVault || !trio.lpEntryVault || !trio.lpExitVault) {
    throw new OgAgentDeployError("V4 trio deployment incomplete.", "migration_failed", 500);
  }
  return { swapVault: trio.swapVault, lpEntryVault: trio.lpEntryVault, lpExitVault: trio.lpExitVault };
}

async function registerV4Slot(runtime: DeployerRuntime, registry: Address, functionName: "registerSwap" | "registerLpEntry" | "registerLpExit", vault: Address): Promise<Hex> {
  return writeVaultContract(runtime, registry, vaultRegistryV4Abi, functionName, [vault]);
}

async function writeVaultContract(
  runtime: DeployerRuntime,
  address: Address,
  abi: Abi | readonly unknown[],
  functionName: string,
  args: readonly unknown[],
  value?: bigint,
): Promise<Hex> {
  const simulation = await runtime.publicClient.simulateContract({
    account: runtime.deployer.address,
    address,
    abi,
    functionName,
    args,
    ...(value !== undefined ? { value } : {}),
  } as any);
  const txHash = await runtime.walletClient.writeContract({
    ...simulation.request,
    account: runtime.deployer,
    chain: runtime.chain,
    ...(value !== undefined ? { value } : {}),
  });
  await waitForReceipt(runtime.publicClient, txHash, functionName);
  return txHash;
}

async function waitForReceipt(publicClient: PublicClient, hash: Hex, label: string): Promise<{ status: "success" | "reverted"; contractAddress?: Address | null; blockNumber: bigint }> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const receipt = await publicClient.getTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new OgAgentDeployError(`${label} transaction reverted: ${hash}`, "tx_reverted", 500);
      return receipt;
    } catch (error) {
      if (error instanceof OgAgentDeployError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (!message.toLowerCase().includes("not found") && !message.toLowerCase().includes("could not")) throw error;
      await sleep(1_000);
    }
  }
  throw new OgAgentDeployError(`Timed out waiting for ${label} receipt: ${hash}`, "tx_timeout", 500);
}

async function readInventoryFromBlock(publicClient: PublicClient, oldVault: Address): Promise<bigint> {
  const explicitSourceBlock =
    readBigintEnv("POLICY_VAULT_V3_MAINNET_FROM_BLOCK") ??
    readBigintEnv("NEXT_PUBLIC_POLICY_VAULT_V3_MAINNET_FROM_BLOCK");
  const v3DeployBlock = explicitSourceBlock ?? await readV3DeployBlock(publicClient, oldVault);
  if (v3DeployBlock <= 0n) {
    throw new OgAgentDeployError(
      `Inventory fromBlock is unavailable for ${oldVault}. Pin POLICY_VAULT_V3_MAINNET_FROM_BLOCK or add blockNumber to the V3 deployment registry before migrating.`,
      "inventory_from_block_missing",
      409,
    );
  }
  return v3DeployBlock;
}

async function readV3DeployBlock(publicClient: PublicClient, oldVault: Address): Promise<bigint> {
  const registry = await readFile(join(process.cwd(), ".data", "deployments", "mainnet-policy-vault-v3-registry.json"), "utf8").catch(() => "[]");
  const entries = JSON.parse(registry) as Array<{ vault?: string; blockNumber?: string }>;
  const entry = entries.find((item) => item.vault && isAddress(item.vault) && sameAddress(getAddress(item.vault), oldVault));
  if (entry?.blockNumber && /^\d+$/u.test(entry.blockNumber)) return BigInt(entry.blockNumber);
  const code = await publicClient.getBytecode({ address: oldVault });
  if (!code || code === "0x") throw new Error("old vault bytecode missing");
  throw new OgAgentDeployError(
    `V3 deploy block is not recorded for ${oldVault}. Refusing to scan NFPM logs from block 0.`,
    "inventory_from_block_missing",
    409,
  );
}

function readBigintEnv(name: string): bigint | null {
  const value = process.env[name]?.trim();
  return value && /^\d+$/u.test(value) ? BigInt(value) : null;
}

async function scanNfpmTransferTokenIds(publicClient: PublicClient, oldVault: Address, fromBlock: bigint, toBlock: bigint): Promise<bigint[]> {
  if (fromBlock > toBlock) return [];
  if (fromBlock <= 0n) {
    throw new OgAgentDeployError("Refusing to enumerate NFPM Transfer logs from block 0.", "inventory_from_block_missing", 409);
  }
  const logs = await scanNfpmTransferLogs(publicClient, oldVault, fromBlock, toBlock);
  const tokenIds = new Set<bigint>();
  for (const log of logs as Array<{ args: { tokenId?: unknown } }>) {
    const tokenId = log.args.tokenId;
    if (typeof tokenId !== "bigint") continue;
    tokenIds.add(tokenId);
  }
  return Array.from(tokenIds).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

async function scanNfpmTransferLogs(publicClient: PublicClient, oldVault: Address, fromBlock: bigint, toBlock: bigint) {
  const chunkSize = readBigintEnv("OG_LOG_CHUNK_BLOCKS") ?? DEFAULT_LOG_CHUNK_BLOCKS;
  const normalizedChunkSize = chunkSize > 0n ? chunkSize : DEFAULT_LOG_CHUNK_BLOCKS;
  const logs: Awaited<ReturnType<PublicClient["getLogs"]>> = [];
  for (let start = fromBlock; start <= toBlock; start += normalizedChunkSize + 1n) {
    const end = start + normalizedChunkSize > toBlock ? toBlock : start + normalizedChunkSize;
    const [incoming, outgoing] = await Promise.all([
      publicClient.getLogs({
        address: ZIA_LP_MAINNET.nonfungiblePositionManager,
        args: { to: oldVault },
        event: transferEvent,
        fromBlock: start,
        toBlock: end,
      }),
      publicClient.getLogs({
        address: ZIA_LP_MAINNET.nonfungiblePositionManager,
        args: { from: oldVault },
        event: transferEvent,
        fromBlock: start,
        toBlock: end,
      }),
    ]).catch((error) => {
      throw new OgAgentDeployError(
        `Unable to enumerate NFPM Transfer logs for ${oldVault} in block range ${start}-${end}: ${error instanceof Error ? error.message : String(error)}`,
        "inventory_enumeration_unavailable",
        409,
      );
    });
    logs.push(...incoming, ...outgoing);
  }
  return logs;
}

async function readTokenBalances(publicClient: PublicClient, oldVault: Address): Promise<TokenBalanceInventory[]> {
  const balances: TokenBalanceInventory[] = [];
  for (const token of uniqueCuratedMainnetTokens()) {
    const balance = await publicClient.readContract({ address: token, abi: erc20BalanceAbi, functionName: "balanceOf", args: [oldVault] }).catch(() => 0n);
    balances.push({ token, balance: String(balance) });
  }
  return balances;
}

function buildPinnedRosterIndex(registry: AgentDeploymentRegistryArtifact, agentIds: string[]): Map<string, OgAgentDeploymentRecord | OgRemovedAgentRecord> {
  const pinnedIdentity = readPinnedAgenticIdAddress();
  const ids = new Set(agentIds);
  const result = new Map<string, OgAgentDeploymentRecord | OgRemovedAgentRecord>();
  for (const record of [...(registry.agents ?? []), ...(registry.removedAgents ?? [])]) {
    if (ids.size > 0 && !ids.has(record.id)) continue;
    if (!record.identityAddress || record.identityAddress.toLowerCase() !== pinnedIdentity.toLowerCase()) continue;
    result.set(String(record.tokenId), record);
  }
  return result;
}

function readPinnedAgenticIdAddress(): Address {
  const value =
    process.env.AGENT_IDENTITY_MAINNET_ADDRESS ??
    process.env.NEXT_PUBLIC_AGENT_IDENTITY_MAINNET_ADDRESS ??
    process.env.AGENT_IDENTITY_ADDRESS ??
    process.env.NEXT_PUBLIC_AGENT_IDENTITY_ADDRESS;
  if (!value || !isAddress(value)) {
    throw new OgAgentDeployError("AGENT_IDENTITY_MAINNET_ADDRESS must be pinned before migrate-v4.", "identity_not_configured", 409);
  }
  return getAddress(value);
}

async function readV3NftGetters(publicClient: PublicClient, oldVault: Address, tokenId: bigint): Promise<{
  ok: SelectorProbeResult;
  values: V3NftGetterValues;
}> {
  const values: V3NftGetterValues = {};
  const ok: SelectorProbeResult = { lpNftOwner: true, lpNftPool: true, lpNftTickLower: true, lpNftTickUpper: true, lpNftDeployedNative: true };
  await Promise.all([
    publicClient.readContract({ address: oldVault, abi: policyVaultV3Abi, functionName: "lpNftOwner", args: [tokenId] }).then((v) => { values.lpNftOwner = v as Hex; }).catch(() => { ok.lpNftOwner = false; }),
    publicClient.readContract({ address: oldVault, abi: policyVaultV3Abi, functionName: "lpNftPool", args: [tokenId] }).then((v) => { values.lpNftPool = v as Hex; }).catch(() => { ok.lpNftPool = false; }),
    publicClient.readContract({ address: oldVault, abi: policyVaultV3Abi, functionName: "lpNftTickLower", args: [tokenId] }).then((v) => { values.lpNftTickLower = Number(v); }).catch(() => { ok.lpNftTickLower = false; }),
    publicClient.readContract({ address: oldVault, abi: policyVaultV3Abi, functionName: "lpNftTickUpper", args: [tokenId] }).then((v) => { values.lpNftTickUpper = Number(v); }).catch(() => { ok.lpNftTickUpper = false; }),
    publicClient.readContract({ address: oldVault, abi: policyVaultV3Abi, functionName: "lpNftDeployedNative", args: [tokenId] }).then((v) => { values.lpNftDeployedNative = v as bigint; }).catch(() => { ok.lpNftDeployedNative = false; }),
  ]);
  return { ok, values };
}

interface BurnedRevertForm {
  dataPrefix?: string;
  messageNeedle?: string;
}

async function probeNfpmBurnedRevertForm(publicClient: PublicClient): Promise<BurnedRevertForm> {
  try {
    await publicClient.readContract({
      address: ZIA_LP_MAINNET.nonfungiblePositionManager,
      abi: ziaNonfungiblePositionManagerAbi,
      functionName: "ownerOf",
      args: [MAX_UINT256],
    });
  } catch (error) {
    const data = extractErrorData(error);
    if (data && data.length >= 10) return { dataPrefix: data.slice(0, 10).toLowerCase() };
    const message = error instanceof Error ? error.message : String(error);
    if (message.trim()) return { messageNeedle: normalizeErrorMessage(message).slice(0, 120) };
  }
  throw new OgAgentDeployError("Unable to verify NFPM burned-token revert form.", "burned_revert_unknown", 409);
}

async function readNfpmOwnerStatus(publicClient: PublicClient, tokenId: bigint, burnedForm: BurnedRevertForm, v3OwnerZero: boolean): Promise<
  | { kind: "owner"; owner: Address }
  | { kind: "burned"; reason: string }
  | { kind: "unknown"; reason: string }
> {
  try {
    const owner = await ownerOfNfpm(publicClient, tokenId);
    return { kind: "owner", owner };
  } catch (error) {
    if (v3OwnerZero && matchesBurnedRevert(error, burnedForm)) return { kind: "burned", reason: "verified_burned_revert" };
    return { kind: "unknown", reason: `ownerOf_revert_unmatched:${error instanceof Error ? error.message : String(error)}` };
  }
}

async function ownerOfNfpm(publicClient: PublicClient, tokenId: bigint): Promise<Address> {
  const owner = await publicClient.readContract({
    address: ZIA_LP_MAINNET.nonfungiblePositionManager,
    abi: ziaNonfungiblePositionManagerAbi,
    functionName: "ownerOf",
    args: [tokenId],
  }) as Address;
  return getAddress(owner);
}

function matchesBurnedRevert(error: unknown, form: BurnedRevertForm): boolean {
  const data = extractErrorData(error);
  if (form.dataPrefix && data?.toLowerCase().startsWith(form.dataPrefix)) return true;
  const message = normalizeErrorMessage(error instanceof Error ? error.message : String(error));
  return Boolean(form.messageNeedle && message.includes(form.messageNeedle));
}

function extractErrorData(error: unknown): Hex | null {
  const cursor = error as { data?: unknown; cause?: unknown; details?: unknown };
  if (typeof cursor.data === "string" && isHex(cursor.data)) return cursor.data as Hex;
  const cause = cursor.cause as { data?: unknown } | undefined;
  if (typeof cause?.data === "string" && isHex(cause.data)) return cause.data as Hex;
  const details = typeof cursor.details === "string" ? cursor.details : "";
  const match = details.match(/0x[a-fA-F0-9]{8,}/u);
  return match && isHex(match[0]) ? match[0] as Hex : null;
}

function normalizeErrorMessage(value: string): string {
  return value.toLowerCase().replace(/\s+/gu, " ").trim();
}

async function reconstructDeployedNativeFromEvents(publicClient: PublicClient, tokenId: bigint, fromBlock: bigint, toBlock: bigint): Promise<bigint | undefined> {
  const position = await publicClient.readContract({
    address: ZIA_LP_MAINNET.nonfungiblePositionManager,
    abi: ziaNonfungiblePositionManagerAbi,
    functionName: "positions",
    args: [tokenId],
  }) as readonly unknown[];
  const token0 = getAddress(position[2] as Address);
  const token1 = getAddress(position[3] as Address);
  const w0g = ZIA_LP_MAINNET.wrappedNative.toLowerCase();
  const w0gIndex = token0.toLowerCase() === w0g ? 0 : token1.toLowerCase() === w0g ? 1 : -1;
  if (w0gIndex < 0) return undefined;
  let total = 0n;
  const increaseLogs = await publicClient.getLogs({
    address: ZIA_LP_MAINNET.nonfungiblePositionManager,
    event: increaseLiquidityEvent,
    args: { tokenId },
    fromBlock,
    toBlock,
  }).catch(() => []);
  for (const log of increaseLogs) {
    total += w0gIndex === 0 ? BigInt(log.args.amount0 ?? 0n) : BigInt(log.args.amount1 ?? 0n);
  }
  const depositLogs = await publicClient.getLogs({
    address: ZIA_LP_MAINNET.nonfungiblePositionManager,
    event: depositEvent,
    args: { tokenId },
    fromBlock,
    toBlock,
  }).catch(() => []);
  for (const log of depositLogs) {
    total += w0gIndex === 0 ? BigInt(log.args.amount0 ?? 0n) : BigInt(log.args.amount1 ?? 0n);
  }
  return total > 0n ? total : undefined;
}

function classifyNftCustody(oldVault: Address, owner: Address): { staked: boolean; stakeVault?: Address } {
  if (sameAddress(owner, oldVault)) return { staked: false };
  const stakeVault = stakeVaultForOwner(owner);
  return stakeVault ? { staked: true, stakeVault } : { staked: false };
}

function stakeVaultForOwner(owner: Address): Address | undefined {
  return ZIA_LP_VAULTS.find((vault) => vault.vaultAddress.toLowerCase() === owner.toLowerCase())?.vaultAddress;
}

function poolLabelForPoolId(poolId: Hex): string | undefined {
  const poolAddress = getAddress(`0x${poolId.slice(-40)}`);
  return findZiaLpVaultByPool(poolAddress)?.label;
}

async function ensurePreservePreflight(
  runtime: DeployerRuntime,
  trio: V4VaultTrio,
  tokenId: bigint,
  agentKey: Hex,
  poolId: Hex,
  deployedNative: bigint,
  enableIfNeeded: boolean,
): Promise<void> {
  const [allowed, lpOwner, policyRaw, spent, windowStart, exposure, block] = await Promise.all([
    runtime.publicClient.readContract({ address: trio.lpEntryVault, abi: policyVaultV4LpEntryAbi, functionName: "allowedLpPools", args: [poolId] }) as Promise<boolean>,
    runtime.publicClient.readContract({ address: trio.lpEntryVault, abi: policyVaultV4LpEntryAbi, functionName: "lpNftOwner", args: [tokenId] }) as Promise<Hex>,
    runtime.publicClient.readContract({ address: trio.lpEntryVault, abi: policyVaultV4LpEntryAbi, functionName: "policy" }),
    runtime.publicClient.readContract({ address: trio.lpEntryVault, abi: policyVaultV4LpEntryAbi, functionName: "lpDailySpent0G" }) as Promise<bigint>,
    runtime.publicClient.readContract({ address: trio.lpEntryVault, abi: policyVaultV4LpEntryAbi, functionName: "lpDailyWindowStart" }) as Promise<bigint>,
    runtime.publicClient.readContract({ address: trio.lpEntryVault, abi: policyVaultV4LpEntryAbi, functionName: "openLpExposure0G" }) as Promise<bigint>,
    runtime.publicClient.getBlock(),
  ]);
  if (!allowed) throw new OgAgentDeployError(`V4 LpEntry pool ${poolId} is not allowlisted.`, "preserve_blocked", 409);
  if (lpOwner !== ZERO_BYTES32 && lpOwner.toLowerCase() !== agentKey.toLowerCase()) {
    throw new OgAgentDeployError(`V4 LpEntry already has lpNftOwner for token ${tokenId.toString()}.`, "preserve_blocked", 409);
  }
  const enabled = await readV4AgentKeyEnabled(runtime.publicClient, trio, agentKey);
  if (!enabled) {
    if (!enableIfNeeded) throw new OgAgentDeployError(`V4 agent key is not enabled for ${agentKey}.`, "preserve_blocked", 409);
    await setAgentKeyEnabledOnV4Trio(runtime, trio, agentKey, true);
  }
  const policy = normalizeV4LpPolicy(policyRaw);
  const effectiveSpent = block.timestamp >= windowStart + DAY_SECONDS ? 0n : spent;
  if (deployedNative > policy.perLpActionCap0G) throw new OgAgentDeployError("V4 per-LP action cap is too low for preserve.", "preserve_blocked", 409);
  if (deployedNative > policy.lpDailyCap0G - effectiveSpent) throw new OgAgentDeployError("V4 LP daily cap remaining is too low for preserve.", "preserve_blocked", 409);
  if (deployedNative > policy.maxLpExposure0G - exposure) throw new OgAgentDeployError("V4 LP exposure remaining is too low for preserve.", "preserve_blocked", 409);
}

function normalizeV4LpPolicy(raw: unknown): PolicyVaultV4LpPolicy {
  return {
    perLpActionCap0G: readBigIntField(raw, 0, "perLpActionCap0G"),
    lpDailyCap0G: readBigIntField(raw, 1, "lpDailyCap0G"),
    maxLpExposure0G: readBigIntField(raw, 2, "maxLpExposure0G"),
    cooldownSecondsLp: readBigIntField(raw, 3, "cooldownSecondsLp"),
    lpMinOutBps: Number(readBigIntField(raw, 4, "lpMinOutBps")),
    minLiquidityFloor: readBigIntField(raw, 5, "minLiquidityFloor"),
    allowStaking: readBoolField(raw, 6, "allowStaking"),
  };
}

function readBigIntField(raw: unknown, index: number, key: string): bigint {
  const record = raw as Record<string, unknown>;
  const list = raw as readonly unknown[];
  const value = record?.[key] ?? list?.[index];
  if (typeof value === "bigint") return value;
  if (typeof value === "number" || typeof value === "string") return BigInt(value);
  throw new Error(`Missing bigint field ${key}`);
}

function readBoolField(raw: unknown, index: number, key: string): boolean {
  const record = raw as Record<string, unknown>;
  const list = raw as readonly unknown[];
  const value = record?.[key] ?? list?.[index];
  if (typeof value === "boolean") return value;
  throw new Error(`Missing boolean field ${key}`);
}

async function importV4LpNft(runtime: DeployerRuntime, v4LpEntry: Address, tokenId: bigint, agentKey: Hex, poolId: Hex, ticks: { tickLower: number; tickUpper: number }, deployedNative: bigint): Promise<Hex> {
  return writeVaultContract(runtime, v4LpEntry, policyVaultV4LpEntryAbi, "importLpNft", [
    tokenId,
    agentKey,
    poolId,
    ticks.tickLower,
    ticks.tickUpper,
    deployedNative,
  ]);
}

async function assertImported(publicClient: PublicClient, v4LpEntry: Address, nfpm: Address, tokenId: bigint, agentKey: Hex, poolId: Hex, deployedNative: bigint): Promise<void> {
  const [owner, lpOwner, lpPool, lpNative] = await Promise.all([
    publicClient.readContract({ address: nfpm, abi: ziaNonfungiblePositionManagerAbi, functionName: "ownerOf", args: [tokenId] }) as Promise<Address>,
    publicClient.readContract({ address: v4LpEntry, abi: policyVaultV4LpEntryAbi, functionName: "lpNftOwner", args: [tokenId] }) as Promise<Hex>,
    publicClient.readContract({ address: v4LpEntry, abi: policyVaultV4LpEntryAbi, functionName: "lpNftPool", args: [tokenId] }) as Promise<Hex>,
    publicClient.readContract({ address: v4LpEntry, abi: policyVaultV4LpEntryAbi, functionName: "lpNftDeployedNative", args: [tokenId] }) as Promise<bigint>,
  ]);
  if (!sameAddress(owner, v4LpEntry) || lpOwner.toLowerCase() !== agentKey.toLowerCase() || lpPool.toLowerCase() !== poolId.toLowerCase() || lpNative !== deployedNative) {
    throw new OgAgentDeployError(`V4 import postcondition failed for NFT ${tokenId.toString()}.`, "migration_verify_failed", 500);
  }
}

function markNftStage(state: VaultMigrateV4State, tokenId: string, stage: PerNftStage, txHashes?: Record<string, Hex>): void {
  state.nftStages = { ...(state.nftStages ?? {}), [tokenId]: stage };
  if (txHashes) state.nftTxHashes = { ...(state.nftTxHashes ?? {}), [tokenId]: txHashes };
}

function affectedRosterEntries(registry: AgentDeploymentRegistryArtifact, oldVault: Address): Array<OgAgentDeploymentRecord | OgRemovedAgentRecord> {
  return [...(registry.agents ?? []), ...(registry.removedAgents ?? [])].filter((record) => sameAddress(record.vault, oldVault));
}

function assertInventoryWithinMigrationCap(inventory: V3VaultInventory): void {
  const oversized = inventory.nfts.filter((nft) => {
    if (nft.deployedNative0G === undefined) return false;
    return BigInt(nft.deployedNative0G) > CAP_PRESET_WEI;
  });
  if (oversized.length > 0) {
    throw new OgAgentDeployError(
      `NFT deployed native exceeds the V4 migration cap (${CAP_PRESET} 0G): ${oversized.map((nft) => nft.tokenId).join(",")}.`,
      "preserve_blocked",
      409,
    );
  }
}

function deriveAgentIdsForVault(registry: AgentDeploymentRegistryArtifact, oldVault: Address): string[] {
  return affectedRosterEntries(registry, oldVault).map((record) => record.id);
}

async function enableAffectedAgentKeys(runtime: DeployerRuntime, trio: V4VaultTrio, oldVault: Address): Promise<void> {
  const registry = await readAgentRegistry();
  for (const record of affectedRosterEntries(registry, oldVault)) {
    await setAgentKeyEnabledOnV4Trio(runtime, trio, record.agentKey ?? agentKeyForDeployment(record), true);
  }
}

async function readV4AgentKeyEnabled(publicClient: PublicClient, trio: V4VaultTrio, agentKey: Hex): Promise<boolean> {
  const [swap, lpEntry, lpExit] = await Promise.all([
    publicClient.readContract({ address: trio.swapVault, abi: policyVaultV4SwapAbi, functionName: "agentKeyEnabled", args: [agentKey] }).catch(() => false),
    publicClient.readContract({ address: trio.lpEntryVault, abi: policyVaultV4LpEntryAbi, functionName: "agentKeyEnabled", args: [agentKey] }).catch(() => false),
    publicClient.readContract({ address: trio.lpExitVault, abi: policyVaultV4LpExitAbi, functionName: "agentKeyEnabled", args: [agentKey] }).catch(() => false),
  ]);
  return Boolean(swap && lpEntry && lpExit);
}

// Read the live V4 LpEntry daily-cap remaining, honoring the 24h rolling window reset
// (matches the per-NFT check in ensurePreservePreflight). Used by the aggregate daily-cap
// guard so a multi-NFT migration is checked against the true on-chain remaining budget.
async function readLiveLpDailyRemaining(
  publicClient: PublicClient,
  lpEntry: Address,
  blockTimestamp: bigint,
): Promise<{ cap: bigint; spent: bigint; remaining: bigint }> {
  const policyRaw = await publicClient.readContract({ address: lpEntry, abi: policyVaultV4LpEntryAbi, functionName: "policy" });
  const policy = normalizeV4LpPolicy(policyRaw);
  const [spent, windowStart] = await Promise.all([
    publicClient.readContract({ address: lpEntry, abi: policyVaultV4LpEntryAbi, functionName: "lpDailySpent0G" }) as Promise<bigint>,
    publicClient.readContract({ address: lpEntry, abi: policyVaultV4LpEntryAbi, functionName: "lpDailyWindowStart" }) as Promise<bigint>,
  ]);
  const effectiveSpent = blockTimestamp >= windowStart + DAY_SECONDS ? 0n : spent;
  const remaining = policy.lpDailyCap0G > effectiveSpent ? policy.lpDailyCap0G - effectiveSpent : 0n;
  return { cap: policy.lpDailyCap0G, spent: effectiveSpent, remaining };
}

function assertSameTrio(expected: V4VaultTrio, actual: V4VaultTrio): void {
  assertSameAddress(expected.swapVault, actual.swapVault, "v4SwapAddress");
  assertSameAddress(expected.lpEntryVault, actual.lpEntryVault, "v4LpEntryAddress");
  assertSameAddress(expected.lpExitVault, actual.lpExitVault, "v4LpExitAddress");
}

function assertSameAddress(actual: Address, expected: Address, label: string): void {
  if (!sameAddress(actual, expected)) {
    throw new OgAgentDeployError(`${label} mismatch: got ${actual}, expected ${expected}.`, "migrate_verify_failed", 500);
  }
}

function sameAddress(left: Address | string, right: Address | string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function compareBigintString(left: string, right: string): number {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function sha256Hex(value: string): Hex {
  return `0x${createHash("sha256").update(value).digest("hex")}` as Hex;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { CAP_PRESET, normalizePolicyVaultV3Policy };
// Re-export the client-safe shared helpers so existing route/test imports from
// this module keep working. The canonical implementation lives in the shared
// module (no "server-only") so the client wallet hook can import it too.
export { hashPerNftDecisions, LEGACY_V3_VAULTS } from "./vault-migrate-v4-shared";
export type { PerNftDecision, V4VaultTrio } from "./vault-migrate-v4-shared";
