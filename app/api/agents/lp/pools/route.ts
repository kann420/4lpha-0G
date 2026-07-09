import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import type { Address } from "viem";

import { buildPoolCandidateDiscovery, makeMainnetPublicClient } from "@/lib/agent/lp/lp-context";
import { MOCK_LP_POOLS, type LpPoolOption, type LpPoolTickAprPoint } from "@/lib/agent/lp/mock-lp-data";
import { zappableZiaLpVaults } from "@/lib/contracts/zia-lp";

// GET /api/agents/lp/pools?minAprPct=&maxAprPct=
// Returns live Zia pool discovery intersected with the vault-allowlisted W0G-leg
// pools. The LP worker uses the same discovery helper, so APR filtering does
// not drift between create UI and autonomous execution.

const MAINNET_CHAIN_ID = 16661;
const MIN_TICK = -887_220;
const MAX_TICK = 887_220;

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const minAprPct = parseNonNegNumber(url.searchParams.get("minAprPct"), 0);
  const maxAprPct = parseNonNegNumber(url.searchParams.get("maxAprPct"), Infinity);

  try {
    const vaultByPool = new Map(zappableZiaLpVaults().map((vault) => [vault.poolAddress.toLowerCase(), vault]));
    const discovery = await buildPoolCandidateDiscovery(makeMainnetPublicClient());
    const enriched = discovery.candidates.map((pool): LpPoolOption => {
      const vaultCfg = vaultByPool.get(pool.poolAddress.toLowerCase());
      const stakingApr = pool.stakingAprPct;
      return {
        poolAddress: pool.poolAddress,
        label: pool.label,
        feeLabel: vaultCfg?.feeLabel ?? `${pool.feeTier / 10_000}%`,
        feeTier: pool.feeTier,
        vaultAddress: vaultCfg?.vaultAddress ?? ("0x0000000000000000000000000000000000000000" as Address),
        aprPct: stakingApr,
        tvl0G: formatUsd(pool.tvlUSD),
        vol24h0G: formatUsd(pool.volume24hUSD),
        tickBounds: {
          minTick: MIN_TICK,
          maxTick: MAX_TICK,
          currentTick: pool.currentTick,
          aprByTick: mockAprByTick(MIN_TICK, MAX_TICK, stakingApr),
        },
      };
    });

    if (enriched.length === 0) {
      return NextResponse.json(
        {
          data: { pools: MOCK_LP_POOLS, qualifyingCount: MOCK_LP_POOLS.length, total: MOCK_LP_POOLS.length },
          meta: { source: "mock-fallback", warning: discovery.warning ?? "No live Zia pools were available." },
        },
        { status: 503 },
      );
    }

    const filtered = enriched.filter((pool) => pool.aprPct >= minAprPct && pool.aprPct <= maxAprPct);
    return NextResponse.json({
      data: { pools: filtered, qualifyingCount: filtered.length, total: enriched.length },
      meta: { source: discovery.source, chainId: MAINNET_CHAIN_ID, warning: discovery.warning },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Zia pool discovery unavailable.";
    return NextResponse.json(
      {
        data: { pools: MOCK_LP_POOLS, qualifyingCount: MOCK_LP_POOLS.length, total: MOCK_LP_POOLS.length },
        meta: { source: "mock-fallback", warning: message },
      },
      { status: 503 },
    );
  }
}

function parseNonNegNumber(raw: string | null, fallback: number): number {
  if (raw === null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function formatUsd(usd: number | null | undefined): string {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return "-";
  if (usd >= 1_000_000) return `${(usd / 1_000_000).toFixed(2)}M`;
  if (usd >= 1_000) return `${(usd / 1_000).toFixed(1)}K`;
  return usd.toFixed(0);
}

function mockAprByTick(minTick: number, maxTick: number, peakApr: number): LpPoolTickAprPoint[] {
  const points: LpPoolTickAprPoint[] = [];
  const steps = 16;
  const span = maxTick - minTick;
  for (let i = 0; i <= steps; i += 1) {
    const tick = Math.round(minTick + (span * i) / steps);
    const bell = Math.sin(Math.PI * (i / steps));
    const apr = Math.max(1, Math.round(peakApr * bell * 10) / 10);
    points.push({ tick, aprPct: apr });
  }
  return points;
}
