import "server-only";

import { isHex, type Hex } from "viem";

/**
 * Download a file from 0G Storage by its Merkle rootHash.
 *
 * Uses the indexer's `downloadToBlob` (browser + Node safe), which the smoke
 * script (scripts/smoke-storage.ts) already exercises with byte-for-byte
 * verification. The server fetches ciphertext by rootHash and returns the raw
 * bytes; decryption happens client-side with the wallet-derived key (the server
 * is ciphertext-only).
 */
export async function downloadBytesFrom0GStorage(rootHash: Hex): Promise<Uint8Array> {
  if (!isHex(rootHash, { strict: true }) || rootHash.length !== 66) {
    throw new Error("rootHash must be a 32-byte hex string.");
  }

  const indexerUrl = requireEnv("OG_STORAGE_INDEXER_URL");
  const { Indexer } = await import("@0gfoundation/0g-storage-ts-sdk");
  const indexer = new Indexer(indexerUrl);
  const [blob, downloadError] = await indexer.downloadToBlob(rootHash, { proof: true });
  if (downloadError !== null || blob === null) {
    throw downloadError ?? new Error(`Failed to download 0G Storage file: ${rootHash}`);
  }
  return new Uint8Array(await blob.arrayBuffer());
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}