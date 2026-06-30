import { NextResponse } from "next/server";
import { isHex, type Hex } from "viem";
import { z } from "zod";
import { loadOgAgentWorkspace, readAgentKeyEnabled, removeSingleOgAgentRecord } from "@/lib/agent/single-agent-server";
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
  agentId: z.string().trim().min(1).max(96),
  agentKeyDisableTxHash: z.string().trim().optional(),
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

  const ownerAddress = readMainnetOwnerAddress(parsed.data.wallet.address);
  if (!ownerAddress) {
    return removeError("invalid_wallet", "Connected wallet address is not valid.", 400);
  }
  const workspace = await loadOgAgentWorkspace({ agentId: parsed.data.agentId, live: true, ownerAddress });
  if (workspace.agent.id !== parsed.data.agentId || !workspace.agent.deployment) {
    return removeError("agent_not_found", "Unknown 0G agent id.", 404);
  }
  if (workspace.agent.status === "removed") {
    return NextResponse.json({ data: { removed: workspace.agent.deployment, workspace } });
  }

  const owner = workspace.agent.deployment?.owner ?? workspace.vault.owner;
  if (!owner) {
    return removeError("owner_unavailable", "Agent owner could not be verified before remove.", 409);
  }
  if (owner.toLowerCase() !== parsed.data.wallet.address.toLowerCase()) {
    return removeError("owner_required", "Connect the Policy Vault owner wallet before removing this agent.", 403);
  }
  if ((workspace.vault.vaultVersion ?? 1) >= 2) {
    const hasOpenPosition = (workspace.vault.sellablePositions ?? []).some((position) => {
      try {
        return BigInt(position.amountRaw) > 0n;
      } catch {
        return false;
      }
    });
    if (hasOpenPosition) {
      return removeError("open_positions", "Sell this agent's open V2 positions before removing it.", 409);
    }
    if (!workspace.vault.vault) {
      return removeError("vault_unavailable", "Policy Vault address is required before removing this agent.", 409);
    }
    if (!process.env.OG_RPC_URL?.trim()) {
      return removeError("rpc_unavailable", "0G RPC is required to verify the V2 agent key before removing this agent.", 409);
    }
    const agentKeyEnabled = await readAgentKeyEnabled(workspace.vault.vault, workspace.agent.deployment).catch(() => undefined);
    if (agentKeyEnabled !== false) {
      return removeError("agent_key_enabled", "Disable this V2 agent key before removing the agent record.", 409);
    }
  }

  const agentKeyDisableTxHash = parseTxHash(parsed.data.agentKeyDisableTxHash);
  if (parsed.data.agentKeyDisableTxHash && !agentKeyDisableTxHash) {
    return removeError("invalid_tx_hash", "Agent key disable transaction hash was not valid.", 400);
  }
  const removed = await removeSingleOgAgentRecord(
    parsed.data.agentId,
    workspace.agent.deployment,
    ownerAddress,
    agentKeyDisableTxHash,
  );
  const nextWorkspace = await loadOgAgentWorkspace({ live: true, ownerAddress });
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

function parseTxHash(value: string | undefined): Hex | undefined {
  return value && isHex(value, { strict: true }) && value.length === 66 ? value : undefined;
}
