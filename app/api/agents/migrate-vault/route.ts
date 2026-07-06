import { NextResponse } from "next/server";
import { z } from "zod";
import {
  loadOgAgentWorkspace,
  migrateOwnerVaultToV3,
  OgAgentDeployError,
} from "@/lib/agent/single-agent-server";
import { readMainnetOwnerAddress, resolveMainnetV3VaultForOwner } from "@/lib/agent/mainnet-vault-resolver";
import { validateCopilotWalletGate } from "@/lib/copilot/wallet-gate";
import { getOgNetwork } from "@/lib/og/networks";

export const runtime = "nodejs";

const requestSchema = z.object({
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
    return migrateError("invalid_request", "Vault migration request was not valid.", 400);
  }
  const network = getOgNetwork("mainnet");
  const walletError = await validateCopilotWalletGate(parsed.data.wallet, "mainnet", network.chainId);
  if (walletError) {
    return migrateError(walletError.code, walletError.message, walletError.status);
  }
  const ownerAddress = readMainnetOwnerAddress(parsed.data.wallet.address);
  if (!ownerAddress) {
    return migrateError("invalid_wallet", "Connected wallet address is not valid.", 400);
  }

  // Confirm the connected wallet is the Policy Vault owner before re-pointing agents.
  const currentWorkspace = await loadOgAgentWorkspace({ live: true, ownerAddress });
  const owner = currentWorkspace.agent.deployment?.owner ?? currentWorkspace.vault.owner;
  if (!owner) {
    return migrateError("owner_unavailable", "Policy Vault owner must be verified before migration.", 409);
  }
  if (owner.toLowerCase() !== parsed.data.wallet.address.toLowerCase()) {
    return migrateError("owner_required", "Connect the Policy Vault owner wallet before migrating to V3.", 403);
  }
  // V3 is deployer-owned and resolved from the off-chain registry (no on-chain V3
  // factory on mainnet). vaultVersion >= 3 only proves a V3 exists for this owner —
  // the agents may still be bound to a V2 vault, which is exactly the case we migrate.
  // Reject only when every agent already points at the V3 vault.
  const v3Vault = await resolveMainnetV3VaultForOwner(owner);
  if (!v3Vault) {
    return migrateError(
      "v3_vault_not_found",
      "No V3 Policy Vault is registered for this owner. Run npm run vault:mainnet:create:v3 first.",
      409,
    );
  }
  const agentsTotal = currentWorkspace.agents.length;
  const agentsOnV3 = currentWorkspace.agents.filter(
    (agent) => agent.vault.toLowerCase() === v3Vault.toLowerCase(),
  ).length;
  if (agentsTotal > 0 && agentsOnV3 === agentsTotal) {
    return migrateError("already_v3", "All agents are already bound to the V3 Policy Vault.", 409);
  }

  try {
    const result = await migrateOwnerVaultToV3(owner);
    const workspace = await loadOgAgentWorkspace({ live: true, ownerAddress });
    return NextResponse.json(
      {
        data: {
          migration: result,
          workspace,
        },
        meta: { network: { id: "mainnet", chainId: 16661 }, provider: "4lpha-agent-executor" },
      },
      { status: 200 },
    );
  } catch (error) {
    if (error instanceof OgAgentDeployError) {
      return migrateError(error.code, error.message, error.status);
    }
    return migrateError("migration_failed", error instanceof Error ? error.message : "Unable to migrate vault to V3.", 500);
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