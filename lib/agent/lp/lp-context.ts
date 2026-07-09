// Shared LP context builders — extracted from lp-mint.ts so the autonomous
// LP worker (lib/agent/runtime/lp-worker.ts) can build the same candidate set
// + fence the mint path uses, without importing a `server-only` module. The
// worker imports this; lp-mint.ts imports it back. No `server-only` here so
// it is safe to load from script entrypoints.

import { createPublicClient, encodePacked, formatEther, getAddress, http, parseEther, type Address, type Chain, type PublicClient } from "viem";

import type { LpBrainFence, LpPoolCandidate } from "@/lib/agent/runtime/types";
import type { OgAgentVaultSnapshot } from "@/lib/agent/single-agent";
import { uniswapV3PoolAbi, verifyZappablePool, zappableZiaLpVaults, ZIA_LP_MAINNET } from "@/lib/contracts/zia-lp";
import { LP_MAINNET_CHAIN_ID } from "@/lib/agent/lp/lp-env-gate";
import { makeMainnetTransport } from "@/lib/og/mainnet-rpc";

const ziaQuoterV2Abi = [
  {
    inputs: [
      { internalType: "bytes", name: "path", type: "bytes" },
      { internalType: "uint256", name: "amountIn", type: "uint256" },
    ],
    name: "quoteExactInput",
    outputs: [
      { internalType: "uint256", name: "amountOut", type: "uint256" },
      { internalType: "uint160[]", name: "sqrtPriceX96AfterList", type: "uint160[]" },
      { internalType: "uint32[]", name: "initializedTicksCrossedList", type: "uint32[]" },
      { internalType: "uint256", name: "gasEstimate", type: "uint256" },
    ],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

type ZiaPoolAprSnapshot = {
  apr: { staking?: number | null; total?: number | null };
  feeTier?: number | null;
  metrics: { tvlUSD?: number | null; volume24h?: number | null };
  name?: string | null;
  poolAddress: Address;
};

export function buildFence(vault: OgAgentVaultSnapshot): LpBrainFence {
  const lp = vault.lpPolicy;
  if (!lp) throw new Error("buildFence: vault has no lpPolicy");
  // lpPolicy fields are formatEther strings (wei -> 0G decimal). parseEther
  // round-trips them back to exact bigint wei — no Number precision loss.
  const perLpActionCap0G = parseEther(lp.perLpActionCap0G);
  const maxLpExposure0G = parseEther(lp.maxLpExposure0G);
  const openLpExposure0G = parseEther(vault.openLpExposure0G ?? "0");
  return {
    perLpActionCap0G: formatEther(perLpActionCap0G),
    maxLpExposure0G: formatEther(maxLpExposure0G),
    openLpExposure0G: formatEther(openLpExposure0G),
    remainingLpExposure0G: formatEther(maxLpExposure0G > openLpExposure0G ? maxLpExposure0G - openLpExposure0G : 0n),
    lpMinOutBps: lp.lpMinOutBps,
    cooldownSecondsLp: Number(lp.cooldownSecondsLp),
    minLiquidityFloor: BigInt(lp.minLiquidityFloor),
    allowStaking: lp.allowStaking,
    maxTickWidth: 4000, // server-side guard; ~+/-20% for v3 1% pools. Tunable.
    minAprPct: 0,
    maxAprPct: null,
  };
}

export async function buildPoolCandidates(
  publicClient: PublicClient,
  constrainPoolAddress?: Address,
): Promise<LpPoolCandidate[]> {
  const discovery = await buildPoolCandidateDiscovery(publicClient, constrainPoolAddress);
  return discovery.candidates;
}

export interface LpPoolCandidateDiscovery {
  candidates: LpPoolCandidate[];
  source: "allowlist-fallback" | "zia-tradegpt-partner";
  warning?: string;
}

export async function buildPoolCandidateDiscovery(
  publicClient: PublicClient,
  constrainPoolAddress?: Address,
): Promise<LpPoolCandidateDiscovery> {
  const zappable = zappableZiaLpVaults();
  let target = constrainPoolAddress
    ? zappable.filter((v) => v.poolAddress.toLowerCase() === constrainPoolAddress.toLowerCase())
    : zappable;
  let source: LpPoolCandidateDiscovery["source"] = "allowlist-fallback";
  let warning: string | undefined;
  let apiByPoolAddress = new Map<string, ZiaPoolAprSnapshot>();

  try {
    const { listZiaPools } = await import("@/lib/integrations/zia-tradegpt");
    const apiPools = await listZiaPools() as ZiaPoolAprSnapshot[];
    apiByPoolAddress = new Map(apiPools.map((pool) => [pool.poolAddress.toLowerCase(), pool]));
    target = target.filter((v) => apiByPoolAddress.has(v.poolAddress.toLowerCase()));
    source = "zia-tradegpt-partner";
  } catch (error) {
    warning = error instanceof Error ? error.message : "Zia pool discovery unavailable; using allowlist fallback APR=0.";
  }

  const candidates: LpPoolCandidate[] = [];
  for (const v of target) {
    const apiPool = apiByPoolAddress.get(v.poolAddress.toLowerCase());
    const verification = await verifyZappablePool(v.poolAddress, publicClient).catch(() => null);
    if (!verification) continue;
    const [slot0Res, tickSpacingRes] = await Promise.all([
      publicClient.readContract({
        address: v.poolAddress,
        abi: uniswapV3PoolAbi,
        functionName: "slot0",
        args: [],
      }).catch(() => null),
      publicClient.readContract({
        address: v.poolAddress,
        abi: uniswapV3PoolAbi,
        functionName: "tickSpacing",
        args: [],
      }).catch(() => null),
    ]);
    if (!slot0Res || tickSpacingRes === null) continue;
    const slot0 = slot0Res as readonly [bigint, number, ...unknown[]];
    const tickSpacing = tickSpacingRes as number;
    candidates.push({
      poolAddress: v.poolAddress,
      label: apiPool?.name ?? v.label,
      feeTier: apiPool?.feeTier ?? v.feeTier,
      tickSpacing,
      currentTick: Number(slot0[1]),
      w0gIsToken0: verification.w0gIsToken0,
      stakingAprPct: apiPool?.apr.staking ?? apiPool?.apr.total ?? 0,
      tvlUSD: apiPool?.metrics.tvlUSD ?? null,
      volume24hUSD: apiPool?.metrics.volume24h ?? null,
    });
  }
  return { candidates, source, warning };
}

// 0G mainnet public client used by the mint path + the autonomous LP worker.
// Throws when OG_RPC_URL is unset so the caller fails fast rather than
// silently using a placeholder RPC.
export function makeMainnetPublicClient(): PublicClient {
  const rpcUrl = process.env.OG_RPC_URL?.trim() ?? process.env.OG_MAINNET_RPC_URL?.trim();
  if (!rpcUrl) throw new Error("OG_RPC_URL is required.");
  const chain: Chain = {
    id: LP_MAINNET_CHAIN_ID,
    name: "0G Mainnet",
    nativeCurrency: { decimals: 18, name: "0G", symbol: "0G" },
    rpcUrls: { default: { http: [rpcUrl] } },
  };
  // Prefer quiknode with public fallback and batch read bursts to stay under
  // quiknode's ~15 req/s ceiling (see makeMainnetTransport). viem retries only
  // non-deterministic errors (429/5xx/network) — never contract reverts.
  return createPublicClient({
    chain,
    transport: makeMainnetTransport(),
  });
}

/// Read the non-W0G token of a Zia pool. Used by the mint quote (to plan the
/// balancing swap) and the zap-out quote (to swap the paired leg back to W0G).
export async function readPairedToken(publicClient: PublicClient, poolAddress: Address): Promise<Address> {
  const [token0, token1] = await Promise.all([
    publicClient.readContract({ address: poolAddress, abi: uniswapV3PoolAbi, functionName: "token0", args: [] }) as Promise<Address>,
    publicClient.readContract({ address: poolAddress, abi: uniswapV3PoolAbi, functionName: "token1", args: [] }) as Promise<Address>,
  ]);
  const w0g = ZIA_LP_MAINNET.wrappedNative.toLowerCase();
  if (token0.toLowerCase() === w0g) return token1;
  if (token1.toLowerCase() === w0g) return token0;
  throw new Error("Pool has no W0G leg.");
}

/// Quote the exact one-hop swap the LP adapter will execute through
/// SwapRouter.exactInputSingle. Partner /route may choose a fallback or
/// different-fee route; LP min floors must mirror this exact pool instead.
export async function quoteZiaExactPoolSwap(
  publicClient: PublicClient,
  poolAddress: Address,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
): Promise<bigint> {
  if (amountIn <= 0n) return 0n;
  const [fee, token0, token1] = await Promise.all([
    publicClient.readContract({ address: poolAddress, abi: uniswapV3PoolAbi, functionName: "fee", args: [] }) as Promise<number>,
    publicClient.readContract({ address: poolAddress, abi: uniswapV3PoolAbi, functionName: "token0", args: [] }) as Promise<Address>,
    publicClient.readContract({ address: poolAddress, abi: uniswapV3PoolAbi, functionName: "token1", args: [] }) as Promise<Address>,
  ]);
  const normalizedIn = getAddress(tokenIn);
  const normalizedOut = getAddress(tokenOut);
  const poolToken0 = getAddress(token0);
  const poolToken1 = getAddress(token1);
  const matchesForward = normalizedIn === poolToken0 && normalizedOut === poolToken1;
  const matchesReverse = normalizedIn === poolToken1 && normalizedOut === poolToken0;
  if (!matchesForward && !matchesReverse) {
    throw new Error("Exact LP quote tokens do not match the selected pool.");
  }
  const path = encodePacked(["address", "uint24", "address"], [normalizedIn, Number(fee), normalizedOut]);
  const [amountOut] = await publicClient.readContract({
    address: ZIA_LP_MAINNET.quoterV2,
    abi: ziaQuoterV2Abi,
    functionName: "quoteExactInput",
    args: [path, amountIn],
  }) as readonly [bigint, readonly bigint[], readonly number[], bigint];
  return amountOut;
}

/// Parse a decimal 0G string to wei bigint. Mirrors parseEther but with an
/// explicit, strict format check so malformed input throws rather than coercing.
export function parse0G(value: string): bigint {
  const normalized = value.trim();
  if (!/^\d+(\.\d+)?$/u.test(normalized)) {
    throw new Error("0G amount must be a positive decimal value.");
  }
  const [whole, frac = ""] = normalized.split(".");
  if (frac.length > 18) throw new Error("0G amount must not have more than 18 fractional digits.");
  const padded = (whole + frac.padEnd(18, "0")).replace(/^0+(?=\d)/, "");
  return BigInt(padded || "0");
}

/// Floor a decimal string to an integer bigint (smallest-unit). The partner
/// /route returns amounts as decimal strings; flooring is conservative (the
/// vault's amount0Min/amount1Min floors further via bps).
export function floorTokenAmount(value: string): bigint {
  const normalized = value.trim();
  if (!/^\d+(\.\d+)?$/u.test(normalized)) {
    throw new Error(`token amount must be a positive decimal value, got: ${value}`);
  }
  const whole = normalized.split(".")[0] ?? "0";
  return BigInt(whole || "0");
}
