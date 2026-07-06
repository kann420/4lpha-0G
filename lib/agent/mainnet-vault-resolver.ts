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
  type MainnetV3VaultRegistryEntry,
} from "@/lib/contracts/policy-vault-v3";

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

/// Resolve a V3 vault for an owner. An explicit env-configured V3 address
/// (NEXT_PUBLIC_POLICY_VAULT_V3_MAINNET_ADDRESS / POLICY_VAULT_V3_MAINNET_ADDRESS)
/// is treated as authoritative when set, because the off-chain registry can be
/// missing, stale, or branch-local and there is NO on-chain V3 factory on 0G
/// mainnet to reconcile. Otherwise fall back to the latest registry match
/// (case-insensitive address match). Returns null if neither source has an entry.
///
/// TRUST BOUNDARY: neither source is on-chain truth. The env override is an
/// operator assertion; the registry is a local deploy artifact. Misconfiguration
/// can point UI/executor at the wrong V3 — operators must keep the env var or
/// the registry file aligned with the actually-funded vault.
export async function resolveMainnetV3VaultForOwner(owner: Address): Promise<Address | null> {
  const envOverride = readConfiguredMainnetV3VaultAddress();
  if (envOverride !== undefined) {
    return getAddress(envOverride);
  }
  const registry = await readMainnetV3VaultRegistry();
  const lower = owner.toLowerCase();
  const entry = [...registry].reverse().find((item) => item.owner.toLowerCase() === lower);
  return entry ? getAddress(entry.vault) : null;
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

function createMainnetPublicClient(): PublicClient {
  const rpcUrl = process.env.OG_RPC_URL?.trim();
  if (!rpcUrl) {
    throw new Error("OG_RPC_URL is required to resolve the mainnet Policy Vault.");
  }
  // Default retryCount:0 preserves fast-fail; env override opts into 429
  // backoff for bursty one-off scripts. viem only retries non-deterministic
  // errors (429/5xx/network) — never contract reverts.
  const retryCount = Number(process.env.OG_RPC_RETRY_COUNT ?? 0);
  const retryDelay = Number(process.env.OG_RPC_RETRY_DELAY_MS ?? 150);
  return createPublicClient({
    chain: make0GMainnetChain(rpcUrl),
    transport: http(rpcUrl, {
      retryCount: Number.isFinite(retryCount) && retryCount >= 0 ? retryCount : 0,
      retryDelay: Number.isFinite(retryDelay) && retryDelay >= 0 ? retryDelay : 150,
      timeout: OG_RPC_TIMEOUT_MS,
    }),
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
