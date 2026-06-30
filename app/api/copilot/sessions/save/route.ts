import { NextResponse } from "next/server";
import { z } from "zod";

import { recordSession, findSession } from "@/lib/copilot/session-registry";
import { anchorSessionProof } from "@/lib/copilot/session-proof";
import { resolveOgComputeRouterConfig } from "@/lib/copilot/router";
import { validateCopilotWalletGate } from "@/lib/copilot/wallet-gate";
import { uploadBytesTo0GStorage } from "@/lib/og/storage-upload";
import type { CopilotSessionRegistryRecord } from "@/lib/types";

export const runtime = "nodejs";

const MAX_CIPHERTEXT_BYTES = 256_000;

const requestSchema = z.object({
  wallet: z.object({
    address: z.string().trim().min(1).max(80),
    chainId: z.number().int().positive(),
    message: z.string().trim().min(1).max(600),
    signature: z.string().trim().min(1).max(200),
  }),
  sessionId: z.string().trim().min(1).max(120),
  networkId: z.string().trim().min(1).max(20),
  ciphertextB64: z.string().min(1).max(360_000),
  ivB64: z.string().min(1).max(64),
  messageCount: z.number().int().min(1).max(500),
  model: z.string().trim().min(1).max(160).optional(),
  label: z.string().trim().min(1).max(160).optional(),
  createdAt: z.string().trim().min(1).max(40),
});

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return sessionError("invalid_request", "Session save request was not valid JSON.", 400);
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return sessionError("invalid_request", "Session save request was not valid.", 400);
  }

  // Saved Copilot sessions are mainnet-only: 0G Storage upload + ProofRegistry
  // anchoring both require chain 16661. Force mainnet regardless of the client's
  // networkId field; the wallet gate below enforces the wallet is on mainnet.
  const networkId = "mainnet";
  const chainId = 16661 as const;
  const config = resolveOgComputeRouterConfig(networkId);
  if ("error" in config) {
    return sessionError(config.error.code, config.error.message, config.error.status);
  }

  const walletError = await validateCopilotWalletGate(parsed.data.wallet, networkId, chainId);
  if (walletError) {
    return sessionError(walletError.code, walletError.message, walletError.status);
  }

  const walletAddress = parsed.data.wallet.address.toLowerCase();

  // Fail fast: reject duplicate sessionId before spending gas on upload/proof.
  const existing = await findSession(walletAddress, parsed.data.sessionId).catch(() => undefined);
  if (existing) {
    return sessionError("session_already_exists", "This Copilot session is already saved.", 409);
  }

  const ciphertext = base64ToBytes(parsed.data.ciphertextB64);
  const iv = base64ToBytes(parsed.data.ivB64);
  if (ciphertext.length === 0 || ciphertext.length > MAX_CIPHERTEXT_BYTES) {
    return sessionError("invalid_request", "Ciphertext size is out of range.", 400);
  }
  if (iv.length !== 12) {
    return sessionError("invalid_request", "AES-GCM IV must be 12 bytes.", 400);
  }

  // Re-wrap ciphertext with its IV into a stable envelope so the 0G Storage
  // Merkle root is deterministic for an identical (iv, ciphertext) pair.
  const envelope = new TextEncoder().encode(
    `${JSON.stringify({ v: 1, iv: parsed.data.ivB64, ct: parsed.data.ciphertextB64 })}\n`,
  );

  let upload;
  try {
    upload = await uploadBytesTo0GStorage(envelope);
  } catch (error) {
    console.error("copilot session save: 0G Storage upload failed", error);
    return sessionError("storage_upload_failed", "0G Storage upload failed.", 502);
  }

  const model = parsed.data.model ?? config.model ?? "auto";
  let proof;
  try {
    proof = await anchorSessionProof({
      sessionId: parsed.data.sessionId,
      rootHash: upload.rootHash,
      storageRef: upload.storageRef,
      model,
      routerBaseUrl: config.auditBaseUrl,
      networkId,
      chainId,
      wallet: walletAddress,
      createdAt: parsed.data.createdAt,
    });
  } catch (error) {
    console.error("copilot session save: proof anchor failed", error);
    // Fail-closed: do NOT write a registry record when anchoring fails.
    return sessionError("proof_anchor_failed", "On-chain proof anchoring failed.", 502);
  }

  const now = new Date().toISOString();
  const record: CopilotSessionRegistryRecord = {
    sessionId: parsed.data.sessionId,
    wallet: walletAddress,
    networkId,
    chainId,
    createdAt: parsed.data.createdAt,
    updatedAt: now,
    mode: "saved",
    model,
    rootHash: upload.rootHash,
    storageRef: upload.storageRef,
    proofTxHash: proof.proofTxHash,
    actionHash: proof.actionHash,
    messageCount: parsed.data.messageCount,
    ...(parsed.data.label ? { label: parsed.data.label } : {}),
  };

  try {
    await recordSession(record);
  } catch (error) {
    const code = (error as Error & { code?: string }).code;
    if (code === "session_already_exists") {
      return sessionError("session_already_exists", "This Copilot session is already saved.", 409);
    }
    console.error("copilot session save: registry write failed", error);
    return sessionError("registry_write_failed", "Failed to record the saved session.", 500);
  }

  return NextResponse.json({
    data: {
      sessionId: record.sessionId,
      rootHash: record.rootHash,
      storageRef: record.storageRef,
      proofTxHash: record.proofTxHash,
      actionHash: record.actionHash,
      savedAt: now,
    },
    meta: { provider: "0g-compute-router" },
  });
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function sessionError(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message }, meta: { provider: "0g-compute-router" } }, { status });
}
