import { NextResponse } from "next/server";
import { z } from "zod";
import {
  assertAgentTypeQuota,
  deploySingleOgAgent,
  invalidateOgAgentWorkspaceCache,
  loadOgAgentWorkspace,
  OgAgentDeployError,
} from "@/lib/agent/single-agent-server";
import { readMainnetOwnerAddress } from "@/lib/agent/mainnet-vault-resolver";
import { OG_AGENT_FILTER_PRESETS, type OgAgentFilterId } from "@/lib/agent/single-agent";
import { validateCopilotWalletGate } from "@/lib/copilot/wallet-gate";
import { getOgNetwork } from "@/lib/og/networks";

export const runtime = "nodejs";

const requestSchema = z.object({
  filterIds: z.array(z.enum(OG_AGENT_FILTER_PRESETS.map((filter) => filter.id) as [OgAgentFilterId, ...OgAgentFilterId[]])).min(1).max(4),
  name: z.string().trim().min(3).max(80),
  runtime: z
    .object({
      maxCapitalPerTrade0G: z.string().trim().max(48).optional(),
      maxHoldingMinutes: z.number().int().min(1).max(24 * 60).optional(),
      maxPositions: z.number().int().min(1).max(5).optional(), // trading agents capped at 5 positions
      signalConfidence: z.number().int().min(1).max(100).optional(),
      slippageBps: z.number().int().min(1).max(1000).optional(),
    })
    .optional(),
  wallet: z.object({
    address: z.string().trim().min(1).max(80),
    chainId: z.number().int().positive(),
    message: z.string().trim().min(1).max(600),
    signature: z.string().trim().min(1).max(200),
  }),
});

export async function POST(request: Request) {
  const parsed = requestSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return deployError("invalid_request", "Agent deploy request was not valid.", 400);
  }
  const network = getOgNetwork("mainnet");
  const walletError = await validateCopilotWalletGate(parsed.data.wallet, "mainnet", network.chainId);
  if (walletError) {
    return deployError(walletError.code, walletError.message, walletError.status);
  }
  const ownerAddress = readMainnetOwnerAddress(parsed.data.wallet.address);
  if (!ownerAddress) {
    return deployError("invalid_wallet", "Connected wallet address is not valid.", 400);
  }
  const currentWorkspace = await loadOgAgentWorkspace({ live: true, ownerAddress });
  const owner = currentWorkspace.agent.deployment?.owner ?? currentWorkspace.vault.owner;
  if (!owner) {
    return deployError("owner_unavailable", "Policy Vault owner must be verified before minting Agentic ID.", 409);
  }
  if (owner.toLowerCase() !== parsed.data.wallet.address.toLowerCase()) {
    return deployError("owner_required", "Connect the Policy Vault owner wallet before minting this Agentic ID.", 403);
  }

  try {
    // Product limit: at most one trading agent per wallet.
    await assertAgentTypeQuota(ownerAddress, "trade");
    const deployment = await deploySingleOgAgent({
      filterIds: parsed.data.filterIds,
      name: parsed.data.name,
      ownerAddress,
      runtime: parsed.data.runtime,
    });
    invalidateOgAgentWorkspaceCache();
    const workspace = await loadOgAgentWorkspace({ agentId: deployment.id, live: true, ownerAddress });
    return NextResponse.json({ data: { deployment, workspace } }, { status: 201 });
  } catch (error) {
    if (error instanceof OgAgentDeployError) {
      return deployError(error.code, error.message, error.status);
    }
    return deployError("deploy_failed", error instanceof Error ? error.message : "Unable to deploy agent.", 500);
  }
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

function deployError(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message } }, { status });
}
