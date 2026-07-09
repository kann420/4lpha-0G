// Client-safe shared helpers for the V4 vault migration. This module MUST NOT
// import "server-only" — it is imported by both the server orchestrator
// (`lib/agent/vault-migrate-v4.ts`) and the client wallet hook
// (`components/app/useWalletPolicyVault.ts`) so the per-NFT decisions hash used
// to build the wallet consent signature is byte-identical to the hash the
// server verifies. A mismatch is fail-closed (the execute phase 401s), but
// keeping a single canonicalize implementation removes any drift risk.

import { sha256, stringToBytes, type Address, type Hex } from "viem";

export type PerNftDecision = "preserve" | "exit";

export interface V4VaultTrio {
  swapVault: Address;
  lpEntryVault: Address;
  lpExitVault: Address;
}

// The deployer-owned legacy/stranded V3 vaults eligible for V4 migration this
// phase. Active agents 7-12 stay on their own V3 vaults and are NOT in this set.
export const LEGACY_V3_VAULTS = [
  "0xfd391E8FFC423E2b7493Ea64C517957688B60BF5",
  "0x7a2ADB32053820F573BC2C917e4369940548Ecdc",
  "0xE4c802B58993e49bEFe824ec0765e1128586dB2A",
  "0x2F89D8d03EAb4a5Bd1056A9Cb8706bc7609e1553",
] as const satisfies readonly Address[];

// Deterministic canonical serialization used for hashing. MUST stay identical
// to the server orchestrator's canonicalize (this is now the single source).
export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
      .join(",")}}`;
  }
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  return JSON.stringify(value);
}

// SHA-256 of the canonicalized per-NFT decisions, returned as a 0x-prefixed hex.
// Uses viem's sync sha256 over the UTF-8 bytes — identical output to the server's
// node createHash("sha256").update(canonical).digest("hex").
export function hashPerNftDecisions(decisions: Record<string, PerNftDecision>): Hex {
  return sha256(stringToBytes(canonicalize(decisions))) as Hex;
}