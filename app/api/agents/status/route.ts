import { NextResponse } from "next/server";
import { z } from "zod";
import { loadOgAgentWorkspace, setSingleOgAgentPaused } from "@/lib/agent/single-agent-server";
import { readMainnetOwnerAddress } from "@/lib/agent/mainnet-vault-resolver";
import { validateCopilotWalletGate } from "@/lib/copilot/wallet-gate";
import { getOgNetwork } from "@/lib/og/networks";

export const runtime = "nodejs";

const walletSchema = z.object({
  address: z.string().trim().min(1).max(80),
  chainId: z.number().int().positive(),
  message: z.string().trim().min(1).max(600),
  signature: z.string().trim().min(1).max(200),
});

const requestSchema = z.object({
  action: z.enum(["arm", "pause"]),
  agentId: z.string().trim().min(1).max(96),
  networkId: z.literal("mainnet"),
  wallet: walletSchema,
});

export async function POST(request: Request) {
  const parsed = requestSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return statusError("invalid_request", "Agent status request was not valid.", 400);
  }

  const network = getOgNetwork("mainnet");
  const walletError = await validateCopilotWalletGate(parsed.data.wallet, "mainnet", network.chainId);
  if (walletError) {
    return statusError(walletError.code, walletError.message, walletError.status);
  }

  const ownerAddress = readMainnetOwnerAddress(parsed.data.wallet.address);
  if (!ownerAddress) {
    return statusError("invalid_wallet", "Connected wallet address is not valid.", 400);
  }
  const workspace = await loadOgAgentWorkspace({ agentId: parsed.data.agentId, live: true, ownerAddress });
  if (workspace.agent.id !== parsed.data.agentId || !workspace.agent.deployment) {
    return statusError("agent_not_found", "Unknown 0G agent id.", 404);
  }
  if (workspace.agent.status === "removed") {
    return statusError("agent_removed", "Removed agent records are read-only and cannot be armed or paused.", 409);
  }

  const owner = workspace.agent.deployment.owner ?? workspace.vault.owner;
  if (!owner) {
    return statusError("owner_unavailable", "Agent owner could not be verified before status update.", 409);
  }
  if (owner.toLowerCase() !== parsed.data.wallet.address.toLowerCase()) {
    return statusError("owner_required", "Connect the Policy Vault owner wallet before updating this agent.", 403);
  }

  const updated = await setSingleOgAgentPaused(
    parsed.data.agentId,
    parsed.data.action === "pause",
    workspace.agent.deployment,
  );
  if (!updated) {
    return statusError("agent_not_found", "Unknown 0G agent id.", 404);
  }

  const nextWorkspace = await loadOgAgentWorkspace({ agentId: parsed.data.agentId, live: true, ownerAddress });
  return NextResponse.json({ data: { deployment: updated, workspace: nextWorkspace } });
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

function statusError(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message } }, { status });
}
