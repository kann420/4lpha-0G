import "server-only";

import { createHash } from "node:crypto";
import {
  createPublicClient,
  formatEther,
  formatUnits,
  getAddress,
  http,
  isAddress,
  keccak256,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  CURATED_MAINNET_POLICY_VAULT_ROUTES,
  W0G_MAINNET,
  uniqueCuratedMainnetTokens,
} from "@/lib/contracts/curated-routes";
import { getVerifiedMainnetTokenProfile } from "@/lib/contracts/verified-tokens";
import { getOgNetwork } from "@/lib/og/networks";
import {
  TradeRouteQuoteError,
  listCuratedMainnetRouteDescriptors,
  quoteCuratedMainnetRoutes,
} from "@/lib/trading/curated-route-quotes";
import type {
  AiScanAgentLogEntry,
  AiScanEvidenceRow,
  AiScanReport,
  AiScanReportItem,
  AiScanReportSection,
  AiScanRequest,
  AiScanRouteRecommendation,
  AiScanVerdict,
  AiScanVerifiedTokenProfile,
} from "@/lib/types/ai-scan";
import type { OgNetworkConfig, OgNetworkId, TradeRouteDescriptor, TradeRouteQuote } from "@/lib/types";

const ZERO_BYTES32 = `0x${"00".repeat(32)}` as Hex;
const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;
const AI_SCAN_MODEL_HASH = "deterministic-rpc-ai-scan-v1";
const RECENT_BLOCK_SCAN_DEPTH = 16;

const erc20MetadataAbi = [
  {
    inputs: [],
    name: "name",
    outputs: [{ internalType: "string", name: "", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "symbol",
    outputs: [{ internalType: "string", name: "", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "decimals",
    outputs: [{ internalType: "uint8", name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "totalSupply",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const ownableAbi = [
  {
    inputs: [],
    name: "owner",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

interface AiScanRpcContext {
  blockNumber: bigint;
  network: OgNetworkConfig;
  publicClient: PublicClient;
  rpcSource: string;
}

interface TokenFacts {
  bytecodeHash?: Hex;
  bytecodeSize: number;
  decimals?: number;
  implementation?: Address;
  isContract: boolean;
  name?: string;
  owner?: Address;
  ownerStatus: "renounced" | "present" | "unavailable";
  symbol?: string;
  totalSupplyFormatted?: string;
}

interface TokenRouteFacts {
  buyQuote?: TradeRouteQuote;
  matchedRoutes: TradeRouteDescriptor[];
  quoteError?: string;
  sellQuote?: TradeRouteQuote;
}

interface WalletFacts {
  bytecodeSize: number;
  nativeBalanceFormatted: string;
  recentTransactions: RecentWalletTransaction[];
  tokenBalances: WalletTokenBalance[];
  transactionCount: number;
}

interface WalletTokenBalance {
  address: Address;
  formatted: string;
  raw: bigint;
  routeCount: number;
  symbol: string;
}

interface RecentWalletTransaction {
  blockNumber: string;
  counterparty: string;
  direction: "in" | "out" | "self";
  hash: Hex;
  kind: "contract call" | "contract creation" | "value transfer";
  value0G: string;
}

interface RpcCandidate {
  source: string;
  url: string;
}

export class AiScanError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function runAiScan(input: AiScanRequest): Promise<{ report: AiScanReport; rpcSource: string }> {
  if (!isAddress(input.address)) {
    throw new AiScanError("AI Scan target must be a valid EVM address.", "invalid_address", 400);
  }

  const address = getAddress(input.address);
  const context = await resolveAiScanRpc(input.networkId);
  const report =
    input.targetType === "token"
      ? await buildTokenReport(context, address, input)
      : await buildWalletReport(context, address, input);

  return {
    report,
    rpcSource: context.rpcSource,
  };
}

export async function findRecentWalletCandidates(networkId: OgNetworkId, limit: number): Promise<Address[]> {
  const context = await resolveAiScanRpc(networkId);
  const seen = new Set<string>();
  const candidates: Address[] = [];
  const depth = Math.max(4, Math.min(32, limit * 8));

  for (let offset = 0; offset < depth && candidates.length < limit; offset += 1) {
    const blockNumber = context.blockNumber - BigInt(offset);
    if (blockNumber < 0n) {
      break;
    }

    const block = await safeAsync(() => context.publicClient.getBlock({ blockNumber, includeTransactions: true }));
    if (!block) {
      continue;
    }

    for (const transaction of block.transactions) {
      if (typeof transaction === "string") {
        continue;
      }

      const addresses = [transaction.from, transaction.to].filter((value): value is Address => Boolean(value && isAddress(value)));
      for (const rawAddress of addresses) {
        const normalized = getAddress(rawAddress);
        const key = normalized.toLowerCase();
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        candidates.push(normalized);
        if (candidates.length >= limit) {
          return candidates;
        }
      }
    }
  }

  return candidates;
}

async function buildTokenReport(context: AiScanRpcContext, address: Address, input: AiScanRequest): Promise<AiScanReport> {
  const facts = await readTokenFacts(context.publicClient, address);
  const routeFacts = await readTokenRouteFacts(context.network.id, address);
  const verifiedToken = context.network.id === "mainnet" ? getVerifiedMainnetTokenProfile(address) : undefined;
  const riskScore = calculateTokenRiskScore(facts, routeFacts);
  const score = verifiedToken ? 100 : riskScore;
  const verdict = verifiedToken ? "Verified" : riskVerdict(riskScore);
  const routeRecommendation = buildRouteRecommendation(routeFacts);
  const targetLabel = verifiedToken?.name ?? (facts.symbol ? `${facts.symbol} Token` : facts.isContract ? "Unknown Token" : "Non-contract address");
  const summary = verifiedToken ? buildVerifiedTokenSummary(context, verifiedToken, routeFacts) : buildTokenSummary(context, facts, routeFacts);
  const recommendation = verifiedToken ? buildVerifiedTokenRecommendation(verifiedToken, routeFacts) : routeRecommendation.summary;
  const evidenceBundle = createEvidenceBundle({
    address,
    blockNumber: context.blockNumber.toString(),
    facts,
    networkId: context.network.id,
    routeFacts,
    targetType: input.targetType,
    verifiedToken,
  });
  const scanId = createScanId(context.network.id, address, evidenceBundle.storageRoot);

  return {
    address,
    agentLogs: tokenAgentLogs(facts, routeFacts, context.blockNumber, verifiedToken),
    evidence: evidenceRows(scanId, evidenceBundle, context, verifiedToken),
    mode: input.mode,
    network: {
      chainId: context.network.chainId,
      id: context.network.id,
      label: context.network.networkName,
    },
    recommendation,
    routeRecommendation,
    scanId,
    score,
    sections: tokenSections(facts, routeFacts, verifiedToken),
    summary,
    targetLabel,
    targetType: "token",
    verdict,
    verifiedToken,
  };
}

async function buildWalletReport(context: AiScanRpcContext, address: Address, input: AiScanRequest): Promise<AiScanReport> {
  const facts = await readWalletFacts(context, address);
  const riskScore = calculateWalletRiskScore(facts);
  const verdict = riskVerdict(riskScore);
  const smartMoneyLabel = classifySmartMoney(facts);
  const evidenceBundle = createEvidenceBundle({
    address,
    blockNumber: context.blockNumber.toString(),
    facts,
    networkId: context.network.id,
    targetType: input.targetType,
  });
  const scanId = createScanId(context.network.id, address, evidenceBundle.storageRoot);

  return {
    address,
    agentLogs: walletAgentLogs(facts, smartMoneyLabel, context.blockNumber),
    evidence: evidenceRows(scanId, evidenceBundle, context),
    mode: input.mode,
    network: {
      chainId: context.network.chainId,
      id: context.network.id,
      label: context.network.networkName,
    },
    recommendation: walletRecommendation(facts, smartMoneyLabel),
    scanId,
    score: riskScore,
    sections: walletSections(facts, smartMoneyLabel),
    summary:
      "Wallet report built from native balance, curated-token balances, transaction count, and recent block activity. Full historical PnL and labels can be enriched later with CMC and indexer data.",
    targetLabel: facts.bytecodeSize > 0 ? "Contract Wallet" : "Wallet",
    targetType: "wallet",
    verdict,
  };
}

async function readTokenFacts(publicClient: PublicClient, address: Address): Promise<TokenFacts> {
  const bytecode = await safeAsync(() => publicClient.getBytecode({ address }));
  const isContract = Boolean(bytecode && bytecode !== "0x");
  const bytecodeSize = bytecode && bytecode !== "0x" ? (bytecode.length - 2) / 2 : 0;
  const bytecodeHash = bytecode && bytecode !== "0x" ? keccak256(bytecode) : undefined;

  if (!isContract) {
    return {
      bytecodeHash,
      bytecodeSize,
      isContract: false,
      ownerStatus: "unavailable",
    };
  }

  const [name, symbol, decimals, totalSupply, owner, implementation] = await Promise.all([
    readErc20String(publicClient, address, "name"),
    readErc20String(publicClient, address, "symbol"),
    readErc20Decimals(publicClient, address),
    readErc20TotalSupply(publicClient, address),
    readOwner(publicClient, address),
    readProxyImplementation(publicClient, address),
  ]);
  const totalSupplyFormatted = totalSupply !== undefined && decimals !== undefined ? formatUnits(totalSupply, decimals) : undefined;

  return {
    bytecodeHash,
    bytecodeSize,
    decimals,
    implementation,
    isContract,
    name,
    owner,
    ownerStatus: owner === undefined ? "unavailable" : owner === zeroAddress() ? "renounced" : "present",
    symbol,
    totalSupplyFormatted,
  };
}

async function readTokenRouteFacts(networkId: OgNetworkId, address: Address): Promise<TokenRouteFacts> {
  if (networkId !== "mainnet") {
    return {
      matchedRoutes: [],
      quoteError: "Curated Policy Vault routes are currently configured for 0G mainnet.",
    };
  }

  const matchedRoutes = listCuratedMainnetRouteDescriptors().filter((route) => route.tokenOut.toLowerCase() === address.toLowerCase());
  if (matchedRoutes.length === 0) {
    return {
      matchedRoutes,
      quoteError: "Token is not in the mainnet Policy Vault curated route allowlist.",
    };
  }

  const [buyQuote, sellQuote] = await Promise.all([
    safeRouteQuote(address, "buy"),
    safeRouteQuote(address, "sell"),
  ]);
  const quoteError = buyQuote.error ?? sellQuote.error;

  return {
    buyQuote: buyQuote.quote,
    matchedRoutes,
    quoteError,
    sellQuote: sellQuote.quote,
  };
}

async function safeRouteQuote(
  tokenOut: Address,
  direction: "buy" | "sell",
): Promise<{ error?: string; quote?: TradeRouteQuote }> {
  try {
    const selection = await quoteCuratedMainnetRoutes({
      amountInDecimal: direction === "buy" ? "0.001" : "0.001",
      direction,
      includeAlternates: true,
      slippageBps: 50,
      tokenOut,
    });
    return { quote: selection.selectedQuote };
  } catch (error) {
    if (error instanceof TradeRouteQuoteError) {
      return { error: error.message };
    }
    return { error: "Live route quote is unavailable from the venue quoter." };
  }
}

async function readWalletFacts(context: AiScanRpcContext, address: Address): Promise<WalletFacts> {
  const [balance, transactionCount, bytecode, recentTransactions, tokenBalances] = await Promise.all([
    context.publicClient.getBalance({ address }),
    context.publicClient.getTransactionCount({ address }),
    safeAsync(() => context.publicClient.getBytecode({ address })),
    readRecentWalletTransactions(context, address),
    readWalletTokenBalances(context, address),
  ]);

  return {
    bytecodeSize: bytecode && bytecode !== "0x" ? (bytecode.length - 2) / 2 : 0,
    nativeBalanceFormatted: formatCompactDecimal(formatEther(balance)),
    recentTransactions,
    tokenBalances,
    transactionCount,
  };
}

async function readWalletTokenBalances(context: AiScanRpcContext, wallet: Address): Promise<WalletTokenBalance[]> {
  if (context.network.id !== "mainnet") {
    return [];
  }

  const tokenRouteCounts = new Map<string, number>();
  for (const route of CURATED_MAINNET_POLICY_VAULT_ROUTES) {
    tokenRouteCounts.set(route.tokenOut.toLowerCase(), (tokenRouteCounts.get(route.tokenOut.toLowerCase()) ?? 0) + 1);
  }
  tokenRouteCounts.set(W0G_MAINNET.toLowerCase(), 0);

  const tokens = [W0G_MAINNET, ...uniqueCuratedMainnetTokens()];
  const balances = await Promise.all(
    tokens.map(async (token) => {
      const [symbol, decimals, raw] = await Promise.all([
        readErc20String(context.publicClient, token, "symbol"),
        readErc20Decimals(context.publicClient, token),
        safeAsync(() =>
          context.publicClient.readContract({
            abi: erc20MetadataAbi,
            address: token,
            args: [wallet],
            functionName: "balanceOf",
          }),
        ),
      ]);
      if (raw === undefined || raw <= 0n || decimals === undefined) {
        return undefined;
      }

      return {
        address: token,
        formatted: formatCompactDecimal(formatUnits(raw, decimals)),
        raw,
        routeCount: tokenRouteCounts.get(token.toLowerCase()) ?? 0,
        symbol: symbol ?? shortAddress(token),
      } satisfies WalletTokenBalance;
    }),
  );

  return balances.filter((balance): balance is WalletTokenBalance => balance !== undefined);
}

async function readRecentWalletTransactions(context: AiScanRpcContext, wallet: Address): Promise<RecentWalletTransaction[]> {
  const normalized = wallet.toLowerCase();
  const transactions: RecentWalletTransaction[] = [];

  for (let offset = 0; offset < RECENT_BLOCK_SCAN_DEPTH && transactions.length < 8; offset += 1) {
    const blockNumber = context.blockNumber - BigInt(offset);
    if (blockNumber < 0n) {
      break;
    }

    const block = await safeAsync(() => context.publicClient.getBlock({ blockNumber, includeTransactions: true }));
    if (!block) {
      continue;
    }

    for (const transaction of block.transactions) {
      if (typeof transaction === "string") {
        continue;
      }

      const from = transaction.from.toLowerCase();
      const to = transaction.to?.toLowerCase();
      if (from !== normalized && to !== normalized) {
        continue;
      }

      const direction = from === normalized && to === normalized ? "self" : from === normalized ? "out" : "in";
      const counterparty =
        direction === "out"
          ? transaction.to
            ? shortAddress(getAddress(transaction.to))
            : "contract creation"
          : shortAddress(getAddress(transaction.from));

      transactions.push({
        blockNumber: blockNumber.toString(),
        counterparty,
        direction,
        hash: transaction.hash,
        kind: transaction.to ? (transaction.input && transaction.input !== "0x" ? "contract call" : "value transfer") : "contract creation",
        value0G: formatCompactDecimal(formatEther(transaction.value)),
      });

      if (transactions.length >= 8) {
        return transactions;
      }
    }
  }

  return transactions;
}

function calculateTokenRiskScore(facts: TokenFacts, routeFacts: TokenRouteFacts): number {
  let score = 18;
  if (!facts.isContract) score += 70;
  if (facts.isContract && (!facts.symbol || facts.decimals === undefined || facts.totalSupplyFormatted === undefined)) score += 18;
  if (facts.ownerStatus === "present") score += 15;
  if (facts.implementation) score += 10;
  if (routeFacts.matchedRoutes.length === 0) score += 24;
  if (!routeFacts.buyQuote) score += 10;
  if (!routeFacts.sellQuote) score += 16;
  if (routeFacts.matchedRoutes.some((route) => route.confidence === "high")) score -= 10;
  if (routeFacts.buyQuote && routeFacts.sellQuote) score -= 14;
  return clampScore(score);
}

function calculateWalletRiskScore(facts: WalletFacts): number {
  let score = 46;
  if (facts.transactionCount === 0) score += 24;
  if (facts.transactionCount > 50) score -= 10;
  if (facts.transactionCount > 250) score -= 8;
  if (facts.recentTransactions.length === 0) score += 10;
  if (facts.recentTransactions.length >= 3) score -= 8;
  if (facts.tokenBalances.length === 0) score += 8;
  if (facts.tokenBalances.length >= 2) score -= 8;
  if (facts.bytecodeSize > 0) score += 8;
  return clampScore(score);
}

function riskVerdict(score: number): AiScanVerdict {
  if (score >= 70) return "High risk";
  if (score >= 35) return "Watch";
  return "Safe";
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function buildRouteRecommendation(routeFacts: TokenRouteFacts): AiScanRouteRecommendation {
  if (routeFacts.matchedRoutes.length === 0) {
    return {
      matchedRoutes: [],
      status: "blocked",
      summary:
        "No Policy Vault route is allowlisted for this token yet. Treat it as blocked for vault execution until a reviewed route, pool, and sell-path quote are added.",
    };
  }

  const selectedQuote = routeFacts.buyQuote;
  const selectedRoute = selectedQuote?.route ?? routeFacts.matchedRoutes[0];
  const sellStatus = routeFacts.sellQuote
    ? "Sell-path quote returned a nonzero amountOutMin."
    : "Sell-path quote is not available yet.";
  const summary = selectedQuote
    ? `Recommended route: ${selectedRoute.label} via ${selectedRoute.venue}. ${sellStatus} Keep max slippage at 0.5% and require nonzero amountOutMin before vault execution.`
    : `Route candidate found: ${selectedRoute.label} via ${selectedRoute.venue}, but live quote is unavailable. Keep this in review until the quoter responds.`;

  return {
    liveQuote: selectedQuote
      ? {
          amountIn: selectedQuote.amountInFormatted,
          amountOut: selectedQuote.amountOutFormatted,
          amountOutMin: selectedQuote.amountOutMinFormatted,
          direction: selectedQuote.direction,
          provider: selectedQuote.quoteProvider,
        }
      : undefined,
    matchedRoutes: routeFacts.matchedRoutes,
    status: routeFacts.buyQuote && routeFacts.sellQuote ? "recommended" : "review",
    summary,
  };
}

function buildTokenSummary(context: AiScanRpcContext, facts: TokenFacts, routeFacts: TokenRouteFacts): string {
  if (!facts.isContract) {
    return `The target has no contract bytecode on ${context.network.networkName}. It cannot be scanned as a token contract.`;
  }

  const metadata = facts.symbol ? `${facts.symbol}${facts.name ? ` (${facts.name})` : ""}` : "ERC20-like contract";
  const routeText =
    routeFacts.matchedRoutes.length > 0
      ? `${routeFacts.matchedRoutes.length} Policy Vault route candidate(s) matched.`
      : "No Policy Vault route candidate matched.";
  return `${metadata} scanned on ${context.network.networkName} at block ${context.blockNumber.toString()}. ${routeText} Holder and market labels can be enriched later with CMC and indexer data.`;
}

function buildVerifiedTokenSummary(
  context: AiScanRpcContext,
  profile: AiScanVerifiedTokenProfile,
  routeFacts: TokenRouteFacts,
): string {
  const routeText =
    routeFacts.matchedRoutes.length > 0
      ? `${routeFacts.matchedRoutes.length} reviewed Policy Vault route(s) matched on ${context.network.networkName}.`
      : `The token is verified in the registry, but no live route matched on ${context.network.networkName}.`;

  return `${profile.summary} ${routeText} Bytecode, ERC20 metadata, route quotes, and evidence hashes are still included as audit context.`;
}

function buildVerifiedTokenRecommendation(
  profile: AiScanVerifiedTokenProfile,
  routeFacts: TokenRouteFacts,
): string {
  const route = routeFacts.buyQuote?.route ?? routeFacts.matchedRoutes[0];
  const routeText = route ? ` Recommended route: ${route.label} via ${route.venue}.` : "";
  const quoteText =
    routeFacts.buyQuote && routeFacts.sellQuote
      ? " Buy and sell quote coverage returned nonzero output in the read-only quoter."
      : " If live quote coverage is temporarily unavailable, keep execution policy-gated until the quoter responds.";

  return `${profile.recommendation}${routeText}${quoteText}`;
}

function tokenSections(
  facts: TokenFacts,
  routeFacts: TokenRouteFacts,
  verifiedToken?: AiScanVerifiedTokenProfile,
): AiScanReportSection[] {
  const sections: AiScanReportSection[] = verifiedToken ? verifiedTokenSections(verifiedToken, routeFacts) : [];

  if (!verifiedToken && routeFacts.matchedRoutes.length > 0) {
    const highConfidenceRoutes = routeFacts.matchedRoutes.filter((route) => route.confidence === "high").length;
    sections.push({
      action: routeFacts.buyQuote && routeFacts.sellQuote ? "Verified route" : "Review quote",
      items: [
        cleanItem(
          "Vault allowlisted token",
          `${routeFacts.matchedRoutes.length} curated Policy Vault route(s) target this token.`,
        ),
        highConfidenceRoutes > 0
          ? cleanItem("High-confidence route", `${highConfidenceRoutes} route(s) are marked high confidence in the vault route catalog.`)
          : infoItem("Medium-confidence route", "Route exists, but confidence is not marked high."),
        routeFacts.buyQuote && routeFacts.sellQuote
          ? cleanItem("Read-only entry and exit quotes", "Both buy and sell quotes returned nonzero output through reviewed route metadata.")
          : warningItem("Quote coverage incomplete", routeFacts.quoteError ?? "One side of the route quote did not return."),
      ],
      title: "Vault Filter",
    });
  }

  sections.push(
    {
      items: [
        routeFacts.sellQuote
          ? cleanItem(
              "Sell path quote available",
              `Read-only quote returned ${routeFacts.sellQuote.amountOutMinFormatted} 0G minimum for a small sell sample.`,
            )
          : warningItem(
              "Sell path unverified",
              routeFacts.quoteError ?? "No read-only sell quote is available for this token.",
            ),
        routeFacts.buyQuote
          ? cleanItem(
              "Buy route quote available",
              `Read-only quote returned ${routeFacts.buyQuote.amountOutMinFormatted} minimum output after 0.5% slippage.`,
            )
          : warningItem("Buy route unverified", routeFacts.quoteError ?? "No read-only buy quote is available for this token."),
        verifiedToken
          ? cleanItem(
              "Transfer behavior policy-gated",
              "Verified registry status prevents false scam classification, while live vault execution still requires the configured route and min-out guard.",
            )
          : infoItem(
              "Transfer fee not inferred",
              "Plain RPC metadata cannot prove fee-on-transfer behavior. A forked buy/sell simulation layer should confirm this before live vault execution.",
            ),
      ],
      title: "Swap Analysis",
    },
    {
      items: [
        facts.isContract
          ? cleanItem("Bytecode present", `${facts.bytecodeSize.toLocaleString("en-US")} bytes deployed.`)
          : dangerItem("No contract bytecode", "Address is an EOA or empty account on the selected 0G network."),
        facts.symbol && facts.decimals !== undefined
          ? cleanItem("ERC20 metadata readable", `${facts.symbol}, ${facts.decimals} decimals.`)
          : warningItem("ERC20 metadata incomplete", "name, symbol, decimals, or totalSupply could not be read."),
        facts.ownerStatus === "renounced"
          ? cleanItem("Owner renounced", "owner() resolves to the zero address.")
          : facts.ownerStatus === "present" && verifiedToken
            ? infoItem(
                "Owner powers present, registry reviewed",
                `owner() resolves to ${shortAddress(facts.owner as Address)}. For verified tokens, owner() alone is treated as an operational note, not a scam signal.`,
              )
          : facts.ownerStatus === "present"
            ? warningItem("Owner powers present", `owner() resolves to ${shortAddress(facts.owner as Address)}.`)
            : infoItem("Owner check unavailable", "owner() is not exposed or reverted."),
        facts.implementation
          ? warningItem("Proxy implementation slot set", `EIP-1967 implementation resolves to ${shortAddress(facts.implementation)}.`)
          : cleanItem("No EIP-1967 proxy hint", "Implementation slot is empty."),
      ],
      title: "Contract Analysis",
    },
    {
      action: "CMC layer later",
      items: [
        facts.totalSupplyFormatted
          ? infoItem("Total supply readable", compactMetric("Supply", facts.totalSupplyFormatted))
          : warningItem("Total supply unavailable", "totalSupply() could not be read."),
        infoItem(
          "Holder distribution pending",
          "Plain RPC does not provide holder distribution. This should be enriched with CMC Pro or an indexed Transfer-log job.",
        ),
      ],
      title: "Holder Analysis",
    },
    ...(verifiedToken
      ? []
      : [
          {
            action: routeFacts.matchedRoutes.length > 0 ? "Vault route candidate" : "Blocked",
            items: routeRecommendationItems(routeFacts),
            title: "Route Recommendation",
          },
        ]),
  );

  return sections;
}

function verifiedTokenSections(
  profile: AiScanVerifiedTokenProfile,
  routeFacts: TokenRouteFacts,
): AiScanReportSection[] {
  const sections: AiScanReportSection[] = [
    {
      action: profile.badgeLabel,
      items: [
        cleanItem("Verified token", `${profile.symbol} is listed in the ${profile.verificationSource}.`),
        cleanItem("Vault-approved asset class", `${profile.category} via ${profile.protocol}.`),
        ...profile.notes.slice(0, 2).map((note) => infoItem("Registry note", note)),
      ],
      title: "Verified Token",
    },
  ];

  if (profile.symbol === "USDC.e") {
    sections.push({
      action: "Bridge asset",
      items: [
        cleanItem("What is USDC.e?", profile.summary),
        infoItem(
          "USDC.e vs native USDC",
          "USDC.e is evaluated as a bridge-native or wrapped USDC exposure. Circle-native USDC remains the direct Circle-issued asset.",
        ),
      ],
      title: "USDC.e Context",
    });
  }

  if (profile.comparison) {
    sections.push({
      action: `${profile.comparison.verifiedLabel} / ${profile.comparison.nativeLabel}`,
      items: profile.comparison.rows.map((row) => ({
        metrics: [`${profile.comparison?.verifiedLabel}: ${row.verified}`, `${profile.comparison?.nativeLabel}: ${row.native}`],
        status: "info",
        title: row.label,
      })),
      title: "Asset Comparison",
    });
  }

  if (routeFacts.matchedRoutes.length > 0) {
    sections.push({
      action: routeFacts.buyQuote && routeFacts.sellQuote ? "Route ready" : "Quote review",
      items: routeRecommendationItems(routeFacts),
      title: "Verified Swap Route",
    });
  }

  return sections;
}

function routeRecommendationItems(routeFacts: TokenRouteFacts): AiScanReportItem[] {
  if (routeFacts.matchedRoutes.length === 0) {
    return [
      dangerItem("Not vault allowlisted", "No curated Policy Vault route currently targets this token."),
      warningItem("Execution guard", "Do not let the vault trade this token until token, pool, router, and route id are reviewed."),
    ];
  }

  const route = routeFacts.buyQuote?.route ?? routeFacts.matchedRoutes[0];
  const metrics = [
    `Primary: ${route.label}`,
    `Venue: ${route.venue}`,
    `Confidence: ${route.confidence}`,
    `Pools: ${route.pools.map(shortAddress).join(" / ")}`,
  ];
  if (routeFacts.buyQuote) {
    metrics.push(`Buy quote: ${routeFacts.buyQuote.amountInFormatted} 0G -> ${routeFacts.buyQuote.amountOutMinFormatted} min`);
  }
  if (routeFacts.sellQuote) {
    metrics.push(`Sell quote: ${routeFacts.sellQuote.amountInFormatted} token -> ${routeFacts.sellQuote.amountOutMinFormatted} 0G min`);
  }

  return [
    {
      metrics,
      status: routeFacts.buyQuote && routeFacts.sellQuote ? "clean" : "warning",
      title: "Recommended swap route",
    },
    routeFacts.sellQuote
      ? cleanItem("Sell exit signal", "Read-only quoter returned a nonzero sell amountOutMin.")
      : warningItem("Sell exit needs review", routeFacts.quoteError ?? "Sell quote did not return."),
  ];
}

function walletSections(facts: WalletFacts, smartMoneyLabel: string): AiScanReportSection[] {
  return [
    {
      action: "Curated tokens",
      items: [
        {
          metrics: [
            `Native 0G: ${facts.nativeBalanceFormatted}`,
            `Tracked token positions: ${facts.tokenBalances.length}`,
            `Lifetime outgoing tx count: ${facts.transactionCount}`,
          ],
          status: facts.tokenBalances.length > 0 ? "info" : "warning",
          title: "Portfolio snapshot",
        },
        facts.tokenBalances.length > 0
          ? {
              metrics: facts.tokenBalances.slice(0, 5).map((balance) => {
                const routeText = balance.routeCount > 0 ? `${balance.routeCount} route(s)` : "wrapped native";
                return `${balance.symbol}: ${balance.formatted} (${routeText})`;
              }),
              status: "clean",
              title: "Tracked holdings",
            }
          : infoItem("No tracked token holdings", "No nonzero balances found across current curated mainnet route tokens."),
      ],
      title: "Portfolio",
    },
    {
      action: "Recent blocks",
      items: [
        {
          metrics:
            facts.recentTransactions.length > 0
              ? facts.recentTransactions.map(
                  (transaction) =>
                    `${transaction.direction} ${transaction.kind} ${transaction.value0G} 0G with ${transaction.counterparty} @ ${transaction.blockNumber}`,
                )
              : ["No matching transactions found in the recent block window."],
          status: facts.recentTransactions.length > 0 ? "clean" : "warning",
          title: "Recent activity",
        },
        {
          metrics: [
            `Recent matches: ${facts.recentTransactions.length}`,
            `Unique counterparties: ${uniqueCounterparties(facts.recentTransactions).length}`,
            `Contract calls: ${facts.recentTransactions.filter((transaction) => transaction.kind === "contract call").length}`,
          ],
          status: "info",
          title: "Behavior window",
        },
      ],
      title: "Recent Activity",
    },
    {
      action: smartMoneyLabel,
      items: [
        {
          metrics: [
            `Tx count: ${facts.transactionCount}`,
            `Position diversity: ${facts.tokenBalances.length}`,
            `Recent counterparty spread: ${uniqueCounterparties(facts.recentTransactions).length}`,
          ],
          status: smartMoneyLabel === "Insufficient data" ? "warning" : "info",
          title: "Smart-money heuristic",
        },
        smartMoneyLabel === "Watchlist candidate"
          ? cleanItem("Useful for research", "Activity and holdings are diverse enough to keep this wallet on a research list.")
          : warningItem("Copy-trade caution", "Do not mirror this wallet automatically until historical PnL and entry timing are indexed."),
      ],
      title: "Smart Money",
    },
  ];
}

function tokenAgentLogs(
  facts: TokenFacts,
  routeFacts: TokenRouteFacts,
  blockNumber: bigint,
  verifiedToken?: AiScanVerifiedTokenProfile,
): AiScanAgentLogEntry[] {
  if (verifiedToken) {
    return [
      {
        detail: `${verifiedToken.symbol} matched the ${verifiedToken.verificationSource}; verified registry status locks the safety score at 100/100 unless explicit critical evidence is present.`,
        label: "Registry match",
        time: "00:00.10",
        tone: "clean",
      },
      {
        detail: facts.isContract
          ? `Bytecode hash ${shortHash(facts.bytecodeHash)} and ERC20 metadata were read from the selected 0G network.`
          : "No bytecode was found; this would override verified-token handling.",
        label: "Contract read",
        time: "00:00.68",
        tone: facts.isContract ? "clean" : "danger",
      },
      {
        detail:
          routeFacts.matchedRoutes.length > 0
            ? `${routeFacts.matchedRoutes.length} reviewed Policy Vault route candidate(s) matched this verified token.`
            : "Verified registry matched, but the active route catalog did not return a route for this network.",
        label: "Vault allowlist",
        time: "00:01.22",
        tone: routeFacts.matchedRoutes.length > 0 ? "clean" : "warning",
      },
      {
        detail:
          routeFacts.buyQuote && routeFacts.sellQuote
            ? "Read-only buy and sell quotes returned nonzero output; vault execution should still use nonzero amountOutMin and configured slippage."
            : "Quote coverage is incomplete, so execution remains policy-gated even though the asset is verified.",
        label: "Route quotes",
        time: "00:01.86",
        tone: routeFacts.buyQuote && routeFacts.sellQuote ? "clean" : "info",
      },
      {
        detail: "0G Compute turns the deterministic packet into a readable report, but the verified-token score and verdict are enforced by backend guardrails.",
        label: "AI reasoning",
        time: "00:02.18",
        tone: "info",
      },
      {
        detail: "Redacted scan facts were hashed into a local evidence root; 0G Storage upload and proof tx are the next backend step.",
        label: "Evidence bundle",
        time: "00:02.54",
        tone: "info",
      },
    ];
  }

  return [
    {
      detail: `Address normalized and 0G RPC snapshot pinned at block ${blockNumber.toString()}.`,
      label: "Input normalized",
      time: "00:00.10",
      tone: "clean",
    },
    {
      detail: facts.isContract
        ? `Bytecode hash ${shortHash(facts.bytecodeHash)} and ERC20 metadata were requested from chain.`
        : "No bytecode was found, so token analysis is blocked.",
      label: "Contract read",
      time: "00:00.68",
      tone: facts.isContract ? "info" : "danger",
    },
    {
      detail:
        routeFacts.matchedRoutes.length > 0
          ? `${routeFacts.matchedRoutes.length} curated route candidate(s) matched the Policy Vault allowlist.`
          : "No curated route matched the Policy Vault allowlist.",
      label: "Vault route",
      time: "00:01.22",
      tone: routeFacts.matchedRoutes.length > 0 ? "clean" : "warning",
    },
    {
      detail: routeFacts.sellQuote
        ? "Read-only sell quote returned nonzero output. Fork simulation is still required for transfer-restriction proof."
        : "Sell path could not be verified by read-only quoter.",
      label: "Sell path",
      time: "00:01.86",
      tone: routeFacts.sellQuote ? "clean" : "warning",
    },
    {
      detail: "Redacted scan facts were hashed into a local evidence root; 0G Storage upload and proof tx are the next backend step.",
      label: "Evidence bundle",
      time: "00:02.34",
      tone: "info",
    },
  ];
}

function walletAgentLogs(facts: WalletFacts, smartMoneyLabel: string, blockNumber: bigint): AiScanAgentLogEntry[] {
  return [
    {
      detail: `Wallet normalized and chain snapshot pinned at block ${blockNumber.toString()}.`,
      label: "Input normalized",
      time: "00:00.10",
      tone: "clean",
    },
    {
      detail: `Native balance ${facts.nativeBalanceFormatted} 0G and ${facts.tokenBalances.length} tracked token position(s) were read.`,
      label: "Portfolio scan",
      time: "00:00.82",
      tone: facts.tokenBalances.length > 0 ? "clean" : "info",
    },
    {
      detail: `${facts.recentTransactions.length} matching transaction(s) found in the recent block window.`,
      label: "Recent activity",
      time: "00:01.46",
      tone: facts.recentTransactions.length > 0 ? "clean" : "warning",
    },
    {
      detail: `${smartMoneyLabel}. Keep as research context unless historical PnL is indexed.`,
      label: "Agent decision",
      time: "00:02.10",
      tone: smartMoneyLabel === "Insufficient data" ? "warning" : "info",
    },
  ];
}

function walletRecommendation(facts: WalletFacts, smartMoneyLabel: string): string {
  if (smartMoneyLabel === "Watchlist candidate") {
    return "Wallet is useful for research and watchlisting. Do not copy trades automatically until historical PnL, entry timing, and counterparty labels are indexed.";
  }
  if (facts.transactionCount === 0) {
    return "Wallet has no outgoing transaction history on this network. Treat it as cold or inactive until more context appears.";
  }
  return "Wallet has partial on-chain context. Use it as a research signal only, and require portfolio/PnL enrichment before any automated strategy follows it.";
}

function classifySmartMoney(facts: WalletFacts): string {
  const counterpartyCount = uniqueCounterparties(facts.recentTransactions).length;
  if (facts.transactionCount >= 50 && (facts.tokenBalances.length >= 2 || counterpartyCount >= 3)) {
    return "Watchlist candidate";
  }
  if (facts.transactionCount >= 10) {
    return "Behavioral sample";
  }
  return "Insufficient data";
}

function evidenceRows(
  scanId: string,
  bundle: { promptHash: string; responseHash: string; storageRoot: string },
  context: AiScanRpcContext,
  verifiedToken?: AiScanVerifiedTokenProfile,
): AiScanEvidenceRow[] {
  return [
    { label: "Scan ID", value: scanId },
    ...(verifiedToken ? [{ label: "Verified registry", value: verifiedToken.verificationSource }] : []),
    { label: "Storage root", value: bundle.storageRoot },
    { label: "Block", value: context.blockNumber.toString() },
    { label: "Model hash", value: hashText(AI_SCAN_MODEL_HASH) },
    { label: "Proof tx", value: "pending 0G anchor" },
  ];
}

function createEvidenceBundle(value: unknown): { promptHash: string; responseHash: string; storageRoot: string } {
  const redacted = stableJson(value);
  return {
    promptHash: hashText(`ai-scan-request:${redacted}`),
    responseHash: hashText(`ai-scan-response:${redacted}`),
    storageRoot: hashText(`ai-scan-storage-root:${redacted}`),
  };
}

async function resolveAiScanRpc(networkId: OgNetworkId): Promise<AiScanRpcContext> {
  const network = getOgNetwork(networkId);
  const candidates = rpcCandidates(networkId, network);
  const failures: string[] = [];

  for (const candidate of candidates) {
    const publicClient = createPublicClient({
      transport: http(candidate.url),
    });

    try {
      const chainId = await publicClient.getChainId();
      if (chainId !== network.chainId) {
        failures.push(`${candidate.source}: chain ${chainId}`);
        continue;
      }
      const blockNumber = await publicClient.getBlockNumber();
      return {
        blockNumber,
        network,
        publicClient,
        rpcSource: candidate.source,
      };
    } catch {
      failures.push(candidate.source);
    }
  }

  throw new AiScanError(
    `Unable to reach ${network.networkName} RPC for AI Scan.`,
    failures.length > 0 ? "rpc_unavailable" : "rpc_not_configured",
    502,
  );
}

function rpcCandidates(networkId: OgNetworkId, network: OgNetworkConfig): RpcCandidate[] {
  const candidates: RpcCandidate[] = [];
  if (networkId === "mainnet") {
    pushRpcCandidate(candidates, "OG_MAINNET_RPC_URL", process.env.OG_MAINNET_RPC_URL);
  } else {
    pushRpcCandidate(candidates, "OG_GALILEO_RPC_URL", process.env.OG_GALILEO_RPC_URL);
    pushRpcCandidate(candidates, "OG_TESTNET_RPC_URL", process.env.OG_TESTNET_RPC_URL);
  }

  if (genericRpcCanServe(network.chainId)) {
    pushRpcCandidate(candidates, "OG_RPC_URL", process.env.OG_RPC_URL);
  }
  pushRpcCandidate(candidates, "official-0g-rpc", network.rpcUrl);

  return dedupeRpcCandidates(candidates);
}

function genericRpcCanServe(chainId: number): boolean {
  const configuredChainId = process.env.OG_CHAIN_ID?.trim();
  return configuredChainId === undefined || configuredChainId === "" || configuredChainId === String(chainId);
}

function pushRpcCandidate(candidates: RpcCandidate[], source: string, rawUrl: string | undefined): void {
  const url = rawUrl?.trim();
  if (!url) {
    return;
  }
  try {
    const parsed = new URL(url);
    if (!isAllowedRpcProtocol(parsed)) {
      return;
    }
    candidates.push({
      source,
      url: parsed.toString().replace(/\/+$/u, ""),
    });
  } catch {}
}

function dedupeRpcCandidates(candidates: RpcCandidate[]): RpcCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = candidate.url.toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function isAllowedRpcProtocol(url: URL): boolean {
  return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname));
}

async function readErc20String(publicClient: PublicClient, address: Address, functionName: "name" | "symbol"): Promise<string | undefined> {
  const value = await safeAsync(() =>
    publicClient.readContract({
      abi: erc20MetadataAbi,
      address,
      functionName,
    }),
  );
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 96) : undefined;
}

async function readErc20Decimals(publicClient: PublicClient, address: Address): Promise<number | undefined> {
  const value = await safeAsync(() =>
    publicClient.readContract({
      abi: erc20MetadataAbi,
      address,
      functionName: "decimals",
    }),
  );
  return typeof value === "number" ? value : undefined;
}

async function readErc20TotalSupply(publicClient: PublicClient, address: Address): Promise<bigint | undefined> {
  return safeAsync(() =>
    publicClient.readContract({
      abi: erc20MetadataAbi,
      address,
      functionName: "totalSupply",
    }),
  );
}

async function readOwner(publicClient: PublicClient, address: Address): Promise<Address | undefined> {
  const owner = await safeAsync(() =>
    publicClient.readContract({
      abi: ownableAbi,
      address,
      functionName: "owner",
    }),
  );
  return owner && isAddress(owner) ? getAddress(owner) : undefined;
}

async function readProxyImplementation(publicClient: PublicClient, address: Address): Promise<Address | undefined> {
  const storage = await safeAsync(() =>
    publicClient.getStorageAt({
      address,
      slot: EIP1967_IMPLEMENTATION_SLOT,
    }),
  );
  return storageToAddress(storage);
}

function storageToAddress(value: Hex | undefined): Address | undefined {
  if (!value || value === ZERO_BYTES32 || value.length < 42) {
    return undefined;
  }
  const candidate = `0x${value.slice(-40)}`;
  if (!isAddress(candidate) || candidate.toLowerCase() === zeroAddress()) {
    return undefined;
  }
  return getAddress(candidate);
}

async function safeAsync<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch {
    return undefined;
  }
}

function cleanItem(title: string, detail: string): AiScanReportItem {
  return { detail, status: "clean", title };
}

function infoItem(title: string, detail: string): AiScanReportItem {
  return { detail, status: "info", title };
}

function warningItem(title: string, detail: string): AiScanReportItem {
  return { detail, status: "warning", title };
}

function dangerItem(title: string, detail: string): AiScanReportItem {
  return { detail, status: "danger", title };
}

function compactMetric(label: string, value: string): string {
  return `${label}: ${formatCompactDecimal(value)}`;
}

function formatCompactDecimal(value: string): string {
  if (!value.includes(".")) {
    return value;
  }
  const [whole, fraction = ""] = value.split(".");
  const compactFraction = fraction.replace(/0+$/u, "").slice(0, 6);
  return compactFraction.length > 0 ? `${whole}.${compactFraction}` : whole;
}

function uniqueCounterparties(transactions: RecentWalletTransaction[]): string[] {
  return [...new Set(transactions.map((transaction) => transaction.counterparty))];
}

function shortAddress(value: Address): string {
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function shortHash(value: Hex | undefined): string {
  if (!value) {
    return "unavailable";
  }
  return `${value.slice(0, 10)}...${value.slice(-6)}`;
}

function zeroAddress(): Address {
  return "0x0000000000000000000000000000000000000000";
}

function createScanId(networkId: OgNetworkId, address: Address, storageRoot: string): string {
  return `scan-${networkId}-${address.slice(2, 8).toLowerCase()}-${storageRoot.slice(2, 10)}`;
}

function hashText(value: string): Hex {
  return `0x${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function stableJson(value: unknown): string {
  if (typeof value === "bigint") {
    return JSON.stringify(value.toString());
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
