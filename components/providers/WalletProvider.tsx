"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createConfig, http, injected, WagmiProvider } from "wagmi";
import { OG_NETWORKS } from "@/lib/og/networks";
import {
  OG_GALILEO_CHAIN,
  OG_MAINNET_CHAIN,
  OG_WAGMI_CHAINS,
} from "@/lib/wallet/chains";

export const OG_GALILEO_CHAIN_ID = OG_GALILEO_CHAIN.id;
export const OG_MAINNET_CHAIN_ID = OG_MAINNET_CHAIN.id;

export const walletConfig = createConfig({
  chains: OG_WAGMI_CHAINS,
  connectors: [
    injected({
      shimDisconnect: true,
      unstable_shimAsyncInject: 1_000,
    }),
  ],
  multiInjectedProviderDiscovery: true,
  ssr: true,
  transports: {
    16602: http(OG_NETWORKS.testnet.rpcUrl),
    16661: http(OG_NETWORKS.mainnet.rpcUrl),
  },
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

export function WalletProvider({ children }: { children: ReactNode }) {
  return (
    <WagmiProvider config={walletConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
