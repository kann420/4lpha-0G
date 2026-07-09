import { randomBytes } from "node:crypto";

import {
  createPublicClient,
  createWalletClient,
  formatEther,
  formatUnits,
  getAddress,
  http,
  isAddress,
  isHex,
  keccak256,
  parseEther,
  parseUnits,
  toBytes,
  zeroAddress,
  type Abi,
  type Address,
  type Chain,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  CURATED_MAINNET_POLICY_VAULT_ROUTES,
  OKU_MAINNET,
  ZIA_MAINNET,
  type CuratedPolicyVaultRoute,
} from "@/lib/contracts/curated-routes";
import {
  defaultMainnetPolicyVaultPolicy,
  getLatestPolicyVaultFactoryVersion,
  policyVaultAbi,
  policyVaultAgentKeyAbi,
  policyVaultFactoryAbi,
  policyVaultV2TradeAbi,
  type PolicyVaultPolicy,
} from "@/lib/contracts/policy-vault";
import { policyVaultV4SwapAbi } from "@/lib/contracts/policy-vault-v4";
import { makeMainnetTransport } from "@/lib/og/mainnet-rpc";
import { uploadBytesTo0GStorage } from "@/lib/og/storage-upload";
import { proofRegistryAbi as PROOF_REGISTRY_ABI } from "@/lib/contracts/proof-registry-abi";

const MAINNET_CHAIN_ID = 16661;
const ZERO_HASH = `0x${"00".repeat(32)}` as Hex;
const AGENT_REF = "4lpha-agent:curated-route-executor:v1";
const DEFAULT_SLIPPAGE_BPS = 50;
const MAX_SCRIPT_TRADE_0G = parseEther("0.005");

export type CuratedTradeSide = "buy" | "sell";

export interface CuratedTradeQuoteInput {
  amount: string;
  networkId: "mainnet";
  routeId?: Hex;
  side: CuratedTradeSide;
  slippageBps?: number;
  tokenAddress?: Address;
  tokenSymbol?: string;
  vaultAddress?: Address;
}

export interface CuratedTradeQuote {
  amountIn: string;
  amountInFormatted: string;
  amountOutMin: string;
  amountOutMinFormatted: string;
  canExecute: boolean;
  deadlineSeconds: string;
  inputDecimals: number;
  inputSymbol: string;
  minOutBps: number;
  networkId: "mainnet";
  outputDecimals: number;
  outputSymbol: string;
  policySnapshotHash?: Hex;
  quotedAmountOut: string;
  quotedAmountOutFormatted: string;
  route: {
    confidence: CuratedPolicyVaultRoute["confidence"];
    id: Hex;
    label: string;
    path: Address[];
    pools: Address[];
    symbol: string;
    tokenOut: Address;
    venue: CuratedPolicyVaultRoute["venue"];
  };
  side: CuratedTradeSide;
  slippageBps: number;
  tokenAddress: Address;
  vaultAddress?: Address;
  vaultBalance0G?: string;
  warnings: string[];
}

export interface CuratedTradeExecutionInput extends CuratedTradeQuoteInput {
  agentKey?: Hex;
  agentRef?: string;
  copilotAudit?: {
    model?: string;
    policyContextHash?: string;
    promptHash?: string;
    responseHash?: string;
  };
}

export interface CuratedTradeExecution {
  actionHash: Hex;
  auditRoot: Hex;
  executionTxHash: Hex;
  proofTxHash: Hex;
  quote: CuratedTradeQuote;
  storageRef: string;
  vaultActionHash: Hex;
}

export interface EnsuredTradingVault {
  created: boolean;
  createTxHash?: Hex;
  depositTxHash?: Hex;
  owner: Address;
  vault: Address;
}

type Runtime = Awaited<ReturnType<typeof resolveMainnetRuntime>>;

const erc20Abi = [
  {
    inputs: [],
    name: "decimals",
    outputs: [{ internalType: "uint8", name: "", type: "uint8" }],
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
    inputs: [{ internalType: "address", name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const proofRegistryAbi = PROOF_REGISTRY_ABI;

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

export async function quoteCuratedTrade(input: CuratedTradeQuoteInput): Promise<CuratedTradeQuote> {
  const runtime = resolveMainnetRuntime();
  const side = input.side;
  const routeCandidates = selectRouteCandidates(input);
  const firstRoute = routeCandidates[0];
  if (!firstRoute) {
    throw new Error("No curated route matches this token.");
  }

  const tokenMeta = await readTokenMeta(runtime, firstRoute.tokenOut);
  const inputDecimals = side === "buy" ? 18 : tokenMeta.decimals;
  const outputDecimals = side === "buy" ? tokenMeta.decimals : 18;
  const inputSymbol = side === "buy" ? "0G" : tokenMeta.symbol;
  const outputSymbol = side === "buy" ? tokenMeta.symbol : "0G";
  const amountIn = parseInputAmount(input.amount, inputDecimals);
  const slippageBps = normalizeSlippageBps(input.slippageBps);
  const warnings: string[] = [];

  let best:
    | {
        amountOut: bigint;
        route: CuratedPolicyVaultRoute;
      }
    | undefined;
  const quoteErrors: string[] = [];

  for (const route of routeCandidates) {
    try {
      const amountOut = await quoteRoute(runtime, route, side, amountIn);
      if (amountOut > 0n && (!best || amountOut > best.amountOut)) {
        best = { amountOut, route };
      }
    } catch (error) {
      quoteErrors.push(`${route.label}: ${error instanceof Error ? error.message : "quote failed"}`);
    }
  }

  if (!best) {
    throw new Error(`No curated route returned a usable quote. ${quoteErrors.join(" | ")}`.trim());
  }

  const vault = input.vaultAddress ? getAddress(input.vaultAddress) : undefined;
  const vaultState = vault ? await readVaultState(runtime, vault, best.route, side, amountIn) : undefined;
  const policy = vaultState?.policy ?? defaultMainnetPolicyVaultPolicy;
  const policySnapshotHash = vaultState?.policySnapshotHash;
  const policyMinOutBps = vaultState?.minOutBps ?? policy.defaultMinOutBps;
  const requestedMinOutBps = 10_000 - slippageBps;
  const minOutBps = Math.max(policyMinOutBps, requestedMinOutBps);
  const amountOutMin = (best.amountOut * BigInt(minOutBps)) / 10_000n;

  if (vaultState) {
    warnings.push(...vaultState.warnings);
  } else {
    warnings.push("No vault was supplied, so execution readiness was not checked.");
  }

  const canExecute = warnings.length === 0;
  return {
    amountIn: amountIn.toString(),
    amountInFormatted: formatUnits(amountIn, inputDecimals),
    amountOutMin: amountOutMin.toString(),
    amountOutMinFormatted: formatUnits(amountOutMin, outputDecimals),
    canExecute,
    deadlineSeconds: policy.maxDeadlineWindowSeconds.toString(),
    inputDecimals,
    inputSymbol,
    minOutBps,
    networkId: "mainnet",
    outputDecimals,
    outputSymbol,
    policySnapshotHash,
    quotedAmountOut: best.amountOut.toString(),
    quotedAmountOutFormatted: formatUnits(best.amountOut, outputDecimals),
    route: serializeRoute(best.route),
    side,
    slippageBps,
    tokenAddress: best.route.tokenOut,
    vaultAddress: vault,
    vaultBalance0G: vaultState?.nativeBalance !== undefined ? formatEther(vaultState.nativeBalance) : undefined,
    warnings,
  };
}

export async function executeCuratedTrade(input: CuratedTradeExecutionInput): Promise<CuratedTradeExecution> {
  requireLiveTradingEnabled();
  const runtime = resolveMainnetRuntime();
  const proofAccount = privateKeyToAccount(readPrivateKeyEnv("DEPLOYER_PRIVATE_KEY"));
  const executorAccount = privateKeyToAccount(readPrivateKeyEnv("VAULT_EXECUTOR_PRIVATE_KEY"));
  const proofWallet = createWalletClient({ account: proofAccount, chain: runtime.chain, transport: http(runtime.rpcUrl) });
  const executorWallet = createWalletClient({ account: executorAccount, chain: runtime.chain, transport: http(runtime.rpcUrl) });

  const vaultAddress = input.vaultAddress ? getAddress(input.vaultAddress) : await vaultOf(runtime, proofAccount.address);
  if (vaultAddress === zeroAddress) {
    throw new Error("No mainnet trading vault exists for the deployer wallet.");
  }

  const quote = await quoteCuratedTrade({ ...input, vaultAddress });
  if (!quote.canExecute) {
    throw new Error(`Trade is not execution-ready: ${quote.warnings.join(" ")}`);
  }

  const route = routeById(quote.route.id);
  const policySnapshotHash = quote.policySnapshotHash;
  if (!policySnapshotHash) {
    throw new Error("Vault policy hash was not available for the trade proof.");
  }

  const isV4Swap = await isV4SwapVault(runtime, vaultAddress);
  await assertVaultCanUseRuntime(runtime, vaultAddress, executorAccount.address, proofAccount.address, isV4Swap);

  const block = await runtime.publicClient.getBlock();
  const deadlineWindow = BigInt(quote.deadlineSeconds);
  const deadline = block.timestamp + (deadlineWindow > 90n ? deadlineWindow - 30n : deadlineWindow);
  const nonce = randomNonce();
  const tokenIn = input.side === "buy" ? zeroAddress : route.tokenOut;
  const tokenOut = input.side === "buy" ? route.tokenOut : zeroAddress;
  const agentKey = input.agentKey;
  // V4 Swap always requires an enabled agent key. Legacy vaults keep the V2 probe.
  let includeAgentKey: boolean;
  if (isV4Swap) {
    if (agentKey === undefined) {
      throw new Error("V4 Swap execution requires an agent key.");
    }
    if (!(await isAgentKeyEnabled(runtime, vaultAddress, agentKey))) {
      throw new Error("V4 agent key is not enabled for this agent.");
    }
    includeAgentKey = true;
  } else {
    const supportsAgentKeys = await vaultSupportsAgentKeys(runtime, vaultAddress);
    if (supportsAgentKeys && agentKey === undefined) {
      throw new Error("PolicyVaultV2 execution requires an agent key.");
    }
    const isV2 = agentKey !== undefined ? await isAgentKeyEnabled(runtime, vaultAddress, agentKey) : false;
    if (agentKey !== undefined && !isV2) {
      throw new Error("PolicyVaultV2 agent key is not enabled for this agent.");
    }
    includeAgentKey = isV2;
  }
  const tradeAbi = isV4Swap ? (policyVaultV4SwapAbi as Abi) : tradeAbiForVersion(includeAgentKey);
  const actionHashAbi = isV4Swap ? (policyVaultV4SwapAbi as Abi) : (policyVaultAbi as Abi);

  const agentRef = input.agentRef ?? AGENT_REF;
  const baseAudit = {
    app: "4lpha-0g",
    kind: "curated-route-trade",
    agentRef,
    chainId: MAINNET_CHAIN_ID,
    createdAt: new Date().toISOString(),
    redacted: true,
    side: input.side,
    vault: vaultAddress,
    route: quote.route,
    tokenIn,
    tokenOut,
    amountIn: quote.amountIn,
    quotedAmountOut: quote.quotedAmountOut,
    amountOutMin: quote.amountOutMin,
    minOutBps: quote.minOutBps,
    policySnapshotHash,
    copilotAudit: input.copilotAudit,
    ...(includeAgentKey ? { agentKey } : {}),
  };
  const storage = await uploadTradeAudit(baseAudit);

  const draftRequest = {
    actionHash: ZERO_HASH,
    amountIn: BigInt(quote.amountIn),
    amountOutMin: BigInt(quote.amountOutMin),
    auditRoot: storage.auditRoot,
    deadline,
    nonce,
    ...(includeAgentKey ? { agentKey } : {}),
    policySnapshotHash,
    poolId: quote.route.id,
    quotedAmountOut: BigInt(quote.quotedAmountOut),
    tokenIn,
    tokenOut,
    vaultActionHash: ZERO_HASH,
  };
  const vaultActionHash = await runtime.publicClient.readContract({
    address: vaultAddress,
    abi: tradeAbi,
    functionName: "vaultActionHashFor",
    args: [input.side === "buy", draftRequest],
  }) as Hex;
  const actionHash = await runtime.publicClient.readContract({
    address: vaultAddress,
    abi: actionHashAbi,
    functionName: "actionHashFor",
    args: [vaultActionHash, storage.auditRoot, policySnapshotHash],
  }) as Hex;
  const tradeRequest = {
    ...draftRequest,
    actionHash,
    vaultActionHash,
  };
  const modelMetadataHash = hashJson({
    copilotAudit: input.copilotAudit,
    quoteSource: "uniswap-v3-quoter-v2",
    routeSelector: "4lpha-curated-route-v1",
  });

  const proofSimulation = await runtime.publicClient.simulateContract({
    account: proofAccount.address,
    address: runtime.proofRegistry,
    abi: proofRegistryAbi,
    functionName: "acceptProof",
    args: [actionHash, storage.auditRoot, policySnapshotHash, modelMetadataHash, storage.storageRef, vaultActionHash, agentRef],
  });
  const proofTxHash = await proofWallet.writeContract({
    ...proofSimulation.request,
    account: proofAccount,
    chain: runtime.chain,
  });
  await waitForReceipt(runtime, proofTxHash, "proof acceptance");

  const functionName = input.side === "buy" ? "buy" : "sell";
  const tradeSimulation = await runtime.publicClient.simulateContract({
    account: executorAccount.address,
    address: vaultAddress,
    abi: tradeAbi,
    functionName,
    args: [tradeRequest],
  });
  const executionTxHash = await executorWallet.writeContract({
    ...tradeSimulation.request,
    account: executorAccount,
    chain: runtime.chain,
  });
  await waitForReceipt(runtime, executionTxHash, `${functionName} execution`);

  return {
    actionHash,
    auditRoot: storage.auditRoot,
    executionTxHash,
    proofTxHash,
    quote,
    storageRef: storage.storageRef,
    vaultActionHash,
  };
}

export async function ensureMainnetTradingVault(options: { deposit0G?: string } = {}): Promise<EnsuredTradingVault> {
  requireMainnetFlags();
  const runtime = resolveMainnetRuntime();
  const ownerAccount = privateKeyToAccount(readPrivateKeyEnv("DEPLOYER_PRIVATE_KEY"));
  const walletClient = createWalletClient({ account: ownerAccount, chain: runtime.chain, transport: http(runtime.rpcUrl) });

  let vault = await vaultOf(runtime, ownerAccount.address);
  let createTxHash: Hex | undefined;
  let created = false;
  if (vault === zeroAddress) {
    const simulation = await runtime.publicClient.simulateContract({
      account: ownerAccount.address,
      address: runtime.factory,
      abi: policyVaultFactoryAbi,
      functionName: "createVault",
      args: [
        ownerAccount.address,
        runtime.executor,
        runtime.adapter,
        runtime.proofRegistry,
        defaultMainnetPolicyVaultPolicy,
        uniqueRouteTokenAddresses(),
        CURATED_MAINNET_POLICY_VAULT_ROUTES.map((route) => route.id),
        false,
      ],
    });
    createTxHash = await walletClient.writeContract(simulation.request);
    await waitForReceipt(runtime, createTxHash, "vault creation");
    vault = await vaultOf(runtime, ownerAccount.address);
    created = true;
  }

  if (vault === zeroAddress) {
    throw new Error("Factory did not resolve a vault after creation.");
  }

  const owner = await runtime.publicClient.readContract({
    address: vault,
    abi: policyVaultAbi,
    functionName: "owner",
  });
  if (owner.toLowerCase() !== ownerAccount.address.toLowerCase()) {
    throw new Error("Resolved vault is not owned by the deployer wallet.");
  }

  let depositTxHash: Hex | undefined;
  if (options.deposit0G) {
    const amount = parseEther(options.deposit0G);
    if (amount <= 0n || amount > MAX_SCRIPT_TRADE_0G) {
      throw new Error("Script deposit must be greater than 0 and at most 0.005 0G.");
    }
    const simulation = await runtime.publicClient.simulateContract({
      account: ownerAccount.address,
      address: vault,
      abi: policyVaultAbi,
      functionName: "depositNative",
      value: amount,
    });
    depositTxHash = await walletClient.writeContract(simulation.request);
    await waitForReceipt(runtime, depositTxHash, "vault deposit");
  }

  return {
    created,
    createTxHash,
    depositTxHash,
    owner: ownerAccount.address,
    vault,
  };
}

export async function discoverMainnetTradingVault(): Promise<Address | null> {
  const runtime = resolveMainnetRuntime();
  const ownerAccount = privateKeyToAccount(readPrivateKeyEnv("DEPLOYER_PRIVATE_KEY"));
  const vault = await vaultOf(runtime, ownerAccount.address);
  return vault === zeroAddress ? null : vault;
}

export function maxScriptTrade0G(): bigint {
  return MAX_SCRIPT_TRADE_0G;
}

function resolveMainnetRuntime() {
  requireMainnetFlags();
  const rpcUrl = requireEnv("OG_RPC_URL");
  const chain = make0GMainnetChain(rpcUrl);
  // Prefer quiknode with public fallback and batch read bursts to stay under
  // quiknode's ~15 req/s ceiling (see makeMainnetTransport). Vault-state reads
  // (readVaultState) fire ~11 calls at once; batching collapses them so the
  // trade quote does not 429.
  const publicClient = createPublicClient({ chain, transport: makeMainnetTransport() });
  const factory = getLatestPolicyVaultFactoryVersion("mainnet");
  if (!factory) {
    throw new Error("Missing mainnet Policy Vault factory configuration.");
  }
  return {
    adapter: readAddressEnv("NEXT_PUBLIC_POLICY_VAULT_ADAPTER_MAINNET_ADDRESS"),
    chain,
    executor: readAddressEnv("NEXT_PUBLIC_VAULT_EXECUTOR_MAINNET_ADDRESS"),
    factory: factory.address,
    proofRegistry: readAddressEnv("NEXT_PUBLIC_PROOF_REGISTRY_MAINNET_ADDRESS"),
    publicClient,
    rpcUrl,
  };
}

function requireMainnetFlags() {
  if ((process.env.OG_NETWORK ?? "").toLowerCase() !== "mainnet") {
    throw new Error("Curated route trading requires OG_NETWORK=mainnet.");
  }
  if (Number(requireEnv("OG_CHAIN_ID")) !== MAINNET_CHAIN_ID) {
    throw new Error(`Curated route trading requires OG_CHAIN_ID=${MAINNET_CHAIN_ID}.`);
  }
  requireFlag("ENABLE_MAINNET_DEPLOY", true);
  requireFlag("ENABLE_REAL_DEX_ADAPTER", true);
  requireFlag("ENABLE_MOCK_DEX_ADAPTER", false);
}

function requireLiveTradingEnabled() {
  requireMainnetFlags();
  requireFlag("AGENT_TRADE_LIVE_ENABLED", true);
}

function make0GMainnetChain(rpcUrl: string): Chain {
  return {
    id: MAINNET_CHAIN_ID,
    name: "0G Mainnet",
    nativeCurrency: {
      decimals: 18,
      name: "0G",
      symbol: "0G",
    },
    rpcUrls: {
      default: { http: [rpcUrl] },
    },
  };
}

function selectRouteCandidates(input: CuratedTradeQuoteInput): CuratedPolicyVaultRoute[] {
  if (input.networkId !== "mainnet") {
    throw new Error("Curated live trading is available on 0G mainnet only.");
  }

  if (input.routeId) {
    return [routeById(input.routeId)];
  }

  const tokenAddress = input.tokenAddress ? getAddress(input.tokenAddress) : undefined;
  const tokenSymbol = input.tokenSymbol?.trim().toLowerCase();
  if (!tokenAddress && !tokenSymbol) {
    throw new Error("Provide tokenSymbol, tokenAddress, or routeId.");
  }

  return CURATED_MAINNET_POLICY_VAULT_ROUTES.filter((route) => {
    const matchesAddress = tokenAddress && route.tokenOut.toLowerCase() === tokenAddress.toLowerCase();
    const matchesSymbol =
      tokenSymbol &&
      (route.symbol.toLowerCase() === tokenSymbol ||
        route.symbol.toLowerCase().replace(/-direct|-oku/u, "") === tokenSymbol ||
        route.label.toLowerCase().endsWith(`/${tokenSymbol}`));
    return Boolean(matchesAddress || matchesSymbol);
  });
}

function routeById(routeId: Hex): CuratedPolicyVaultRoute {
  const route = CURATED_MAINNET_POLICY_VAULT_ROUTES.find((candidate) => candidate.id.toLowerCase() === routeId.toLowerCase());
  if (!route) {
    throw new Error("Unknown curated route id.");
  }
  return route;
}

function serializeRoute(route: CuratedPolicyVaultRoute): CuratedTradeQuote["route"] {
  return {
    confidence: route.confidence,
    id: route.id,
    label: route.label,
    path: [...route.path],
    pools: [...route.pools],
    symbol: route.symbol,
    tokenOut: route.tokenOut,
    venue: route.venue,
  };
}

async function quoteRoute(
  runtime: Runtime,
  route: CuratedPolicyVaultRoute,
  side: CuratedTradeSide,
  amountIn: bigint,
): Promise<bigint> {
  const quoter = route.venue === "Oku" ? OKU_MAINNET.quoterV2 : ZIA_MAINNET.quoterV2;
  const encodedPath = encodeRoutePath(route, side === "sell");
  const simulation = await runtime.publicClient.simulateContract({
    address: quoter,
    abi: quoterV2Abi,
    functionName: "quoteExactInput",
    args: [encodedPath, amountIn],
  });
  return readQuoteAmountOut(simulation.result);
}

function readQuoteAmountOut(value: unknown): bigint {
  if (typeof value === "bigint") {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === "bigint") {
    return value[0];
  }
  if (value && typeof value === "object" && "amountOut" in value && typeof value.amountOut === "bigint") {
    return value.amountOut;
  }
  throw new Error("Quoter returned an unexpected result.");
}

async function readTokenMeta(runtime: Runtime, token: Address): Promise<{ decimals: number; symbol: string }> {
  const [decimals, symbol] = await Promise.all([
    runtime.publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "decimals",
    }),
    runtime.publicClient
      .readContract({
        address: token,
        abi: erc20Abi,
        functionName: "symbol",
      })
      .catch(() => "TOKEN"),
  ]);
  return {
    decimals: Number(decimals),
    symbol,
  };
}

interface VaultTradeState {
  dailySpent0G: bigint;
  dailyWindowStart: bigint;
  lastTradeAt: bigint;
  minOutBps: number;
  nativeBalance: bigint;
  openExposure0G: bigint;
  policy: PolicyVaultPolicy;
  policySnapshotHash: Hex;
  warnings: string[];
}

// Detects whether `vault` is a V4 Swap third (exposes swapAdapter()) vs a legacy
// V2/V3 vault (exposes adapter()), then reads state with the matching ABI. The
// V4 Swap vault renamed adapter()->swapAdapter() and dropped the allowlist/window
// getters, so reading it with the legacy ABI reverts (adapter()) and forces every
// route into a permanent hold. Self-detecting keeps every caller correct.
async function readVaultState(
  runtime: Runtime,
  vault: Address,
  route: CuratedPolicyVaultRoute,
  side: CuratedTradeSide,
  amountIn: bigint,
): Promise<VaultTradeState> {
  const swapAdapter = (await runtime.publicClient
    .readContract({ address: vault, abi: policyVaultV4SwapAbi, functionName: "swapAdapter" })
    .catch(() => null)) as Address | null;
  if (swapAdapter) {
    return readV4SwapVaultState(runtime, vault, side, amountIn, swapAdapter);
  }
  return readLegacyVaultState(runtime, vault, route, side, amountIn);
}

// V4 Swap third: fewer getters than V3. Token/pool allowlist is enforced on-chain
// inside buy()/sell() (no public getter), so allowlist warnings are omitted here
// and surfaced by the execution simulate (NotAllowed) before any spend. minOut and
// caps come from the swap Policy struct, which is field-compatible with PolicyVaultPolicy.
async function readV4SwapVaultState(
  runtime: Runtime,
  vault: Address,
  side: CuratedTradeSide,
  amountIn: bigint,
  swapAdapter: Address,
): Promise<VaultTradeState> {
  const [block, owner, executor, proofRegistry, paused, executorRevoked, policySnapshotHash, rawPolicy, nativeBalance, dailySpent0G, openExposure0G] =
    await Promise.all([
      runtime.publicClient.getBlock(),
      runtime.publicClient.readContract({ address: vault, abi: policyVaultV4SwapAbi, functionName: "owner" }) as Promise<Address>,
      runtime.publicClient.readContract({ address: vault, abi: policyVaultV4SwapAbi, functionName: "executor" }) as Promise<Address>,
      runtime.publicClient.readContract({ address: vault, abi: policyVaultV4SwapAbi, functionName: "proofRegistry" }) as Promise<Address>,
      runtime.publicClient.readContract({ address: vault, abi: policyVaultV4SwapAbi, functionName: "paused" }) as Promise<boolean>,
      runtime.publicClient.readContract({ address: vault, abi: policyVaultV4SwapAbi, functionName: "executorRevoked" }) as Promise<boolean>,
      runtime.publicClient.readContract({ address: vault, abi: policyVaultV4SwapAbi, functionName: "policyHash" }) as Promise<Hex>,
      runtime.publicClient.readContract({ address: vault, abi: policyVaultV4SwapAbi, functionName: "policy" }),
      runtime.publicClient.getBalance({ address: vault }),
      runtime.publicClient.readContract({ address: vault, abi: policyVaultV4SwapAbi, functionName: "dailySpent0G" }) as Promise<bigint>,
      runtime.publicClient.readContract({ address: vault, abi: policyVaultV4SwapAbi, functionName: "openExposure0G" }) as Promise<bigint>,
    ]);

  const warnings: string[] = [];
  const policy = normalizePolicy(rawPolicy);
  if (!owner || owner === zeroAddress) warnings.push("Vault owner could not be resolved.");
  if (executor.toLowerCase() !== runtime.executor.toLowerCase()) warnings.push("Vault executor does not match server executor.");
  if (swapAdapter.toLowerCase() !== runtime.adapter.toLowerCase()) warnings.push("Vault adapter is not the curated route adapter.");
  if (proofRegistry.toLowerCase() !== runtime.proofRegistry.toLowerCase()) warnings.push("Vault proof registry does not match server config.");
  if (paused) warnings.push("Vault is paused.");
  if (executorRevoked) warnings.push("Vault executor is revoked.");
  if (side === "buy") {
    // V4 Swap has no dailyWindowStart getter; pass the current block timestamp as
    // the window start so recorded dailySpent0G is always treated as in-window
    // (conservative — never under-counts). The vault re-enforces the true window.
    warnings.push(...validateBuySpendReadiness({ amountIn, blockTimestamp: block.timestamp, dailySpent0G, dailyWindowStart: block.timestamp, lastTradeAt: 0n, nativeBalance, openExposure0G, policy }));
  }

  return {
    dailySpent0G,
    dailyWindowStart: block.timestamp,
    lastTradeAt: 0n,
    minOutBps: policy.defaultMinOutBps,
    nativeBalance,
    openExposure0G,
    policy,
    policySnapshotHash,
    warnings,
  };
}

async function readLegacyVaultState(
  runtime: Runtime,
  vault: Address,
  route: CuratedPolicyVaultRoute,
  side: CuratedTradeSide,
  amountIn: bigint,
): Promise<VaultTradeState> {
  const tokenIn = side === "buy" ? zeroAddress : route.tokenOut;
  const tokenOut = side === "buy" ? route.tokenOut : zeroAddress;
  const [
    block,
    owner,
    executor,
    adapter,
    proofRegistry,
    paused,
    executorRevoked,
    allowedToken,
    allowedPool,
    policySnapshotHash,
    rawPolicy,
    minOutBps,
    nativeBalance,
    dailySpent0G,
    dailyWindowStart,
    lastTradeAt,
    openExposure0G,
  ] =
    await Promise.all([
      runtime.publicClient.getBlock(),
      runtime.publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "owner" }),
      runtime.publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "executor" }),
      runtime.publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "adapter" }),
      runtime.publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "proofRegistry" }),
      runtime.publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "paused" }),
      runtime.publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "executorRevoked" }),
      runtime.publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "allowedTokens", args: [route.tokenOut] }),
      runtime.publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "allowedPools", args: [route.id] }),
      runtime.publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "policyHash" }),
      runtime.publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "policy" }),
      runtime.publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "minOutBpsFor", args: [tokenIn, tokenOut] }),
      runtime.publicClient.getBalance({ address: vault }),
      runtime.publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "dailySpent0G" }),
      runtime.publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "dailyWindowStart" }),
      runtime.publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "lastTradeAt" }),
      runtime.publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "openExposure0G" }),
    ]);

  const warnings: string[] = [];
  const policy = normalizePolicy(rawPolicy);
  if (!owner || owner === zeroAddress) warnings.push("Vault owner could not be resolved.");
  if (executor.toLowerCase() !== runtime.executor.toLowerCase()) warnings.push("Vault executor does not match server executor.");
  if (adapter.toLowerCase() !== runtime.adapter.toLowerCase()) warnings.push("Vault adapter is not the curated route adapter.");
  if (proofRegistry.toLowerCase() !== runtime.proofRegistry.toLowerCase()) warnings.push("Vault proof registry does not match server config.");
  if (paused) warnings.push("Vault is paused.");
  if (executorRevoked) warnings.push("Vault executor is revoked.");
  if (!allowedToken) warnings.push("Selected token is not allowlisted by this vault.");
  if (!allowedPool) warnings.push("Selected route id is not allowlisted by this vault.");
  if (side === "buy") {
    warnings.push(...validateBuySpendReadiness({ amountIn, blockTimestamp: block.timestamp, dailySpent0G, dailyWindowStart, lastTradeAt, nativeBalance, openExposure0G, policy }));
  }

  return {
    dailySpent0G,
    dailyWindowStart,
    lastTradeAt,
    minOutBps,
    nativeBalance,
    openExposure0G,
    policy,
    policySnapshotHash,
    warnings,
  };
}

function validateBuySpendReadiness({
  amountIn,
  blockTimestamp,
  dailySpent0G,
  dailyWindowStart,
  lastTradeAt,
  nativeBalance,
  openExposure0G,
  policy,
}: {
  amountIn: bigint;
  blockTimestamp: bigint;
  dailySpent0G: bigint;
  dailyWindowStart: bigint;
  lastTradeAt: bigint;
  nativeBalance: bigint;
  openExposure0G: bigint;
  policy: PolicyVaultPolicy;
}): string[] {
  const warnings: string[] = [];
  const activeDailySpent =
    dailyWindowStart === 0n || blockTimestamp >= dailyWindowStart + 86_400n ? 0n : dailySpent0G;

  if (amountIn > nativeBalance) {
    warnings.push(`Vault balance is ${formatEther(nativeBalance)} 0G, below the requested ${formatEther(amountIn)} 0G.`);
  }
  if (amountIn > policy.perTradeCap0G) {
    warnings.push(`Requested buy exceeds the vault per-trade cap of ${formatEther(policy.perTradeCap0G)} 0G.`);
  }
  if (activeDailySpent + amountIn > policy.dailyCap0G) {
    warnings.push(`Requested buy exceeds the vault daily cap of ${formatEther(policy.dailyCap0G)} 0G.`);
  }
  if (openExposure0G + amountIn > policy.maxExposure0G) {
    warnings.push(`Requested buy exceeds the vault max exposure of ${formatEther(policy.maxExposure0G)} 0G.`);
  }
  if (policy.cooldownSeconds !== 0n && lastTradeAt !== 0n && blockTimestamp < lastTradeAt + policy.cooldownSeconds) {
    warnings.push(`Vault cooldown is active for ${lastTradeAt + policy.cooldownSeconds - blockTimestamp} more seconds.`);
  }

  return warnings;
}

// Detects a V4 Swap third (swapAdapter() exists) vs a legacy V2/V3 vault (adapter()).
async function isV4SwapVault(runtime: Runtime, vault: Address): Promise<boolean> {
  return runtime.publicClient
    .readContract({ address: vault, abi: policyVaultV4SwapAbi, functionName: "swapAdapter" })
    .then(() => true, () => false);
}

async function assertVaultCanUseRuntime(runtime: Runtime, vault: Address, executor: Address, proofOwner: Address, isV4Swap: boolean) {
  const adapterRead = isV4Swap
    ? runtime.publicClient.readContract({ address: vault, abi: policyVaultV4SwapAbi, functionName: "swapAdapter" })
    : runtime.publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "adapter" });
  const executorRead = isV4Swap
    ? runtime.publicClient.readContract({ address: vault, abi: policyVaultV4SwapAbi, functionName: "executor" })
    : runtime.publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "executor" });
  const proofRegistryRead = isV4Swap
    ? runtime.publicClient.readContract({ address: vault, abi: policyVaultV4SwapAbi, functionName: "proofRegistry" })
    : runtime.publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "proofRegistry" });
  const [vaultExecutor, vaultAdapter, vaultProofRegistry, registryOwner] = await Promise.all([
    executorRead,
    adapterRead,
    proofRegistryRead,
    runtime.publicClient.readContract({ address: runtime.proofRegistry, abi: proofRegistryAbi, functionName: "owner" }),
  ]);

  if (vaultExecutor.toLowerCase() !== executor.toLowerCase()) {
    throw new Error("VAULT_EXECUTOR_PRIVATE_KEY does not control this vault executor.");
  }
  if (vaultAdapter.toLowerCase() !== runtime.adapter.toLowerCase()) {
    throw new Error("Vault is not wired to the active curated route adapter.");
  }
  if (vaultProofRegistry.toLowerCase() !== runtime.proofRegistry.toLowerCase()) {
    throw new Error("Vault proof registry does not match active mainnet config.");
  }
  if (registryOwner.toLowerCase() !== proofOwner.toLowerCase()) {
    throw new Error("DEPLOYER_PRIVATE_KEY is not the ProofRegistry owner.");
  }
}

function normalizePolicy(value: unknown): PolicyVaultPolicy {
  const item = value as {
    cooldownSeconds?: bigint;
    dailyCap0G?: bigint;
    defaultMinOutBps?: number;
    maxDeadlineWindowSeconds?: bigint;
    maxExposure0G?: bigint;
    perTradeCap0G?: bigint;
  } & readonly [bigint, bigint, bigint, bigint, bigint, number];
  return {
    cooldownSeconds: item.cooldownSeconds ?? item[3],
    dailyCap0G: item.dailyCap0G ?? item[1],
    defaultMinOutBps: Number(item.defaultMinOutBps ?? item[5]),
    maxDeadlineWindowSeconds: item.maxDeadlineWindowSeconds ?? item[4],
    maxExposure0G: item.maxExposure0G ?? item[2],
    perTradeCap0G: item.perTradeCap0G ?? item[0],
  };
}

function encodeRoutePath(route: CuratedPolicyVaultRoute, reverse: boolean): Hex {
  const tokens = reverse ? [...route.path].reverse() : [...route.path];
  const fees = reverse ? [...route.fees].reverse() : [...route.fees];
  let encoded = tokens[0].toLowerCase() as string;
  for (let index = 0; index < fees.length; index += 1) {
    encoded += fees[index].toString(16).padStart(6, "0");
    encoded += tokens[index + 1].slice(2).toLowerCase();
  }
  return encoded as Hex;
}

function parseInputAmount(value: string, decimals: number): bigint {
  const normalized = value.trim();
  if (!/^\d+(\.\d+)?$/u.test(normalized)) {
    throw new Error("Amount must be a positive decimal value.");
  }
  const parsed = parseUnits(normalized, decimals);
  if (parsed <= 0n) {
    throw new Error("Amount must be greater than zero.");
  }
  return parsed;
}

function normalizeSlippageBps(value: number | undefined): number {
  if (value === undefined) return DEFAULT_SLIPPAGE_BPS;
  if (!Number.isInteger(value) || value < 1 || value > 1_000) {
    throw new Error("slippageBps must be an integer between 1 and 1000.");
  }
  return value;
}

async function vaultOf(runtime: Runtime, owner: Address): Promise<Address> {
  return runtime.publicClient.readContract({
    address: runtime.factory,
    abi: policyVaultFactoryAbi,
    functionName: "vaultOf",
    args: [owner],
  });
}

function uniqueRouteTokenAddresses(): Address[] {
  const seen = new Set<string>();
  const result: Address[] = [];
  for (const route of CURATED_MAINNET_POLICY_VAULT_ROUTES) {
    const key = route.tokenOut.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(route.tokenOut);
    }
  }
  return result;
}

async function uploadTradeAudit(payload: unknown): Promise<{ auditRoot: Hex; storageRef: string }> {
  const encoded = new TextEncoder().encode(`${stableJson(payload)}\n`);
  const upload = await uploadBytesTo0GStorage(encoded);
  return {
    auditRoot: upload.rootHash,
    storageRef: upload.storageRef,
  };
}

async function isAgentKeyEnabled(runtime: Runtime, vault: Address, agentKey: Hex): Promise<boolean> {
  return runtime.publicClient.readContract({
    address: vault,
    abi: policyVaultAgentKeyAbi,
    functionName: "agentKeyEnabled",
    args: [agentKey],
  }).catch(() => false);
}

async function vaultSupportsAgentKeys(runtime: Runtime, vault: Address): Promise<boolean> {
  return runtime.publicClient.readContract({
    address: vault,
    abi: policyVaultAgentKeyAbi,
    functionName: "agentOpenPositionCount",
    args: [ZERO_HASH],
  }).then(() => true, () => false);
}

function tradeAbiForVersion(isV2: boolean): Abi {
  return (isV2 ? policyVaultV2TradeAbi : policyVaultAbi) as Abi;
}

function hashJson(value: unknown): Hex {
  return keccak256(toBytes(stableJson(value)));
}

function stableJson(value: unknown): string {
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
  if (typeof value === "bigint") {
    return JSON.stringify(value.toString());
  }
  return JSON.stringify(value);
}

function randomNonce(): bigint {
  return BigInt(`0x${randomBytes(16).toString("hex")}`);
}

function getHex32(value: string, label: string): Hex {
  if (!isHex(value, { strict: true }) || value.length !== 66) {
    throw new Error(`${label} must be a bytes32 hex value.`);
  }
  return value as Hex;
}

async function waitForReceipt(runtime: Runtime, hash: Hex, label: string) {
  const maxAttempts = 150;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const receipt = await runtime.publicClient.getTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        throw new Error(`${label} transaction reverted: ${hash}`);
      }
      return receipt;
    } catch (error) {
      if (!isReceiptPendingError(error)) {
        throw error;
      }
      await sleep(1_000);
    }
  }
  throw new Error(`Timed out waiting for ${label} receipt: ${hash}`);
}

function isReceiptPendingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes("receipt") && message.toLowerCase().includes("not") && message.toLowerCase().includes("found");
}

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function readPrivateKeyEnv(name: string): Hex {
  const value = requireEnv(name);
  if (!isHex(value, { strict: true }) || value.length !== 66) {
    throw new Error(`${name} must be a 32-byte private key hex string.`);
  }
  return value as Hex;
}

function readAddressEnv(name: string): Address {
  const value = requireEnv(name);
  if (!isAddress(value)) {
    throw new Error(`${name} must be a valid EVM address.`);
  }
  return getAddress(value);
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function requireFlag(name: string, expected: boolean) {
  const actual = (process.env[name] ?? "false").toLowerCase() === "true";
  if (actual !== expected) {
    throw new Error(`${name} must be ${String(expected)}.`);
  }
}
