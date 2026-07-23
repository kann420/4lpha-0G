import "server-only";

import { isAddress, verifyMessage, type Address, type Hex } from "viem";

import { GALILEO_CHAIN_ID, GALILEO_NETWORK_ID, assertGalileoRoute } from "@/lib/galileo/config";
import {
  consumeGalileoPrepare,
  issueGalileoPrepare,
  readGalileoPrepare,
  type GalileoConsentAction,
  type GalileoLedgerOptions,
  type GalileoPreparedConfig,
  type GalileoPreparedTrade,
  GalileoLedgerError,
} from "@/lib/galileo/ledger";

export interface GalileoWalletConsent {
  address: string;
  chainId: number;
  message: string;
  signature: string;
}

export function issueGalileoConsent(input: {
  action: GalileoConsentAction;
  config?: GalileoPreparedConfig;
  owner: Address;
  trade?: GalileoPreparedTrade;
}, options?: GalileoLedgerOptions) {
  return issueGalileoPrepare(input, options);
}

export function buildGalileoConsentMessage(input: {
  action: GalileoConsentAction;
  agentRef?: string;
  configDigest?: Hex;
  expiresAt: number;
  nonce: string;
  owner: Address;
  trade?: GalileoPreparedTrade;
  vault?: Address;
}): string {
  const lines = [
    "4lpha 0G Galileo action consent",
    `Wallet: ${input.owner.toLowerCase()}`,
    `Network: ${GALILEO_NETWORK_ID}`,
    `Chain ID: ${GALILEO_CHAIN_ID}`,
    `Action: ${input.action}`,
    `Vault: ${(input.trade?.vault ?? input.vault)?.toLowerCase() ?? "none"}`,
    `Agent reference: ${input.agentRef ?? "none"}`,
  ];
  if (input.action === "trade") {
    if (!input.trade) throw new GalileoLedgerError("consent_invalid", "Galileo trade consent is missing its normalized tuple.", 400);
    lines.push(
      `Agent key: ${input.trade.agentKey.toLowerCase()}`,
      `Adapter: ${input.trade.adapter.toLowerCase()}`,
      `Pool ID: ${input.trade.poolId.toLowerCase()}`,
      `Policy hash: ${input.trade.policyHash.toLowerCase()}`,
      `Side: ${input.trade.side}`,
      `Amount in: ${input.trade.amountIn}`,
      `Trusted quote: ${input.trade.trustedQuote}`,
      `Minimum out: ${input.trade.minOut}`,
      `Quote block: ${input.trade.quoteBlock}`,
      `Quote expiry: ${input.trade.quoteExpiry}`,
      `Native reserve: ${input.trade.reserveNative}`,
      `Token reserve: ${input.trade.reserveToken}`,
      `Request ID: ${input.trade.clientRequestId}`,
      `Payload digest: ${input.trade.payloadDigest.toLowerCase()}`,
    );
  } else {
    lines.push(`Configuration digest: ${input.configDigest ?? "none"}`);
  }
  lines.push(
    `Nonce: ${input.nonce}`,
    `Expires at: ${input.expiresAt}`,
    "Purpose: authorize one Galileo testnet agent action. This signature is single-use.",
    "Version: 1",
  );
  return lines.join("\n");
}

export async function verifyAndConsumeGalileoConsent(input: {
  action: GalileoConsentAction;
  nonce: string;
  prepareId: string;
  wallet: GalileoWalletConsent;
}, options?: GalileoLedgerOptions) {
  const record = await verifyGalileoConsent(input, options);
  return consumeGalileoPrepare({ action: input.action, nonce: input.nonce, owner: record.owner, prepareId: input.prepareId }, options);
}

/** Signature validation without state mutation; callers that also claim an
 * idempotency key must perform the consume inside their ledger transaction. */
export async function verifyGalileoConsent(input: {
  action: GalileoConsentAction;
  nonce: string;
  prepareId: string;
  wallet: GalileoWalletConsent;
}, options?: GalileoLedgerOptions) {
  const record = readGalileoPrepare(input.prepareId, options);
  if (!record || record.action !== input.action || !isAddress(input.wallet.address, { strict: true }) || input.wallet.address.toLowerCase() !== record.owner) {
    throw new GalileoLedgerError("consent_invalid", "Galileo action consent is invalid.", 401);
  }
  if (input.wallet.chainId !== GALILEO_CHAIN_ID || record.expiresAt <= Math.floor(Date.now() / 1000)) {
    throw new GalileoLedgerError("consent_expired", "Galileo action consent has expired or is on the wrong network.", 401);
  }
  const expectedMessage = buildGalileoConsentMessage({
    action: record.action,
    agentRef: record.agentRef,
    configDigest: record.configDigest,
    expiresAt: record.expiresAt,
    nonce: input.nonce,
    owner: record.owner,
    trade: record.trade,
    vault: record.config?.vault,
  });
  if (input.wallet.message !== expectedMessage || !/^0x[0-9a-f]+$/iu.test(input.wallet.signature)) {
    throw new GalileoLedgerError("wallet_signature_invalid", "Galileo action signature does not match the prepared action.", 401);
  }
  const valid = await verifyMessage({
    address: record.owner,
    message: expectedMessage,
    signature: input.wallet.signature as Hex,
  }).catch(() => false);
  if (!valid) throw new GalileoLedgerError("wallet_signature_invalid", "Galileo action signature could not be verified.", 401);
  return record;
}

/** Validate before any config, signer, Storage, ProofRegistry, or executor work. */
export function assertGalileoRequestBoundary(request: Request, input: { chainId: unknown; networkId: unknown }, env: Readonly<Record<string, string | undefined>> = process.env): void {
  assertGalileoRoute(input.networkId, input.chainId);
  const configured = env.NEXT_PUBLIC_APP_URL?.trim();
  if (!configured) throw new GalileoLedgerError("origin_unconfigured", "Galileo requests are unavailable.", 503);
  let expectedOrigin: string;
  try {
    expectedOrigin = new URL(configured).origin;
  } catch {
    throw new GalileoLedgerError("origin_unconfigured", "Galileo requests are unavailable.", 503);
  }
  if (request.headers.get("origin") !== expectedOrigin) {
    throw new GalileoLedgerError("origin_invalid", "Galileo requests must originate from the configured app origin.", 403);
  }
}
