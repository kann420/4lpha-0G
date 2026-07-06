import { NextResponse } from "next/server";
import { z } from "zod";
import { isAddress, parseEther, type Hex } from "viem";

import { loadOgAgentWorkspace, OgAgentDeployError } from "@/lib/agent/single-agent-server";
import { readMainnetOwnerAddress } from "@/lib/agent/mainnet-vault-resolver";
import { consumeActionNonce } from "@/lib/copilot/action-nonce-store";
import { validateCopilotActionConsent } from "@/lib/copilot/wallet-gate";
import { getOgNetwork } from "@/lib/og/networks";
import { isOgMainnetAgentId } from "@/lib/agent/single-agent";
import { runLpMintForAgent } from "@/lib/agent/lp/lp-mint";
import { runLpExitForAgent } from "@/lib/agent/lp/lp-exec";
import { recordLpActionHistory } from "@/lib/agent/lp/lp-action-history";
import { findZiaLpVaultByPool } from "@/lib/contracts/zia-lp";

export const runtime = "nodejs";

const requestSchema = z.object({
  poolAddress: z.string().refine((v) => isAddress(v), "poolAddress must be a valid address"),
  tickLower: z.number().int().min(-887_272).max(887_272),
  tickUpper: z.number().int().min(-887_272).max(887_272),
  amount0G: z.string().trim().min(1).max(48),
  llmModel: z.string().trim().max(80).optional(),
  wallet: z.object({
    address: z.string().trim().min(1).max(80),
    chainId: z.number().int().positive(),
    message: z.string().trim().min(1).max(1_200),
    signature: z.string().trim().min(1).max(200),
  }),
  nonce: z.string().trim().min(8).max(64),
  expiresAt: z.number().int().positive(),
});

// POST /api/agents/lp/[id]/mint
// Manual mint (empty-state bootstrap or worker-equivalent). The body supplies
// the pool + tick range + amount (UI-driven); the route validates the pool is
// zappable, then calls runLpMintForAgent which quotes + executes through the
// Policy Vault V3 LP adapter. When lpPolicy.allowStaking is on AND a Zia stake
// vault is mapped for the pool, the mint CHAINS an auto-stake (a separate
// executor tx: stakeLp moves the freshly minted NFT into the Zia vault so it
// earns the advertised staking APR). The stake is best-effort — if it fails the
// mint still succeeded; the response carries staked:false + stakeError so the
// UI can prompt a manual Stake. The lp-mint consent covers the mint+stake flow
// (stake moves the NFT into the Zia vault; no funds leave the vault; the vault
// is deny-by-default and stakeLp is a narrow allowed entrypoint).
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id: agentId } = await context.params;
  if (!isOgMainnetAgentId(agentId)) {
    return mintError("invalid_agent_id", "Agent id must match /^agent-0g-mainnet-\\d+$/u.", 400);
  }

  const parsed = requestSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return mintError("invalid_request", "LP mint request was not valid.", 400);
  }

  const amount = parsePositive0G(parsed.data.amount0G);
  if (amount === null) {
    return mintError("invalid_amount", "amount0G must be a positive decimal string with <= 18 fractional digits.", 400);
  }
  const network = getOgNetwork("mainnet");
  const ownerAddress = readMainnetOwnerAddress(parsed.data.wallet.address);
  if (!ownerAddress) {
    return mintError("invalid_wallet", "Connected wallet address is not valid.", 400);
  }

  const workspace = await loadOgAgentWorkspace({ agentId, live: true, ownerAddress });
  if (workspace.agent.id !== agentId || !workspace.agent.deployment) {
    return mintError("agent_not_found", "Unknown 0G LP agent id.", 404);
  }
  if ((workspace.vault.vaultVersion ?? 1) < 3 || !workspace.vault.lpAdapter || !workspace.vault.lpPolicy) {
    return mintError("migrate_to_v3", "LP mint requires a V3 vault with an LP adapter.", 409);
  }
  const vaultAddress = workspace.agent.deployment.vault;
  const consentError = await validateCopilotActionConsent(parsed.data.wallet, "mainnet", network.chainId, {
    action: "lp-mint",
    vault: vaultAddress,
    agentId,
    poolAddress: parsed.data.poolAddress,
    tickLower: parsed.data.tickLower,
    tickUpper: parsed.data.tickUpper,
    amount0G: parsed.data.amount0G,
    nonce: parsed.data.nonce,
    expiresAt: parsed.data.expiresAt,
  });
  if (consentError) {
    return mintError(consentError.code, consentError.message, consentError.status);
  }
  const nonceError = consumeActionNonce({
    address: parsed.data.wallet.address,
    expiresAt: parsed.data.expiresAt,
    nonce: parsed.data.nonce,
    scope: "lp-mint",
  });
  if (nonceError) {
    return mintError(nonceError.code, nonceError.message, nonceError.status);
  }
  if (workspace.vault.paused) {
    return mintError("vault_paused", "Policy Vault is paused; resume before minting.", 409);
  }
  if (workspace.vault.executorRevoked) {
    return mintError("executor_revoked", "Policy Vault executor is revoked; re-enable before minting.", 409);
  }
  if (workspace.agent.status === "paused") {
    return mintError("agent_paused", "Agent is paused; arm it before minting.", 409);
  }

  const poolAddress = parsed.data.poolAddress;
  if (!findZiaLpVaultByPool(poolAddress)) {
    return mintError("pool_not_zappable", "Pool is not in the vault's W0G-leg allowlist.", 400);
  }
  // The per-card mint is constrained to a pool the agent already has a position
  // in (the card's pool). If the agent has no positions yet, allow any zappable
  // pool — the first mint from the detail page is the bootstrap case.
  const existingPositions = workspace.vault.sellableLpPositions ?? [];
  if (existingPositions.length > 0) {
    const ownsPool = existingPositions.some((p) => p.poolAddress.toLowerCase() === poolAddress.toLowerCase());
    if (!ownsPool) {
      return mintError("pool_not_owned", "Per-card mint is constrained to a pool the agent already has a position in.", 400);
    }
  }

  // UI pre-check against the fence. The vault enforces on-chain; this catches
  // obvious violations before the brain/quote/executor spend gas.
  const lpPolicy = workspace.vault.lpPolicy;
  const openLpExposure0G = workspace.vault.openLpExposure0G ?? "0";
  const perLpActionCap = parseEther(lpPolicy.perLpActionCap0G);
  const maxLpExposure = parseEther(lpPolicy.maxLpExposure0G);
  const openLpExposure = parseEther(openLpExposure0G);
  if (amount <= 0n) {
    return mintError("invalid_amount", "amount0G must be > 0.", 400);
  }
  if (amount > perLpActionCap) {
    return mintError("cap_exceeded", `amount0G exceeds per-position cap (${lpPolicy.perLpActionCap0G} 0G).`, 400);
  }
  if (openLpExposure + amount > maxLpExposure) {
    return mintError("exposure_exceeded", `amount0G exceeds remaining exposure headroom (open ${openLpExposure0G} + ${parsed.data.amount0G} > cap ${lpPolicy.maxLpExposure0G}).`, 400);
  }
  if (parsed.data.tickLower >= parsed.data.tickUpper) {
    return mintError("invalid_range", "tickLower must be < tickUpper.", 400);
  }

  try {
    const result = await runLpMintForAgent({
      deployment: workspace.agent.deployment,
      llmModel: parsed.data.llmModel,
      constrainPoolAddress: poolAddress,
      overrideTickLower: parsed.data.tickLower,
      overrideTickUpper: parsed.data.tickUpper,
      overrideAmount0G: parsed.data.amount0G,
    });

    // Chain auto-stake when the vault policy allows staking AND a Zia stake
    // vault is mapped for this pool AND there is no LP cooldown. Best-effort: a
    // stake failure does NOT fail the mint — the NFT is already minted and
    // vault-held; the owner can retry via the per-position Stake button. The
    // cooldown gate is required: the mint just set lastLpActionAt on-chain, so
    // for any cooldown-gated vault the stakeLp tx is guaranteed to revert with
    // LpCooldownActive — skip auto-stake and leave the position unstaked for a
    // manual Stake after the cooldown (no gas wasted on a guaranteed revert).
    let stakeTxHash: string | undefined;
    let staked = false;
    let stakeError: string | undefined;
    const canAutoStake = Boolean(result.tokenId)
      && lpPolicy.allowStaking
      && Boolean(findZiaLpVaultByPool(result.poolAddress))
      && Number(lpPolicy.cooldownSecondsLp) === 0;
    if (canAutoStake) {
      try {
        const stakeResult = await runLpExitForAgent({
          deployment: workspace.agent.deployment,
          kind: "stake",
          poolAddress: result.poolAddress,
          tokenId: String(result.tokenId),
        });
        stakeTxHash = stakeResult.lpTxHash;
        staked = true;
      } catch (stakeErr) {
        stakeError = stakeErr instanceof Error ? stakeErr.message : "Auto-stake failed; use Stake to retry.";
        // Record the stake failure as a dedicated history entry so it is
        // structurally visible (status:errored), not just free-text in the
        // mint summary. The position is left unstaked + vault-held for manual
        // recovery via the per-position Stake button.
        await recordLpActionHistory({
          decision: "stake",
          status: "errored",
          deployment: workspace.agent.deployment,
          poolAddress: result.poolAddress,
          tokenId: result.tokenId,
          vault: vaultAddress,
          brainSummary: "Auto-stake after mint failed; retry via the Stake button.",
          error: stakeError,
        }).catch(() => undefined);
      }
    }

    const brainSummary = result.brainSummary ?? "Manual LP mint submitted from the agent detail page.";
    const mintSummary = staked
      ? `${brainSummary} minted + staked`
      : stakeError
        ? `${brainSummary} minted (stake failed — use Stake to retry)`
        : brainSummary;
    await recordLpActionHistory({
      amount0G: result.amount0G,
      brainSummary: mintSummary,
      decision: "mint",
      deployment: workspace.agent.deployment,
      lpTxHash: result.lpTxHash,
      model: parsed.data.llmModel,
      poolAddress: result.poolAddress,
      proofTxHash: result.proofTxHash,
      tickLower: result.tickLower,
      tickUpper: result.tickUpper,
      tokenId: result.tokenId,
      vault: vaultAddress,
    }).catch(() => undefined);
    if (staked && stakeTxHash) {
      await recordLpActionHistory({
        brainSummary: "Auto-staked after mint (NFT moved into the Zia stake vault to earn staking APR).",
        decision: "stake",
        deployment: workspace.agent.deployment,
        lpTxHash: stakeTxHash as Hex,
        poolAddress: result.poolAddress,
        tokenId: result.tokenId,
        vault: vaultAddress,
      }).catch(() => undefined);
    }
    return NextResponse.json(
      {
        data: {
          lpTxHash: result.lpTxHash,
          tokenId: result.tokenId,
          liquidity: result.liquidity,
          poolAddress: result.poolAddress,
          tickLower: result.tickLower,
          tickUpper: result.tickUpper,
          amount0G: result.amount0G,
          quoteSource: result.quoteSource,
          staked,
          stakeTxHash,
          stakeError,
        },
        meta: { network: "mainnet", chainId: network.chainId },
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof OgAgentDeployError) {
      return mintError(error.code, error.message, error.status);
    }
    return mintError("mint_failed", error instanceof Error ? error.message : "Unable to mint LP NFT.", 500);
  }
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

function mintError(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message } }, { status });
}

function parsePositive0G(value: string): bigint | null {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{1,18})?$/u.test(normalized)) return null;
  const amount = parseEther(normalized);
  return amount > 0n ? amount : null;
}
