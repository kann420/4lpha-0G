import "server-only";

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, fsyncSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";

import { isAddress, keccak256, stringToHex, type Address, type Hex } from "viem";

import { GALILEO_CHAIN_ID, GALILEO_NETWORK_ID } from "@/lib/galileo/config";
import { canonicalJson, sha256Hex } from "@/lib/galileo/metadata";

export const GALILEO_CONSENT_TTL_SECONDS = 5 * 60;

export type GalileoConsentAction = "deploy" | "trade" | "workspace-read";

export interface GalileoPreparedConfig {
  clientRequestId?: string;
  filters: string[];
  name: string;
  owner: Address;
  runtime?: {
    maxHoldingMinutes?: number;
    maxPositions?: number;
    maxTrade0G?: string;
    slippageBps?: number;
  };
  vault?: Address;
}

/** The only user-controlled trade fields retained for consent binding. */
export interface GalileoPreparedTrade {
  adapter: Address;
  agentKey: Hex;
  agentRef: string;
  amountIn: string;
  chainId: typeof GALILEO_CHAIN_ID;
  clientRequestId: string;
  minOut: string;
  networkId: typeof GALILEO_NETWORK_ID;
  payloadDigest: Hex;
  poolId: Hex;
  policyHash: Hex;
  quoteBlock: string;
  quoteExpiry: number;
  reserveNative: string;
  reserveToken: string;
  side: "buy" | "sell";
  trustedQuote: string;
  vault: Address;
}

export interface GalileoPrepareRecord {
  action: GalileoConsentAction;
  agentKey?: Hex;
  agentRef?: string;
  config?: GalileoPreparedConfig;
  configDigest?: Hex;
  consumedAt?: string;
  createdAt: string;
  expiresAt: number;
  nonceHash: Hex;
  owner: Address;
  prepareId: string;
  trade?: GalileoPreparedTrade;
}

export interface GalileoPrepareIssue {
  agentKey?: Hex;
  agentRef?: string;
  configDigest?: Hex;
  expiresAt: number;
  nonce: string;
  prepareId: string;
  /** Server-normalized, non-secret trade fields for the wallet consent text. */
  trade?: GalileoPreparedTrade;
}

export interface GalileoLocalAgentRecord {
  agentKey: Hex;
  agentRef: string;
  chainId: typeof GALILEO_CHAIN_ID;
  createdAt: string;
  owner: Address;
  storageRef: string;
  storageRoot: Hex;
  storageVerified: true;
  vault: Address;
  adapter?: Address;
  executor?: Address;
  modelMetadata?: { algorithm: "sha256"; digest: Hex; provider: string };
  proofRegistry?: Address;
  storageTxHash?: Hex;
  storageTxSeq?: number;
}

export type GalileoTradeState = "claimed" | "storage_verified" | "proof_submitted" | "proof_accepted" | "trade_submitted" | "confirmed" | "failed" | "blocked" | "recovery_required";
export interface GalileoTradeRecord {
  actionHash?: Hex;
  agentRef: string;
  auditRoot?: Hex;
  clientRequestId: string;
  createdAt: string;
  owner: Address;
  payloadDigest: Hex;
  proofTxHash?: Hex;
  signerNonce?: string;
  state: GalileoTradeState;
  storageRef?: string;
  storageRoot?: Hex;
  tradeTxHash?: Hex;
  updatedAt: string;
}
export interface GalileoDeploymentRecord {
  clientRequestId: string;
  createdAt: string;
  owner: Address;
  payloadDigest: Hex;
  state: "claimed" | "verified" | "blocked";
  updatedAt: string;
}

interface GalileoLedger {
  deployments: GalileoDeploymentRecord[];
  prepares: GalileoPrepareRecord[];
  trades: GalileoTradeRecord[];
  version: 2;
}

export interface GalileoLedgerOptions {
  rootDir?: string;
}

const DEFAULT_ROOT = join(".data", "trades", "galileo");
const TERMINAL_TRADE_RETENTION_HOURS = 48;
const TERMINAL_TRADE_RETENTION_MS = TERMINAL_TRADE_RETENTION_HOURS * 60 * 60 * 1_000;
const TERMINAL_TRADE_MIN_COUNT = 200;
const TERMINAL_TRADE_STATES = new Set<GalileoTradeState>(["confirmed", "failed", "blocked"]);

export function issueGalileoPrepare(input: {
  action: GalileoConsentAction;
  config?: GalileoPreparedConfig;
  owner: Address;
  trade?: GalileoPreparedTrade;
  ttlSeconds?: number;
}, options?: GalileoLedgerOptions): GalileoPrepareIssue {
  const owner = normalizeAddress(input.owner, "owner");
  const now = Math.floor(Date.now() / 1000);
  const ttl = Math.max(1, Math.min(input.ttlSeconds ?? GALILEO_CONSENT_TTL_SECONDS, GALILEO_CONSENT_TTL_SECONDS));
  const nonce = randomBytes(32).toString("hex");
  const prepareId = randomUUID();
  const config = input.action === "deploy" ? normalizeConfig(input.config, owner) : undefined;
  const trade = input.action === "trade" ? normalizeTrade(input.trade, owner) : undefined;
  const agentRef = config ? `galileo-${randomUUID()}` : trade?.agentRef;
  const agentKey = config ? deriveGalileoAgentKey(agentRef!) : trade?.agentKey;
  const configDigest = config ? configurationDigest(config, agentRef!, agentKey!) : trade?.payloadDigest;
  const record: GalileoPrepareRecord = {
    action: input.action,
    agentKey,
    agentRef,
    config,
    configDigest,
    createdAt: new Date().toISOString(),
    expiresAt: now + ttl,
    nonceHash: hashNonce(nonce),
    owner,
    prepareId,
    trade,
  };
  withLedger(options, (ledger) => {
    ledger.prepares = prune(ledger.prepares, now);
    ledger.prepares.push(record);
  });
  return { agentKey, agentRef, configDigest, expiresAt: record.expiresAt, nonce, prepareId, trade };
}

/** Claim deployment idempotency and consume its signed consent in one lock. */
export function claimDeployAndConsume(input: { nonce: string; owner: Address; prepareId: string }, options?: GalileoLedgerOptions): { prepare: GalileoPrepareRecord; deployment: GalileoDeploymentRecord; replay: boolean } {
  const owner = normalizeAddress(input.owner, "owner");
  return withLedger(options, (ledger) => {
    // Locate the prepared action first so an exact retry can return its durable
    // idempotency record even when its one-time consent was already consumed.
    // Claim/consume still happens under this one lock and snapshot write.
    const prepare = preparedForLedger(ledger, { action: "deploy", ...input, owner });
    const clientRequestId = prepare.config?.clientRequestId;
    if (!clientRequestId || !prepare.configDigest) throw new GalileoLedgerError("consent_invalid", "Galileo deploy consent is incomplete.", 401);
    const previous = ledger.deployments.find((entry) => entry.owner === owner && entry.clientRequestId === clientRequestId);
    if (previous) {
      if (previous.payloadDigest !== prepare.configDigest) throw new GalileoLedgerError("idempotency_conflict", "This request ID has different Galileo deployment data.", 409);
      if (!prepare.consumedAt) consumePreparedInLedger(ledger, { action: "deploy", ...input, owner });
      return { prepare, deployment: previous, replay: true };
    }
    if (prepare.consumedAt) throw new GalileoLedgerError("consent_replayed", "This Galileo consent is invalid, expired, or already used.", 401);
    consumePreparedInLedger(ledger, { action: "deploy", ...input, owner });
    const now = new Date().toISOString();
    const deployment = { clientRequestId, createdAt: now, owner, payloadDigest: prepare.configDigest, state: "claimed" as const, updatedAt: now };
    ledger.deployments.push(deployment);
    return { prepare, deployment, replay: false };
  });
}

export function markGalileoDeployment(input: { clientRequestId: string; owner: Address; state: "verified" | "blocked" }, options?: GalileoLedgerOptions): GalileoDeploymentRecord {
  const owner = normalizeAddress(input.owner, "owner");
  return withLedger(options, (ledger) => {
    const record = ledger.deployments.find((entry) => entry.owner === owner && entry.clientRequestId === input.clientRequestId);
    if (!record || record.state !== "claimed") throw new GalileoLedgerError("deployment_state_invalid", "Galileo deployment checkpoint is unavailable.", 409);
    record.state = input.state; record.updatedAt = new Date().toISOString(); return record;
  });
}

export function claimGalileoTrade(input: { agentRef: string; clientRequestId: string; owner: Address; payloadDigest: Hex }, options?: GalileoLedgerOptions): { record: GalileoTradeRecord; replay: boolean } {
  const owner = normalizeAddress(input.owner, "owner");
  return withLedger(options, (ledger) => {
    const existing = ledger.trades.find((entry) => entry.owner === owner && entry.agentRef === input.agentRef && entry.clientRequestId === input.clientRequestId);
    if (existing) {
      if (existing.payloadDigest !== input.payloadDigest) throw new GalileoLedgerError("idempotency_conflict", "This request ID has different Galileo trade data.", 409);
      return { record: existing, replay: true };
    }
    const now = new Date().toISOString();
    const record: GalileoTradeRecord = { ...input, createdAt: now, state: "claimed", updatedAt: now };
    ledger.trades.push(record); return { record, replay: false };
  });
}

/**
 * Claim the Galileo trade idempotency key and consume the already signature-
 * verified prepared consent in one ledger transaction. The exact same signed
 * request returns the durable record after a crash/retry; a changed payload is
 * always a conflict. Call only after verifyGalileoConsent succeeds.
 */
export function claimTradeAndConsume(input: { nonce: string; owner: Address; prepareId: string }, options?: GalileoLedgerOptions): { prepare: GalileoPrepareRecord; record: GalileoTradeRecord; replay: boolean } {
  const owner = normalizeAddress(input.owner, "owner");
  return withLedger(options, (ledger) => {
    const prepare = preparedForLedger(ledger, { action: "trade", ...input, owner });
    const trade = prepare.trade;
    if (!trade || !prepare.configDigest) throw new GalileoLedgerError("consent_invalid", "Galileo trade consent is incomplete.", 401);
    const existing = ledger.trades.find((entry) => entry.owner === owner && entry.agentRef === trade.agentRef && entry.clientRequestId === trade.clientRequestId);
    if (existing) {
      if (existing.payloadDigest !== trade.payloadDigest) throw new GalileoLedgerError("idempotency_conflict", "This request ID has different Galileo trade data.", 409);
      if (!prepare.consumedAt) consumePreparedInLedger(ledger, { action: "trade", ...input, owner });
      return { prepare, record: existing, replay: true };
    }
    if (prepare.consumedAt) throw new GalileoLedgerError("consent_replayed", "This Galileo consent is invalid, expired, or already used.", 401);
    consumePreparedInLedger(ledger, { action: "trade", ...input, owner });
    const now = new Date().toISOString();
    const record: GalileoTradeRecord = {
      agentRef: trade.agentRef,
      clientRequestId: trade.clientRequestId,
      createdAt: now,
      owner,
      payloadDigest: trade.payloadDigest,
      state: "claimed",
      updatedAt: now,
    };
    ledger.trades.push(record);
    return { prepare, record, replay: false };
  });
}

const TRADE_TRANSITIONS: Record<GalileoTradeState, GalileoTradeState[]> = {
  claimed: ["storage_verified", "blocked", "failed", "recovery_required"], storage_verified: ["proof_submitted", "blocked", "failed", "recovery_required"], proof_submitted: ["proof_accepted", "failed", "recovery_required"], proof_accepted: ["trade_submitted", "failed", "recovery_required"], trade_submitted: ["confirmed", "failed", "recovery_required"], confirmed: [], failed: [], blocked: [], recovery_required: [],
};
export function advanceGalileoTrade(input: { actionHash?: Hex; agentRef: string; clientRequestId: string; owner: Address; state: Exclude<GalileoTradeState, "claimed">; patch?: Partial<Omit<GalileoTradeRecord, "agentRef" | "clientRequestId" | "owner" | "payloadDigest" | "state" | "createdAt" | "updatedAt">> }, options?: GalileoLedgerOptions): GalileoTradeRecord {
  const owner = normalizeAddress(input.owner, "owner");
  return withLedger(options, (ledger) => {
    const record = ledger.trades.find((entry) => entry.owner === owner && entry.agentRef === input.agentRef && entry.clientRequestId === input.clientRequestId);
    if (!record || !TRADE_TRANSITIONS[record.state].includes(input.state)) throw new GalileoLedgerError("trade_state_invalid", "Galileo trade checkpoint is unavailable.", 409);
    Object.assign(record, input.patch ?? {}, input.actionHash ? { actionHash: input.actionHash } : {}, { state: input.state, updatedAt: new Date().toISOString() });
    return record;
  });
}

/** States a crashed trade can be authoritatively reconciled from (all non-terminal). */
const RECONCILABLE_STATES: GalileoTradeState[] = ["claimed", "storage_verified", "proof_submitted", "proof_accepted", "trade_submitted", "recovery_required"];

/** Patch record fields WITHOUT a state transition — e.g. record a proof/trade tx hash
 *  immediately after broadcast so a crash keeps the on-chain handle for recovery. */
export function patchGalileoTrade(input: { agentRef: string; clientRequestId: string; owner: Address; patch: Partial<Omit<GalileoTradeRecord, "agentRef" | "clientRequestId" | "owner" | "payloadDigest" | "state" | "createdAt" | "updatedAt">> }, options?: GalileoLedgerOptions): GalileoTradeRecord {
  const owner = normalizeAddress(input.owner, "owner");
  return withLedger(options, (ledger) => {
    const record = ledger.trades.find((entry) => entry.owner === owner && entry.agentRef === input.agentRef && entry.clientRequestId === input.clientRequestId);
    if (!record) throw new GalileoLedgerError("trade_state_invalid", "Galileo trade record is unavailable.", 409);
    Object.assign(record, input.patch, { updatedAt: new Date().toISOString() });
    return record;
  });
}

/** Authoritative reconciliation write: settle a non-terminal record to its true terminal
 *  state after reading the chain. Deliberately bypasses the incremental transition table. */
export function settleGalileoTrade(input: { agentRef: string; clientRequestId: string; owner: Address; state: "confirmed" | "failed"; patch?: Partial<Omit<GalileoTradeRecord, "agentRef" | "clientRequestId" | "owner" | "payloadDigest" | "state" | "createdAt" | "updatedAt">> }, options?: GalileoLedgerOptions): GalileoTradeRecord {
  const owner = normalizeAddress(input.owner, "owner");
  return withLedger(options, (ledger) => {
    const record = ledger.trades.find((entry) => entry.owner === owner && entry.agentRef === input.agentRef && entry.clientRequestId === input.clientRequestId);
    if (!record || !RECONCILABLE_STATES.includes(record.state)) throw new GalileoLedgerError("trade_state_invalid", "Galileo trade cannot be reconciled from its current state.", 409);
    Object.assign(record, input.patch ?? {}, { state: input.state, updatedAt: new Date().toISOString() });
    return record;
  });
}

export function readGalileoTrade(input: { agentRef: string; clientRequestId: string; owner: Address }, options?: GalileoLedgerOptions): GalileoTradeRecord | undefined {
  const owner = normalizeAddress(input.owner, "owner");
  return readLedger(options).trades.find((entry) => entry.owner === owner && entry.agentRef === input.agentRef && entry.clientRequestId === input.clientRequestId);
}

/** All non-terminal trades — the input to a startup/CLI crash-recovery sweep. */
export function listReconcilableGalileoTrades(options?: GalileoLedgerOptions): GalileoTradeRecord[] {
  return readLedger(options).trades.filter((entry) => RECONCILABLE_STATES.includes(entry.state));
}

interface GalileoRateStore { global: number[]; ips: Record<string, number[]>; wallets: Record<string, number[]>; version: 1 }
export interface GalileoRateLimits { windowMs?: number; walletMax?: number; ipMax?: number; globalMax?: number; now?: number }

/**
 * Durable sliding-window rate limiter (shared across processes/instances), replacing the
 * former per-process in-memory counters. Uses the same mkdir file-lock + atomic snapshot as
 * the ledger. Prunes every bucket by window on write so the store stays bounded to
 * active-in-window callers.
 */
export function recordGalileoRateHit(input: { owner: Address; ip: string } & GalileoRateLimits, options?: GalileoLedgerOptions): { allowed: boolean; reason?: "wallet" | "ip" | "global" } {
  const owner = normalizeAddress(input.owner, "owner");
  const ip = input.ip;
  const now = input.now ?? Date.now();
  const windowMs = input.windowMs ?? 60_000;
  const walletMax = input.walletMax ?? 5;
  const ipMax = input.ipMax ?? 20;
  const globalMax = input.globalMax ?? 50;
  const root = resolveRoot(options);
  return withFileLock(join(root, "rate-limit.lock"), () => {
    const path = join(root, "rate-limit.json");
    const store = readJson<Partial<GalileoRateStore>>(path, {});
    const prune = (values?: number[]) => (values ?? []).filter((value) => now - value < windowMs);
    const global = prune(store.global);
    const wallet = prune(store.wallets?.[owner]);
    const ips = prune(store.ips?.[ip]);
    if (wallet.length >= walletMax) return { allowed: false, reason: "wallet" as const };
    if (ips.length >= ipMax) return { allowed: false, reason: "ip" as const };
    if (global.length >= globalMax) return { allowed: false, reason: "global" as const };
    wallet.push(now); ips.push(now); global.push(now);
    const pruneMap = (map: Record<string, number[]> | undefined, extra: Record<string, number[]>) => {
      const merged: Record<string, number[]> = { ...(map ?? {}), ...extra };
      return Object.fromEntries(Object.entries(merged).map(([key, value]) => [key, prune(value)]).filter(([, value]) => (value as number[]).length > 0));
    };
    writeAtomicJson(path, { global, ips: pruneMap(store.ips, { [ip]: ips }), wallets: pruneMap(store.wallets, { [owner]: wallet }), version: 1 } satisfies GalileoRateStore);
    return { allowed: true };
  });
}

export function readGalileoPrepare(prepareId: string, options?: GalileoLedgerOptions): GalileoPrepareRecord | undefined {
  return readLedger(options).prepares.find((record) => record.prepareId === prepareId);
}

/** Atomically consumes a one-time consent after the caller has verified its wallet signature. */
export function consumeGalileoPrepare(input: {
  action: GalileoConsentAction;
  nonce: string;
  owner: Address;
  prepareId: string;
}, options?: GalileoLedgerOptions): GalileoPrepareRecord {
  const owner = normalizeAddress(input.owner, "owner");
  const now = Math.floor(Date.now() / 1000);
  return withLedger(options, (ledger) => consumePreparedInLedger(ledger, { ...input, owner, now }));
}

/**
 * A verified Storage retrieval is mandatory. This deliberately rejects records
 * without proof so an unverified metadata bundle can never arm a Galileo agent.
 */
export function persistVerifiedGalileoAgent(record: GalileoLocalAgentRecord, options?: GalileoLedgerOptions): void {
  if (record.chainId !== GALILEO_CHAIN_ID || !record.storageVerified || !record.storageRef.trim() || !/^0x[0-9a-f]{64}$/iu.test(record.storageRoot)) {
    throw new Error("A Galileo local agent record requires verified Galileo Storage evidence.");
  }
  const path = agentRecordPath(options);
  withFileLock(`${path}.lock`, () => {
    const existing = readJson<GalileoLocalAgentRecord[]>(path, []);
    const remaining = existing.filter((entry) => entry.agentRef !== record.agentRef);
    writeAtomicJson(path, [...remaining, record]);
  });
}

export function listVerifiedGalileoAgents(owner: Address, options?: GalileoLedgerOptions): GalileoLocalAgentRecord[] {
  const normalizedOwner = normalizeAddress(owner, "owner");
  return readJson<GalileoLocalAgentRecord[]>(agentRecordPath(options), [])
    .filter((entry) => entry.owner?.toLowerCase() === normalizedOwner && entry.chainId === GALILEO_CHAIN_ID && entry.storageVerified === true)
    .map((entry) => ({ ...entry, owner: entry.owner.toLowerCase() as Address, vault: entry.vault.toLowerCase() as Address }));
}

export class GalileoLedgerError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) {
    super(message);
  }
}

export function deriveGalileoAgentKey(agentRef: string): Hex {
  return keccak256(stringToHex(`4lpha-galileo-agent-key:v1:${agentRef}`));
}

export function configurationDigest(config: GalileoPreparedConfig, agentRef: string, agentKey: Hex): Hex {
  return sha256Hex(canonicalJson({ agentKey, agentRef, chainId: GALILEO_CHAIN_ID, config, networkId: GALILEO_NETWORK_ID }));
}

function normalizeConfig(config: GalileoPreparedConfig | undefined, owner: Address): GalileoPreparedConfig {
  if (!config || !config.vault || !isAddress(config.vault, { strict: true })) {
    throw new GalileoLedgerError("vault_invalid", "A valid Galileo vault address is required.", 400);
  }
  const name = config.name?.trim();
  if (!name || name.length < 3 || name.length > 80) throw new GalileoLedgerError("name_invalid", "Agent name must be 3-80 characters.", 400);
  const filters = [...new Set(config.filters.map((filter) => filter.trim()))].filter(Boolean);
  if (filters.length < 1 || filters.length > 4 || filters.some((filter) => filter.length > 64)) {
    throw new GalileoLedgerError("filters_invalid", "Provide one to four bounded Galileo filters.", 400);
  }
  return {
    filters: filters.sort(),
    name,
    owner,
    runtime: config.runtime,
    clientRequestId: normalizeClientRequestId(config.clientRequestId), vault: normalizeAddress(config.vault, "vault"),
  };
}

function normalizeTrade(trade: GalileoPreparedTrade | undefined, owner: Address): GalileoPreparedTrade {
  if (!trade || trade.networkId !== GALILEO_NETWORK_ID || trade.chainId !== GALILEO_CHAIN_ID || !isAddress(trade.vault, { strict: true }) || !isAddress(trade.adapter, { strict: true }) || !isBytes32(trade.agentKey) || !isBytes32(trade.poolId) || !isBytes32(trade.policyHash) || !isBytes32(trade.payloadDigest) || !["buy", "sell"].includes(trade.side)) {
    throw new GalileoLedgerError("trade_invalid", "Galileo trade consent is invalid.", 400);
  }
  const agentRef = trade.agentRef.trim();
  if (!/^[A-Za-z0-9_-]{8,160}$/u.test(agentRef)) throw new GalileoLedgerError("trade_invalid", "Galileo trade consent is invalid.", 400);
  const normalized: GalileoPreparedTrade = {
    adapter: normalizeAddress(trade.adapter, "adapter"),
    agentKey: trade.agentKey.toLowerCase() as Hex,
    agentRef,
    amountIn: normalizeUint(trade.amountIn, "amountIn", true),
    chainId: GALILEO_CHAIN_ID,
    clientRequestId: normalizeClientRequestId(trade.clientRequestId),
    minOut: normalizeUint(trade.minOut, "minOut", true),
    networkId: GALILEO_NETWORK_ID,
    payloadDigest: trade.payloadDigest.toLowerCase() as Hex,
    policyHash: trade.policyHash.toLowerCase() as Hex,
    poolId: trade.poolId.toLowerCase() as Hex,
    quoteBlock: normalizeUint(trade.quoteBlock, "quoteBlock", true),
    quoteExpiry: normalizeUnixTimestamp(trade.quoteExpiry, "quoteExpiry"),
    reserveNative: normalizeUint(trade.reserveNative, "reserveNative", true),
    reserveToken: normalizeUint(trade.reserveToken, "reserveToken", true),
    side: trade.side,
    trustedQuote: normalizeUint(trade.trustedQuote, "trustedQuote", true),
    vault: normalizeAddress(trade.vault, "vault"),
  };
  const expected = galileoTradePayloadDigest(owner, normalized);
  if (normalized.payloadDigest !== expected) throw new GalileoLedgerError("trade_payload_digest_invalid", "Galileo trade payload digest does not match the normalized consent tuple.", 400);
  return normalized;
}

/** Canonical SHA-256 digest signed with every Galileo trade consent. */
export function galileoTradePayloadDigest(owner: Address, trade: Omit<GalileoPreparedTrade, "payloadDigest"> | GalileoPreparedTrade): Hex {
  return sha256Hex(canonicalJson({
    adapter: trade.adapter.toLowerCase(),
    agentKey: trade.agentKey.toLowerCase(),
    agentRef: trade.agentRef,
    amountIn: trade.amountIn,
    chainId: trade.chainId,
    clientRequestId: trade.clientRequestId,
    minOut: trade.minOut,
    networkId: trade.networkId,
    owner: owner.toLowerCase(),
    policyHash: trade.policyHash.toLowerCase(),
    poolId: trade.poolId.toLowerCase(),
    quoteBlock: trade.quoteBlock,
    quoteExpiry: trade.quoteExpiry,
    reserveNative: trade.reserveNative,
    reserveToken: trade.reserveToken,
    side: trade.side,
    trustedQuote: trade.trustedQuote,
    vault: trade.vault.toLowerCase(),
  }));
}

function normalizeClientRequestId(value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9_-]{8,96}$/u.test(value)) throw new GalileoLedgerError("client_request_id_invalid", "clientRequestId must be 8-96 URL-safe characters.", 400);
  return value;
}

function normalizeUint(value: string, field: string, nonzero: boolean): string {
  if (!/^(0|[1-9][0-9]{0,77})$/u.test(value)) throw new GalileoLedgerError("trade_invalid", `Galileo ${field} is invalid.`, 400);
  const normalized = BigInt(value).toString();
  if (nonzero && normalized === "0") throw new GalileoLedgerError("trade_invalid", `Galileo ${field} must be nonzero.`, 400);
  return normalized;
}

function normalizeUnixTimestamp(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= Math.floor(Date.now() / 1000)) throw new GalileoLedgerError("trade_invalid", `Galileo ${field} is invalid.`, 400);
  return value;
}

function isBytes32(value: string): value is Hex {
  return /^0x[0-9a-f]{64}$/iu.test(value);
}

function normalizeAddress(value: string, field: string): Address {
  if (!isAddress(value, { strict: true })) throw new GalileoLedgerError(`${field}_invalid`, `A valid ${field} address is required.`, 400);
  return value.toLowerCase() as Address;
}

function hashNonce(nonce: string): Hex {
  if (!/^[a-f0-9]{64}$/iu.test(nonce)) throw new GalileoLedgerError("consent_invalid", "Galileo consent nonce is invalid.", 400);
  return `0x${createHash("sha256").update(nonce.toLowerCase()).digest("hex")}` as Hex;
}

function resolveRoot(options?: GalileoLedgerOptions): string {
  return options?.rootDir ?? DEFAULT_ROOT;
}

function agentRecordPath(options?: GalileoLedgerOptions): string {
  // In production this intentionally matches the plan's isolated public-agent
  // store. Tests supply a private root so they never touch workspace state.
  return options?.rootDir ? join(options.rootDir, "agents.json") : join(".data", "agents", "galileo-agents.json");
}

function readLedger(options?: GalileoLedgerOptions): GalileoLedger {
  const ledger = readJson<Partial<GalileoLedger>>(join(resolveRoot(options), "consents.json"), { version: 2, prepares: [], deployments: [], trades: [] });
  if (!isGalileoLedger(ledger)) throw new Error("Galileo durable ledger has an invalid schema.");
  return ledger as GalileoLedger;
}

/** Fail closed on partial/corrupt durable state; only ENOENT gets an empty ledger. */
function isGalileoLedger(value: Partial<GalileoLedger>): value is GalileoLedger {
  return value.version === 2
    && Array.isArray(value.prepares) && value.prepares.every(isPrepareRecord)
    && Array.isArray(value.deployments) && value.deployments.every(isDeploymentRecord)
    && Array.isArray(value.trades) && value.trades.every(isTradeRecord);
}

function isPrepareRecord(value: unknown): value is GalileoPrepareRecord {
  if (!isObject(value) || !["deploy", "trade", "workspace-read"].includes(String(value.action)) || typeof value.prepareId !== "string" || typeof value.owner !== "string" || !isAddress(value.owner, { strict: true }) || typeof value.expiresAt !== "number" || !Number.isSafeInteger(value.expiresAt) || !isBytes32(String(value.nonceHash)) || typeof value.createdAt !== "string" || (value.consumedAt !== undefined && typeof value.consumedAt !== "string")) return false;
  if (value.action === "deploy") return isPreparedConfig(value.config) && typeof value.configDigest === "string" && isBytes32(value.configDigest) && typeof value.agentRef === "string" && isBytes32(String(value.agentKey));
  if (value.action === "trade") return isPreparedTrade(value.trade) && typeof value.configDigest === "string" && isBytes32(value.configDigest) && value.agentRef === value.trade.agentRef && value.agentKey === value.trade.agentKey;
  return value.config === undefined && value.trade === undefined;
}

function isPreparedConfig(value: unknown): value is GalileoPreparedConfig {
  return isObject(value) && typeof value.clientRequestId === "string" && typeof value.name === "string" && Array.isArray(value.filters) && value.filters.every((item) => typeof item === "string") && typeof value.owner === "string" && isAddress(value.owner, { strict: true }) && typeof value.vault === "string" && isAddress(value.vault, { strict: true });
}

function isPreparedTrade(value: unknown): value is GalileoPreparedTrade {
  return isObject(value) && value.networkId === GALILEO_NETWORK_ID && value.chainId === GALILEO_CHAIN_ID && typeof value.agentRef === "string" && typeof value.clientRequestId === "string" && typeof value.side === "string" && ["buy", "sell"].includes(value.side) && typeof value.quoteExpiry === "number" && Number.isSafeInteger(value.quoteExpiry) && ["adapter", "agentKey", "amountIn", "minOut", "payloadDigest", "policyHash", "poolId", "quoteBlock", "reserveNative", "reserveToken", "trustedQuote", "vault"].every((key) => typeof value[key] === "string");
}

function isDeploymentRecord(value: unknown): value is GalileoDeploymentRecord {
  return isObject(value) && typeof value.clientRequestId === "string" && typeof value.createdAt === "string" && typeof value.updatedAt === "string" && typeof value.owner === "string" && isAddress(value.owner, { strict: true }) && typeof value.payloadDigest === "string" && isBytes32(value.payloadDigest) && ["claimed", "verified", "blocked"].includes(String(value.state));
}

function isTradeRecord(value: unknown): value is GalileoTradeRecord {
  return isObject(value) && typeof value.agentRef === "string" && typeof value.clientRequestId === "string" && typeof value.createdAt === "string" && typeof value.updatedAt === "string" && typeof value.owner === "string" && isAddress(value.owner, { strict: true }) && typeof value.payloadDigest === "string" && isBytes32(value.payloadDigest) && typeof value.state === "string" && Object.hasOwn(TRADE_TRANSITIONS, value.state);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withLedger<T>(options: GalileoLedgerOptions | undefined, mutate: (ledger: GalileoLedger) => T): T {
  const root = resolveRoot(options);
  return withFileLock(join(root, "consents.lock"), () => {
    const ledger = readLedger(options);
    const result = mutate(ledger);
    ledger.trades = pruneTerminalTrades(ledger.trades, Date.now());
    writeAtomicJson(join(root, "consents.json"), ledger);
    return result;
  });
}

function pruneTerminalTrades(records: GalileoTradeRecord[], now: number): GalileoTradeRecord[] {
  const terminalRecords = records.filter((record) => TERMINAL_TRADE_STATES.has(record.state));
  const newestTerminalRecords = new Set(
    terminalRecords
      .map((record, index) => ({ index, record, updatedAt: Date.parse(record.updatedAt) }))
      .filter(({ updatedAt }) => Number.isFinite(updatedAt))
      .sort((left, right) => right.updatedAt - left.updatedAt || right.index - left.index)
      .slice(0, TERMINAL_TRADE_MIN_COUNT)
      .map(({ record }) => record),
  );

  return records.filter((record) => {
    if (!TERMINAL_TRADE_STATES.has(record.state)) return true;
    if (newestTerminalRecords.has(record)) return true;
    const updatedAt = Date.parse(record.updatedAt);
    return !Number.isFinite(updatedAt) || now - updatedAt < TERMINAL_TRADE_RETENTION_MS;
  });
}

/**
 * mkdir is the inter-process atomic claim. The file is fsynced and renamed as a
 * snapshot while the lock is held; this is intentionally not a JSON RMW store.
 */
function withFileLock<T>(lockPath: string, action: () => T): T {
  mkdirSync(dirname(lockPath), { recursive: true });
  const startedAt = Date.now();
  for (;;) {
    try {
      mkdirSync(lockPath);
      break;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // A process crash must not permanently block local recovery. Ledger work is
      // synchronous and bounded; a lock older than 30s is therefore abandoned.
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 30_000) rmSync(lockPath, { recursive: true, force: true });
      } catch { /* retry */ }
      if (Date.now() - startedAt > 5_000) throw new Error("Galileo durable ledger is busy.");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    return action();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw new Error("Galileo durable state could not be read safely.");
  }
}

function consumePreparedInLedger(ledger: GalileoLedger, input: { action: GalileoConsentAction; nonce: string; owner: Address; prepareId: string; now?: number }): GalileoPrepareRecord {
  const record = preparedForLedger(ledger, input);
  if (record.consumedAt) throw new GalileoLedgerError("consent_replayed", "This Galileo consent is invalid, expired, or already used.", 401);
  record.consumedAt = new Date().toISOString(); return record;
}

function preparedForLedger(ledger: GalileoLedger, input: { action: GalileoConsentAction; nonce: string; owner: Address; prepareId: string; now?: number }): GalileoPrepareRecord {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  ledger.prepares = prune(ledger.prepares, now);
  const record = ledger.prepares.find((candidate) => candidate.prepareId === input.prepareId);
  if (!record || record.action !== input.action || record.owner !== input.owner || record.nonceHash !== hashNonce(input.nonce)) {
    throw new GalileoLedgerError("consent_replayed", "This Galileo consent is invalid, expired, or already used.", 401);
  }
  return record;
}

function writeAtomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  // Ensure the directory entry is durable when the platform permits it.
  if (existsSync(path)) {
    try {
      const directory = openSync(dirname(path), "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } catch { /* Windows does not support fsync on a directory. */ }
  }
}

function prune(records: GalileoPrepareRecord[], now: number): GalileoPrepareRecord[] {
  return records.filter((record) => record.expiresAt > now || Boolean(record.consumedAt));
}
