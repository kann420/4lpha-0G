import { NextResponse } from "next/server";
import { isAddress } from "viem";

import { issueActionNonce, maxActionNonceTtlSeconds } from "@/lib/copilot/action-nonce-store";
import { getOgNetwork } from "@/lib/og/networks";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const network = getOgNetwork("mainnet");
  const address = new URL(request.url).searchParams.get("address")?.trim();
  if (!address || !isAddress(address)) {
    return NextResponse.json(
      { error: { code: "wallet_invalid", message: "A valid owner wallet address is required." } },
      { status: 400 },
    );
  }
  const issue = issueActionNonce({ address, scope: "lp-agent-deploy" });
  return NextResponse.json({
    data: issue,
    meta: {
      action: "lp-agent-deploy",
      chainId: network.chainId,
      network: "mainnet",
      maxTtlSeconds: maxActionNonceTtlSeconds(),
    },
  });
}
