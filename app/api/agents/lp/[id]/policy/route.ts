import { NextResponse } from "next/server";
import { z } from "zod";
import { isAddress } from "viem";

import { readMainnetOwnerAddress } from "@/lib/agent/mainnet-vault-resolver";
import { isOgMainnetAgentId } from "@/lib/agent/single-agent";
import { invalidateOgAgentWorkspaceCache, loadOgAgentWorkspace, setAgentLpRuntimePolicy } from "@/lib/agent/single-agent-server";
import { consumeActionNonce } from "@/lib/copilot/action-nonce-store";
import type { CopilotWalletAccess } from "@/lib/copilot/wallet-access";
import { validateLpPolicyActionConsent } from "@/lib/copilot/wallet-gate";
import { getOgNetwork } from "@/lib/og/networks";

export const runtime = "nodejs";

const requestSchema = z.object({
  lpFence: z.object({
    maxPositions: z.number().int().min(1).max(10),
    maxPerPosition0G: z.string().trim().min(1).max(48),
    minAprPct: z.number().min(0).max(1000).default(0),
    maxAprPct: z.number().min(0).max(1000).nullable().default(null),
  }),
  wallet: z.object({
    address: z.string().trim().min(1).max(80),
    chainId: z.number().int().positive(),
    message: z.string().trim().min(1).max(1_500),
    signature: z.string().trim().min(1).max(200),
  }),
  nonce: z.string().trim().min(8).max(64),
  expiresAt: z.number().int().positive(),
});

// POST /api/agents/lp/[id]/policy
// Update the LP runtime policy on an existing agent. This route intentionally
// does NOT call vault.tightenPolicy: maxPositions, maxPerPosition0G, and APR
// filters are agent runtime settings, while perLpActionCap0G remains only a
// generous vault ceiling/backstop. The connected wallet signs an lp-policy
// consent binding {agentId, vault, maxPositions, maxPerPosition0G, APR band,
// nonce} so a captured signature cannot be replayed to update a different
// agent or policy.
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id: agentId } = await context.params;
  if (!isOgMainnetAgentId(agentId)) {
    return policyError("invalid_agent_id", "Agent id must match /^agent-0g-mainnet-\\d+$/u.", 400);
  }

  const parsed = requestSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return policyError("invalid_request", "LP runtime policy request was not valid.", 400);
  }

  const network = getOgNetwork("mainnet");
  const ownerAddress = readMainnetOwnerAddress(parsed.data.wallet.address);
  if (!ownerAddress || !isAddress(ownerAddress)) {
    return policyError("invalid_wallet", "Connected wallet address is not valid.", 400);
  }

  const workspace = await loadOgAgentWorkspace({ agentId, live: true, ownerAddress });
  if (workspace.agent.id !== agentId || !workspace.agent.deployment) {
    return policyError("agent_not_found", "Unknown 0G LP agent id.", 404);
  }
  if ((workspace.vault.vaultVersion ?? 1) < 3 || !workspace.vault.lpPolicy) {
    return policyError("migrate_to_v3", "LP runtime policy update requires a V3 vault with lpPolicy.", 409);
  }

  const deployment = workspace.agent.deployment;
  const vaultAddress = deployment.vault;
  const vaultOwner = deployment.owner ?? workspace.vault.owner;
  if (!vaultOwner) {
    return policyError("owner_unavailable", "Policy Vault owner must be verified before updating LP runtime policy.", 409);
  }
  if (vaultOwner.toLowerCase() !== parsed.data.wallet.address.toLowerCase()) {
    return policyError("owner_required", "Connect the Policy Vault owner wallet before updating LP runtime policy.", 403);
  }

  const wallet: CopilotWalletAccess = parsed.data.wallet;
  const consentError = await validateLpPolicyActionConsent(wallet, "mainnet", network.chainId, {
    vault: vaultAddress,
    agentId,
    maxPositions: parsed.data.lpFence.maxPositions,
    maxPerPosition0G: parsed.data.lpFence.maxPerPosition0G,
    minAprPct: parsed.data.lpFence.minAprPct,
    maxAprPct: parsed.data.lpFence.maxAprPct,
    nonce: parsed.data.nonce,
    expiresAt: parsed.data.expiresAt,
  });
  if (consentError) {
    return policyError(consentError.code, consentError.message, consentError.status);
  }

  const nonceError = consumeActionNonce({
    address: parsed.data.wallet.address,
    expiresAt: parsed.data.expiresAt,
    nonce: parsed.data.nonce,
    scope: "lp-policy",
  });
  if (nonceError) {
    return policyError(nonceError.code, nonceError.message, nonceError.status);
  }

  try {
    const updated = await setAgentLpRuntimePolicy(agentId, ownerAddress, {
      maxPositions: parsed.data.lpFence.maxPositions,
      maxPerPosition0G: parsed.data.lpFence.maxPerPosition0G,
      minAprPct: parsed.data.lpFence.minAprPct,
      maxAprPct: parsed.data.lpFence.maxAprPct,
    });
    invalidateOgAgentWorkspaceCache();
    return NextResponse.json(
      {
        data: {
          runtime: updated.runtime,
          tightenTxHash: null,
          noChange: false,
        },
        meta: { network: "mainnet", chainId: network.chainId, agentId },
      },
      { status: 200 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "agent_not_found") {
      return policyError("agent_not_found", "Unknown 0G LP agent id.", 404);
    }
    if (message === "owner_mismatch") {
      return policyError("owner_required", "Connect the Policy Vault owner wallet before updating LP runtime policy.", 403);
    }
    return policyError("policy_update_failed", message || "Unable to update LP runtime policy.", 500);
  }
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

function policyError(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message } }, { status });
}
