import { NextResponse } from "next/server";
import { z } from "zod";
import { formatEther, isAddress } from "viem";

import { invalidateOgAgentWorkspaceCache, loadOgAgentWorkspace, OgAgentDeployError } from "@/lib/agent/single-agent-server";
import { readMainnetOwnerAddress } from "@/lib/agent/mainnet-vault-resolver";
import { consumeActionNonce } from "@/lib/copilot/action-nonce-store";
import { validateCopilotActionConsent } from "@/lib/copilot/wallet-gate";
import { getOgNetwork } from "@/lib/og/networks";
import { isOgMainnetAgentId } from "@/lib/agent/single-agent";
import { runLpExitForAgent } from "@/lib/agent/lp/lp-exec";
import { recordLpActionHistory } from "@/lib/agent/lp/lp-action-history";
import { quoteLpZapOut } from "@/lib/agent/lp/lp-zapout-quote";
import { makeMainnetPublicClient } from "@/lib/agent/lp/lp-context";
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

// POST /api/agents/lp/[id]/zap-out
// Burns a vault-held (non-staked) LP NFT, swaps the paired leg back to W0G,
// unwraps, and returns native 0G to the vault. Funds-moving consent: action
// "lp-zap-out" + vault + agentId + tokenId + nonce + expiry. The quote mirrors
// the on-chain adapter path (decreaseLiquidity → swap → unwrap → native out);
// amountOutMin is the nonzero native-out floor (the only slippage protection).
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id: agentId } = await context.params;
  if (!isOgMainnetAgentId(agentId)) {
    return zapOutError("invalid_agent_id", "Agent id must match /^agent-0g-mainnet-\\d+$/u.", 400);
  }

  const parsed = requestSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return zapOutError("invalid_request", "LP zap-out request was not valid.", 400);
  }

  const network = getOgNetwork("mainnet");
  const ownerAddress = readMainnetOwnerAddress(parsed.data.wallet.address);
  if (!ownerAddress) {
    return zapOutError("invalid_wallet", "Connected wallet address is not valid.", 400);
  }

  const workspace = await loadOgAgentWorkspace({ agentId, live: true, ownerAddress });
  if (workspace.agent.id !== agentId || !workspace.agent.deployment) {
    return zapOutError("agent_not_found", "Unknown 0G LP agent id.", 404);
  }
  if ((workspace.vault.vaultVersion ?? 1) < 3 || !workspace.vault.lpAdapter || !workspace.vault.lpPolicy) {
    return zapOutError("migrate_to_v3", "LP zap-out requires a V3 vault with an LP adapter.", 409);
  }
  if (workspace.vault.paused) {
    return zapOutError("vault_paused", "Policy Vault is paused; resume before zap-out.", 409);
  }

  const vaultAddress = workspace.agent.deployment.vault;
  const wallet: CopilotWalletAccess = parsed.data.wallet;
  const consentError = await validateCopilotActionConsent(wallet, "mainnet", network.chainId, {
    action: "lp-zap-out",
    vault: vaultAddress,
    agentId,
    poolAddress: parsed.data.poolAddress,
    tokenId: parsed.data.tokenId,
    nonce: parsed.data.nonce,
    expiresAt: parsed.data.expiresAt,
  });
  if (consentError) {
    return zapOutError(consentError.code, consentError.message, consentError.status);
  }
  const nonceError = consumeActionNonce({
    address: parsed.data.wallet.address,
    expiresAt: parsed.data.expiresAt,
    nonce: parsed.data.nonce,
    scope: "lp-zap-out",
  });
  if (nonceError) {
    return zapOutError(nonceError.code, nonceError.message, nonceError.status);
  }

  // Precheck: position exists AND is not staked. Staked positions report
  // liquidity 0 and the vault zapOut only accepts vault-held NFTs.
  const position = (workspace.vault.sellableLpPositions ?? []).find(
    (p) => p.tokenId === parsed.data.tokenId
      && p.poolAddress.toLowerCase() === parsed.data.poolAddress.toLowerCase(),
  );
  if (!position) {
    return zapOutError("position_not_found", `LP position #${parsed.data.tokenId} not found in this vault.`, 404);
  }
  if (position.staked) {
    return zapOutError(
      "staked_position_not_zappable",
      `Position #${parsed.data.tokenId} is staked; unstake it before zap-out.`,
      409,
    );
  }

  const lpPolicy = workspace.vault.lpPolicy;
  let quote;
  try {
    const publicClient = makeMainnetPublicClient();
    quote = await quoteLpZapOut({
      publicClient,
      poolAddress: parsed.data.poolAddress,
      tokenId: parsed.data.tokenId,
      liquidity: BigInt(position.liquidity),
      tickLower: position.tickLower,
      tickUpper: position.tickUpper,
      lpMinOutBps: lpPolicy.lpMinOutBps,
    });
  } catch (error) {
    return zapOutError(
      "zap_out_quote_failed",
      error instanceof Error ? error.message : "Unable to compute the zap-out quote.",
      500,
    );
  }

  try {
    const result = await runLpExitForAgent({
      deployment: workspace.agent.deployment,
      kind: "zap-out",
      poolAddress: parsed.data.poolAddress,
      tokenId: parsed.data.tokenId,
      quotedAmountOut: quote.quotedAmountOut,
      amountOutMin: quote.amountOutMin,
      quotedSqrtPriceX96: quote.sqrtPriceX96,
    });
    await recordLpActionHistory({
      amount0G: result.amountOutMin !== undefined ? formatEther(result.amountOutMin) : undefined,
      brainSummary: "Manual zap-out submitted from the LP agent detail page.",
      decision: "zap-out",
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
          amountOutMin: result.amountOutMin?.toString(),
          quoteSource: "server-floor",
        },
        meta: { network: "mainnet", chainId: network.chainId },
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof OgAgentDeployError) {
      return zapOutError(error.code, error.message, error.status);
    }
    return zapOutError("zap_out_failed", error instanceof Error ? error.message : "Unable to zap out LP NFT.", 500);
  }
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

function zapOutError(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message } }, { status });
}
