import { NextResponse } from "next/server";
import { z } from "zod";

import { listSessions } from "@/lib/copilot/session-registry";
import { resolveOgComputeRouterConfig } from "@/lib/copilot/router";
import { validateCopilotWalletGate } from "@/lib/copilot/wallet-gate";

export const runtime = "nodejs";

const requestSchema = z.object({
  wallet: z.object({
    address: z.string().trim().min(1).max(80),
    chainId: z.number().int().positive(),
    message: z.string().trim().min(1).max(600),
    signature: z.string().trim().min(1).max(200),
  }),
  networkId: z.string().trim().min(1).max(20).optional(),
});

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return sessionError("invalid_request", "Session list request was not valid JSON.", 400);
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return sessionError("invalid_request", "Session list request was not valid.", 400);
  }

  // Saved sessions are mainnet-only; gate against mainnet.
  const networkId = "mainnet";
  const config = resolveOgComputeRouterConfig(networkId);
  if ("error" in config) {
    return sessionError(config.error.code, config.error.message, config.error.status);
  }

  const walletError = await validateCopilotWalletGate(parsed.data.wallet, networkId, config.network.chainId);
  if (walletError) {
    return sessionError(walletError.code, walletError.message, walletError.status);
  }

  const sessions = await listSessions(parsed.data.wallet.address.toLowerCase());

  return NextResponse.json({
    data: { sessions },
    meta: { provider: "0g-compute-router" },
  });
}

function sessionError(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message }, meta: { provider: "0g-compute-router" } }, { status });
}