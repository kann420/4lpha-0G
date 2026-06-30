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

/**
 * Message the wallet signs to derive a per-session AES-256-GCM key used to
 * encrypt the chat session transcript before uploading it to 0G Storage.
 *
 * This is a CLIENT-ONLY secret. The signature never leaves the browser and is
 * never used for server auth (server auth uses the separate access message
 * above). The message is scoped to a specific sessionId so a signature cannot
 * be reused to decrypt a different session. Re-signing the same message
 * reproduces the same key on deterministic-signing wallets (RFC 6979, used by
 * viem's local signer and MetaMask), which is what lets the user decrypt a
 * past session on a new device by re-signing.
 */
export function buildCopilotSessionKeyMessage({
  address,
  chainId,
  networkId,
  sessionId,
}: {
  address: string;
  chainId: number;
  networkId: OgNetworkId;
  sessionId: string;
}): string {
  return [
    "4lpha 0G Copilot session key",
    `Wallet: ${address}`,
    `Network: ${networkId}`,
    `Chain ID: ${chainId}`,
    `Session: ${sessionId}`,
    "Purpose: derive a symmetric key to encrypt this Copilot chat session for 0G Storage. This signature is a client-only secret and is never sent to the server.",
    "Version: 1",
  ].join("\n");
}
