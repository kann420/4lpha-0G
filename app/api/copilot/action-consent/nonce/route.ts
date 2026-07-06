import { NextResponse } from "next/server";
import { isAddress } from "viem";

import {
  issueActionNonce,
  isActionNonceScope,
  maxActionNonceTtlSeconds,
} from "@/lib/copilot/action-nonce-store";
import { getOgNetwork } from "@/lib/og/networks";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const network = getOgNetwork("mainnet");
  const url = new URL(request.url);
  const address = url.searchParams.get("address")?.trim();
  const action = url.searchParams.get("action")?.trim();
  if (!address || !isAddress(address)) {
    return NextResponse.json(
      { error: { code: "wallet_invalid", message: "A valid owner wallet address is required." } },
      { status: 400 },
    );
  }
  if (!action || !isActionNonceScope(action)) {
    return NextResponse.json(
      { error: { code: "action_invalid", message: "A supported action scope is required." } },
      { status: 400 },
    );
  }
  const issue = issueActionNonce({ address, scope: action });
  return NextResponse.json({
    data: issue,
    meta: {
      action,
      chainId: network.chainId,
      network: "mainnet",
      maxTtlSeconds: maxActionNonceTtlSeconds(),
    },
  });
}
