import { NextResponse } from "next/server";
import { z } from "zod";

import { invalidateOgAgentWorkspaceCache, loadOgAgentWorkspace, OgAgentDeployError } from "@/lib/agent/single-agent-server";
import { readMainnetOwnerAddress } from "@/lib/agent/mainnet-vault-resolver";
import { runVaultMigrateFullFlow, CAP_PRESET } from "@/lib/agent/vault-migrate";
import { consumeActionNonce } from "@/lib/copilot/action-nonce-store";
import type { CopilotWalletAccess } from "@/lib/copilot/wallet-access";
import { validateVaultMigrateActionConsent } from "@/lib/copilot/wallet-gate";
import { getOgNetwork } from "@/lib/og/networks";

export const runtime = "nodejs";

const requestSchema = z.object({
  wallet: z.object({
    address: z.string().trim().min(1).max(80),
    chainId: z.number().int().positive(),
    message: z.string().trim().min(1).max(1_500),
    signature: z.string().trim().min(1).max(200),
  }),
  nonce: z.string().trim().min(8).max(64),
  expiresAt: z.number().int().positive(),
  // Cap preset for the new vault. "1000000" = 1M 0G per-action + daily caps +
  // uint256.max LP exposure (effectively unlimited, AGENTS.md-compliant).
  capPreset: z.enum(["1000000"]).default("1000000"),
  // Explicit user confirmation. Must include "migrate-v3" or the route refuses
  // — guards against an accidental broadcast (real gas + real funds + a new
  // vault deploy + re-pointing every agent).
  confirmedSteps: z.array(z.string().trim().min(1).max(40)).min(0).max(20),
});

// POST /api/vault/migrate-v3
// Full-flow owner-only redeploy + migrate: deploy a NEW PolicyVaultV3 with 1M
// caps, drain the current vault's native 0G, deposit it into the new vault,
// flip the resolver env override (in-memory + persisted to .env.local), and
// re-point every active agent at the new vault. Funds-moving consent: action
// "vault-migrate" + oldVault + capPreset + nonce + expiry. DEPLOYER signs every
// tx (onlyOwner withdraw/deposit + deployContract + setAgentKeyEnabled); the
// orchestrator verifies DEPLOYER === vault.owner on-chain. Never auto-broadcast.
// The autonomous worker picks up the new vault only after a dev restart (the
// worker reads lpPolicy from the resolver-driven workspace, a separate process
// with env loaded at startup) — `restartRequired: true` in the response.
export async function POST(request: Request) {
  const parsed = requestSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return migrateError("invalid_request", "Vault migrate request was not valid.", 400);
  }

  const ownerAddress = readMainnetOwnerAddress(parsed.data.wallet.address);
  if (!ownerAddress) {
    return migrateError("invalid_wallet", "Connected wallet address is not valid.", 400);
  }

  // Load the workspace to resolve the CURRENT vault (the one being abandoned) +
  // the vault owner. The connected wallet must be that owner.
  const currentWorkspace = await loadOgAgentWorkspace({ live: true, ownerAddress });
  const vaultOwner = currentWorkspace.agent.deployment?.owner ?? currentWorkspace.vault.owner;
  if (!vaultOwner) {
    return migrateError("owner_unavailable", "Policy Vault owner must be verified before migration.", 409);
  }
  if (vaultOwner.toLowerCase() !== parsed.data.wallet.address.toLowerCase()) {
    return migrateError("owner_required", "Connect the Policy Vault owner wallet before migrating to a new vault.", 403);
  }
  const oldVault = currentWorkspace.vault.vault;
  if (!oldVault) {
    return migrateError("vault_unavailable", "No current Policy Vault resolved to migrate from.", 409);
  }

  const network = getOgNetwork("mainnet");
  const wallet: CopilotWalletAccess = parsed.data.wallet;
  const consentError = await validateVaultMigrateActionConsent(wallet, "mainnet", network.chainId, {
    oldVault,
    capPreset: parsed.data.capPreset,
    nonce: parsed.data.nonce,
    expiresAt: parsed.data.expiresAt,
  });
  if (consentError) {
    return migrateError(consentError.code, consentError.message, consentError.status);
  }
  const nonceError = consumeActionNonce({
    address: parsed.data.wallet.address,
    expiresAt: parsed.data.expiresAt,
    nonce: parsed.data.nonce,
    scope: "vault-migrate",
  });
  if (nonceError) {
    return migrateError(nonceError.code, nonceError.message, nonceError.status);
  }
  if (!parsed.data.confirmedSteps.includes("migrate-v3")) {
    return migrateError(
      "confirm_required",
      'Confirm the migration by including confirmedSteps:["migrate-v3"].',
      400,
    );
  }

  // Migrate EVERY active agent for the owner — the new vault replaces the old
  // one for all current + future agents.
  const agentIds = currentWorkspace.agents.map((agent) => agent.id);

  try {
    const result = await runVaultMigrateFullFlow({ owner: ownerAddress, oldVault, agentIds });
    invalidateOgAgentWorkspaceCache();
    return NextResponse.json(
      {
        data: result,
        meta: {
          network: "mainnet",
          chainId: network.chainId,
          capPreset: CAP_PRESET,
          restartRequired: true,
          note: "Restart the dev server so the autonomous worker reads the new vault's policy.",
        },
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof OgAgentDeployError) {
      return migrateError(error.code, error.message, error.status);
    }
    return migrateError(
      "migration_failed",
      error instanceof Error ? error.message : "Unable to migrate to a new vault.",
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

function migrateError(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message } }, { status });
}