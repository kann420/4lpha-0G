import type { CopilotSessionBundle } from "@/lib/types";

/**
 * Stable serialization for Copilot session bundles.
 *
 * The encrypted session is uploaded to 0G Storage as a single file. To keep the
 * Merkle root deterministic for an identical bundle (so smoke tests and audits
 * can recompute it), we serialize with sorted keys and bigint-as-string. This
 * mirrors the `stableJson` helper in lib/agent/curated-trade.ts but is kept
 * local here to avoid coupling the chat path to the trade-execution module.
 */

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  if (typeof value === "bigint") {
    return JSON.stringify(value.toString());
  }
  return JSON.stringify(value);
}

/** Serialize a session bundle to stable UTF-8 bytes (no trailing newline). */
export function serializeSessionBundle(bundle: CopilotSessionBundle): Uint8Array {
  return new TextEncoder().encode(stableJson(bundle));
}

/** Parse session bundle bytes (UTF-8 JSON) back into a typed bundle. */
export function parseSessionBundle(bytes: Uint8Array): CopilotSessionBundle {
  const text = new TextDecoder().decode(bytes);
  const parsed = JSON.parse(text) as CopilotSessionBundle;
  if (parsed.schemaVersion !== 1 || parsed.kind !== "copilot-session") {
    throw new Error("Invalid Copilot session bundle: unexpected schema.");
  }
  return parsed;
}