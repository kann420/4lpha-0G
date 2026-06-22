import type { OgNetworkId } from "@/lib/types";

export interface CopilotWalletAccess {
  address: string;
  chainId: number;
  message: string;
  signature: string;
}

export function buildCopilotWalletAccessMessage({
  address,
  chainId,
  networkId,
}: {
  address: string;
  chainId: number;
  networkId: OgNetworkId;
}): string {
  return [
    "4lpha 0G Copilot access",
    `Wallet: ${address}`,
    `Network: ${networkId}`,
    `Chain ID: ${chainId}`,
    "Purpose: unlock server-only 0G Compute Router chat and Policy Vault review context.",
    "Version: 1",
  ].join("\n");
}
