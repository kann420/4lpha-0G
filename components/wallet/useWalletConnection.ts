"use client";

import { useMemo } from "react";
import {
  useAccount,
  useChainId,
  useConnect,
  useDisconnect,
  useSwitchChain,
} from "wagmi";
import { DEFAULT_OG_NETWORK_ID } from "@/lib/og/networks";
import type { OgNetworkId } from "@/lib/types";
import { getOgWalletChain } from "@/lib/wallet/chains";

export function useWalletConnection(targetNetworkId: OgNetworkId = DEFAULT_OG_NETWORK_ID) {
  const account = useAccount();
  const chainId = useChainId();
  const connect = useConnect();
  const disconnect = useDisconnect();
  const switchChain = useSwitchChain();
  const targetChain = getOgWalletChain(targetNetworkId);
  const isWrongChain = account.isConnected && chainId !== targetChain.id;

  const maskedAddress = useMemo(() => {
    if (!account.address) return undefined;
    return `${account.address.slice(0, 6)}...${account.address.slice(-4)}`;
  }, [account.address]);

  return {
    address: account.address,
    chainId,
    connectors: connect.connectors,
    connectAsync: connect.connectAsync,
    connector: account.connector,
    connectorIcon: account.connector?.icon,
    connectorName: account.connector?.name,
    disconnect: disconnect.disconnect,
    isConnected: account.isConnected,
    isConnecting: connect.isPending,
    isSwitchingChain: switchChain.isPending,
    isWrongChain,
    maskedAddress,
    switchToOg: () => switchChain.switchChainAsync({ chainId: targetChain.id }),
    targetChainId: targetChain.id,
    targetNetworkName: targetChain.name,
  };
}
