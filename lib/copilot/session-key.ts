import { keccak256, toBytes, type Hex } from "viem";

/**
 * Client-side encryption helpers for Copilot chat sessions.
 *
 * The server cannot derive a wallet secret, so the browser signs a session-key
 * message (see `buildCopilotSessionKeyMessage`), derives an AES-256-GCM key via
 * HKDF-SHA256, and encrypts the session transcript before uploading ciphertext
 * to 0G Storage. The plaintext, the AES key, and the session-key signature never
 * leave the client.
 *
 * This module is isomorphic: it only uses `globalThis.crypto.subtle`, available in
 * browsers and Node 20+. Do not import Node's `crypto` module here - it would
 * break the browser bundle.
 */

const HKDF_SALT_TAG = "4lpha-copilot-session-salt";
const HKDF_INFO = "copilot-session-aes-256-gcm";
const AES_KEY_LENGTH = 256;
const GCM_IV_LENGTH = 12;

function subtle(): SubtleCrypto {
  const cryptoRef = globalThis.crypto;
  if (!cryptoRef?.subtle) {
    throw new Error("WebCrypto subtle API is unavailable in this runtime.");
  }
  return cryptoRef.subtle;
}

function toBufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy;
}

/**
 * Derive an AES-256-GCM CryptoKey from a wallet's session-key signature.
 * The signature is treated as high-entropy key material; HKDF-SHA256 mixes it
 * with a fixed salt and an info label to produce a 256-bit symmetric key.
 */
export async function deriveSessionAesKey(signature: Hex): Promise<CryptoKey> {
  const keyMaterial = await subtle().importKey(
    "raw",
    toBufferSource(toBytes(signature)),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return subtle().deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: toBufferSource(toBytes(keccak256(toBytes(HKDF_SALT_TAG)))),
      info: new TextEncoder().encode(HKDF_INFO),
    },
    keyMaterial,
    { name: "AES-GCM", length: AES_KEY_LENGTH },
    false,
    ["encrypt", "decrypt"],
  );
}

export interface EncryptedSessionBytes {
  iv: Uint8Array;
  ciphertext: Uint8Array;
}

/**
 * Encrypt plaintext bytes with AES-256-GCM using a fresh random 12-byte IV.
 * Returns the IV and ciphertext separately so callers can store/transmit both.
 */
export async function encryptSessionBytes(
  plaintext: Uint8Array,
  key: CryptoKey,
): Promise<EncryptedSessionBytes> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(GCM_IV_LENGTH));
  const ciphertext = await subtle().encrypt({ name: "AES-GCM", iv }, key, toBufferSource(plaintext));
  return { iv, ciphertext: new Uint8Array(ciphertext) };
}

/** Decrypt AES-256-GCM ciphertext with the given IV. */
export async function decryptSessionBytes(
  encrypted: EncryptedSessionBytes,
  key: CryptoKey,
): Promise<Uint8Array> {
  const plaintext = await subtle().decrypt(
    { name: "AES-GCM", iv: toBufferSource(encrypted.iv) },
    key,
    toBufferSource(encrypted.ciphertext),
  );
  return new Uint8Array(plaintext);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i] as number);
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
