import "server-only";

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
  return createPublicClient({
    chain: make0GMainnetChain(rpcUrl),
    transport: http(rpcUrl, {
      retryCount: 0,
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
