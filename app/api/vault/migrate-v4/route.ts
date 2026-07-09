import { NextResponse } from "next/server";
import {
  createPublicClient,
  getAddress,
  http,
  isAddress,
  verifyMessage,
  type Address,
  type Chain,
  type Hex,
} from "viem";
import { z } from "zod";

import { OgAgentDeployError } from "@/lib/agent/agent-deploy-common";
import { readMainnetOwnerAddress } from "@/lib/agent/mainnet-vault-resolver";
import { finalizeWalletOwnedV4Migration } from "@/lib/agent/vault-migrate-v4";
import type { V4VaultTrio } from "@/lib/agent/vault-migrate-v4-shared";
import { consumeActionNonce } from "@/lib/copilot/action-nonce-store";
import { buildVaultMigrateV4FinalizeConsentMessage } from "@/lib/copilot/wallet-access";
import { getOgNetwork } from "@/lib/og/networks";

export const runtime = "nodejs";

const MAINNET_CHAIN_ID = 16661;
const addressSchema = z.string().trim().refine((value) => isAddress(value), "invalid address");
const hex32Schema = z.string().trim().regex(/^0x[a-fA-F0-9]{64}$/u);

const requestSchema = z.object({
  wallet: z.object({
    address: z.string().trim().min(1).max(80),
    chainId: z.number().int().positive(),
    message: z.string().trim().min(1).max(3_000),
    signature: z.string().trim().min(1).max(200),
  }),
  nonce: z.string().trim().min(8).max(64),
  expiresAt: z.number().int().positive(),
  sourceVault: addressSchema,
  sourceVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  planHash: hex32Schema,
  inventoryHash: hex32Schema.optional(),
  v4Trio: z.object({
    swap: addressSchema,
    lpEntry: addressSchema,
    lpExit: addressSchema,
  }),
});

export async function POST(request: Request) {
  const parsed = requestSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return migrateError("invalid_request", "Vault migrate-v4 finalize request was not valid.", 400);
  }
  if (parsed.data.wallet.chainId !== MAINNET_CHAIN_ID) {
    return migrateError("mainnet_required", `Migrate to V4 requires 0G mainnet (${MAINNET_CHAIN_ID}).`, 409);
  }
  const ownerAddress = readMainnetOwnerAddress(parsed.data.wallet.address);
  if (!ownerAddress) {
    return migrateError("invalid_wallet", "Connected wallet address is not valid.", 400);
  }

  const network = getOgNetwork("mainnet");
  const v4Trio = normalizeRouteTrio(parsed.data.v4Trio);
  const expectedMessage = buildVaultMigrateV4FinalizeConsentMessage({
    address: parsed.data.wallet.address,
    chainId: network.chainId,
    networkId: network.id,
    sourceVault: getAddress(parsed.data.sourceVault),
    sourceVersion: parsed.data.sourceVersion,
    planHash: parsed.data.planHash,
    inventoryHash: parsed.data.inventoryHash ?? null,
    v4SwapAddress: v4Trio.swapVault,
    v4LpEntryAddress: v4Trio.lpEntryVault,
    v4LpExitAddress: v4Trio.lpExitVault,
    nonce: parsed.data.nonce,
    expiresAt: parsed.data.expiresAt,
  });
  if (parsed.data.wallet.message !== expectedMessage) {
    return migrateError("wallet_signature_invalid", "Vault migrate-v4 finalize signature does not match the expected payload.", 401);
  }
  if (parsed.data.expiresAt <= Math.floor(Date.now() / 1000)) {
    return migrateError("consent_expired", "Action consent has expired; re-sign.", 401);
  }
  const verified = await verifyMessage({
    address: ownerAddress,
    message: expectedMessage,
    signature: parsed.data.wallet.signature as Hex,
  }).catch(() => false);
  if (!verified) {
    return migrateError("wallet_signature_invalid", "Vault migrate-v4 finalize signature could not be verified.", 401);
  }

  const nonceError = consumeActionNonce({
    address: parsed.data.wallet.address,
    expiresAt: parsed.data.expiresAt,
    nonce: parsed.data.nonce,
    scope: "vault-migrate-v4",
  });
  if (nonceError) {
    return migrateError(nonceError.code, nonceError.message, nonceError.status);
  }

  try {
    const rpcUrl = process.env.OG_RPC_URL?.trim() || network.rpcUrl;
    const publicClient = createPublicClient({ chain: make0GMainnetChain(rpcUrl), transport: http(rpcUrl) });
    const result = await finalizeWalletOwnedV4Migration({
      inventoryHash: parsed.data.inventoryHash as Hex | undefined,
      owner: ownerAddress,
      sourceVault: getAddress(parsed.data.sourceVault),
      sourceVersion: parsed.data.sourceVersion,
      v4Trio,
    }, { publicClient });
    return NextResponse.json({ data: result, meta: { network: "mainnet", chainId: network.chainId, restartRequired: false } }, { status: 200 });
  } catch (error) {
    if (error instanceof OgAgentDeployError) {
      return migrateError(error.code, error.message, error.status);
    }
    return migrateError("migration_failed", error instanceof Error ? error.message : "Unable to finalize V4 migration.", 500);
  }
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

function normalizeRouteTrio(input: z.infer<typeof requestSchema>["v4Trio"]): V4VaultTrio {
  return {
    swapVault: getAddress(input.swap),
    lpEntryVault: getAddress(input.lpEntry),
    lpExitVault: getAddress(input.lpExit),
  };
}

function migrateError(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message } }, { status });
}

function make0GMainnetChain(rpcUrl: string): Chain {
  return {
    id: MAINNET_CHAIN_ID,
    name: "0G Mainnet",
    nativeCurrency: { decimals: 18, name: "0G", symbol: "0G" },
    rpcUrls: { default: { http: [rpcUrl] } },
  };
}
