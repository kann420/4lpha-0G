import type { OgNetworkConfig, OgNetworkId } from "@/lib/types";

export const OG_NETWORKS: Record<OgNetworkId, OgNetworkConfig> = {
  testnet: {
    chainId: 16602,
    explorerUrl: "https://chainscan-galileo.0g.ai",
    faucetUrl: "https://faucet.0g.ai",
    id: "testnet",
    label: "0G Testnet",
    nativeToken: "0G",
    networkName: "0G Galileo Testnet",
    readinessLabel: "Default demo network",
    rpcUrl: "https://evmrpc-testnet.0g.ai",
    storageIndexerUrl: "https://indexer-storage-testnet-turbo.0g.ai",
  },
  mainnet: {
    chainId: 16661,
    explorerUrl: "https://chainscan.0g.ai",
    id: "mainnet",
    label: "0G Mainnet",
    nativeToken: "0G",
    networkName: "0G Mainnet",
    readinessLabel: "Requires reviewed vault config",
    rpcUrl: "https://evmrpc.0g.ai",
    storageIndexerUrl: "https://indexer-storage-turbo.0g.ai",
  },
};

export const DEFAULT_OG_NETWORK_ID: OgNetworkId = "mainnet";
export const OG_NETWORK_STORAGE_KEY = "4lpha-0g:selected-network";

export function isOgNetworkId(value: unknown): value is OgNetworkId {
  return value === "testnet" || value === "mainnet";
}

export function getOgNetwork(value: OgNetworkId): OgNetworkConfig {
  return OG_NETWORKS[value];
}
