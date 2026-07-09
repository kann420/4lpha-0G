import { NextResponse } from "next/server";
import { z } from "zod";
import { isAddress } from "viem";

import { invalidateOgAgentWorkspaceCache, loadOgAgentWorkspace, OgAgentDeployError } from "@/lib/agent/single-agent-server";
import { readMainnetOwnerAddress } from "@/lib/agent/mainnet-vault-resolver";
import { consumeActionNonce } from "@/lib/copilot/action-nonce-store";
import { validateCopilotActionConsent } from "@/lib/copilot/wallet-gate";
import { getOgNetwork } from "@/lib/og/networks";
import { isOgMainnetAgentId } from "@/lib/agent/single-agent";
import { runLpExitForAgent } from "@/lib/agent/lp/lp-exec";
import { recordLpActionHistory } from "@/lib/agent/lp/lp-action-history";
import { findZiaLpVaultByPool } from "@/lib/contracts/zia-lp";
import type { CopilotWalletAccess } from "@/lib/copilot/wallet-access";

export const runtime = "nodejs";

const requestSchema = z.object({
  poolAddress: z.string().refine((v) => isAddress(v), "poolAddress must be a valid address"),
  tokenId: z.string().trim().min(1).max(40),
  wallet: z.object({
    address: z.string().trim().min(1).max(80),
    chainId: z.number().int().positive(),
    message: z.string().trim().min(1).max(800),
    signature: z.string().trim().min(1).max(200),
  }),
  nonce: z.string().trim().min(8).max(64),
  expiresAt: z.number().int().positive(),
});

// POST /api/agents/lp/[id]/stake
// Stakes an existing vault-held LP NFT into the Zia stake vault for its pool.
// Funds-moving consent: validateCopilotActionConsent binds the signature to
// action "lp-stake" + vault + agentId + poolAddress + tokenId + server nonce.
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id: agentId } = await context.params;
  if (!isOgMainnetAgentId(agentId)) {
    return stakeError("invalid_agent_id", "Agent id must match /^agent-0g-mainnet-\\d+$/u.", 400);
  }

  const parsed = requestSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return stakeError("invalid_request", "LP stake request was not valid.", 400);
  }

  const network = getOgNetwork("mainnet");
  const ownerAddress = readMainnetOwnerAddress(parsed.data.wallet.address);
  if (!ownerAddress) {
    return stakeError("invalid_wallet", "Connected wallet address is not valid.", 400);
  }

  const workspace = await loadOgAgentWorkspace({ agentId, live: true, ownerAddress });
  if (workspace.agent.id !== agentId || !workspace.agent.deployment) {
    return stakeError("agent_not_found", "Unknown 0G LP agent id.", 404);
  }
  if ((workspace.vault.vaultVersion ?? 1) < 3 || !workspace.vault.lpAdapter || !workspace.vault.lpPolicy) {
    return stakeError("migrate_to_v3", "LP stake requires a V3 vault with an LP adapter.", 409);
  }
  if (workspace.vault.paused) {
    return stakeError("vault_paused", "Policy Vault is paused; resume before staking.", 409);
  }

  const vaultAddress = workspace.agent.deployment.vault;
  const wallet: CopilotWalletAccess = parsed.data.wallet;
  const consentError = await validateCopilotActionConsent(wallet, "mainnet", network.chainId, {
    action: "lp-stake",
    vault: vaultAddress,
    agentId,
    poolAddress: parsed.data.poolAddress,
    tokenId: parsed.data.tokenId,
    nonce: parsed.data.nonce,
    expiresAt: parsed.data.expiresAt,
  });
  if (consentError) {
    return stakeError(consentError.code, consentError.message, consentError.status);
  }
  const nonceError = consumeActionNonce({
    address: parsed.data.wallet.address,
    expiresAt: parsed.data.expiresAt,
    nonce: parsed.data.nonce,
    scope: "lp-stake",
  });
  if (nonceError) {
    return stakeError(nonceError.code, nonceError.message, nonceError.status);
  }

  // Server-side prechecks (the vault enforces on-chain; these catch obvious
  // violations before the executor spends gas).
  const position = (workspace.vault.sellableLpPositions ?? []).find(
    (p) => p.tokenId === parsed.data.tokenId
      && p.poolAddress.toLowerCase() === parsed.data.poolAddress.toLowerCase(),
  );
  if (!position) {
    return stakeError("position_not_found", `LP position #${parsed.data.tokenId} not found in this vault.`, 404);
  }
  if (position.staked) {
    return stakeError("already_staked", `Position #${parsed.data.tokenId} is already staked.`, 409);
  }
  if (!workspace.vault.lpPolicy.allowStaking) {
    return stakeError("staking_disabled", "Vault lpPolicy does not allow staking.", 409);
  }
  if (!findZiaLpVaultByPool(parsed.data.poolAddress)) {
    return stakeError("pool_not_zappable", "No Zia stake vault mapped for this pool.", 400);
  }

  try {
    const result = await runLpExitForAgent({
      deployment: workspace.agent.deployment,
      kind: "stake",
      poolAddress: parsed.data.poolAddress,
      tokenId: parsed.data.tokenId,
    });
    await recordLpActionHistory({
      brainSummary: "Manual stake submitted from the LP agent detail page.",
      decision: "stake",
      deployment: workspace.agent.deployment,
      lpTxHash: result.lpTxHash,
      poolAddress: result.poolAddress,
      proofTxHash: result.proofTxHash,
      tokenId: result.tokenId,
      vault: vaultAddress,
    }).catch(() => undefined);
    invalidateOgAgentWorkspaceCache();
    return NextResponse.json(
      {
        data: {
          lpTxHash: result.lpTxHash,
          proofTxHash: result.proofTxHash,
          tokenId: result.tokenId,
          poolAddress: result.poolAddress,
        },
        meta: { network: "mainnet", chainId: network.chainId },
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof OgAgentDeployError) {
      return stakeError(error.code, error.message, error.status);
    }
    return stakeError("stake_failed", error instanceof Error ? error.message : "Unable to stake LP NFT.", 500);
  }
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

function stakeError(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message } }, { status });
}
