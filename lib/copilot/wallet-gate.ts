import "server-only";

import { isAddress, isHex, verifyMessage, type Address, type Hex } from "viem";
import { buildCopilotWalletAccessMessage, type CopilotWalletAccess } from "@/lib/copilot/wallet-access";
import type { OgNetworkId } from "@/lib/types";

export interface CopilotWalletGateError {
  code: string;
  message: string;
  status: number;
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
