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
 * Action-specific signed consent for funds-moving operations (LP stake /
 * unstake / zap-out, owner withdraw-native, LP automation toggle). Unlike the
 * generic Copilot-access message above, this binds the signature to a single
 * action + target (vault, agentId, tokenId, amount) + a single-use nonce +
 * expiry, so a captured signature cannot be replayed for a different action,
 * target, or amount. The server generates the nonce + expiry and returns them
 * to the client; the client includes them in the signed message.
 */
export function buildCopilotActionConsentMessage({
  address,
  chainId,
  networkId,
  action,
  vault,
  agentId,
  poolAddress,
  tokenId,
  tickLower,
  tickUpper,
  amount0G,
  automationEnabled,
  nonce,
  expiresAt,
}: {
  address: string;
  chainId: number;
  networkId: OgNetworkId;
  action: string;
  vault: string;
  agentId?: string;
  poolAddress?: string;
  tokenId?: string;
  tickLower?: number;
  tickUpper?: number;
  amount0G?: string;
  automationEnabled?: boolean;
  nonce: string;
  expiresAt: number;
}): string {
  const lines = [
    "4lpha 0G action consent",
    `Wallet: ${address}`,
    `Network: ${networkId}`,
    `Chain ID: ${chainId}`,
    `Action: ${action}`,
    `Vault: ${vault}`,
  ];
  if (agentId !== undefined) lines.push(`Agent: ${agentId}`);
  if (poolAddress !== undefined) lines.push(`Pool: ${poolAddress}`);
  if (tokenId !== undefined) lines.push(`Token ID: ${tokenId}`);
  if (tickLower !== undefined) lines.push(`Tick lower: ${tickLower}`);
  if (tickUpper !== undefined) lines.push(`Tick upper: ${tickUpper}`);
  if (amount0G !== undefined) lines.push(`Amount 0G: ${amount0G}`);
  if (automationEnabled !== undefined) lines.push(`Automation enabled: ${automationEnabled ? "true" : "false"}`);
  lines.push(`Nonce: ${nonce}`);
  lines.push(`Expires at: ${expiresAt}`);
  lines.push("Purpose: authorize a single funds-moving Policy Vault action. This signature is action-specific and single-use.");
  lines.push("Version: 1");
  return lines.join("\n");
}

export type LpDeployConsentStep =
  | "mint-agentic-id"
  | "enable-agent-key"
  | "tighten-policy"
  | "deposit-native"
  | "first-mint";

const LP_DEPLOY_STEP_ORDER: LpDeployConsentStep[] = [
  "mint-agentic-id",
  "enable-agent-key",
  "tighten-policy",
  "deposit-native",
  "first-mint",
];

export function buildLpDeployActionConsentMessage({
  address,
  chainId,
  networkId,
  vault,
  agentName,
  maxPositions,
  maxPerPosition0G,
  minAprPct,
  maxAprPct,
  depositNative0G,
  confirmedSteps,
  triggerFirstMint,
  nonce,
  expiresAt,
}: {
  address: string;
  chainId: number;
  networkId: OgNetworkId;
  vault: string;
  agentName: string;
  maxPositions: number;
  maxPerPosition0G: string;
  minAprPct: number;
  maxAprPct: number | null;
  depositNative0G: string;
  confirmedSteps: readonly LpDeployConsentStep[];
  triggerFirstMint: boolean;
  nonce: string;
  expiresAt: number;
}): string {
  return [
    "4lpha 0G LP deploy consent",
    `Wallet: ${address}`,
    `Network: ${networkId}`,
    `Chain ID: ${chainId}`,
    "Action: lp-agent-deploy",
    `Vault: ${vault}`,
    `Agent name: ${agentName.trim()}`,
    `Max positions: ${maxPositions}`,
    `Max 0G per position: ${maxPerPosition0G.trim()}`,
    `APR filter: ${minAprPct} to ${maxAprPct === null ? "none" : maxAprPct}`,
    `Deposit 0G: ${depositNative0G.trim() || "0"}`,
    `Confirmed steps: ${normalizeLpDeployConsentSteps(confirmedSteps).join(",")}`,
    `Trigger first mint: ${triggerFirstMint ? "true" : "false"}`,
    `Nonce: ${nonce}`,
    `Expires at: ${expiresAt}`,
    "Purpose: authorize one mainnet LP Agent provisioning intent. This signature is single-use.",
    "Version: 1",
  ].join("\n");
}

export function normalizeLpDeployConsentSteps(steps: readonly LpDeployConsentStep[]): LpDeployConsentStep[] {
  const selected = new Set(steps);
  return LP_DEPLOY_STEP_ORDER.filter((step) => selected.has(step));
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
