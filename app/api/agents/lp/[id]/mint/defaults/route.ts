import { NextResponse } from "next/server";
import { formatEther, isAddress, parseEther, type Address } from "viem";

import { buildPoolCandidates, makeMainnetPublicClient } from "@/lib/agent/lp/lp-context";
import { MAX_TICK, MIN_TICK, nearestUsableTick } from "@/lib/agent/lp/tick-math";
import { readMainnetOwnerAddress } from "@/lib/agent/mainnet-vault-resolver";
import { isOgMainnetAgentId } from "@/lib/agent/single-agent";
import { loadOgAgentWorkspace } from "@/lib/agent/single-agent-server";
import { policyVaultV3Abi } from "@/lib/contracts/policy-vault-v3";
import { findZiaLpVaultByPool, poolIdFromAddress } from "@/lib/contracts/zia-lp";
import { getOgNetwork } from "@/lib/og/networks";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id: agentId } = await context.params;
  if (!isOgMainnetAgentId(agentId)) {
    return defaultsError("invalid_agent_id", "Agent id must match /^agent-0g-mainnet-\\d+$/u.", 400);
  }

  const url = new URL(request.url);
  const wallet = url.searchParams.get("wallet")?.trim();
  const requestedPool = url.searchParams.get("poolAddress")?.trim();
  if (!wallet || !isAddress(wallet)) {
    return defaultsError("invalid_wallet", "A valid wallet query param is required.", 400);
  }
  if (requestedPool && !isAddress(requestedPool)) {
    return defaultsError("invalid_pool", "poolAddress must be a valid address.", 400);
  }

  const ownerAddress = readMainnetOwnerAddress(wallet);
  if (!ownerAddress) {
    return defaultsError("invalid_wallet", "Connected wallet address is not valid.", 400);
  }

  const workspace = await loadOgAgentWorkspace({ agentId, live: true, ownerAddress });
  if (workspace.agent.id !== agentId || !workspace.agent.deployment) {
    return defaultsError("agent_not_found", "Unknown 0G LP agent id.", 404);
  }
  if ((workspace.vault.vaultVersion ?? 1) < 3 || !workspace.vault.lpAdapter || !workspace.vault.lpPolicy) {
    return defaultsError("migrate_to_v3", "LP mint requires a V3 vault with an LP adapter.", 409);
  }
  if (workspace.vault.paused) {
    return defaultsError("vault_paused", "Policy Vault is paused; resume before minting.", 409);
  }

  const publicClient = makeMainnetPublicClient();
  const pools = await buildPoolCandidates(publicClient, requestedPool as Address | undefined);
  const allowedPools = [];
  for (const candidate of pools) {
    const allowed = await isPoolAllowedForManualMint(publicClient, workspace.agent.deployment.vault, candidate.poolAddress);
    if (allowed) allowedPools.push(candidate);
  }
  const pool = allowedPools[0];
  if (!pool) {
    return defaultsError("pool_not_allowed", "No vault-allowlisted W0G-leg pool is available for this request.", 404);
  }

  const amount = defaultMintAmount0G({
    balance0G: workspace.vault.balance0G,
    maxLpExposure0G: workspace.vault.lpPolicy.maxLpExposure0G,
    openLpExposure0G: workspace.vault.openLpExposure0G,
    perLpActionCap0G: workspace.vault.lpPolicy.perLpActionCap0G,
  });
  if (!amount) {
    return defaultsError("no_mint_headroom", "Vault balance or LP exposure headroom is not enough for a manual mint.", 409);
  }

  const range = deriveManualMintRange(pool.currentTick, pool.tickSpacing, pool.w0gIsToken0);
  const network = getOgNetwork("mainnet");
  return NextResponse.json({
    data: {
      poolAddress: pool.poolAddress,
      poolLabel: pool.label,
      feeTier: pool.feeTier,
      currentTick: pool.currentTick,
      tickSpacing: pool.tickSpacing,
      tickLower: range.tickLower,
      tickUpper: range.tickUpper,
      defaultAmount0G: amount.defaultAmount0G,
      maxAmount0G: amount.maxAmount0G,
    },
    meta: { network: "mainnet", chainId: network.chainId },
  });
}

function defaultMintAmount0G(input: {
  balance0G?: string;
  maxLpExposure0G: string;
  openLpExposure0G?: string;
  perLpActionCap0G: string;
}): { defaultAmount0G: string; maxAmount0G: string } | null {
  const balance = safeParse0G(input.balance0G ?? "0");
  const perCap = safeParse0G(input.perLpActionCap0G);
  const maxExposure = safeParse0G(input.maxLpExposure0G);
  const openExposure = safeParse0G(input.openLpExposure0G ?? "0");
  const remainingExposure = maxExposure > openExposure ? maxExposure - openExposure : 0n;
  const maxAmount = minWei(balance, perCap, remainingExposure);
  if (maxAmount <= 0n) return null;
  const suggested = minWei(maxAmount, parseEther("0.01"));
  if (suggested <= 0n) return null;
  return {
    defaultAmount0G: formatEther(suggested),
    maxAmount0G: formatEther(maxAmount),
  };
}

function deriveManualMintRange(currentTick: number, tickSpacing: number, w0gIsToken0: boolean): { tickLower: number; tickUpper: number } {
  const spacing = Math.max(1, Math.abs(Math.trunc(tickSpacing)));
  const steps = Math.max(2, Math.floor(4_000 / spacing));
  const width = steps * spacing;
  let tickLower: number;
  let tickUpper: number;
  if (w0gIsToken0) {
    tickUpper = nearestUsableTick(currentTick + spacing, spacing);
    tickLower = tickUpper - width;
  } else {
    tickLower = nearestUsableTick(currentTick, spacing);
    tickUpper = tickLower + width;
  }
  if (tickLower >= currentTick) tickLower = nearestUsableTick(currentTick - spacing, spacing);
  if (tickUpper <= currentTick) tickUpper = nearestUsableTick(currentTick + spacing, spacing);
  if (tickUpper <= tickLower) tickUpper = Math.min(MAX_TICK, tickLower + spacing);
  if (tickUpper <= tickLower) tickLower = Math.max(MIN_TICK, tickUpper - spacing);
  return { tickLower, tickUpper };
}

async function isPoolAllowedForManualMint(
  publicClient: ReturnType<typeof makeMainnetPublicClient>,
  vault: Address,
  poolAddress: Address,
): Promise<boolean> {
  const ziaVault = findZiaLpVaultByPool(poolAddress);
  if (!ziaVault) return false;
  const poolId = poolIdFromAddress(poolAddress);
  const [poolAllowed, stakeVaultAllowed] = await Promise.all([
    publicClient.readContract({
      address: vault,
      abi: policyVaultV3Abi,
      functionName: "allowedLpPools",
      args: [poolId],
    }) as Promise<boolean>,
    publicClient.readContract({
      address: vault,
      abi: policyVaultV3Abi,
      functionName: "allowedStakeVaults",
      args: [ziaVault.vaultAddress],
    }) as Promise<boolean>,
  ]);
  return poolAllowed && stakeVaultAllowed;
}

function minWei(first: bigint, ...rest: bigint[]): bigint {
  return rest.reduce((min, value) => (value < min ? value : min), first);
}

function safeParse0G(value: string): bigint {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{1,18})?$/u.test(normalized)) return 0n;
  return parseEther(normalized);
}

function defaultsError(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message } }, { status });
}
