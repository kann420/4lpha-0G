import { NextResponse } from "next/server";
import { z } from "zod";

import { readMainnetOwnerAddress, resolveMainnetV3VaultForOwner } from "@/lib/agent/mainnet-vault-resolver";
import { withdrawMainnetVaultNative } from "@/lib/agent/mainnet-vault-withdraw";
import { invalidateOgAgentWorkspaceCache, loadOgAgentWorkspace, OgAgentDeployError } from "@/lib/agent/single-agent-server";
import { isOgMainnetAgentId } from "@/lib/agent/single-agent";
import { recordLpActionHistory } from "@/lib/agent/lp/lp-action-history";
import { consumeActionNonce } from "@/lib/copilot/action-nonce-store";
import { validateCopilotActionConsent } from "@/lib/copilot/wallet-gate";
import { getOgNetwork } from "@/lib/og/networks";
import type { CopilotWalletAccess } from "@/lib/copilot/wallet-access";

export const runtime = "nodejs";

const requestSchema = z.object({
  agentId: z.string().trim().min(1).max(80).optional(),
  amount0G: z.string().trim().min(1).max(40),
  wallet: z.object({
    address: z.string().trim().min(1).max(80),
    chainId: z.number().int().positive(),
    message: z.string().trim().min(1).max(800),
    signature: z.string().trim().min(1).max(200),
  }),
  nonce: z.string().trim().min(8).max(64),
  expiresAt: z.number().int().positive(),
  // Explicit user confirmation. Must include "withdraw-native" or the route
  // refuses — guards against accidental broadcasts (real gas + real funds).
  confirmedSteps: z.array(z.string().trim().min(1).max(40)).min(0).max(20),
});

// POST /api/vault/withdraw-native
// Owner-only native 0G withdrawal from the V3 Policy Vault. Funds-moving
// consent: action "vault-withdraw-native" + vault + amount0G + nonce + expiry.
// Gated by ENABLE_MAINNET_WITHDRAW=true and confirmedSteps:["withdraw-native"].
// DEPLOYER signs (onlyOwner); the helper verifies the DEPLOYER === vault.owner
// on-chain. Never auto-broadcast.
export async function POST(request: Request) {
  const parsed = requestSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return withdrawError("invalid_request", "Withdraw request was not valid.", 400);
  }
  const amount0G = normalizeAmount0G(parsed.data.amount0G);
  if (amount0G === null) {
    return withdrawError("invalid_amount", "amount0G must be a positive decimal string with <= 18 fractional digits.", 400);
  }

  if ((process.env.ENABLE_MAINNET_WITHDRAW ?? "false").toLowerCase() !== "true") {
    return withdrawError(
      "withdraw_disabled",
      "Owner withdraw is disabled. Set ENABLE_MAINNET_WITHDRAW=true to enable.",
      403,
    );
  }
  if (!parsed.data.confirmedSteps.includes("withdraw-native")) {
    return withdrawError(
      "confirm_required",
      "Confirm the withdrawal by including confirmedSteps:[\"withdraw-native\"].",
      400,
    );
  }

  const ownerAddress = readMainnetOwnerAddress(parsed.data.wallet.address);
  if (!ownerAddress) {
    return withdrawError("invalid_wallet", "Connected wallet address is not valid.", 400);
  }

  // Resolve the V3 vault first so the consent can be bound to its address.
  // resolveMainnetV3VaultForOwner is reused inside the helper, but we call it
  // here to surface v3_vault_not_found BEFORE consent verification.
  const vault = await resolveMainnetV3VaultForOwner(ownerAddress);
  if (!vault) {
    return withdrawError(
      "v3_vault_not_found",
      "No V3 Policy Vault is registered for this owner. Run npm run vault:mainnet:create:v3 first.",
      409,
    );
  }

  const network = getOgNetwork("mainnet");
  const wallet: CopilotWalletAccess = parsed.data.wallet;
  const consentError = await validateCopilotActionConsent(wallet, "mainnet", network.chainId, {
    action: "vault-withdraw-native",
    vault,
    amount0G,
    nonce: parsed.data.nonce,
    expiresAt: parsed.data.expiresAt,
  });
  if (consentError) {
    return withdrawError(consentError.code, consentError.message, consentError.status);
  }
  const nonceError = consumeActionNonce({
    address: parsed.data.wallet.address,
    expiresAt: parsed.data.expiresAt,
    nonce: parsed.data.nonce,
    scope: "vault-withdraw-native",
  });
  if (nonceError) {
    return withdrawError(nonceError.code, nonceError.message, nonceError.status);
  }

  try {
    const result = await withdrawMainnetVaultNative({
      owner: ownerAddress,
      amount0G,
    });
    invalidateOgAgentWorkspaceCache();
    if (parsed.data.agentId && isOgMainnetAgentId(parsed.data.agentId)) {
      const workspace = await loadOgAgentWorkspace({
        agentId: parsed.data.agentId,
        live: true,
        ownerAddress,
      }).catch(() => null);
      const deployment = workspace?.agent.deployment;
      if (deployment && deployment.vault.toLowerCase() === result.vault.toLowerCase()) {
        await recordLpActionHistory({
          amount0G: result.amount0G,
          balanceAfter0G: result.balanceAfter0G,
          balanceBefore0G: result.balanceBefore0G,
          brainSummary: "Owner withdrew idle native 0G from the LP agent detail page.",
          decision: "withdraw-native",
          deployment,
          lpTxHash: result.txHash,
          vault: result.vault,
        }).catch(() => undefined);
      }
    }
    return NextResponse.json(
      {
        data: {
          txHash: result.txHash,
          amount0G: result.amount0G,
          balanceBefore0G: result.balanceBefore0G,
          balanceAfter0G: result.balanceAfter0G,
          vault: result.vault,
        },
        meta: { network: "mainnet", chainId: network.chainId },
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof OgAgentDeployError) {
      return withdrawError(error.code, error.message, error.status);
    }
    return withdrawError(
      "withdraw_failed",
      error instanceof Error ? error.message : "Unable to withdraw native 0G.",
      500,
    );
  }
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

function withdrawError(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message } }, { status });
}

function normalizeAmount0G(value: string): string | null {
  const trimmed = value.trim();
  if (!/^\d+(?:\.\d{1,18})?$/u.test(trimmed)) return null;
  if (/^0+(?:\.0+)?$/u.test(trimmed)) return null;
  return trimmed;
}
