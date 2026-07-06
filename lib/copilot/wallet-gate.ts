import "server-only";

import { isAddress, isHex, verifyMessage, type Address, type Hex } from "viem";
import {
  buildCopilotActionConsentMessage,
  buildCopilotWalletAccessMessage,
  buildLpDeployActionConsentMessage,
  type CopilotWalletAccess,
  type LpDeployConsentStep,
} from "@/lib/copilot/wallet-access";
import type { OgNetworkId } from "@/lib/types";

export interface CopilotWalletGateError {
  code: string;
  message: string;
  status: number;
}

export interface CopilotActionConsentExpected {
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
}

export interface LpDeployActionConsentExpected {
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
}

/**
 * Validate an action-specific signed consent for funds-moving operations.
 * Verifies the wallet address is valid, the chain matches, the signature is
 * hex, the consent has not expired, the signed message matches the expected
 * action-specific payload, and the signature verifies against the wallet
 * address. Unlike the generic access gate, a captured consent signature is
 * bound to one action + target + nonce + expiry and cannot be replayed.
 */
export async function validateCopilotActionConsent(
  wallet: CopilotWalletAccess | undefined,
  networkId: OgNetworkId,
  expectedChainId: number,
  expected: CopilotActionConsentExpected,
): Promise<CopilotWalletGateError | undefined> {
  if (!wallet) {
    return { code: "wallet_required", message: "Connect a wallet before signing this action.", status: 401 };
  }
  if (!isAddress(wallet.address)) {
    return { code: "wallet_invalid", message: "Connected wallet address is not valid.", status: 400 };
  }
  if (wallet.chainId !== expectedChainId) {
    return { code: "wallet_wrong_network", message: "Switch wallet to the selected 0G network before signing.", status: 403 };
  }
  if (!isHex(wallet.signature)) {
    return { code: "wallet_signature_invalid", message: "Action consent signature is not valid.", status: 401 };
  }
  // Expiry is a unix-seconds deadline; reject if already past.
  if (!Number.isFinite(expected.expiresAt) || expected.expiresAt <= Math.floor(Date.now() / 1000)) {
    return { code: "consent_expired", message: "Action consent has expired; re-sign.", status: 401 };
  }
  if (!expected.nonce.trim()) {
    return { code: "consent_invalid", message: "Action consent nonce is required.", status: 400 };
  }
  const expectedMessage = buildCopilotActionConsentMessage({
    address: wallet.address,
    chainId: wallet.chainId,
    networkId,
    action: expected.action,
    vault: expected.vault,
    agentId: expected.agentId,
    poolAddress: expected.poolAddress,
    tokenId: expected.tokenId,
    tickLower: expected.tickLower,
    tickUpper: expected.tickUpper,
    amount0G: expected.amount0G,
    automationEnabled: expected.automationEnabled,
    nonce: expected.nonce,
    expiresAt: expected.expiresAt,
  });
  if (wallet.message !== expectedMessage) {
    return { code: "wallet_signature_invalid", message: "Action consent signature does not match the expected payload.", status: 401 };
  }
  const verified = await verifyMessage({
    address: wallet.address as Address,
    message: expectedMessage,
    signature: wallet.signature as Hex,
  }).catch(() => false);
  if (!verified) {
    return { code: "wallet_signature_invalid", message: "Action consent signature could not be verified.", status: 401 };
  }
  return undefined;
}

export async function validateLpDeployActionConsent(
  wallet: CopilotWalletAccess | undefined,
  networkId: OgNetworkId,
  expectedChainId: number,
  expected: LpDeployActionConsentExpected,
): Promise<CopilotWalletGateError | undefined> {
  const baseError = validateWalletEnvelope(wallet, expectedChainId);
  if (baseError) return baseError;
  if (!wallet) {
    return { code: "wallet_required", message: "Connect a wallet before signing this action.", status: 401 };
  }
  if (!Number.isFinite(expected.expiresAt) || expected.expiresAt <= Math.floor(Date.now() / 1000)) {
    return { code: "consent_expired", message: "Action consent has expired; re-sign.", status: 401 };
  }
  if (!expected.nonce.trim()) {
    return { code: "consent_invalid", message: "Action consent nonce is required.", status: 400 };
  }
  const expectedMessage = buildLpDeployActionConsentMessage({
    address: wallet.address,
    chainId: wallet.chainId,
    networkId,
    vault: expected.vault,
    agentName: expected.agentName,
    maxPositions: expected.maxPositions,
    maxPerPosition0G: expected.maxPerPosition0G,
    minAprPct: expected.minAprPct,
    maxAprPct: expected.maxAprPct,
    depositNative0G: expected.depositNative0G,
    confirmedSteps: expected.confirmedSteps,
    triggerFirstMint: expected.triggerFirstMint,
    nonce: expected.nonce,
    expiresAt: expected.expiresAt,
  });
  if (wallet.message !== expectedMessage) {
    return { code: "wallet_signature_invalid", message: "LP deploy consent signature does not match the expected payload.", status: 401 };
  }
  const verified = await verifyMessage({
    address: wallet.address as Address,
    message: expectedMessage,
    signature: wallet.signature as Hex,
  }).catch(() => false);
  if (!verified) {
    return {
      code: "wallet_signature_invalid",
      message: "LP deploy consent signature could not be verified.",
      status: 401,
    };
  }
  return undefined;
}

export async function validateCopilotWalletGate(
  wallet: CopilotWalletAccess | undefined,
  networkId: OgNetworkId,
  expectedChainId: number,
): Promise<CopilotWalletGateError | undefined> {
  if (!wallet) {
    return {
      code: "wallet_required",
      message: "Connect a wallet before using 0G Copilot chat.",
      status: 401,
    };
  }

  if (!isAddress(wallet.address)) {
    return {
      code: "wallet_invalid",
      message: "Connected wallet address is not valid.",
      status: 400,
    };
  }

  if (wallet.chainId !== expectedChainId) {
    return {
      code: "wallet_wrong_network",
      message: "Switch wallet to the selected 0G network before using Copilot chat.",
      status: 403,
    };
  }

  if (!isHex(wallet.signature)) {
    return {
      code: "wallet_signature_invalid",
      message: "Wallet access signature is not valid.",
      status: 401,
    };
  }

  const expectedMessage = buildCopilotWalletAccessMessage({
    address: wallet.address,
    chainId: wallet.chainId,
    networkId,
  });
  if (wallet.message !== expectedMessage) {
    return {
      code: "wallet_signature_invalid",
      message: "Wallet access signature does not match the selected 0G network.",
      status: 401,
    };
  }

  const verified = await verifyMessage({
    address: wallet.address as Address,
    message: expectedMessage,
    signature: wallet.signature as Hex,
  }).catch(() => false);

  if (!verified) {
    return {
      code: "wallet_signature_invalid",
      message: "Wallet access signature could not be verified.",
      status: 401,
    };
  }

  return undefined;
}

function validateWalletEnvelope(
  wallet: CopilotWalletAccess | undefined,
  expectedChainId: number,
): CopilotWalletGateError | undefined {
  if (!wallet) {
    return { code: "wallet_required", message: "Connect a wallet before signing this action.", status: 401 };
  }
  if (!isAddress(wallet.address)) {
    return { code: "wallet_invalid", message: "Connected wallet address is not valid.", status: 400 };
  }
  if (wallet.chainId !== expectedChainId) {
    return { code: "wallet_wrong_network", message: "Switch wallet to the selected 0G network before signing.", status: 403 };
  }
  if (!isHex(wallet.signature)) {
    return { code: "wallet_signature_invalid", message: "Wallet signature is not valid.", status: 401 };
  }
  return undefined;
}
