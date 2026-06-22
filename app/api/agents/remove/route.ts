import { NextResponse } from "next/server";
import { z } from "zod";
import { loadOgAgentWorkspace, removeSingleOgAgentRecord } from "@/lib/agent/single-agent-server";
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
  agentId: z.string().trim().min(1).max(96),
  networkId: z.literal("mainnet"),
  wallet: walletSchema,
});

export async function POST(request: Request) {
  const parsed = requestSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return removeError("invalid_request", "Agent remove request was not valid.", 400);
  }

  const network = getOgNetwork("mainnet");
  const walletError = await validateCopilotWalletGate(parsed.data.wallet, "mainnet", network.chainId);
  if (walletError) {
    return removeError(walletError.code, walletError.message, walletError.status);
  }

  const workspace = await loadOgAgentWorkspace(parsed.data.agentId);
  if (workspace.agent.id !== parsed.data.agentId || !workspace.agent.deployment) {
    return removeError("agent_not_found", "Unknown 0G agent id.", 404);
  }

  const owner = workspace.agent.deployment?.owner ?? workspace.vault.owner;
  if (!owner) {
    return removeError("owner_unavailable", "Agent owner could not be verified before remove.", 409);
  }
  if (owner.toLowerCase() !== parsed.data.wallet.address.toLowerCase()) {
    return removeError("owner_required", "Connect the Policy Vault owner wallet before removing this agent.", 403);
  }

  const removed = await removeSingleOgAgentRecord(parsed.data.agentId, workspace.agent.deployment);
  const nextWorkspace = await loadOgAgentWorkspace();
  return NextResponse.json({ data: { removed, workspace: nextWorkspace } });
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

function removeError(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message } }, { status });
}
