import "server-only";

import { randomBytes } from "node:crypto";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeAbiParameters,
  getAddress,
  http,
  isAddress,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { galileoSandboxPoolAbi, galileoVaultAbi } from "@/lib/contracts/policy-vault-v4-galileo";
import { proofRegistryAbi } from "@/lib/contracts/proof-registry-abi";
import { assertGalileoStackIntegrity } from "@/lib/galileo/attestation";
import { verifyGalileoConsent, type GalileoWalletConsent } from "@/lib/galileo/consent";
import { GALILEO_CHAIN_ID, GALILEO_NETWORK_ID, type GalileoWriteConfig } from "@/lib/galileo/config";
import {
  advanceGalileoTrade,
  claimTradeAndConsume,
  listReconcilableGalileoTrades,
  listVerifiedGalileoAgents,
  patchGalileoTrade,
  settleGalileoTrade,
  type GalileoPreparedTrade,
  type GalileoTradeRecord,
} from "@/lib/galileo/ledger";
import { canonicalJson, sha256Hex } from "@/lib/galileo/metadata";
import { downloadAndVerifyGalileoBytes, uploadGalileoBytes } from "@/lib/galileo/storage";

const NATIVE_TOKEN = "0x0000000000000000000000000000000000000000" as Address;
const BUY_NATIVE_FLOOR = 250_000_000_000_000_000n; // 0.25 0G
const BUY_TOKEN_FLOOR = 250_000_000n; // 250 mUSDC (6 decimals)
const DEFAULT_RPC_RETRY_COUNT = 4;
const DEFAULT_RPC_RETRY_DELAY_MS = 250;

function galileoRpcEnvInteger(name: "OG_RPC_RETRY_COUNT" | "OG_RPC_RETRY_DELAY_MS", fallback: number, maximum: number): number {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= maximum ? parsed : fallback;
}

function galileoTransport(rpcUrl: string) {
  return http(rpcUrl, {
    retryCount: galileoRpcEnvInteger("OG_RPC_RETRY_COUNT", DEFAULT_RPC_RETRY_COUNT, 10),
    retryDelay: galileoRpcEnvInteger("OG_RPC_RETRY_DELAY_MS", DEFAULT_RPC_RETRY_DELAY_MS, 30_000),
  });
}

function galileoPublicClient(rpcUrl: string) {
  return createPublicClient({ transport: galileoTransport(rpcUrl) });
}

/**
 * Buy-only operational reserve floor: a buy is blocked when it would leave the sandbox pool
 * below 0.25 0G or 250 mUSDC of accounted reserves. Sells deliberately do NOT use this — an
 * exit is evaluated by inventory + trusted quote + min-out + actual liquidity instead.
 */
export function crossesBuyReserveFloor(nativeReserve: bigint, amountIn: bigint, tokenReserve: bigint, quote: bigint): boolean {
  return nativeReserve + amountIn < BUY_NATIVE_FLOOR || tokenReserve - quote < BUY_TOKEN_FLOOR;
}

export interface GalileoTradeInput {
  agentRef: string;
  amountIn: bigint;
  clientRequestId: string;
  owner: Address;
  side: "buy" | "sell";
  userMinOut: bigint;
  vault: Address;
}

export interface GalileoTradeConsentInput {
  nonce: string;
  prepareId: string;
  wallet: GalileoWalletConsent;
}

export interface GalileoTradePreview {
  agentKey?: Hex;
  amountOutMin: bigint;
  blockedReason?: string;
  decision: "allow" | "block";
  dailySpent0G: bigint;
  feeBps: number;
  openExposure0G: bigint;
  policyHash: Hex;
  pool: { nativeReserve: bigint; tokenReserve: bigint; quoteBlock: bigint };
  policy: { perTradeCap0G: bigint; dailyCap0G: bigint; maxExposure0G: bigint; cooldownSeconds: bigint; maxDeadlineWindowSeconds: bigint; defaultMinOutBps: number };
  priceImpactBps: bigint;
  quote: bigint;
  sellableInventory: bigint;
  state: { agentKeyEnabled: boolean; allowedPool: boolean; allowedToken: boolean; executorRevoked: boolean; paused: boolean };
  userMinOut: bigint;
  vaultMinOut: bigint;
  vaultBalance: bigint;
}

export interface GalileoTradeExecution {
  actionHash: Hex;
  auditRoot: Hex;
  proofTxHash: Hex;
  record: GalileoTradeRecord;
  storageRef: string;
  storageRoot: Hex;
  tradeTxHash: Hex;
  vaultActionHash: Hex;
}

export class GalileoTradeError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 409) { super(message); }
}

/** A signer-free read path. It never resolves a service key or feature gate. */
export async function previewGalileoTrade(input: GalileoTradeInput, config: Pick<GalileoWriteConfig, "rpcUrl" | "addresses">): Promise<GalileoTradePreview> {
  const owner = address(input.owner, "owner");
  const vault = address(input.vault, "vault");
  if (input.amountIn <= 0n || input.userMinOut <= 0n) throw new GalileoTradeError("invalid_amount", "Galileo trades require nonzero input and minimum output.", 400);
  const agent = listVerifiedGalileoAgents(owner).find((entry) => entry.agentRef === input.agentRef && entry.vault.toLowerCase() === vault.toLowerCase());
  const client = galileoPublicClient(config.rpcUrl);
  const [policyTuple, nativeReserve, tokenReserve, vaultBalance, dailySpent0G, lastTradeAt, openExposure0G, paused, executorRevoked, allowedToken, allowedPool, currentPolicyHash] = await Promise.all([
    client.readContract({ address: vault, abi: galileoVaultAbi, functionName: "policy" }),
    client.readContract({ address: config.addresses.pool, abi: galileoSandboxPoolAbi, functionName: "nativeReserve" }),
    client.readContract({ address: config.addresses.pool, abi: galileoSandboxPoolAbi, functionName: "tokenReserve" }),
    client.getBalance({ address: vault }),
    client.readContract({ address: vault, abi: galileoVaultAbi, functionName: "dailySpent0G" }),
    client.readContract({ address: vault, abi: galileoVaultAbi, functionName: "lastTradeAt" }),
    client.readContract({ address: vault, abi: galileoVaultAbi, functionName: "openExposure0G" }),
    client.readContract({ address: vault, abi: galileoVaultAbi, functionName: "paused" }),
    client.readContract({ address: vault, abi: galileoVaultAbi, functionName: "executorRevoked" }),
    client.readContract({ address: vault, abi: galileoVaultAbi, functionName: "allowedTokens", args: [config.addresses.sandboxToken] }),
    client.readContract({ address: vault, abi: galileoVaultAbi, functionName: "allowedPools", args: [poolId(config)] }),
    client.readContract({ address: vault, abi: galileoVaultAbi, functionName: "policyHash" }),
  ]);
  const policy = { perTradeCap0G: policyTuple[0], dailyCap0G: policyTuple[1], maxExposure0G: policyTuple[2], cooldownSeconds: policyTuple[3], maxDeadlineWindowSeconds: policyTuple[4], defaultMinOutBps: policyTuple[5] };
  const isBuy = input.side === "buy";
  const tokenIn = isBuy ? NATIVE_TOKEN : config.addresses.sandboxToken;
  const tokenOut = isBuy ? config.addresses.sandboxToken : NATIVE_TOKEN;
  const [quote, agentKeyEnabled, sellableInventory, block] = await Promise.all([
    client.readContract({ address: config.addresses.pool, abi: galileoSandboxPoolAbi, functionName: "quoteExactIn", args: [tokenIn, input.amountIn] }),
    agent ? client.readContract({ address: vault, abi: galileoVaultAbi, functionName: "agentKeyEnabled", args: [agent.agentKey] }) : Promise.resolve(false),
    agent ? client.readContract({ address: vault, abi: galileoVaultAbi, functionName: "agentPositionUnits", args: [agent.agentKey, config.addresses.sandboxToken] }) : Promise.resolve(0n),
    client.getBlockNumber(),
  ]);
  // `minOutFor` receives the trusted quote, not amountIn. Re-read precisely.
  const trustedFloor = await client.readContract({ address: vault, abi: galileoVaultAbi, functionName: "minOutFor", args: [tokenIn, tokenOut, quote] });
  const amountOutMin = trustedFloor > input.userMinOut ? trustedFloor : input.userMinOut;
  const spotDenominator = isBuy ? nativeReserve : tokenReserve;
  const spotNumerator = isBuy ? tokenReserve : nativeReserve;
  const spot = spotDenominator === 0n ? 0n : input.amountIn * spotNumerator / spotDenominator;
  const priceImpactBps = spot === 0n || quote >= spot ? 0n : (spot - quote) * 10_000n / spot;
  const now = BigInt(Math.floor(Date.now() / 1000));
  let blockedReason: string | undefined;
  if (!agent) blockedReason = "A verified Galileo-local agent for this vault is required.";
  else if (!agentKeyEnabled) blockedReason = "The Galileo agent key is disabled.";
  else if (paused || executorRevoked) blockedReason = "The vault is paused or its executor is revoked.";
  else if (!allowedToken || !allowedPool) blockedReason = "The vault allowlist does not match the Galileo sandbox route.";
  else if (amountOutMin === 0n || amountOutMin > quote) blockedReason = "The requested minimum output is not executable.";
  else if (isBuy && (input.amountIn > policy.perTradeCap0G || input.amountIn + openExposure0G > policy.maxExposure0G || dailySpent0G + input.amountIn > policy.dailyCap0G)) blockedReason = "The buy exceeds a vault policy cap.";
  else if (isBuy && crossesBuyReserveFloor(nativeReserve, input.amountIn, tokenReserve, quote)) blockedReason = "The buy would cross the Galileo sandbox reserve floor.";
  else if (!isBuy && sellableInventory < input.amountIn) blockedReason = "The selected agent key does not have enough sellable inventory.";
  else if (!isBuy && quote > nativeReserve) blockedReason = "The sandbox pool lacks native liquidity for this sell.";
  else if (lastTradeAt !== 0n && now < lastTradeAt + policy.cooldownSeconds) blockedReason = "The vault cooldown is active.";
  else if (isBuy && vaultBalance < input.amountIn) blockedReason = "The vault has insufficient native balance.";
  return { agentKey: agent?.agentKey, amountOutMin, blockedReason, decision: blockedReason ? "block" : "allow", dailySpent0G, feeBps: 30, openExposure0G, policyHash: currentPolicyHash, pool: { nativeReserve, tokenReserve, quoteBlock: block }, policy: { ...policy }, priceImpactBps, quote, sellableInventory, state: { agentKeyEnabled, allowedPool, allowedToken, executorRevoked, paused }, userMinOut: input.userMinOut, vaultMinOut: trustedFloor, vaultBalance };
}

/** Executes one already-previewed, exactly consented Galileo trade. */
export async function executeGalileoTrade(input: GalileoTradeInput, consent: GalileoTradeConsentInput, config: GalileoWriteConfig, preview?: GalileoTradePreview): Promise<GalileoTradeExecution> {
  const owner = address(input.owner, "owner");
  const vault = address(input.vault, "vault");
  await assertGalileoStackIntegrity(config, vault);
  const prepared = await verifyGalileoConsent({ action: "trade", nonce: consent.nonce, prepareId: consent.prepareId, wallet: consent.wallet });
  if (!prepared.trade || prepared.owner.toLowerCase() !== owner.toLowerCase()) throw new GalileoTradeError("consent_invalid", "Galileo trade consent is incomplete.", 401);
  preview ??= await previewGalileoTrade(input, config);
  if (preview.userMinOut !== input.userMinOut) throw new GalileoTradeError("consent_mismatch", "The Galileo preview minimum output does not match the execution request.", 409);
  if (preview.decision !== "allow" || !preview.agentKey) throw new GalileoTradeError("policy_blocked", preview.blockedReason ?? "The Galileo trade is blocked.");
  const deadline = Math.min(prepared.expiresAt, prepared.trade.quoteExpiry, Math.floor(Date.now() / 1000) + Number(preview.policy.maxDeadlineWindowSeconds));
  if (deadline <= Math.floor(Date.now() / 1000)) throw new GalileoTradeError("quote_stale", "The Galileo quote has expired.");
  const normalized = normalizePreparedTrade({
    ...prepared.trade,
    adapter: config.addresses.adapter,
    agentKey: preview.agentKey,
    agentRef: input.agentRef,
    amountIn: input.amountIn.toString(),
    clientRequestId: input.clientRequestId,
    minOut: preview.amountOutMin.toString(),
    payloadDigest: prepared.trade.payloadDigest,
    policyHash: await policyHash(config.rpcUrl, vault),
    // quoteBlock/reserveNative/reserveToken are the SIGNED snapshot (informational
    // evidence), preserved from prepared.trade — do NOT override with execute-time
    // values: the block advances every ~2s so an override would make every signed
    // consent fail. Freshness is enforced by the trustedQuote equality + deadline
    // + the post-storage/post-proof freshness checks below, not by the block.
    poolId: poolId(config), quoteExpiry: prepared.trade.quoteExpiry, side: input.side,
    trustedQuote: preview.quote.toString(), vault,
  });
  assertPreparedMatches(prepared.trade, normalized);
  const claim = claimTradeAndConsume({ nonce: consent.nonce, owner, prepareId: consent.prepareId });
  if (claim.replay) {
    const outcome = await reconcileGalileoTrade(claim.record, config);
    if (outcome === "confirmed") throw new GalileoTradeError("idempotent_complete", "This Galileo request already completed; inspect its evidence.", 200);
    if (outcome === "in_flight") throw new GalileoTradeError("idempotent_in_flight", "This Galileo request is in flight; retry shortly.", 409);
    throw new GalileoTradeError("idempotent_failed", "This Galileo request already terminated without success; a new consent is required.", 409);
  }
  const audit = buildTradeAudit(normalized, deadline, config.signers.executor.address, modelMetadataHash(owner, input.agentRef), preview);
  const auditRoot = sha256Hex(audit.bytes);
  try {
    const storage = await uploadGalileoBytes(audit.bytes, config);
    if (!(await downloadAndVerifyGalileoBytes(storage.storageRef, audit.bytes, config))) throw new GalileoTradeError("storage_verify_failed", "Galileo Storage could not verify the audit bytes.", 503);
    advanceGalileoTrade({ owner, agentRef: input.agentRef, clientRequestId: input.clientRequestId, state: "storage_verified", patch: { auditRoot, storageRef: storage.storageRef, storageRoot: storage.rootHash } });
    const refreshed = await readGalileoTradeFreshness(input, config, vault);
    // The trusted quote, derived min-out, policy, and allow decision must be
    // unchanged. We deliberately do NOT require the block to advance: an
    // unchanged quote across the same block is valid, and requiring a new block
    // would spuriously reject an otherwise-fresh trade.
    if (!isGalileoTradeFresh(refreshed, preview, normalized.policyHash)) {
      throw new GalileoTradeError("quote_stale", "The Galileo quote or policy changed before proof acceptance.");
    }
    const vaultActionHash = hashVaultAction({ ...normalized, deadline, auditRoot, executor: config.signers.executor.address, owner, proofRegistry: config.addresses.proofRegistry, token: config.addresses.sandboxToken });
    const actionHash = hashAction(vaultActionHash, auditRoot, normalized.policyHash);
    const proofWallet = createWalletClient({ account: privateKeyToAccount(config.signers.proofAttestor.privateKey), transport: galileoTransport(config.rpcUrl) });
    const proofNonce = await publicClientFor(config.rpcUrl).getTransactionCount({ address: config.signers.proofAttestor.address, blockTag: "pending" });
    advanceGalileoTrade({ owner, agentRef: input.agentRef, clientRequestId: input.clientRequestId, state: "proof_submitted", actionHash, patch: { auditRoot, storageRef: storage.storageRef, storageRoot: storage.rootHash, signerNonce: proofNonce.toString() } });
    const proofTxHash = await proofWallet.writeContract({ address: config.addresses.proofRegistry, abi: proofRegistryAbi as any, functionName: "acceptProof", args: [actionHash, auditRoot, normalized.policyHash, modelMetadataHash(owner, input.agentRef), storage.storageRef, vaultActionHash, input.agentRef], nonce: proofNonce } as any);
    // Record the tx handle immediately after broadcast so a crash before the
    // receipt still leaves a recoverable handle (state stays proof_submitted).
    patchGalileoTrade({ owner, agentRef: input.agentRef, clientRequestId: input.clientRequestId, patch: { proofTxHash } });
    const publicClient = galileoPublicClient(config.rpcUrl);
    const proofReceipt = await waitGalileoReceipt(publicClient, proofTxHash);
    if (proofReceipt.status !== "success") throw new GalileoTradeError("proof_failed", "ProofRegistry did not accept the Galileo proof.", 502);
    const [accepted, proof] = await Promise.all([
      publicClient.readContract({ address: config.addresses.proofRegistry, abi: proofRegistryAbi, functionName: "isAccepted", args: [actionHash, auditRoot, normalized.policyHash, vaultActionHash] }),
      publicClient.readContract({ address: config.addresses.proofRegistry, abi: proofRegistryAbi, functionName: "proofFor", args: [actionHash] }),
    ]);
    const expectedModel = modelMetadataHash(owner, input.agentRef);
    if (!accepted || proof.auditRoot !== auditRoot || proof.policySnapshotHash !== normalized.policyHash || proof.modelMetadataHash !== expectedModel || proof.vaultActionHash !== vaultActionHash || proof.storageRef !== storage.storageRef || proof.agentRef !== input.agentRef || proof.acceptedAt === 0n) throw new GalileoTradeError("proof_mismatch", "The accepted Galileo proof does not match the action evidence.", 502);
    advanceGalileoTrade({ owner, agentRef: input.agentRef, clientRequestId: input.clientRequestId, state: "proof_accepted", actionHash, patch: { proofTxHash } });
    const postProof = await readGalileoTradeFreshness(input, config, vault);
    if (!isGalileoTradeFresh(postProof, preview, normalized.policyHash)) throw new GalileoTradeError("quote_stale", "The Galileo trade became stale after proof acceptance.");
    const request = tradeRequest(normalized, deadline, auditRoot, vaultActionHash, actionHash, config.addresses.sandboxToken);
    const executorWallet = createWalletClient({ account: privateKeyToAccount(config.signers.executor.privateKey), transport: galileoTransport(config.rpcUrl) });
    const executorNonce = await publicClient.getTransactionCount({ address: config.signers.executor.address, blockTag: "pending" });
    const before = await balances(publicClient, vault, config.addresses.pool, config.addresses.sandboxToken);
    advanceGalileoTrade({ owner, agentRef: input.agentRef, clientRequestId: input.clientRequestId, state: "trade_submitted", actionHash, patch: { signerNonce: executorNonce.toString() } });
    const tradeTxHash = await executorWallet.writeContract({ address: vault, abi: galileoVaultAbi as any, functionName: input.side, args: [request], nonce: executorNonce } as any);
    // Record the trade tx handle right after broadcast (state stays trade_submitted).
    patchGalileoTrade({ owner, agentRef: input.agentRef, clientRequestId: input.clientRequestId, patch: { tradeTxHash } });
    const tradeReceipt = await waitGalileoReceipt(publicClient, tradeTxHash);
    if (tradeReceipt.status !== "success") throw new GalileoTradeError("trade_failed", "The Galileo vault transaction failed.", 502);
    const after = await balances(publicClient, vault, config.addresses.pool, config.addresses.sandboxToken);
    verifyDeltas(input.side, input.amountIn, preview.amountOutMin, before, after);
    const event = parseTradeEvent(tradeReceipt.logs, vault);
    if (!event || event.args.actionHash !== actionHash || event.args.agentKey !== preview.agentKey) throw new GalileoTradeError("trade_event_missing", "The expected Galileo trade event was not emitted.", 502);
    const record = advanceGalileoTrade({ owner, agentRef: input.agentRef, clientRequestId: input.clientRequestId, state: "confirmed", actionHash, patch: { proofTxHash, tradeTxHash } });
    return { actionHash, auditRoot, proofTxHash, record, storageRef: storage.storageRef, storageRoot: storage.rootHash, tradeTxHash, vaultActionHash };
  } catch (error) {
    // Any mid-flight failure/crash leaves the record reconcilable. reconcileGalileoTrade
    // reads the chain (usedActionHashes + proofFor) as the source of truth to settle it —
    // proofAccepted is intentionally not special-cased here.
    try { advanceGalileoTrade({ owner, agentRef: input.agentRef, clientRequestId: input.clientRequestId, state: "recovery_required" }); } catch { /* preserve the original failure */ }
    throw error;
  }
}

/** How long a non-terminal trade must be idle before reconciliation assumes its owning
 *  process died (rather than being actively in-flight in another worker). */
const GALILEO_TRADE_STALE_MS = 120_000;

/**
 * Resolve a non-terminal (crashed/interrupted) trade to a terminal state by reading the
 * chain: `usedActionHashes` proves the vault trade executed; otherwise the attempt is dead
 * (an accepted proof cannot be reused for a modified trade). Returns the settled outcome, or
 * `in_flight` when the record is too fresh to assume a crash.
 */
export async function reconcileGalileoTrade(record: GalileoTradeRecord, config: GalileoWriteConfig): Promise<"confirmed" | "failed" | "in_flight"> {
  if (record.state === "confirmed") return "confirmed";
  if (record.state === "failed" || record.state === "blocked") return "failed";
  const key = { owner: record.owner, agentRef: record.agentRef, clientRequestId: record.clientRequestId };
  if (Date.now() - Date.parse(record.updatedAt) < GALILEO_TRADE_STALE_MS && record.state !== "recovery_required") return "in_flight";
  // Nothing reached the chain (no actionHash yet): the consumed consent is dead → failed.
  if (!record.actionHash) { settleGalileoTrade({ ...key, state: "failed" }); return "failed"; }
  const agent = listVerifiedGalileoAgents(record.owner).find((entry) => entry.agentRef === record.agentRef);
  if (!agent) { settleGalileoTrade({ ...key, state: "failed" }); return "failed"; }
  const client = galileoPublicClient(config.rpcUrl);
  const [used, proof] = await Promise.all([
    client.readContract({ address: agent.vault, abi: galileoVaultAbi, functionName: "usedActionHashes", args: [record.actionHash] }),
    client.readContract({ address: config.addresses.proofRegistry, abi: proofRegistryAbi, functionName: "proofFor", args: [record.actionHash] }),
  ]);
  if (used) {
    settleGalileoTrade({ ...key, state: "confirmed", patch: { auditRoot: proof.auditRoot, storageRef: proof.storageRef } });
    return "confirmed";
  }
  // Trade did not execute. Whether or not the proof landed, it cannot be reused for a new
  // payload, so this attempt is terminal; a retry requires a fresh consent/nonce/bundle.
  settleGalileoTrade({ ...key, state: "failed" });
  return "failed";
}

/** Startup/CLI sweep: reconcile every stuck Galileo trade before any new side effect. */
export async function recoverGalileoTrades(config: GalileoWriteConfig): Promise<Array<{ agentRef: string; clientRequestId: string; outcome: "confirmed" | "failed" | "in_flight" }>> {
  const results: Array<{ agentRef: string; clientRequestId: string; outcome: "confirmed" | "failed" | "in_flight" }> = [];
  for (const record of listReconcilableGalileoTrades()) {
    const outcome = await reconcileGalileoTrade(record, config).catch(() => "in_flight" as const);
    results.push({ agentRef: record.agentRef, clientRequestId: record.clientRequestId, outcome });
  }
  return results;
}

export function hashPolicy(policy: GalileoTradePreview["policy"]): Hex {
  return keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint16" }], [policy.perTradeCap0G, policy.dailyCap0G, policy.maxExposure0G, policy.cooldownSeconds, policy.maxDeadlineWindowSeconds, policy.defaultMinOutBps]));
}
export function hashVaultAction(input: GalileoPreparedTrade & { auditRoot: Hex; deadline: number; executor: Address; owner: Address; proofRegistry: Address; token: Address }): Hex {
  const isBuy = input.side === "buy";
  const tokenIn = isBuy ? NATIVE_TOKEN : input.token;
  const tokenOut = isBuy ? input.token : NATIVE_TOKEN;
  return keccak256(encodeAbiParameters([{ type: "string" }, { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "bool" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }], ["4LPHA_GALILEO_POLICY_VAULT_ACTION", BigInt(GALILEO_CHAIN_ID), input.vault, input.owner as Address, input.executor, input.adapter, input.proofRegistry, isBuy, tokenIn, tokenOut, BigInt(input.amountIn), BigInt(input.trustedQuote), BigInt(input.minOut), BigInt(input.deadline), contractNonce(input), input.agentKey, input.poolId, input.policyHash, input.auditRoot]));
}
export function hashAction(vaultActionHash: Hex, auditRoot: Hex, policySnapshotHash: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "string" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }], ["4LPHA_0G_POLICY_VAULT_PROOF", vaultActionHash, auditRoot, policySnapshotHash]));
}

function poolId(config: Pick<GalileoWriteConfig, "addresses">): Hex { return keccak256(stringToHex("4LPHA_GALILEO_0G_MUSDC_V1")); }
function address(value: string, field: string): Address { if (!isAddress(value, { strict: true })) throw new GalileoTradeError(`${field}_invalid`, `A valid Galileo ${field} is required.`, 400); return getAddress(value); }
async function policyHash(rpcUrl: string, vault: Address): Promise<Hex> { return galileoPublicClient(rpcUrl).readContract({ address: vault, abi: galileoVaultAbi, functionName: "policyHash" }); }
async function readGalileoTradeFreshness(input: Pick<GalileoTradeInput, "amountIn" | "side">, config: Pick<GalileoWriteConfig, "rpcUrl" | "addresses">, vault: Address) {
  const client = galileoPublicClient(config.rpcUrl);
  const tokenIn = input.side === "buy" ? NATIVE_TOKEN : config.addresses.sandboxToken;
  const [quote, currentPolicyHash, paused, executorRevoked] = await Promise.all([
    client.readContract({ address: config.addresses.pool, abi: galileoSandboxPoolAbi, functionName: "quoteExactIn", args: [tokenIn, input.amountIn] }),
    client.readContract({ address: vault, abi: galileoVaultAbi, functionName: "policyHash" }),
    client.readContract({ address: vault, abi: galileoVaultAbi, functionName: "paused" }),
    client.readContract({ address: vault, abi: galileoVaultAbi, functionName: "executorRevoked" }),
  ]);
  return { executorRevoked, paused, policyHash: currentPolicyHash, quote };
}
function isGalileoTradeFresh(freshness: Awaited<ReturnType<typeof readGalileoTradeFreshness>>, preview: GalileoTradePreview, expectedPolicyHash: Hex): boolean {
  const amountOutMin = preview.vaultMinOut > preview.userMinOut ? preview.vaultMinOut : preview.userMinOut;
  return !freshness.paused
    && !freshness.executorRevoked
    && freshness.quote === preview.quote
    && amountOutMin > 0n
    && amountOutMin === preview.amountOutMin
    && freshness.policyHash === expectedPolicyHash;
}
function contractNonce(input: GalileoPreparedTrade): bigint { return BigInt(`0x${input.payloadDigest.slice(2, 18)}`); }
function modelMetadataHash(owner: Address, agentRef: string): Hex { const agent = listVerifiedGalileoAgents(owner).find((entry) => entry.agentRef === agentRef); if (!agent?.modelMetadata?.digest) throw new GalileoTradeError("agent_metadata_missing", "Galileo agent model metadata is unavailable.", 409); return agent.modelMetadata.digest; }
function normalizePreparedTrade(value: GalileoPreparedTrade): GalileoPreparedTrade { return { ...value, adapter: value.adapter.toLowerCase() as Address, agentKey: value.agentKey.toLowerCase() as Hex, payloadDigest: value.payloadDigest.toLowerCase() as Hex, policyHash: value.policyHash.toLowerCase() as Hex, poolId: value.poolId.toLowerCase() as Hex, vault: value.vault.toLowerCase() as Address }; }
function assertPreparedMatches(expected: GalileoPreparedTrade, actual: GalileoPreparedTrade): void { if (canonicalJson(expected) !== canonicalJson(actual)) throw new GalileoTradeError("consent_mismatch", "The signed Galileo trade tuple no longer matches the live quote.", 409); }
/**
 * Assemble the Galileo trade audit bundle from an ALLOWLIST-ONLY DTO — every field is copied
 * explicitly from the normalized trade/preview, never the raw request — so no wallet
 * signature, authorization nonce, cookie, header, key, or raw payload can leak into Storage.
 * Pure + exported for the redaction sentinel test. The caller resolves `modelHash`.
 */
export function buildTradeAudit(trade: GalileoPreparedTrade, deadline: number, executor: Address, modelHash: Hex, preview: Pick<GalileoTradePreview, "amountOutMin" | "vaultMinOut">) { const value = { schemaVersion: 1, networkId: GALILEO_NETWORK_ID, chainId: GALILEO_CHAIN_ID, request: { adapter: trade.adapter, agentKey: trade.agentKey, agentRef: trade.agentRef, amountIn: trade.amountIn, clientRequestId: trade.clientRequestId, deadline, minOut: trade.minOut, poolId: trade.poolId, policyHash: trade.policyHash, side: trade.side, trustedQuote: trade.trustedQuote, vault: trade.vault }, quote: { block: trade.quoteBlock, nativeReserve: trade.reserveNative, tokenReserve: trade.reserveToken }, executor: executor.toLowerCase(), modelMetadataHash: modelHash, verification: { amountOutMin: preview.amountOutMin.toString(), vaultMinOut: preview.vaultMinOut.toString() } }; const json = canonicalJson(value); return { bytes: new TextEncoder().encode(json), value }; }
function tradeRequest(trade: GalileoPreparedTrade, deadline: number, auditRoot: Hex, vaultActionHash: Hex, actionHash: Hex, token: Address) { const isBuy = trade.side === "buy"; return { tokenIn: isBuy ? NATIVE_TOKEN : token, tokenOut: isBuy ? token : NATIVE_TOKEN, amountIn: BigInt(trade.amountIn), quotedAmountOut: BigInt(trade.trustedQuote), amountOutMin: BigInt(trade.minOut), deadline: BigInt(deadline), nonce: contractNonce(trade), agentKey: trade.agentKey, poolId: trade.poolId, vaultActionHash, actionHash, policySnapshotHash: trade.policyHash, auditRoot }; }
async function balances(client: ReturnType<typeof createPublicClient>, vault: Address, pool: Address, token: Address) { const [vaultNative, vaultToken, poolNative, poolToken] = await Promise.all([client.getBalance({ address: vault }), client.readContract({ address: token, abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }] as const, functionName: "balanceOf", args: [vault] }), client.getBalance({ address: pool }), client.readContract({ address: token, abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }] as const, functionName: "balanceOf", args: [pool] })]); return { vaultNative, vaultToken, poolNative, poolToken }; }
function verifyDeltas(side: "buy" | "sell", amountIn: bigint, minOut: bigint, before: Awaited<ReturnType<typeof balances>>, after: Awaited<ReturnType<typeof balances>>) { if (side === "buy") { if (before.vaultNative - after.vaultNative !== amountIn || after.vaultToken - before.vaultToken < minOut || after.poolNative - before.poolNative !== amountIn || before.poolToken - after.poolToken < minOut) throw new GalileoTradeError("balance_delta_invalid", "Galileo buy balance deltas did not match the vault event.", 502); } else if (before.vaultToken - after.vaultToken !== amountIn || after.vaultNative - before.vaultNative < minOut || after.poolToken - before.poolToken !== amountIn || before.poolNative - after.poolNative < minOut) throw new GalileoTradeError("balance_delta_invalid", "Galileo sell balance deltas did not match the vault event.", 502); }
function parseTradeEvent(logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[], vault: Address) {
  for (const log of logs) {
    if (log.address.toLowerCase() !== vault.toLowerCase()) continue;
    try {
      const event = decodeEventLog({ abi: galileoVaultAbi, data: log.data, topics: [...log.topics] as any });
      if (event.eventName === "TradeExecuted") return event;
    } catch {
      // Keep scanning vault logs until the expected event decodes.
    }
  }
  return undefined;
}
function publicClientFor(rpcUrl: string) { return galileoPublicClient(rpcUrl); }
/** The public Galileo RPC serves receipts with a lag that trips viem's default
 *  waitForTransactionReceipt. Poll manually and tolerate transient not-found/RPC
 *  errors so a mined proof/trade tx is never treated as failed. */
async function waitGalileoReceipt(client: ReturnType<typeof createPublicClient>, hash: Hex) {
  for (let attempt = 0; attempt < 90; attempt++) {
    try { const receipt = await client.getTransactionReceipt({ hash }); if (receipt) return receipt; }
    catch { /* receipt not visible yet on this node */ }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new GalileoTradeError("receipt_timeout", `Timed out waiting for Galileo receipt ${hash}`, 502);
}
