import { NextResponse } from "next/server";

import { loadOgAgentWorkspace } from "@/lib/agent/single-agent-server";
import { readMainnetOwnerAddress } from "@/lib/agent/mainnet-vault-resolver";
import { getOgNetwork } from "@/lib/og/networks";
import { isOgMainnetAgentId } from "@/lib/agent/single-agent";

export const runtime = "nodejs";

// GET /api/agents/lp/[id]/snapshot
// Returns the live workspace + the V3 LP snapshot (lpAdapter, lpPolicy,
// openLpExposure0G, lpDailySpent0G, sellableLpPositions) for an LP agent.
// The workspace already populates the LP fields via readVaultSnapshot
// (single-agent-server.ts); this route is the read-only surface the LP detail
// page polls. vaultVersion < 3 returns 409 'migrate-to-v3' with a hint.
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id: agentId } = await context.params;
  if (!isOgMainnetAgentId(agentId)) {
    return snapshotError("invalid_agent_id", "Agent id must match /^agent-0g-mainnet-\\d+$/u.", 400);
  }

  const url = new URL(request.url);
  const walletRaw = url.searchParams.get("wallet");
  // The wallet gate is normally a signed body; for a GET we accept a raw
  // address query param and rely on the read-only nature of the snapshot
  // (no on-chain writes). The owner check still gates which vault is read.
  const ownerAddress = walletRaw ? readMainnetOwnerAddress(walletRaw) : undefined;
  if (walletRaw && !ownerAddress) {
    return snapshotError("invalid_wallet", "Connected wallet address is not valid.", 400);
  }

  const workspace = await loadOgAgentWorkspace({ agentId, live: true, ownerAddress });
  if (workspace.agent.id !== agentId || !workspace.agent.deployment) {
    return snapshotError("agent_not_found", "Unknown 0G LP agent id.", 404);
  }
  if ((workspace.vault.vaultVersion ?? 1) < 3) {
    return snapshotError(
      "migrate_to_v3",
      "This agent is on a V2 vault. Migrate to the V3 Policy Vault before reading the LP snapshot.",
      409,
    );
  }

  return NextResponse.json({
    data: {
      workspace,
      lpSnapshot: {
        lpAdapter: workspace.vault.lpAdapter,
        lpPolicy: workspace.vault.lpPolicy,
        openLpExposure0G: workspace.vault.openLpExposure0G,
        lpDailySpent0G: workspace.vault.lpDailySpent0G,
        sellableLpPositions: workspace.vault.sellableLpPositions,
      },
    },
    meta: { network: "mainnet", chainId: getOgNetwork("mainnet").chainId },
  });
}

function snapshotError(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message } }, { status });
}