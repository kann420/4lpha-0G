import { NextResponse } from "next/server";
import { loadOgAgentWorkspace } from "@/lib/agent/single-agent-server";
import { readMainnetOwnerAddress } from "@/lib/agent/mainnet-vault-resolver";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const agentId = searchParams.get("agentId") ?? undefined;
  const live = isTruthy(searchParams.get("live"));
  const ownerAddress = readMainnetOwnerAddress(searchParams.get("ownerAddress"));
  const workspace = await loadOgAgentWorkspace({ agentId, live, ownerAddress });
  return NextResponse.json({
    data: workspace,
    meta: {
      provider: "4lpha-0g-agent-registry",
    },
  });
}

function isTruthy(value: string | null): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}
