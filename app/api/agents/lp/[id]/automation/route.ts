import { NextResponse } from "next/server";
import { z } from "zod";

import {
  loadOgAgentWorkspace,
  OgAgentDeployError,
  setAgentAutomation,
} from "@/lib/agent/single-agent-server";
import { readMainnetOwnerAddress } from "@/lib/agent/mainnet-vault-resolver";
import { consumeActionNonce } from "@/lib/copilot/action-nonce-store";
import { validateCopilotActionConsent } from "@/lib/copilot/wallet-gate";
import { getOgNetwork } from "@/lib/og/networks";
import { isOgMainnetAgentId } from "@/lib/agent/single-agent";
import type { CopilotWalletAccess } from "@/lib/copilot/wallet-access";

export const runtime = "nodejs";

const requestSchema = z.object({
  autoMint: z.boolean(),
  wallet: z.object({
    address: z.string().trim().min(1).max(80),
    chainId: z.number().int().positive(),
    message: z.string().trim().min(1).max(800),
    signature: z.string().trim().min(1).max(200),
  }),
  // Server-issued single-use nonce + unix-seconds expiry. The signed message
  // binds action + vault + agentId + desired autoMint state + nonce + expiry.
  nonce: z.string().trim().min(8).max(64),
  expiresAt: z.number().int().positive(),
});

// POST /api/agents/lp/[id]/automation
// Toggles the agent's `runtime.automation.autoMint` flag, which opts the agent
// into (or out of) the autonomous LP mint loop (scripts/og-agent-lp-worker.ts).
// Funds-moving consent: uses validateCopilotActionConsent (NOT the generic
// Copilot-access gate) so the signature is bound to this single action + agent.
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id: agentId } = await context.params;
  if (!isOgMainnetAgentId(agentId)) {
    return automationError("invalid_agent_id", "Agent id must match /^agent-0g-mainnet-\\d+$/u.", 400);
  }

  const parsed = requestSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return automationError("invalid_request", "Automation request was not valid.", 400);
  }

  const network = getOgNetwork("mainnet");
  const ownerAddress = readMainnetOwnerAddress(parsed.data.wallet.address);
  if (!ownerAddress) {
    return automationError("invalid_wallet", "Connected wallet address is not valid.", 400);
  }

  // Resolve the workspace first to surface a clear 404 / migrate_to_v3 before
  // the consent check, and to read the vault address for the consent payload.
  const workspace = await loadOgAgentWorkspace({ agentId, live: true, ownerAddress });
  if (workspace.agent.id !== agentId || !workspace.agent.deployment) {
    return automationError("agent_not_found", "Unknown 0G LP agent id.", 404);
  }
  if ((workspace.vault.vaultVersion ?? 1) < 3 || !workspace.vault.lpAdapter || !workspace.vault.lpPolicy) {
    return automationError("migrate_to_v3", "LP automation requires a V3 vault with an LP adapter.", 409);
  }

  const vaultAddress = workspace.agent.deployment.vault;
  const wallet: CopilotWalletAccess = parsed.data.wallet;
  const consentError = await validateCopilotActionConsent(wallet, "mainnet", network.chainId, {
    action: "lp-automation",
    vault: vaultAddress,
    agentId,
    automationEnabled: parsed.data.autoMint,
    nonce: parsed.data.nonce,
    expiresAt: parsed.data.expiresAt,
  });
  if (consentError) {
    return automationError(consentError.code, consentError.message, consentError.status);
  }
  const nonceError = consumeActionNonce({
    address: parsed.data.wallet.address,
    expiresAt: parsed.data.expiresAt,
    nonce: parsed.data.nonce,
    scope: "lp-automation",
  });
  if (nonceError) {
    return automationError(nonceError.code, nonceError.message, nonceError.status);
  }

  // Owner-only gate: the connected wallet must be the vault owner. The V3
  // singleton owner is the DEPLOYER for the demo; readMainnetOwnerAddress
  // already normalized the connected wallet to the owner address space, and
  // loadOgAgentWorkspace resolves the vault the agent actually trades through.
  const vaultOwner = workspace.vault.owner;
  if (!vaultOwner || vaultOwner.toLowerCase() !== ownerAddress.toLowerCase()) {
    return automationError("owner_required", "Only the vault owner can toggle LP automation.", 403);
  }

  try {
    const updated = await setAgentAutomation(agentId, ownerAddress, parsed.data.autoMint);
    return NextResponse.json(
      {
        data: {
          autoMint: updated.runtime?.automation?.autoMint ?? false,
          agentId: updated.id,
        },
        meta: { network: "mainnet", chainId: network.chainId },
      },
      { status: 200 },
    );
  } catch (error) {
    if (error instanceof OgAgentDeployError) {
      return automationError(error.code, error.message, error.status);
    }
    const message = error instanceof Error ? error.message : "Unable to update automation flag.";
    if (message === "agent_not_found") {
      return automationError("agent_not_found", "Unknown 0G LP agent id.", 404);
    }
    if (message === "owner_mismatch") {
      return automationError("owner_required", "Only the vault owner can toggle LP automation.", 403);
    }
    return automationError("automation_update_failed", message, 500);
  }
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

function automationError(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message } }, { status });
}
