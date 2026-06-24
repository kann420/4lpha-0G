"use client";

import { useSyncExternalStore } from "react";
import {
  DEFAULT_OG_NETWORK_ID,
  OG_NETWORK_STORAGE_KEY,
  getOgNetwork,
} from "@/lib/og/networks";
import type { OgNetworkConfig, OgNetworkId } from "@/lib/types";

export function useOgNetwork(): {
  network: OgNetworkConfig;
  networkId: OgNetworkId;
  setNetworkId: (value: OgNetworkId) => void;
} {
  const networkId = useSyncExternalStore(subscribeToNetwork, getNetworkSnapshot, getNetworkServerSnapshot);

  function setNetworkId(value: OgNetworkId) {
    try {
      window.localStorage.setItem(OG_NETWORK_STORAGE_KEY, value === "mainnet" ? value : DEFAULT_OG_NETWORK_ID);
      window.dispatchEvent(new Event("4lpha-0g-network-change"));
    } catch {}
  }

  return {
    network: getOgNetwork(networkId),
    networkId,
    setNetworkId,
  };
}

function subscribeToNetwork(onStoreChange: () => void): () => void {
  function handleStorage(event: StorageEvent) {
    if (event.key === OG_NETWORK_STORAGE_KEY) {
      onStoreChange();
    }
  }

  window.addEventListener("storage", handleStorage);
  window.addEventListener("4lpha-0g-network-change", onStoreChange);

  return () => {
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener("4lpha-0g-network-change", onStoreChange);
  };
}

function getNetworkSnapshot(): OgNetworkId {
  return DEFAULT_OG_NETWORK_ID;
}

function getNetworkServerSnapshot(): OgNetworkId {
  return DEFAULT_OG_NETWORK_ID;
}
