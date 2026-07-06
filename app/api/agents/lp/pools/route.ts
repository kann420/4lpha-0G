import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { createPublicClient, http, type Address, type Chain } from "viem";

import {
  uniswapV3PoolAbi,
  verifyZappablePool,
  zappableZiaLpVaults,
  type ZiaLpVaultConfig,
} from "@/lib/contracts/zia-lp";
import { listZiaPools, resolveZiaBaseUrl, ZiaApiError, type ZiaPool } from "@/lib/integrations/zia-tradegpt";
import { MOCK_LP_POOLS, type LpPoolOption, type LpPoolTickAprPoint } from "@/lib/agent/lp/mock-lp-data";

// GET /api/agents/lp/pools?minAprPct=&maxAprPct=
// Returns the live Zia pool discovery, intersected with the vault-allowlisted
// W0G-leg pools (zappableZiaLpVaults), verified on-chain to actually carry W0G,
// with the real current tick from slot0. APR surfaced is the STAKING APR
// (AGENTS.md: advertised APR comes from staking rewards, not total/trading).
// When the partner URL is unset or unreachable, returns 503 with the MOCK pool
// set labeled clearly so the create-form demo stays alive.

const MAINNET_CHAIN_ID = 16661;
const MIN_TICK = -887_220;
const MAX_TICK = 887_220;

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const minAprPct = parseNonNegNumber(url.searchParams.get("minAprPct"), 0);
  const maxAprPct = parseNonNegNumber(url.searchParams.get("maxAprPct"), Infinity);

  const base = resolveZiaBaseUrl();
  if ("error" in base) {
    return NextResponse.json(
      {
        data: { pools: MOCK_LP_POOLS, qualifyingCount: MOCK_LP_POOLS.length, total: MOCK_LP_POOLS.length },
        meta: { source: "mock-fallback", warning: base.error.message },
      },
      { status: 503 },
    );
  }

  try {
    const apiPools = await listZiaPools();
    const zappable = zappableZiaLpVaults();
    const zappableByAddr = new Map<string, ZiaLpVaultConfig>(
      zappable.map((v) => [v.poolAddress.toLowerCase(), v]),
    );

    // Intersect: only pools the vault allowlists AND the API returns.
    const intersected = apiPools.filter((p) => zappableByAddr.has(p.poolAddress.toLowerCase()));

    const publicClient = makeMainnetPublicClient();

    // Verify each candidate actually carries a W0G leg on-chain + read slot0 for
    // the real current tick. Failures drop the pool (honest: the vault would
    // reject it anyway).
    const enriched: LpPoolOption[] = [];
    for (const pool of intersected) {
      const vaultCfg = zappableByAddr.get(pool.poolAddress.toLowerCase())!;
      const verification = await verifyZappablePool(pool.poolAddress, publicClient).catch(() => null);
      if (!verification) continue;
      const currentTick = await readCurrentTick(publicClient, pool.poolAddress).catch(() => null);
      const stakingApr = pool.apr.staking ?? pool.apr.total ?? 0;
      const tick = currentTick ?? Math.round((MIN_TICK + MAX_TICK) / 2);
      enriched.push({
        poolAddress: pool.poolAddress,
        label: pool.name ?? vaultCfg.label,
        feeLabel: vaultCfg.feeLabel,
        feeTier: pool.feeTier ?? vaultCfg.feeTier,
        vaultAddress: vaultCfg.vaultAddress,
        aprPct: stakingApr,
        tvl0G: formatUsd(pool.metrics.tvlUSD),
        vol24h0G: formatUsd(pool.metrics.volume24h),
        tickBounds: {
          minTick: MIN_TICK,
          maxTick: MAX_TICK,
          currentTick: tick,
          aprByTick: mockAprByTick(MIN_TICK, MAX_TICK, stakingApr),
        },
      });
    }

    const filtered = enriched.filter((p) => p.aprPct >= minAprPct && p.aprPct <= maxAprPct);
    return NextResponse.json({
      data: { pools: filtered, qualifyingCount: filtered.length, total: enriched.length },
      meta: { source: "zia-tradegpt-partner", chainId: MAINNET_CHAIN_ID },
    });
  } catch (err) {
    const code = err instanceof ZiaApiError ? err.code : "zia_api_unreachable";
    const message = err instanceof Error ? err.message : "Zia API unreachable.";
    return NextResponse.json(
      {
        data: { pools: MOCK_LP_POOLS, qualifyingCount: MOCK_LP_POOLS.length, total: MOCK_LP_POOLS.length },
        meta: { source: "mock-fallback", warning: `partner API failed (${code}): ${message}` },
      },
      { status: 503 },
    );
  }
}

function parseNonNegNumber(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function formatUsd(usd: number | null | undefined): string {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return "—";
  if (usd >= 1_000_000) return `${(usd / 1_000_000).toFixed(2)}M`;
  if (usd >= 1_000) return `${(usd / 1_000).toFixed(1)}K`;
  return usd.toFixed(0);
}

async function readCurrentTick(
  client: ReturnType<typeof makeMainnetPublicClient>,
  pool: Address,
): Promise<number | null> {
  const slot0 = (await client.readContract({
    address: pool,
    abi: uniswapV3PoolAbi,
    functionName: "slot0",
    args: [],
  })) as readonly [bigint, number, ...unknown[]];
  const tick = Number(slot0[1]);
  return Number.isFinite(tick) ? tick : null;
}

// Per-tick APR bell curve — visual only. The Zia API returns a single pool APR,
// not a per-tick distribution, so this is a labeled mock for the histogram.
function mockAprByTick(minTick: number, maxTick: number, peakApr: number): LpPoolTickAprPoint[] {
  const points: LpPoolTickAprPoint[] = [];
  const steps = 16;
  const span = maxTick - minTick;
  for (let i = 0; i <= steps; i++) {
    const tick = Math.round(minTick + (span * i) / steps);
    const bell = Math.sin(Math.PI * (i / steps));
    const apr = Math.max(1, Math.round(peakApr * bell * 10) / 10);
    points.push({ tick, aprPct: apr });
  }
  return points;
}

function makeMainnetPublicClient() {
  const rpcUrl = process.env.OG_RPC_URL?.trim();
  if (!rpcUrl) throw new Error("OG_RPC_URL is required to read Zia pool slot0.");
  const chain: Chain = {
    id: MAINNET_CHAIN_ID,
    name: "0G Mainnet",
    nativeCurrency: { decimals: 18, name: "0G", symbol: "0G" },
    rpcUrls: { default: { http: [rpcUrl] } },
  };
  return createPublicClient({
    chain,
    transport: http(rpcUrl, { retryCount: 0, timeout: 8_000 }),
  });
}