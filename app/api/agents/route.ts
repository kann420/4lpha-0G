import { NextResponse } from "next/server";
import { loadOgAgentWorkspace } from "@/lib/agent/single-agent-server";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const agentId = searchParams.get("agentId") ?? undefined;
  const workspace = await loadOgAgentWorkspace(agentId);
  return NextResponse.json({
    data: workspace,
    meta: {
      provider: "4lpha-0g-agent-registry",
    },
  });
}
