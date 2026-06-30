import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import dotenv from "dotenv";
import { privateKeyToAccount } from "viem/accounts";
import { type Hex } from "viem";

import { buildCopilotSessionKeyMessage } from "@/lib/copilot/wallet-access";
import {
  bytesToBase64,
  base64ToBytes,
  decryptSessionBytes,
  deriveSessionAesKey,
  encryptSessionBytes,
} from "@/lib/copilot/session-key";
import { parseSessionBundle, serializeSessionBundle } from "@/lib/copilot/session-bundle";
import { anchorSessionProof } from "@/lib/copilot/session-proof";
import { recordSession } from "@/lib/copilot/session-registry";
import { downloadBytesFrom0GStorage } from "@/lib/og/storage-download";
import { uploadBytesTo0GStorage } from "@/lib/og/storage-upload";
import type { CopilotSessionBundle, CopilotSessionRegistryRecord } from "@/lib/types";

dotenv.config({ path: ".env.local", quiet: true });

const MAINNET_CHAIN_ID = 16661;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function requireFlag(name: string, expected: boolean): void {
  const value = (process.env[name] ?? "").toLowerCase();
  const enabled = value === "true" || value === "1";
  if (enabled !== expected) {
    throw new Error(`Smoke requires ${name}=${expected ? "true" : "false"}.`);
  }
}

// Guardrails: this smoke uploads to real 0G Storage + anchors a real mainnet tx
// (DEPLOYER pays gas). Require explicit mainnet opt-in.
if ((process.env.OG_NETWORK ?? "").toLowerCase() !== "mainnet") {
  throw new Error("Copilot session smoke requires OG_NETWORK=mainnet.");
}
if (Number(requireEnv("OG_CHAIN_ID")) !== MAINNET_CHAIN_ID) {
  throw new Error(`Copilot session smoke requires OG_CHAIN_ID=${MAINNET_CHAIN_ID}.`);
}
requireFlag("ENABLE_MAINNET_DEPLOY", true);

const privateKey = requireEnv("DEPLOYER_PRIVATE_KEY") as Hex;
const account = privateKeyToAccount(privateKey);
const networkId = "mainnet" as const;
const sessionId = `smoke-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const createdAt = new Date().toISOString();

// 1) Build a sample Copilot session transcript (plaintext, never sent to server).
const bundle: CopilotSessionBundle = {
  schemaVersion: 1,
  kind: "copilot-session",
  sessionId,
  wallet: { address: account.address, chainId: MAINNET_CHAIN_ID, networkId },
  createdAt,
  updatedAt: createdAt,
  mode: "saved",
  model: "smoke-model",
  networkLabel: "0G Mainnet",
  messages: [
    { content: "Summarize the current vault policy.", role: "operator" },
    { content: "Per-trade cap 5 0G, daily cap 25 0G, cooldown 0s.", role: "assistant" },
  ],
  auditBundles: [],
};
const plaintext = serializeSessionBundle(bundle);

// 2) Sign the session-key message and derive the AES-256-GCM key client-side.
const keyMessage = buildCopilotSessionKeyMessage({
  address: account.address,
  chainId: MAINNET_CHAIN_ID,
  networkId,
  sessionId,
});
const signature = (await account.signMessage({ message: keyMessage })) as Hex;
const key = await deriveSessionAesKey(signature);

// 3) Encrypt, then wrap (iv, ciphertext) into the stable envelope the save route uploads.
const { iv, ciphertext } = await encryptSessionBytes(plaintext, key);
const ivB64 = bytesToBase64(iv);
const ctB64 = bytesToBase64(ciphertext);
const envelope = new TextEncoder().encode(`${JSON.stringify({ v: 1, iv: ivB64, ct: ctB64 })}\n`);

// 4) Upload the ciphertext envelope to 0G Storage (DEPLOYER pays).
const upload = await uploadBytesTo0GStorage(envelope);
console.log("uploaded:", { rootHash: upload.rootHash, txHash: upload.txHash, txSeq: upload.txSeq });

// 5) Anchor the proof on-chain via ProofRegistry.acceptProof (DEPLOYER pays gas).
const proof = await anchorSessionProof({
  sessionId,
  rootHash: upload.rootHash,
  storageRef: upload.storageRef,
  model: bundle.model,
  routerBaseUrl: "smoke-router",
  networkId,
  chainId: MAINNET_CHAIN_ID,
  wallet: account.address.toLowerCase(),
  createdAt,
});
console.log("anchored:", { proofTxHash: proof.proofTxHash, actionHash: proof.actionHash });

// 6) Record the saved session in the per-wallet registry.
const record: CopilotSessionRegistryRecord = {
  sessionId,
  wallet: account.address.toLowerCase(),
  networkId,
  chainId: MAINNET_CHAIN_ID,
  createdAt,
  updatedAt: createdAt,
  mode: "saved",
  model: bundle.model,
  rootHash: upload.rootHash,
  storageRef: upload.storageRef,
  proofTxHash: proof.proofTxHash,
  actionHash: proof.actionHash,
  messageCount: bundle.messages.length,
  label: "smoke session",
};
await recordSession(record);

// 7) Download the ciphertext back from 0G Storage by rootHash and decrypt.
const downloaded = await downloadBytesFrom0GStorage(upload.rootHash);
const envelopeText = new TextDecoder().decode(downloaded);
const parsedEnvelope = JSON.parse(envelopeText.trim()) as { v: number; iv: string; ct: string };
if (parsedEnvelope.v !== 1) {
  throw new Error("Downloaded envelope had unexpected schema.");
}
const decrypted = await decryptSessionBytes(
  { iv: base64ToBytes(parsedEnvelope.iv), ciphertext: base64ToBytes(parsedEnvelope.ct) },
  key,
);
const restored = parseSessionBundle(decrypted);
if (JSON.stringify(restored) !== JSON.stringify(bundle)) {
  throw new Error("Decrypted bundle does not match the original.");
}
console.log("decrypt round-trip OK:", { sessionId: restored.sessionId, messages: restored.messages.length });

// 8) RFC 6979 determinism check (local viem signer only): re-sign the same
// session-key message, re-derive the AES key, and confirm it decrypts the same
// ciphertext. This proves the key is reproducible for this signer. MetaMask /
// Ledger must be verified manually in the browser.
const signature2 = (await account.signMessage({ message: keyMessage })) as Hex;
const key2 = await deriveSessionAesKey(signature2);
const decrypted2 = await decryptSessionBytes(
  { iv: base64ToBytes(parsedEnvelope.iv), ciphertext: base64ToBytes(parsedEnvelope.ct) },
  key2,
);
if (JSON.stringify(new TextDecoder().decode(decrypted2)) !== JSON.stringify(new TextDecoder().decode(decrypted))) {
  throw new Error("Re-derived AES key did not reproduce the plaintext (non-deterministic signing).");
}
console.log("RFC 6979 determinism OK on local viem signer.");

const outputPath = join(".data", "copilot-sessions-smoke", "last-result.json");
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(
  outputPath,
  `${JSON.stringify(
    {
      sessionId,
      wallet: account.address.toLowerCase(),
      rootHash: upload.rootHash,
      storageRef: upload.storageRef,
      txHash: upload.txHash,
      txSeq: upload.txSeq,
      proofTxHash: proof.proofTxHash,
      actionHash: proof.actionHash,
      bytes: envelope.length,
    },
    null,
    2,
  )}\n`,
  "utf8",
);
console.log("Copilot session smoke passed. Result:", outputPath);