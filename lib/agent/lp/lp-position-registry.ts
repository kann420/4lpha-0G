import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Address, Hex } from "viem";

// Server-side LP position registry — the getLogs-free enumeration source for
// readSellableLpPositions (Bug 1: listing flicker from getLogs({fromBlock:0})
// timing out on quiknode) and the dedup gate (Bug 3: duplicate pool pairs). Also
// works around the deployed V3 vault 0xfd391E... lacking the agentLpNfts /
// agentStakedNfts array getters (added to source ~3h after that vault deployed,
// so they revert on-chain; scalar lpNftOwner/lpNftPool reads still work).
//
// The registry is a candidate-id list, NOT authoritative state — the listing
// path re-validates every tokenId via readLpPositionByTokenId (lp-exec.ts:190),
// so a stale or drifted entry cannot poison the UI. The cached `poolAddress` is
// only read by the dedup gate (lp-worker.ts), which derives openPoolAddresses
// from the validated sellableLpPositions list, not this raw file — so a stale
// cached pool cannot block a pool forever either.
//
// Single-writer guarantee = the worker file lock (scripts/og-agent-lp-worker.ts);
// the one-shot backfill script also acquires that lock. JSON write is plain
// overwrite (no atomic temp+rename), matching lib/agent/runtime/lp-store.ts.
// Path: .data/lp-positions/<safeAgentKey>.json.

export interface LpRegistryEntry {
  tokenId: string; // decimal string (matches OgAgentVaultLpPosition.tokenId)
  poolAddress: Address; // lowercased — cached at mint time for zero-RPC dedup
  addedAt: string; // ISO timestamp of the mint that inserted it
}

export interface LpPositionRegistryRecord {
  agentKey: Hex;
  vault: Address; // lowercased — sanity check against drift
  positions: LpRegistryEntry[];
  updatedAt: string;
}

const LP_POSITION_DIR = join(".data", "lp-positions");

export function lpPositionRegistryPath(agentKey: Hex): string {
  return join(LP_POSITION_DIR, `${safeArtifactName(agentKey)}.json`);
}

export async function readLpPositionRegistry(agentKey: Hex): Promise<LpPositionRegistryRecord | null> {
  return readJsonArtifact<LpPositionRegistryRecord>(lpPositionRegistryPath(agentKey));
}

export async function writeLpPositionRegistry(record: LpPositionRegistryRecord): Promise<void> {
  await writeJsonArtifact(lpPositionRegistryPath(record.agentKey), record);
}

/// Idempotent append — dedup by tokenId string. Never throws on the mint path:
/// callers wrap this in try/catch so a registry write failure cannot turn a
/// successful mint into a 500.
export async function addTokenIdToRegistry(
  agentKey: Hex,
  vault: Address,
  tokenId: string,
  poolAddress: Address,
): Promise<LpPositionRegistryRecord> {
  const current = await readLpPositionRegistry(agentKey);
  const positions = current?.positions ?? [];
  if (current && positions.some((p) => p.tokenId === tokenId)) {
    // Already tracked — leave addedAt/positions as-is. (poolAddress is
    // immutable for a Uniswap V3 pool, so no refresh needed.)
    return current;
  }
  const record: LpPositionRegistryRecord = {
    agentKey,
    vault: vault.toLowerCase() as Address,
    positions: [
      ...positions,
      { tokenId, poolAddress: poolAddress.toLowerCase() as Address, addedAt: new Date().toISOString() },
    ],
    updatedAt: new Date().toISOString(),
  };
  await writeLpPositionRegistry(record);
  return record;
}

/// Remove a tokenId from the registry. Call this ONLY on a confirmed full-burn
/// zap-out (re-read readLpPositionByTokenId after the tx and remove if it
/// returns undefined — a partial liquidity zap keeps the NFT recorded on-chain,
/// so keeping the registry entry preserves dedup of that pool). Returns null
/// when the registry file is missing (nothing to remove).
export async function removeTokenIdFromRegistry(
  agentKey: Hex,
  tokenId: string,
): Promise<LpPositionRegistryRecord | null> {
  const current = await readLpPositionRegistry(agentKey);
  if (!current) return null;
  if (!current.positions.some((p) => p.tokenId === tokenId)) return current; // not present
  const record: LpPositionRegistryRecord = {
    ...current,
    positions: current.positions.filter((p) => p.tokenId !== tokenId),
    updatedAt: new Date().toISOString(),
  };
  await writeLpPositionRegistry(record);
  return record;
}

export async function listRegistryTokenIds(
  agentKey: Hex,
): Promise<{ tokenId: string; poolAddress: Address }[]> {
  const current = await readLpPositionRegistry(agentKey);
  return (current?.positions ?? []).map((p) => ({ tokenId: p.tokenId, poolAddress: p.poolAddress }));
}

// Duplicated from lib/agent/runtime/lp-store.ts (same 3 helpers appear 4x in the
// repo). Kept module-local to avoid touching lp-store; non-atomic write matches
// the single-writer convention.
function safeArtifactName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/gu, "_").slice(0, 96);
}

async function readJsonArtifact<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw.replace(/^﻿/u, "")) as T;
  } catch {
    return null;
  }
}

async function writeJsonArtifact(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}