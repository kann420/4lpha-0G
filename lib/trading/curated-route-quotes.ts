import "server-only";

import {
  concatHex,
  createPublicClient,
  decodeFunctionResult,
  encodeFunctionData,
  formatEther,
  formatUnits,
  getAddress,
  http,
  isAddress,
  isHex,
  numberToHex,
  parseEther,
  parseUnits,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  CURATED_MAINNET_POLICY_VAULT_ROUTES,
  OKU_MAINNET,
  W0G_MAINNET,
  ZIA_MAINNET,
  type CuratedPolicyVaultRoute,
} from "@/lib/contracts/curated-routes";
import { OG_NETWORKS } from "@/lib/og/networks";
import type {
  TradeRouteDescriptor,
  TradeRouteDirection,
  TradeRouteQuote,
  TradeRouteQuoteCandidate,
  TradeRouteQuoteProvider,
  TradeRouteVenue,
} from "@/lib/types";

const MAINNET_CHAIN_ID = 16661;
const DEFAULT_SLIPPAGE_BPS = 50;
const MAX_SLIPPAGE_BPS = 1_000;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

const quoterV2Abi = [
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

const erc20MetadataAbi = [
  {
    inputs: [],
    name: "decimals",
    outputs: [{ internalType: "uint8", name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export interface CuratedRouteQuoteInput {
  amountInDecimal?: string;
  amountInRaw?: bigint;
  direction: TradeRouteDirection;
  includeAlternates?: boolean;
  routeId?: Hex;
  slippageBps?: number;
  symbol?: string;
  tokenOut?: Address;
  venue?: TradeRouteVenue;
}

export interface CuratedRouteQuoteSelection {
  alternates: TradeRouteQuoteCandidate[];
  blockNumber: bigint;
  request: {
    amountInMode: "decimal" | "raw";
    direction: TradeRouteDirection;
    routeId?: Hex;
    slippageBps: number;
    symbol?: string;
    tokenOut?: Address;
    venue?: TradeRouteVenue;
  };
  rpcSource: "OG_MAINNET_RPC_URL" | "OG_RPC_URL" | "official-0g-mainnet-rpc";
  selectedQuote: TradeRouteQuote;
}

type QuotedRouteCandidate = TradeRouteQuoteCandidate & {
  quote: TradeRouteQuote;
  status: "quoted";
};

export class TradeRouteQuoteError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function listCuratedMainnetRouteDescriptors(): TradeRouteDescriptor[] {
  return CURATED_MAINNET_POLICY_VAULT_ROUTES.map(toRouteDescriptor);
}

export async function quoteCuratedMainnetRoutes(input: CuratedRouteQuoteInput): Promise<CuratedRouteQuoteSelection> {
  const normalized = normalizeSelectionInput(input);
  const candidates = selectRouteCandidates(normalized);
  if (candidates.length === 0) {
    throw new TradeRouteQuoteError("No curated mainnet route matched the requested token or route id.", "route_not_found", 404);
  }

  const config = resolveMainnetRouteQuoteConfig();
  const publicClient = createPublicClient({
    transport: http(config.rpcUrl),
  });
  const chainId = await readMainnetChainId(publicClient);
  if (chainId !== MAINNET_CHAIN_ID) {
    throw new TradeRouteQuoteError("Configured 0G RPC is not connected to 0G mainnet.", "rpc_chain_mismatch", 502);
  }

  const blockNumber = await publicClient.getBlockNumber();
  const decimals = new Map<string, number>();
  const quoteResults: TradeRouteQuoteCandidate[] = await Promise.all(
    candidates.map(async (route) => {
      try {
        const tokenOutDecimals = await readTokenDecimals(publicClient, route.tokenOut, decimals);
        const amountIn = resolveAmountInRaw(normalized, tokenOutDecimals);
        const quote =
          route.venue === "ZIA"
            ? await quoteZiaUniswapV3Route({
                amountIn,
                blockNumber,
                direction: normalized.direction,
                publicClient,
                route,
                slippageBps: normalized.slippageBps,
                tokenOutDecimals,
              })
            : await quoteOkuUniswapV3Route({
                amountIn,
                blockNumber,
                direction: normalized.direction,
                publicClient,
                route,
                slippageBps: normalized.slippageBps,
                tokenOutDecimals,
              });

        return {
          quote,
          route: toRouteDescriptor(route),
          status: "quoted" as const,
        };
      } catch (error) {
        if (error instanceof TradeRouteQuoteError && error.status < 500) {
          throw error;
        }

        return {
          error: {
            code: "quote_unavailable",
            message: "Route quote is unavailable from the venue quoter.",
          },
          route: toRouteDescriptor(route),
          status: "unavailable" as const,
        };
      }
    }),
  );

  const quoted = quoteResults.filter((result): result is QuotedRouteCandidate => {
    return result.status === "quoted" && result.quote !== undefined;
  });
  if (quoted.length === 0) {
    throw new TradeRouteQuoteError("No live quote was available for the requested curated route set.", "no_live_quote", 502);
  }

  const selected = [...quoted].sort(compareQuoteCandidates)[0];
  if (selected === undefined) {
    throw new TradeRouteQuoteError("No live quote was available for the requested curated route set.", "no_live_quote", 502);
  }
  const alternates = normalized.includeAlternates
    ? quoteResults.filter((result) => result.route.id.toLowerCase() !== selected.route.id.toLowerCase())
    : [];

  return {
    alternates,
    blockNumber,
    request: {
      amountInMode: normalized.amountInRaw === undefined ? "decimal" : "raw",
      direction: normalized.direction,
      routeId: normalized.routeId,
      slippageBps: normalized.slippageBps,
      symbol: normalized.symbol,
      tokenOut: normalized.tokenOut,
      venue: normalized.venue,
    },
    rpcSource: config.rpcSource,
    selectedQuote: selected.quote,
  };
}

export async function quoteZiaUniswapV3Route({
  amountIn,
  blockNumber,
  direction,
  publicClient,
  route,
  slippageBps,
  tokenOutDecimals,
}: {
  amountIn: bigint;
  blockNumber: bigint;
  direction: TradeRouteDirection;
  publicClient: PublicClient;
  route: CuratedPolicyVaultRoute;
  slippageBps: number;
  tokenOutDecimals: number;
}): Promise<TradeRouteQuote> {
  if (route.venue !== "ZIA") {
    throw new TradeRouteQuoteError("Route is not a ZIA curated route.", "route_venue_mismatch", 400);
  }

  return quoteRouteWithQuoterV2({
    amountIn,
    blockNumber,
    direction,
    provider: "zia-quoter-v2",
    publicClient,
    quoter: ZIA_MAINNET.quoterV2,
    route,
    slippageBps,
    tokenOutDecimals,
  });
}

export async function quoteOkuUniswapV3Route({
  amountIn,
  blockNumber,
  direction,
  publicClient,
  route,
  slippageBps,
  tokenOutDecimals,
}: {
  amountIn: bigint;
  blockNumber: bigint;
  direction: TradeRouteDirection;
  publicClient: PublicClient;
  route: CuratedPolicyVaultRoute;
  slippageBps: number;
  tokenOutDecimals: number;
}): Promise<TradeRouteQuote> {
  if (route.venue !== "Oku") {
    throw new TradeRouteQuoteError("Route is not an Oku curated route.", "route_venue_mismatch", 400);
  }

  return quoteRouteWithQuoterV2({
    amountIn,
    blockNumber,
    direction,
    provider: "oku-quoter-v2",
    publicClient,
    quoter: OKU_MAINNET.quoterV2,
    route,
    slippageBps,
    tokenOutDecimals,
  });
}

function normalizeSelectionInput(input: CuratedRouteQuoteInput): Required<Pick<CuratedRouteQuoteInput, "direction" | "includeAlternates" | "slippageBps">> &
  Omit<CuratedRouteQuoteInput, "direction" | "includeAlternates" | "slippageBps"> {
  if (input.direction !== "buy" && input.direction !== "sell") {
    throw new TradeRouteQuoteError("Trade route direction must be buy or sell.", "invalid_direction", 400);
  }
  if (input.amountInRaw === undefined && input.amountInDecimal === undefined) {
    throw new TradeRouteQuoteError("Trade route quote requires amountInDecimal or amountInRaw.", "invalid_amount", 400);
  }
  if (input.amountInRaw !== undefined && input.amountInRaw <= 0n) {
    throw new TradeRouteQuoteError("Trade route quote amount must be greater than zero.", "invalid_amount", 400);
  }
  if (input.amountInDecimal !== undefined && !/^\d+(\.\d+)?$/.test(input.amountInDecimal)) {
    throw new TradeRouteQuoteError("Trade route decimal amount was not valid.", "invalid_amount", 400);
  }
  if (!input.routeId && !input.tokenOut && !input.symbol) {
    throw new TradeRouteQuoteError("Trade route quote requires routeId, tokenOut, or symbol.", "route_filter_required", 400);
  }
  if (input.routeId && (!isHex(input.routeId, { strict: true }) || input.routeId.length !== 66)) {
    throw new TradeRouteQuoteError("Trade route id must be a bytes32 hex value.", "invalid_route_id", 400);
  }

  const slippageBps = input.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > MAX_SLIPPAGE_BPS) {
    throw new TradeRouteQuoteError("Trade route slippageBps must be between 0 and 1000.", "invalid_slippage", 400);
  }

  return {
    ...input,
    includeAlternates: input.includeAlternates ?? true,
    slippageBps,
    symbol: input.symbol?.trim(),
  };
}

function selectRouteCandidates(input: CuratedRouteQuoteInput): CuratedPolicyVaultRoute[] {
  return CURATED_MAINNET_POLICY_VAULT_ROUTES.filter((route) => {
    if (input.routeId && route.id.toLowerCase() !== input.routeId.toLowerCase()) {
      return false;
    }
    if (input.tokenOut && route.tokenOut.toLowerCase() !== input.tokenOut.toLowerCase()) {
      return false;
    }
    if (input.symbol && !symbolMatches(route.symbol, input.symbol)) {
      return false;
    }
    if (input.venue && route.venue !== input.venue) {
      return false;
    }
    return true;
  });
}

async function quoteRouteWithQuoterV2({
  amountIn,
  blockNumber,
  direction,
  provider,
  publicClient,
  quoter,
  route,
  slippageBps,
  tokenOutDecimals,
}: {
  amountIn: bigint;
  blockNumber: bigint;
  direction: TradeRouteDirection;
  provider: TradeRouteQuoteProvider;
  publicClient: PublicClient;
  quoter: Address;
  route: CuratedPolicyVaultRoute;
  slippageBps: number;
  tokenOutDecimals: number;
}): Promise<TradeRouteQuote> {
  const encodedPath = direction === "buy" ? encodeV3Path(route.path, route.fees) : encodeV3Path([...route.path].reverse(), [...route.fees].reverse());
  const data = encodeFunctionData({
    abi: quoterV2Abi,
    args: [encodedPath, amountIn],
    functionName: "quoteExactInput",
  });
  const callResult = await publicClient.call({
    data,
    to: quoter,
  });
  if (!callResult.data || callResult.data === "0x") {
    throw new TradeRouteQuoteError("Venue quoter returned an empty response.", "empty_quote_response", 502);
  }

  const [amountOut, , , gasEstimate] = decodeFunctionResult({
    abi: quoterV2Abi,
    data: callResult.data,
    functionName: "quoteExactInput",
  });
  if (amountOut <= 0n) {
    throw new TradeRouteQuoteError("Venue quoter returned a zero amount out.", "zero_quote_amount_out", 502);
  }

  const amountOutMin = applySlippage(amountOut, slippageBps);
  if (amountOutMin <= 0n) {
    throw new TradeRouteQuoteError("Quote would produce a zero amountOutMin.", "zero_amount_out_min", 400);
  }

  return {
    amountInFormatted: formatRouteAmount(direction === "buy" ? "native" : "token", amountIn, tokenOutDecimals),
    amountInRaw: amountIn.toString(),
    amountOutFormatted: formatRouteAmount(direction === "buy" ? "token" : "native", amountOut, tokenOutDecimals),
    amountOutMinFormatted: formatRouteAmount(direction === "buy" ? "token" : "native", amountOutMin, tokenOutDecimals),
    amountOutMinRaw: amountOutMin.toString(),
    amountOutRaw: amountOut.toString(),
    blockNumber: blockNumber.toString(),
    direction,
    execution: {
      submitsTransaction: false,
      type: "quote-only",
    },
    gasEstimate: gasEstimate.toString(),
    quoteProvider: provider,
    route: toRouteDescriptor(route),
    slippageBps,
  };
}

function resolveAmountInRaw(input: CuratedRouteQuoteInput, tokenOutDecimals: number): bigint {
  if (input.amountInRaw !== undefined) {
    return input.amountInRaw;
  }

  const decimal = input.amountInDecimal;
  if (decimal === undefined) {
    throw new TradeRouteQuoteError("Trade route quote requires amountInDecimal or amountInRaw.", "invalid_amount", 400);
  }

  try {
    return input.direction === "buy" ? parseEther(decimal) : parseUnits(decimal, tokenOutDecimals);
  } catch {
    throw new TradeRouteQuoteError("Trade route decimal amount could not be parsed for the route token.", "invalid_amount", 400);
  }
}

async function readMainnetChainId(publicClient: PublicClient): Promise<number> {
  try {
    return await publicClient.getChainId();
  } catch {
    throw new TradeRouteQuoteError("Unable to reach the configured 0G mainnet RPC.", "rpc_unavailable", 502);
  }
}

async function readTokenDecimals(publicClient: PublicClient, token: Address, cache: Map<string, number>): Promise<number> {
  const key = token.toLowerCase();
  const cached = cache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  try {
    const decimals = await publicClient.readContract({
      abi: erc20MetadataAbi,
      address: token,
      functionName: "decimals",
    });
    cache.set(key, decimals);
    return decimals;
  } catch {
    throw new TradeRouteQuoteError("Unable to read route token metadata.", "token_metadata_unavailable", 502);
  }
}

function resolveMainnetRouteQuoteConfig(): {
  rpcSource: CuratedRouteQuoteSelection["rpcSource"];
  rpcUrl: string;
} {
  const mainnetRpc = process.env.OG_MAINNET_RPC_URL?.trim();
  if (mainnetRpc) {
    return {
      rpcSource: "OG_MAINNET_RPC_URL",
      rpcUrl: normalizeRpcUrl(mainnetRpc, "OG_MAINNET_RPC_URL"),
    };
  }

  const genericRpc = process.env.OG_RPC_URL?.trim();
  const configuredNetwork = process.env.OG_NETWORK?.trim().toLowerCase();
  const configuredChainId = process.env.OG_CHAIN_ID?.trim();
  if (genericRpc && (configuredNetwork === "mainnet" || configuredChainId === String(MAINNET_CHAIN_ID) || (!configuredNetwork && !configuredChainId))) {
    return {
      rpcSource: "OG_RPC_URL",
      rpcUrl: normalizeRpcUrl(genericRpc, "OG_RPC_URL"),
    };
  }

  return {
    rpcSource: "official-0g-mainnet-rpc",
    rpcUrl: OG_NETWORKS.mainnet.rpcUrl,
  };
}

function normalizeRpcUrl(value: string, envName: string): string {
  try {
    const url = new URL(value);
    if (!isAllowedRpcProtocol(url)) {
      throw new Error("bad protocol");
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    throw new TradeRouteQuoteError(`${envName} must be a valid HTTPS RPC URL.`, "invalid_rpc_url", 500);
  }
}

function isAllowedRpcProtocol(url: URL): boolean {
  if (url.protocol === "https:") {
    return true;
  }
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
}

function encodeV3Path(path: readonly Address[], fees: readonly number[]): Hex {
  if (path.length < 2 || fees.length !== path.length - 1) {
    throw new TradeRouteQuoteError("Curated route path metadata is invalid.", "bad_route_path", 500);
  }

  const parts: Hex[] = [path[0]];
  for (let i = 0; i < fees.length; i += 1) {
    parts.push(numberToHex(fees[i], { size: 3 }), path[i + 1]);
  }
  return concatHex(parts);
}

function applySlippage(amountOut: bigint, slippageBps: number): bigint {
  return (amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
}

function compareQuoteCandidates(left: QuotedRouteCandidate, right: QuotedRouteCandidate) {
  const leftOut = BigInt(left.quote.amountOutRaw);
  const rightOut = BigInt(right.quote.amountOutRaw);
  if (leftOut !== rightOut) {
    return leftOut > rightOut ? -1 : 1;
  }

  const confidenceDelta = confidenceRank(right.route.confidence) - confidenceRank(left.route.confidence);
  if (confidenceDelta !== 0) {
    return confidenceDelta;
  }

  const hopDelta = left.route.fees.length - right.route.fees.length;
  if (hopDelta !== 0) {
    return hopDelta;
  }

  return left.route.label.localeCompare(right.route.label);
}

function confidenceRank(confidence: TradeRouteDescriptor["confidence"]): number {
  if (confidence === "high") {
    return 3;
  }
  if (confidence === "medium") {
    return 2;
  }
  return 1;
}

function symbolMatches(routeSymbol: string, requestedSymbol: string): boolean {
  const requested = normalizeSymbol(requestedSymbol);
  const routeBase = normalizeSymbol(routeSymbol.split("-")[0] ?? routeSymbol);
  return routeBase === requested || normalizeSymbol(routeSymbol) === requested;
}

function normalizeSymbol(value: string): string {
  return value.trim().toLowerCase();
}

function formatRouteAmount(kind: "native" | "token", amount: bigint, tokenOutDecimals: number): string {
  return kind === "native" ? formatEther(amount) : formatUnits(amount, tokenOutDecimals);
}

function toRouteDescriptor(route: CuratedPolicyVaultRoute): TradeRouteDescriptor {
  return {
    confidence: route.confidence,
    factory: route.factory,
    fees: [...route.fees],
    id: route.id,
    label: route.label,
    path: [...route.path],
    pools: [...route.pools],
    router: route.router,
    symbol: route.symbol,
    tokenIn: W0G_MAINNET,
    tokenOut: route.tokenOut,
    venue: route.venue,
  };
}

export function parseRouteQuoteAddress(value: string | undefined): Address | undefined {
  return value !== undefined && isAddress(value) ? getAddress(value) : undefined;
}

export function parseRouteQuoteHex32(value: string | undefined): Hex | undefined {
  return value !== undefined && isHex(value, { strict: true }) && value.length === 66 ? value : undefined;
}

export function zeroAddress(): Address {
  return ZERO_ADDRESS;
}
