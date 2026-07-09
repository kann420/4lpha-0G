// MOCK — backend not wired. Single source of mock data for the frontend-only LP
// Agents UI. No contract calls, no viem clients, no API routes. Real 0G mainnet
// addresses from lib/contracts/zia-lp.ts are reused so hashes look right; APR /
// TVL / vol / tickBounds are fabricated for demo only. When the backend is wired,
// replace MOCK_LP_POOLS with the Zia pool discovery response and
// MOCK_LP_AGENT_SNAPSHOT with a real OgAgentWorkspace fetch.

import type { Address } from "viem";

import { poolIdFromAddress, zappableZiaLpVaults } from "@/lib/contracts/zia-lp";
import type { OgAgentLogEntry, OgAgentVaultLpPosition, OgAgentVaultSnapshot } from "@/lib/agent/single-agent";

export interface LpPoolTickAprPoint {
  tick: number;
  aprPct: number;
}

export interface LpPoolOption {
  poolAddress: Address;
  label: string;
  feeLabel: string;
  feeTier: number;
  vaultAddress: Address;
  // MOCK demo fields — not from Zia.
  aprPct: number;
  tvl0G: string;
  vol24h0G: string;
  tickBounds: {
    minTick: number;
    maxTick: number;
    currentTick: number;
    aprByTick: LpPoolTickAprPoint[];
  };
}

// Derive the 6 W0G-leg Zia v3 pools (single-sided zap-in from native 0G) and
// attach fabricated APR / TVL / vol / tickBounds. APR is a mock staking-reward
// figure; real APR comes from the Zia vault staking rewards endpoint (backend).
const ZAPPABLE = zappableZiaLpVaults();

function mockAprByTick(minTick: number, maxTick: number, peakApr: number): LpPoolTickAprPoint[] {
  const points: LpPoolTickAprPoint[] = [];
  const steps = 16;
  const span = maxTick - minTick;
  for (let i = 0; i <= steps; i++) {
    const tick = Math.round(minTick + (span * i) / steps);
    // Bell curve peaking at the middle tick.
    const t = i / steps;
    const bell = Math.sin(Math.PI * t);
    const apr = Math.max(1, Math.round(peakApr * bell * 10) / 10);
    points.push({ tick, aprPct: apr });
  }
  return points;
}

function makePool(
  idx: number,
  label: string,
  feeLabel: string,
  feeTier: number,
  poolAddress: Address,
  vaultAddress: Address,
  aprPct: number,
  tvl0G: string,
  vol24h0G: string,
): LpPoolOption {
  const minTick = -887_220;
  const maxTick = 887_220;
  const currentTick = Math.round(minTick + ((maxTick - minTick) * (idx + 2)) / 8);
  return {
    poolAddress,
    label,
    feeLabel,
    feeTier,
    vaultAddress,
    aprPct,
    tvl0G,
    vol24h0G,
    tickBounds: { minTick, maxTick, currentTick, aprByTick: mockAprByTick(minTick, maxTick, aprPct) },
  };
}

export const MOCK_LP_POOLS: readonly LpPoolOption[] = ZAPPABLE.map((v, idx) => {
  // Fabricated demo APR/TVL/vol — deterministic per index, no randomness.
  const aprPct = [12.4, 28.1, 45.6, 18.3, 33.9, 60.2][idx % 6];
  const tvl0G = ["1.42M", "0.86M", "0.31M", "2.05M", "0.64M", "0.18M"][idx % 6];
  const vol24h0G = ["0.22M", "0.14M", "0.05M", "0.41M", "0.09M", "0.03M"][idx % 6];
  return makePool(idx, v.label, v.feeLabel, v.feeTier, v.poolAddress, v.vaultAddress, aprPct, tvl0G, vol24h0G);
});

export function findMockPoolByAddress(addr: Address | null): LpPoolOption | undefined {
  if (!addr) return undefined;
  const target = addr.toLowerCase();
  return MOCK_LP_POOLS.find((p) => p.poolAddress.toLowerCase() === target);
}

// Default pool the mock LP agent runs on — the first W0G/USDC pool found.
export const MOCK_LP_POOL: LpPoolOption =
  findMockPoolByAddress(MOCK_LP_POOLS[0]?.poolAddress ?? null) ?? MOCK_LP_POOLS[0];

export const MOCK_LP_AGENT_ID = "lp-mock-001";

// MOCK: any id renders this same snapshot for the frontend-only phase. Real
// backend wiring will fetch OgAgentWorkspace by agentId.
export const MOCK_LP_AGENT_SNAPSHOT = {
  agent: {
    id: MOCK_LP_AGENT_ID,
    name: "Galileo LP rehearsal",
    status: "armed" as const,
    readiness: { wallet: true, network: true, vault: true, identity: false, storage: false },
  },
  vault: {
    ready: true,
    vaultVersion: 3,
    vault: "0x599bf69f54BAEF47C3A23cA85C5BC1Ef74868D29" as Address,
    owner: "0xd7e0ABfFB9E4d8d5a5f0c6c2e1F3a4B5c6D7e8f9" as Address,
    executor: "0xf56b1b3e1c0a2b3c4d5e6f7a8b9c0d1e2f3a4b5c" as Address,
    adapter: "0xC357e548e2E3f7A6831a18A640F2BE2b25453816" as Address,
    lpAdapter: "0xC357e548e2E3f7A6831a18A640F2BE2b25453816" as Address,
    proofRegistry: "0x0000000000000000000000000000000000000000" as Address,
    balance0G: "0.42",
    openLpExposure0G: "0.30",
    lpDailySpent0G: "0.05",
    paused: false,
    mockAdapterAllowed: true,
    lpPolicy: {
      perLpActionCap0G: "0.5",
      lpDailyCap0G: "2.0",
      maxLpExposure0G: "5.0",
      cooldownSecondsLp: "3600",
      lpMinOutBps: 9900,
      minLiquidityFloor: "0.001",
      allowStaking: false,
      lpMaxPositions: 5,
      lpMaxPerPosition0G: "0.5",
    },
    sellableLpPositions: [
      {
        tokenId: "12451",
        poolId: poolIdFromAddress(MOCK_LP_POOLS[0]!.poolAddress),
        poolAddress: MOCK_LP_POOLS[0]!.poolAddress,
        poolLabel: MOCK_LP_POOLS[0]!.label,
        tickLower: -1000,
        tickUpper: 1000,
        deployedNative0G: "0.30",
        liquidity: "123456",
        staked: false,
      } satisfies OgAgentVaultLpPosition,
      {
        tokenId: "12452",
        poolId: poolIdFromAddress(MOCK_LP_POOLS[1]!.poolAddress),
        poolAddress: MOCK_LP_POOLS[1]!.poolAddress,
        poolLabel: MOCK_LP_POOLS[1]!.label,
        tickLower: -500,
        tickUpper: 1500,
        deployedNative0G: "0.08",
        liquidity: "88412",
        staked: false,
      } satisfies OgAgentVaultLpPosition,
      {
        tokenId: "12453",
        poolId: poolIdFromAddress(MOCK_LP_POOLS[2]!.poolAddress),
        poolAddress: MOCK_LP_POOLS[2]!.poolAddress,
        poolLabel: MOCK_LP_POOLS[2]!.label,
        tickLower: -2000,
        tickUpper: 500,
        deployedNative0G: "0.04",
        liquidity: "41203",
        staked: false,
      } satisfies OgAgentVaultLpPosition,
    ],
    warnings: [],
  } satisfies OgAgentVaultSnapshot,
  logs: [
    {
      id: "lp-log-1",
      action: "quote",
      createdAt: "2026-07-04T14:22:03Z",
      filter: "reasoning",
      status: "ready",
      summary: "Mock zap-in rehearsal preview accepted for W0G/USDC LP position #12451",
      notes: ["testnet rehearsal only", "no transaction broadcast", "no 0G Storage upload"],
      routeHash: "mock-route-w0g-usdc",
    },
    {
      id: "lp-log-2",
      action: "quote",
      createdAt: "2026-07-04T14:22:01Z",
      filter: "reasoning",
      status: "ready",
      summary: "Mock policy checked max positions and per-position budget",
      notes: ["Agentic ID disabled", "storage disabled", "mock adapter"],
    },
    {
      id: "lp-log-3",
      action: "none",
      createdAt: "2026-07-04T14:21:58Z",
      filter: "reasoning",
      status: "ready",
      summary: "Rehearsal workspace opened",
      notes: ["local browser session", "mainnet untouched"],
    },
  ] satisfies OgAgentLogEntry[],
};

export function mockLpAgentIdFromDraft(): string {
  // MOCK: always lands on the shared mock detail page for the frontend-only phase.
  return MOCK_LP_AGENT_ID;
}

// MOCK — per-position accounting figures for the detail page's position cards.
// Mirrors the 4alpha LpPositionInfoStrip cells (Balance / Assets / Unclaimed fee
// / Unrealized PnL / APR). APR replaces the old Fee cell. Unrealized PnL is USD
// ($X.XX) for consistency with the real per-position accounting. Real values
// come from the Zia pool fetch in readSellableLpPositions. Keyed by tokenId.
export interface MockLpAccounting {
  balance: { value: string; subValue: string };
  assets: { value: string; subValue: string };
  unclaimedFee: { value: string; subValue: string };
  unrealizedPnl: { value: string; subValue: string; tone: "success" | "danger" | "neutral" };
  apr: { value: string; subValue: string };
}

export const MOCK_POSITION_ACCOUNTING: Record<string, MockLpAccounting> = {
  "12451": {
    balance: { value: "~ 0.30 0G", subValue: "0.15 W0G · 0.15 USDC" },
    assets: { value: "0.15 W0G · 0.15 USDC", subValue: "50.0% / 50.0%" },
    unclaimedFee: { value: "~ 0.012 0G", subValue: "0.008 W0G / 0.002 USDC" },
    unrealizedPnl: { value: "$0.03", subValue: "+1.20%", tone: "success" },
    apr: { value: "12.40%", subValue: "staking APR" },
  },
  "12452": {
    balance: { value: "~ 0.08 0G", subValue: "0.04 W0G · 0.04 WETH" },
    assets: { value: "0.04 W0G · 0.04 WETH", subValue: "50.0% / 50.0%" },
    unclaimedFee: { value: "~ 0.004 0G", subValue: "0.003 W0G / 0.001 WETH" },
    unrealizedPnl: { value: "-$0.01", subValue: "-0.40%", tone: "danger" },
    apr: { value: "8.10%", subValue: "staking APR" },
  },
  "12453": {
    balance: { value: "~ 0.04 0G", subValue: "0.02 W0G · 0.02 USDT" },
    assets: { value: "0.02 W0G · 0.02 USDT", subValue: "50.0% / 50.0%" },
    unclaimedFee: { value: "~ 0.002 0G", subValue: "0.001 W0G / 0.0005 USDT" },
    unrealizedPnl: { value: "$0.01", subValue: "+0.30%", tone: "success" },
    apr: { value: "6.90%", subValue: "staking APR" },
  },
};

const FALLBACK_ACCOUNTING: MockLpAccounting = {
  balance: { value: "~ 0 0G", subValue: "—" },
  assets: { value: "—", subValue: "—" },
  unclaimedFee: { value: "~ 0 0G", subValue: "—" },
  unrealizedPnl: { value: "$0.00", subValue: "0.00%", tone: "neutral" },
  apr: { value: "—", subValue: "—" },
};

export function mockAccountingFor(tokenId: string): MockLpAccounting {
  return MOCK_POSITION_ACCOUNTING[tokenId] ?? FALLBACK_ACCOUNTING;
}
