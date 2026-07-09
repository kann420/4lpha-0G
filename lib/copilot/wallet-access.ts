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
  | "fund-lp-entry-from-v4-swap"
  | "first-mint";

const LP_DEPLOY_STEP_ORDER: LpDeployConsentStep[] = [
  "mint-agentic-id",
  "enable-agent-key",
  "tighten-policy",
  "deposit-native",
  "fund-lp-entry-from-v4-swap",
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
  fundLpEntryFromSwap0G,
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
  fundLpEntryFromSwap0G: string;
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
    `Fund LP Entry from V4 Swap 0G: ${fundLpEntryFromSwap0G.trim() || "0"}`,
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

/// Consent message for the "redeploy + migrate to a new V3 vault" route. Binds the
/// OLD vault being abandoned + the cap preset (the new vault's policy) + a single-
/// use nonce + expiry. The NEW vault address is NOT in the message — it is
/// deployed server-side after the consent is verified, so it cannot be known at
/// sign time. A captured signature can only authorize "migrate from this oldVault
/// to a new vault with this cap preset", and the single-use nonce prevents replay.
export function buildVaultMigrateActionConsentMessage({
  address,
  chainId,
  networkId,
  oldVault,
  capPreset,
  nonce,
  expiresAt,
}: {
  address: string;
  chainId: number;
  networkId: OgNetworkId;
  oldVault: string;
  capPreset: string;
  nonce: string;
  expiresAt: number;
}): string {
  return [
    "4lpha 0G vault migrate consent",
    `Wallet: ${address}`,
    `Network: ${networkId}`,
    `Chain ID: ${chainId}`,
    "Action: vault-migrate",
    `Old vault: ${oldVault}`,
    `Cap preset: ${capPreset}`,
    `Nonce: ${nonce}`,
    `Expires at: ${expiresAt}`,
    "Purpose: authorize redeploying a new Policy Vault, moving all native 0G from the old vault, and re-pointing all agents. This signature is single-use.",
    "Version: 1",
  ].join("\n");
}

export type VaultMigrateV4ConsentPhase = "review" | "execute";

export interface VaultMigrateV4ConsentTrio {
  v4LpEntryAddress: string;
  v4LpExitAddress: string;
  v4SwapAddress: string;
}

const VAULT_MIGRATE_V4_STEP_ORDER = ["migrate-v4-review", "migrate-v4-execute"] as const;

export function buildVaultMigrateV4ActionConsentMessage({
  address,
  chainId,
  networkId,
  phase,
  oldVault,
  confirmedSteps,
  inventoryHash,
  perNftDecisionsHash,
  v4LpEntryAddress,
  v4LpExitAddress,
  v4SwapAddress,
  nonce,
  expiresAt,
}: {
  address: string;
  chainId: number;
  networkId: OgNetworkId;
  phase: VaultMigrateV4ConsentPhase;
  oldVault: string;
  confirmedSteps?: readonly string[];
  inventoryHash?: string;
  perNftDecisionsHash?: string;
  v4LpEntryAddress?: string;
  v4LpExitAddress?: string;
  v4SwapAddress?: string;
  nonce: string;
  expiresAt: number;
}): string {
  const lines = [
    "4lpha 0G vault migrate consent",
    `Wallet: ${address}`,
    `Network: ${networkId}`,
    `Chain ID: ${chainId}`,
    "Action: vault-migrate-v4",
    `Phase: ${phase}`,
    `Old vault: ${oldVault}`,
  ];
  if (phase === "execute") {
    if (!inventoryHash || !perNftDecisionsHash || !v4SwapAddress || !v4LpEntryAddress || !v4LpExitAddress) {
      throw new Error("V4 migrate execute consent requires inventoryHash, perNftDecisionsHash, and all V4 trio addresses.");
    }
    lines.push(`Confirmed steps: ${normalizeVaultMigrateV4ConsentSteps(confirmedSteps ?? []).join(",")}`);
    lines.push(`Inventory hash: ${inventoryHash}`);
    lines.push(`Per-NFT decisions hash: ${perNftDecisionsHash}`);
    lines.push(`V4 swap: ${v4SwapAddress}`);
    lines.push(`V4 LP entry: ${v4LpEntryAddress}`);
    lines.push(`V4 LP exit: ${v4LpExitAddress}`);
  }
  lines.push(`Nonce: ${nonce}`);
  lines.push(`Expires at: ${expiresAt}`);
  lines.push(
    phase === "execute"
      ? "Purpose: authorize the reviewed preserve-only V4 migration execution for this old vault and exact V4 trio. This signature is single-use."
      : "Purpose: authorize a V4 migration inventory review for this old vault. This signature is single-use.",
  );
  lines.push("Version: 1");
  return lines.join("\n");
}

export function buildVaultMigrateV4FinalizeConsentMessage({
  address,
  chainId,
  networkId,
  sourceVault,
  sourceVersion,
  planHash,
  inventoryHash,
  v4LpEntryAddress,
  v4LpExitAddress,
  v4SwapAddress,
  nonce,
  expiresAt,
}: {
  address: string;
  chainId: number;
  networkId: OgNetworkId;
  sourceVault: string;
  sourceVersion: number;
  planHash: string;
  inventoryHash?: string | null;
  v4SwapAddress: string;
  v4LpEntryAddress: string;
  v4LpExitAddress: string;
  nonce: string;
  expiresAt: number;
}): string {
  return [
    "4lpha 0G vault migrate consent",
    `Wallet: ${address}`,
    `Network: ${networkId}`,
    `Chain ID: ${chainId}`,
    "Action: vault-migrate-v4-finalize",
    `Source vault: ${sourceVault}`,
    `Source version: ${sourceVersion}`,
    `Plan hash: ${planHash}`,
    `Inventory hash: ${inventoryHash ?? "none"}`,
    `V4 swap: ${v4SwapAddress}`,
    `V4 LP entry: ${v4LpEntryAddress}`,
    `V4 LP exit: ${v4LpExitAddress}`,
    `Nonce: ${nonce}`,
    `Expires at: ${expiresAt}`,
    "Purpose: verify the completed wallet-owned V4 migration and activate the V4 vault trio for this owner. This signature is single-use.",
    "Version: 1",
  ].join("\n");
}

export function normalizeVaultMigrateV4ConsentSteps(steps: readonly string[]): string[] {
  const selected = new Set(steps.map((step) => step.trim()).filter(Boolean));
  const ordered = VAULT_MIGRATE_V4_STEP_ORDER.filter((step) => selected.has(step));
  const extras = Array.from(selected)
    .filter((step) => !(VAULT_MIGRATE_V4_STEP_ORDER as readonly string[]).includes(step))
    .sort();
  return [...ordered, ...extras];
}

/// Consent message for the "apply runtime policy to an EXISTING LP agent" route.
/// Binds the runtime fields (maxPositions + maxPerPosition0G) plus the APR band,
/// agentId, vault, nonce, and expiry, so a captured signature cannot be replayed
/// to update a different agent or policy. Mirrors buildLpDeployActionConsentMessage
/// but with the policy fields + agentId and without deploy-only steps/deposit/
/// first-mint.
export function buildLpPolicyActionConsentMessage({
  address,
  chainId,
  networkId,
  vault,
  agentId,
  maxPositions,
  maxPerPosition0G,
  minAprPct,
  maxAprPct,
  nonce,
  expiresAt,
}: {
  address: string;
  chainId: number;
  networkId: OgNetworkId;
  vault: string;
  agentId: string;
  maxPositions: number;
  maxPerPosition0G: string;
  minAprPct: number;
  maxAprPct: number | null;
  nonce: string;
  expiresAt: number;
}): string {
  return [
    "4lpha 0G LP runtime policy update consent",
    `Wallet: ${address}`,
    `Network: ${networkId}`,
    `Chain ID: ${chainId}`,
    "Action: lp-policy",
    `Vault: ${vault}`,
    `Agent: ${agentId}`,
    `Max positions: ${maxPositions}`,
    `Max 0G per position: ${maxPerPosition0G.trim()}`,
    `APR filter: ${minAprPct} to ${maxAprPct === null ? "none" : maxAprPct}`,
    `Nonce: ${nonce}`,
    `Expires at: ${expiresAt}`,
    "Purpose: authorize one mainnet LP runtime policy update. This signature is single-use.",
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
