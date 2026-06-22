import { defineChain } from "viem";
import { OG_NETWORKS } from "@/lib/og/networks";
import type { OgNetworkId } from "@/lib/types";

const galileo = OG_NETWORKS.testnet;
const mainnet = OG_NETWORKS.mainnet;

export const OG_GALILEO_CHAIN = defineChain({
  id: galileo.chainId,
  name: galileo.networkName,
  nativeCurrency: {
    decimals: 18,
    name: galileo.nativeToken,
    symbol: galileo.nativeToken,
  },
  rpcUrls: {
    default: {
      http: [galileo.rpcUrl],
    },
    public: {
      http: [galileo.rpcUrl],
    },
  },
  blockExplorers: {
    default: {
      name: "0G ChainScan Galileo",
      url: galileo.explorerUrl,
    },
  },
  testnet: true,
});

export const OG_MAINNET_CHAIN = defineChain({
  id: mainnet.chainId,
  name: mainnet.networkName,
  nativeCurrency: {
    decimals: 18,
    name: mainnet.nativeToken,
    symbol: mainnet.nativeToken,
  },
  rpcUrls: {
    default: {
      http: [mainnet.rpcUrl],
    },
    public: {
      http: [mainnet.rpcUrl],
    },
  },
  blockExplorers: {
    default: {
      name: "0G ChainScan",
      url: mainnet.explorerUrl,
    },
  },
});

export const OG_WAGMI_CHAINS = [OG_GALILEO_CHAIN, OG_MAINNET_CHAIN] as const;

export const OG_CHAIN_BY_NETWORK_ID = {
  testnet: OG_GALILEO_CHAIN,
  mainnet: OG_MAINNET_CHAIN,
} satisfies Record<OgNetworkId, (typeof OG_WAGMI_CHAINS)[number]>;

export function getOgWalletChain(networkId: OgNetworkId) {
  return OG_CHAIN_BY_NETWORK_ID[networkId];
}
