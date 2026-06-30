import { NextResponse } from "next/server";
import { z } from "zod";

import { findSession } from "@/lib/copilot/session-registry";
import { resolveOgComputeRouterConfig } from "@/lib/copilot/router";
import { validateCopilotWalletGate } from "@/lib/copilot/wallet-gate";
import { downloadBytesFrom0GStorage } from "@/lib/og/storage-download";

export const runtime = "nodejs";

const requestSchema = z.object({
  wallet: z.object({
    address: z.string().trim().min(1).max(80),
    chainId: z.number().int().positive(),
    message: z.string().trim().min(1).max(600),
    signature: z.string().trim().min(1).max(200),
  }),
  sessionId: z.string().trim().min(1).max(120),
});

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return sessionError("invalid_request", "Session load request was not valid JSON.", 400);
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return sessionError("invalid_request", "Session load request was not valid.", 400);
  }

  const networkId = "mainnet";
  const config = resolveOgComputeRouterConfig(networkId);
  if ("error" in config) {
    return sessionError(config.error.code, config.error.message, config.error.status);
  }

  const walletError = await validateCopilotWalletGate(parsed.data.wallet, networkId, config.network.chainId);
  if (walletError) {
    return sessionError(walletError.code, walletError.message, walletError.status);
  }

  const walletAddress = parsed.data.wallet.address.toLowerCase();
  const record = await findSession(walletAddress, parsed.data.sessionId);
  if (!record || record.wallet !== walletAddress) {
    return sessionError("session_not_found", "Saved Copilot session was not found.", 404);
  }

  let ciphertext: Uint8Array;
  try {
    ciphertext = await downloadBytesFrom0GStorage(record.rootHash);
  } catch (error) {
    console.error("copilot session load: 0G Storage download failed", error);
    return sessionError("storage_download_failed", "Failed to download the session ciphertext from 0G Storage.", 502);
  }

  // The uploaded envelope is `{"v":1,"iv":"<b64>","ct":"<b64>"}\n`. Parse it back
  // so the client receives the iv and ciphertext it needs for AES-GCM decryption.
  const envelope = parseEnvelope(new TextDecoder().decode(ciphertext));
  if (!envelope) {
    return sessionError("storage_corrupt", "Stored session envelope was unreadable.", 502);
  }

  return NextResponse.json({
    data: {
      sessionId: record.sessionId,
      ciphertextB64: envelope.ct,
      ivB64: envelope.iv,
      record,
    },
    meta: { provider: "0g-compute-router" },
  });
}

function parseEnvelope(text: string): { iv: string; ct: string } | null {
  try {
    const parsed = JSON.parse(text.trim()) as { v?: number; iv?: string; ct?: string };
    if (parsed.v !== 1 || typeof parsed.iv !== "string" || typeof parsed.ct !== "string") {
      return null;
    }
    return { iv: parsed.iv, ct: parsed.ct };
  } catch {
    return null;
  }
}

function sessionError(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message }, meta: { provider: "0g-compute-router" } }, { status });
}