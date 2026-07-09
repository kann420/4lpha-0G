import "server-only";

import { readFile } from "node:fs/promises";

import {
  createPublicClient,
  getAddress,
  http,
  isAddress,
  zeroAddress,
  type Address,
  type Chain,
  type PublicClient,
} from "viem";
import {
  getLatestPolicyVaultFactoryVersion,
  getPolicyVaultFactoryVersions,
  policyVaultFactoryAbi,
  type PolicyVaultFactoryVersion,
} from "@/lib/contracts/policy-vault";
import {
  MAINNET_V3_VAULT_REGISTRY_PATH,
  policyVaultV3Abi,
  type MainnetV3VaultRegistryEntry,
} from "@/lib/contracts/policy-vault-v3";
import {
  NEXT_PUBLIC_POLICY_VAULT_V4_REGISTRY_MAINNET_ADDRESS,
  policyVaultV4LpEntryAbi,
  policyVaultV4LpExitAbi,
  policyVaultV4SwapAbi,
  vaultRegistryV4Abi,
} from "@/lib/contracts/policy-vault-v4";
import { makeMainnetTransport } from "@/lib/og/mainnet-rpc";

const MAINNET_CHAIN_ID = 16661;
const OG_RPC_TIMEOUT_MS = 4_000;

export function readMainnetOwnerAddress(value: string | null | undefined): Address | undefined {
  const normalized = value?.trim();
  return normalized && isAddress(normalized) ? getAddress(normalized) : undefined;
}

export function readConfiguredMainnetVaultAddress(): Address | undefined {
  return (
    readMainnetOwnerAddress(process.env.NEXT_PUBLIC_POLICY_VAULT_MAINNET_ADDRESS) ??
    readMainnetOwnerAddress(process.env.POLICY_VAULT_MAINNET_ADDRESS)
  );
}

export function readConfiguredMainnetFactoryAddress(): Address | undefined {
  return getLatestPolicyVaultFactoryVersion("mainnet")?.address;
}

export function readConfiguredMainnetFactoryVersions(): PolicyVaultFactoryVersion[] {
  return getPolicyVaultFactoryVersions("mainnet");
}

// =====================================================================
// V3 resolver — off-chain registry (no on-chain V3 factory on mainnet).
// =====================================================================

export function readConfiguredMainnetV3VaultAddress(): Address | undefined {
  return (
    readMainnetOwnerAddress(process.env.NEXT_PUBLIC_POLICY_VAULT_V3_MAINNET_ADDRESS) ??
    readMainnetOwnerAddress(process.env.POLICY_VAULT_V3_MAINNET_ADDRESS)
  );
}

/// Read the V3 vault registry JSON. Returns [] if the file does not exist yet
/// (no V3 vaults deployed). Throws on malformed JSON.
export async function readMainnetV3VaultRegistry(): Promise<MainnetV3VaultRegistryEntry[]> {
  try {
    const raw = await readFile(MAINNET_V3_VAULT_REGISTRY_PATH, "utf8");
    const parsed = JSON.parse(raw) as MainnetV3VaultRegistryEntry[];
    if (!Array.isArray(parsed)) {
      throw new Error("V3 vault registry is not an array");
    }
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("ENOENT") || message.includes("no such file")) {
      return [];
    }
    // Malformed JSON is a real error — surface it.
    throw error;
  }
}

/// Resolve a V3 vault for an owner from the owner-scoped registry only.
/// Env-configured V3 addresses are operator/script hints and must not decide a
/// browser user's vault; every registry match is verified against on-chain
/// owner() before being returned.
///
/// can point UI/executor at the wrong V3 — operators must keep the env var or
export async function resolveMainnetV3VaultForOwner(
  owner: Address,
  client?: PublicClient,
): Promise<Address | null> {
  const registry = await readMainnetV3VaultRegistry();
  const lower = owner.toLowerCase();
  const entry = [...registry].reverse().find((item) => item.owner.toLowerCase() === lower);
  if (!entry) {
    return null;
  }
  const vault = getAddress(entry.vault);
  const publicClient = client ?? createMainnetPublicClient();
  const onChainOwner = await publicClient.readContract({
    address: vault,
    abi: policyVaultV3Abi,
    functionName: "owner",
  }).catch(() => null) as Address | null;
  return onChainOwner && onChainOwner.toLowerCase() === lower ? vault : null;
}

/// Pre-deploy guard: throw if the owner already has a V3 vault. V2 coexistence
/// is allowed (the V3 contract is a separate singleton), so this only checks V3.
export async function assertNoExistingV3VaultForOwner(owner: Address): Promise<void> {
  const existing = await resolveMainnetV3VaultForOwner(owner);
  if (existing !== null) {
    throw new Error(`Owner ${owner} already has a V3 vault at ${existing}. Clear the V3 registry entry to redeploy intentionally.`);
  }
}

export async function resolveMainnetVaultForOwner(
  owner: Address,
  client?: PublicClient,
): Promise<Address | null> {
  const factory = getLatestPolicyVaultFactoryVersion("mainnet");
  if (!factory) {
    return null;
  }

  const publicClient = client ?? createMainnetPublicClient();
  const vault = await publicClient.readContract({
    address: factory.address,
    abi: policyVaultFactoryAbi,
    functionName: "vaultOf",
    args: [owner],
  });

  return vault === zeroAddress ? null : getAddress(vault);
}

export async function resolveMainnetVaultVersionsForOwner(
  owner: Address,
  client?: PublicClient,
): Promise<Array<{ factory: Address; vault: Address; version: number }>> {
  const factories = readConfiguredMainnetFactoryVersions();
  if (factories.length === 0) {
    return [];
  }
  const publicClient = client ?? createMainnetPublicClient();
  const results = await Promise.all(
    factories.map(async (factory) => {
      const vault = await publicClient.readContract({
        address: factory.address,
        abi: policyVaultFactoryAbi,
        functionName: "vaultOf",
        args: [owner],
      }).catch(() => zeroAddress);
      return vault === zeroAddress ? null : { factory: factory.address, vault: getAddress(vault), version: factory.version };
    }),
  );
  return results.filter((result): result is { factory: Address; vault: Address; version: number } => result !== null);
}

export interface MainnetV4VaultResolution {
  swapVault: Address;
  lpEntryVault: Address;
  lpExitVault: Address;
}

export interface ActiveVaultResolution {
  v4: MainnetV4VaultResolution | null;
  v3: Address | null;
  v2Latest: Address | null;
  v2Versions: Array<{ factory: Address; vault: Address; version: number }>;
  swapActive: boolean;
  lpActive: boolean;
  active: boolean;
}

export async function resolveMainnetV4VaultForOwner(
  owner: Address,
  agentKey?: `0x${string}`,
  client?: PublicClient,
): Promise<(MainnetV4VaultResolution & { swapActive: boolean; lpActive: boolean; active: boolean }) | null> {
  const registry = NEXT_PUBLIC_POLICY_VAULT_V4_REGISTRY_MAINNET_ADDRESS;
  if (registry === zeroAddress) {
    return null;
  }
  const publicClient = client ?? createMainnetPublicClient();
  const [swapVaultRaw, lpEntryVaultRaw, lpExitVaultRaw] = await publicClient.readContract({
    address: registry,
    abi: vaultRegistryV4Abi,
    functionName: "vaultOf",
    args: [owner],
  });

  if (swapVaultRaw === zeroAddress || lpEntryVaultRaw === zeroAddress || lpExitVaultRaw === zeroAddress) {
    return null;
  }

  const swapVault = getAddress(swapVaultRaw);
  const lpEntryVault = getAddress(lpEntryVaultRaw);
  const lpExitVault = getAddress(lpExitVaultRaw);
  if (agentKey === undefined) {
    return { swapVault, lpEntryVault, lpExitVault, swapActive: false, lpActive: false, active: false };
  }

  const [swapEnabled, lpEntryEnabled, lpExitEnabled] = await Promise.all([
    publicClient.readContract({
      address: swapVault,
      abi: policyVaultV4SwapAbi,
      functionName: "agentKeyEnabled",
      args: [agentKey],
    }).catch(() => false),
    publicClient.readContract({
      address: lpEntryVault,
      abi: policyVaultV4LpEntryAbi,
      functionName: "agentKeyEnabled",
      args: [agentKey],
    }).catch(() => false),
    publicClient.readContract({
      address: lpExitVault,
      abi: policyVaultV4LpExitAbi,
      functionName: "agentKeyEnabled",
      args: [agentKey],
    }).catch(() => false),
  ]);

  const swapActive = Boolean(swapEnabled);
  const lpActive = Boolean(lpEntryEnabled && lpExitEnabled);
  return { swapVault, lpEntryVault, lpExitVault, swapActive, lpActive, active: swapActive && lpActive };
}

export async function resolveActiveVaultForOwner(
  owner: Address,
  agentKey: `0x${string}`,
  client?: PublicClient,
): Promise<ActiveVaultResolution> {
  const publicClient = client ?? createMainnetPublicClient();
  const [v4, v3, v2Versions] = await Promise.all([
    resolveMainnetV4VaultForOwner(owner, agentKey, publicClient),
    resolveMainnetV3VaultForOwner(owner, publicClient),
    resolveMainnetVaultVersionsForOwner(owner, publicClient),
  ]);
  return {
    v4,
    v3,
    v2Latest: v2Versions.at(-1)?.vault ?? null,
    v2Versions,
    swapActive: v4?.swapActive ?? false,
    lpActive: v4?.lpActive ?? false,
    active: v4?.active ?? false,
  };
}

function createMainnetPublicClient(): PublicClient {
  const rpcUrl = process.env.OG_RPC_URL?.trim();
  if (!rpcUrl && !process.env.OG_MAINNET_RPC_URL?.trim()) {
    throw new Error("OG_RPC_URL is required to resolve the mainnet Policy Vault.");
  }
  // Prefer quiknode with public fallback + batched read bursts (see makeMainnetTransport).
  return createPublicClient({
    chain: make0GMainnetChain(rpcUrl ?? process.env.OG_MAINNET_RPC_URL!.trim()),
    transport: makeMainnetTransport(),
  });
}

function make0GMainnetChain(rpcUrl: string): Chain {
  return {
    id: MAINNET_CHAIN_ID,
    name: "0G Mainnet",
    nativeCurrency: {
      decimals: 18,
      name: "0G",
      symbol: "0G",
    },
    rpcUrls: {
      default: { http: [rpcUrl] },
    },
    blockExplorers: {
      default: {
        name: "0G ChainScan",
        url: "https://chainscan.0g.ai",
      },
    },
  };
}
