import { NextResponse } from "next/server";
import { z } from "zod";
import { isAddress } from "viem";

import { deployLpAgent, type LpDeployStep } from "@/lib/agent/lp/lp-deploy";
import { assertAgentTypeQuota, invalidateOgAgentWorkspaceCache, loadOgAgentWorkspace, OgAgentDeployError } from "@/lib/agent/single-agent-server";
import { readMainnetOwnerAddress } from "@/lib/agent/mainnet-vault-resolver";
import { consumeActionNonce } from "@/lib/copilot/action-nonce-store";
import { normalizeLpDeployConsentSteps, type LpDeployConsentStep } from "@/lib/copilot/wallet-access";
import { validateLpDeployActionConsent } from "@/lib/copilot/wallet-gate";
import { resolveOgComputeRouterConfig } from "@/lib/copilot/router";
import { getOgNetwork } from "@/lib/og/networks";

export const runtime = "nodejs";

const stepSchema = z.enum([
  "mint-agentic-id",
  "enable-agent-key",
  "tighten-policy",
  "deposit-native",
  "fund-lp-entry-from-v4-swap",
  "first-mint",
] as const);

const requestSchema = z.object({
  name: z.string().trim().min(3).max(80),
  lpFence: z.object({
    maxPositions: z.number().int().min(1).max(10),
    maxPerPosition0G: z.string().trim().min(1).max(48),
    minAprPct: z.number().min(0).max(1000).default(0),
    maxAprPct: z.number().min(0).max(1000).nullable().default(null),
  }),
  depositNative0G: z.string().trim().min(1).max(48),
  fundLpEntryFromSwap0G: z.string().trim().min(1).max(48).optional().default("0"),
  llmModel: z.string().trim().max(80).optional(),
  confirmedSteps: z.array(stepSchema).min(1),
  triggerFirstMint: z.boolean().default(false),
  nonce: z.string().trim().min(1).max(80),
  expiresAt: z.number().int().positive(),
  wallet: z.object({
    address: z.string().trim().min(1).max(80),
    chainId: z.number().int().positive(),
    message: z.string().trim().min(1).max(1_500),
    signature: z.string().trim().min(1).max(200),
  }),
});

export async function POST(request: Request) {
  const parsed = requestSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return deployError("invalid_request", "LP agent deploy request was not valid.", 400);
  }
  const network = getOgNetwork("mainnet");
  const depositNative0G = normalizeDepositNative0G(parsed.data.depositNative0G);
  if (depositNative0G === null) {
    return deployError("invalid_request", "depositNative0G must be a decimal string with <= 18 fractional digits.", 400);
  }
  const fundLpEntryFromSwap0G = normalizeDepositNative0G(parsed.data.fundLpEntryFromSwap0G);
  if (fundLpEntryFromSwap0G === null) {
    return deployError("invalid_request", "fundLpEntryFromSwap0G must be a decimal string with <= 18 fractional digits.", 400);
  }
  const confirmedSteps = normalizeLpDeployConsentSteps(parsed.data.confirmedSteps as LpDeployConsentStep[]) as LpDeployStep[];
  const stepError = validateConfirmedSteps({
    confirmedSteps,
    depositNative0G,
    fundLpEntryFromSwap0G,
    triggerFirstMint: parsed.data.triggerFirstMint,
  });
  if (stepError) {
    return deployError(stepError.code, stepError.message, stepError.status);
  }

  const ownerAddress = readMainnetOwnerAddress(parsed.data.wallet.address);
  if (!ownerAddress || !isAddress(ownerAddress)) {
    return deployError("invalid_wallet", "Connected wallet address is not valid.", 400);
  }

  // The wallet must be the vault owner — tighten/deposit are onlyOwner.
  const currentWorkspace = await loadOgAgentWorkspace({ live: true, ownerAddress });
  const vaultOwner = currentWorkspace.agent.deployment?.owner ?? currentWorkspace.vault.owner;
  if (!vaultOwner) {
    return deployError("owner_unavailable", "Policy Vault owner must be verified before deploying an LP agent.", 409);
  }
  if (vaultOwner.toLowerCase() !== parsed.data.wallet.address.toLowerCase()) {
    return deployError("owner_required", "Connect the Policy Vault owner wallet before deploying an LP agent.", 403);
  }
  if (!currentWorkspace.vault.vault) {
    return deployError("vault_unavailable", "Policy Vault address must be resolved before deploying an LP agent.", 409);
  }

  // Product limit: at most one LP agent per wallet. Checked before consuming the consent nonce.
  try {
    await assertAgentTypeQuota(ownerAddress, "lp");
  } catch (error) {
    if (error instanceof OgAgentDeployError) {
      return deployError(error.code, error.message, error.status);
    }
    throw error;
  }

  const consentError = await validateLpDeployActionConsent(parsed.data.wallet, "mainnet", network.chainId, {
    vault: currentWorkspace.vault.vault,
    agentName: parsed.data.name,
    maxPositions: parsed.data.lpFence.maxPositions,
    maxPerPosition0G: parsed.data.lpFence.maxPerPosition0G,
    minAprPct: parsed.data.lpFence.minAprPct,
    maxAprPct: parsed.data.lpFence.maxAprPct,
    depositNative0G,
    fundLpEntryFromSwap0G,
    confirmedSteps,
    triggerFirstMint: parsed.data.triggerFirstMint,
    nonce: parsed.data.nonce,
    expiresAt: parsed.data.expiresAt,
  });
  if (consentError) {
    return deployError(consentError.code, consentError.message, consentError.status);
  }
  const nonceError = consumeActionNonce({
    address: parsed.data.wallet.address,
    expiresAt: parsed.data.expiresAt,
    nonce: parsed.data.nonce,
    scope: "lp-agent-deploy",
  });
  if (nonceError) {
    return deployError(nonceError.code, nonceError.message, nonceError.status);
  }

  try {
    const result = await deployLpAgent({
      name: parsed.data.name,
      ownerAddress,
      lpFence: parsed.data.lpFence,
      depositNative0G,
      fundLpEntryFromSwap0G,
      llmModel: parsed.data.llmModel,
      confirmedSteps,
      triggerFirstMint: parsed.data.triggerFirstMint,
    });
    invalidateOgAgentWorkspaceCache();
    const workspace = await loadOgAgentWorkspace({ agentId: result.deployment.id, live: true, ownerAddress });
    return NextResponse.json(
      {
        data: {
          deployment: result.deployment,
          tightenTxHash: result.tightenTxHash,
          depositTxHash: result.depositTxHash,
          lpEntryFundFromSwap: result.lpEntryFundFromSwap,
          firstMint: result.firstMint,
          firstMintError: result.firstMintError,
          firstMintRun: result.firstMintRun,
          firstMintSummary: result.firstMintSummary,
          stepsExecuted: result.stepsExecuted,
          workspace,
        },
        meta: { network: "mainnet", chainId: network.chainId, stepsExecuted: result.stepsExecuted },
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof OgAgentDeployError) {
      return deployError(error.code, error.message, error.status);
    }
    return deployError("deploy_failed", error instanceof Error ? error.message : "Unable to deploy LP agent.", 500);
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

function normalizeDepositNative0G(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return "0";
  if (!/^\d+(?:\.\d{1,18})?$/u.test(trimmed)) return null;
  return trimmed;
}

function isZeroDecimal(value: string): boolean {
  return /^0+(?:\.0+)?$/u.test(value);
}

function validateConfirmedSteps({
  confirmedSteps,
  depositNative0G,
  fundLpEntryFromSwap0G,
  triggerFirstMint,
}: {
  confirmedSteps: readonly LpDeployStep[];
  depositNative0G: string;
  fundLpEntryFromSwap0G: string;
  triggerFirstMint: boolean;
}): { code: string; message: string; status: number } | undefined {
  const confirmed = new Set(confirmedSteps);
  if (confirmed.has("tighten-policy")) {
    return {
      code: "deprecated_step",
      message: "tighten-policy is deprecated for LP agents. maxPositions and maxPerPosition0G are stored in agent runtime; remove tighten-policy and resubmit.",
      status: 400,
    };
  }
  if (!confirmed.has("mint-agentic-id") || !confirmed.has("enable-agent-key")) {
    return {
      code: "missing_confirmation",
      message: "confirmedSteps must include mint-agentic-id and enable-agent-key.",
      status: 400,
    };
  }
  const depositRequested = !isZeroDecimal(depositNative0G);
  if (depositRequested && !confirmed.has("deposit-native")) {
    return {
      code: "missing_confirmation",
      message: "deposit-native must be confirmed when depositNative0G is greater than zero.",
      status: 400,
    };
  }
  if (!depositRequested && confirmed.has("deposit-native")) {
    return {
      code: "invalid_request",
      message: "deposit-native requires depositNative0G greater than zero.",
      status: 400,
    };
  }
  const fundFromSwapRequested = !isZeroDecimal(fundLpEntryFromSwap0G);
  if (fundFromSwapRequested && !confirmed.has("fund-lp-entry-from-v4-swap")) {
    return {
      code: "missing_confirmation",
      message: "fund-lp-entry-from-v4-swap must be confirmed when fundLpEntryFromSwap0G is greater than zero.",
      status: 400,
    };
  }
  if (!fundFromSwapRequested && confirmed.has("fund-lp-entry-from-v4-swap")) {
    return {
      code: "invalid_request",
      message: "fund-lp-entry-from-v4-swap requires fundLpEntryFromSwap0G greater than zero.",
      status: 400,
    };
  }
  if (confirmed.has("first-mint")) {
    if (!triggerFirstMint) {
      return { code: "invalid_request", message: "first-mint requires triggerFirstMint=true.", status: 400 };
    }
    if (process.env.AGENT_TRADE_LIVE_ENABLED !== "true") {
      return {
        code: "first_mint_not_ready",
        message: "first-mint requires AGENT_TRADE_LIVE_ENABLED=true.",
        status: 409,
      };
    }
    const routerConfig = resolveOgComputeRouterConfig("mainnet");
    if ("error" in routerConfig) {
      return {
        code: "first_mint_not_ready",
        message: routerConfig.error.message,
        status: routerConfig.error.status,
      };
    }
  }
  return undefined;
}
