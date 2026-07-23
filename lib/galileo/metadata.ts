import "server-only";

import { createHash } from "node:crypto";
import type { Address, Hex } from "viem";

import { GALILEO_CHAIN_ID, GALILEO_NETWORK_ID } from "@/lib/galileo/config";

export interface GalileoAgentMetadataInput {
  agentKey: Hex;
  agentRef: string;
  authorizationDigest: Hex;
  adapter?: Address;
  configurationDigest: Hex;
  createdAt: string;
  executor?: Address;
  filters: readonly string[];
  name: string;
  owner: Address;
  policyHash?: Hex;
  proofRegistry?: Address;
  poolId?: Hex;
  runtime?: {
    maxHoldingMinutes?: number;
    maxPositions?: number;
    maxTrade0G?: string;
    slippageBps?: number;
  };
  vault: Address;
}

export interface GalileoCanonicalMetadata {
  bytes: Uint8Array;
  digest: Hex;
  json: string;
  value: Record<string, unknown>;
}

/**
 * Produces the exact redacted bytes intended for Galileo Storage. This helper
 * has no uploader on purpose: a local agent record may only be created after a
 * future uploader has downloaded and byte-verified these exact bytes.
 */
export function buildGalileoAgentMetadata(input: GalileoAgentMetadataInput): GalileoCanonicalMetadata {
  const value = {
    agentKey: input.agentKey.toLowerCase(),
    agentRef: input.agentRef,
    adapter: input.adapter?.toLowerCase(),
    authorizationDigest: input.authorizationDigest.toLowerCase(),
    configurationDigest: input.configurationDigest.toLowerCase(),
    createdAt: input.createdAt,
    executor: input.executor?.toLowerCase(),
    filters: [...input.filters].sort(),
    name: input.name,
    network: {
      chainId: GALILEO_CHAIN_ID,
      networkId: GALILEO_NETWORK_ID,
    },
    owner: input.owner.toLowerCase(),
    policyHash: input.policyHash?.toLowerCase(),
    proofRegistry: input.proofRegistry?.toLowerCase(),
    poolId: input.poolId?.toLowerCase(),
    runtime: input.runtime ? redactRuntime(input.runtime) : undefined,
    schemaVersion: 1,
    vault: input.vault.toLowerCase(),
  };
  const json = canonicalJson(value);
  const bytes = new TextEncoder().encode(json);
  return {
    bytes,
    digest: sha256Hex(bytes),
    json,
    value: JSON.parse(json) as Record<string, unknown>,
  };
}

/** Stable JSON (sorted object keys, omitted undefineds) used for all bound digests. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256Hex(value: Uint8Array | string): Hex {
  return `0x${createHash("sha256").update(value).digest("hex")}` as Hex;
}

function redactRuntime(runtime: NonNullable<GalileoAgentMetadataInput["runtime"]>) {
  return {
    maxHoldingMinutes: runtime.maxHoldingMinutes,
    maxPositions: runtime.maxPositions,
    maxTrade0G: runtime.maxTrade0G,
    slippageBps: runtime.slippageBps,
  };
}

function canonicalize(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical Galileo metadata cannot contain non-finite numbers.");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  throw new Error("Canonical Galileo metadata contains an unsupported value.");
}
