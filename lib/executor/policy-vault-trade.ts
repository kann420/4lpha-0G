import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  isAddress,
  isHex,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  CURATED_MAINNET_POLICY_VAULT_ROUTES,
  type CuratedPolicyVaultRoute,
} from "@/lib/contracts/curated-routes";

export type PolicyVaultTradeSide = "buy" | "sell";

export interface PolicyVaultExecutorClients {
  account: Account;
  chain: Chain;
  executor: Address;
  publicClient: PublicClient;
  walletClient: WalletClient;
}

export interface PolicyVaultExecutorTradeInput {
  agentRef: string;
  amountIn: bigint;
  amountOutMin?: bigint;
  auditRoot: Hex;
  deadlineSeconds?: bigint;
  modelMetadataHash: Hex;
  nonce?: bigint;
  quotedAmountOut: bigint;
  routeId: Hex;
  side: PolicyVaultTradeSide;
  storageRef: string;
  token?: Address;
  vault: Address;
}

export interface PolicyVaultTradeRequest {
  actionHash: Hex;
  amountIn: bigint;
  amountOutMin: bigint;
  auditRoot: Hex;
  deadline: bigint;
  nonce: bigint;
  policySnapshotHash: Hex;
  poolId: Hex;
  quotedAmountOut: bigint;
  tokenIn: Address;
  tokenOut: Address;
  vaultActionHash: Hex;
}

export interface PreparedExecutorTrade {
  accountCanAcceptProof: boolean;
  adapter: Address;
  executor: Address;
  proofAlreadyAccepted: boolean;
  proofRegistry: Address;
  proofRegistryOwner: Address;
  proofTransaction: PreparedTransaction | null;
  request: PolicyVaultTradeRequest;
  route: CuratedPolicyVaultRoute;
  side: PolicyVaultTradeSide;
  tradeFunctionName: "buy" | "sell";
  tradeTransaction: PreparedTransaction;
  vault: Address;
}

export interface PreparedTransaction {
  data: Hex;
  to: Address;
  value: bigint;
}

export interface ExecutorTradeRunResult {
  prepared: PreparedExecutorTrade;
  proofTxHash?: Hex;
  tradeTxHash?: Hex;
}

const MAINNET_CHAIN_ID = 16661;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
const ZERO_HASH = `0x${"00".repeat(32)}` as Hex;
const DEFAULT_DEADLINE_SECONDS = 5n * 60n;

const tradeRequestComponents = [
  { internalType: "address", name: "tokenIn", type: "address" },
  { internalType: "address", name: "tokenOut", type: "address" },
  { internalType: "uint256", name: "amountIn", type: "uint256" },
  { internalType: "uint256", name: "quotedAmountOut", type: "uint256" },
  { internalType: "uint256", name: "amountOutMin", type: "uint256" },
  { internalType: "uint256", name: "deadline", type: "uint256" },
  { internalType: "uint256", name: "nonce", type: "uint256" },
  { internalType: "bytes32", name: "poolId", type: "bytes32" },
  { internalType: "bytes32", name: "vaultActionHash", type: "bytes32" },
  { internalType: "bytes32", name: "actionHash", type: "bytes32" },
  { internalType: "bytes32", name: "policySnapshotHash", type: "bytes32" },
  { internalType: "bytes32", name: "auditRoot", type: "bytes32" },
] as const;

export const policyVaultExecutorAbi = [
  {
    inputs: [{ components: tradeRequestComponents, internalType: "struct PolicyVault.TradeRequest", name: "request", type: "tuple" }],
    name: "buy",
    outputs: [{ internalType: "uint256", name: "amountOut", type: "uint256" }],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [{ components: tradeRequestComponents, internalType: "struct PolicyVault.TradeRequest", name: "request", type: "tuple" }],
    name: "sell",
    outputs: [{ internalType: "uint256", name: "amountOut", type: "uint256" }],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [],
    name: "adapter",
    outputs: [{ internalType: "contract IPolicyVaultAdapter", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "bytes32", name: "vaultActionHash", type: "bytes32" }, { internalType: "bytes32", name: "auditRoot", type: "bytes32" }, { internalType: "bytes32", name: "policySnapshotHash", type: "bytes32" }],
    name: "actionHashFor",
    outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
    stateMutability: "pure",
    type: "function",
  },
  {
    inputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
    name: "allowedPools",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "", type: "address" }],
    name: "allowedTokens",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "executor",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "executorRevoked",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "tokenIn", type: "address" }, { internalType: "address", name: "tokenOut", type: "address" }, { internalType: "uint256", name: "quotedAmountOut", type: "uint256" }],
    name: "minOutFor",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "paused",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "policy",
    outputs: [
      { internalType: "uint256", name: "perTradeCap0G", type: "uint256" },
      { internalType: "uint256", name: "dailyCap0G", type: "uint256" },
      { internalType: "uint256", name: "maxExposure0G", type: "uint256" },
      { internalType: "uint256", name: "cooldownSeconds", type: "uint256" },
      { internalType: "uint256", name: "maxDeadlineWindowSeconds", type: "uint256" },
      { internalType: "uint16", name: "defaultMinOutBps", type: "uint16" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "policyHash",
    outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "proofRegistry",
    outputs: [{ internalType: "contract IProofRegistry", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "bool", name: "isBuy", type: "bool" }, { components: tradeRequestComponents, internalType: "struct PolicyVault.TradeRequest", name: "request", type: "tuple" }],
    name: "vaultActionHashFor",
    outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export const proofRegistryExecutorAbi = [
  {
    inputs: [
      { internalType: "bytes32", name: "actionHash", type: "bytes32" },
      { internalType: "bytes32", name: "auditRoot", type: "bytes32" },
      { internalType: "bytes32", name: "policySnapshotHash", type: "bytes32" },
      { internalType: "bytes32", name: "modelMetadataHash", type: "bytes32" },
      { internalType: "string", name: "storageRef", type: "string" },
      { internalType: "bytes32", name: "vaultActionHash", type: "bytes32" },
      { internalType: "string", name: "agentRef", type: "string" },
    ],
    name: "acceptProof",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "bytes32", name: "actionHash", type: "bytes32" }, { internalType: "bytes32", name: "auditRoot", type: "bytes32" }, { internalType: "bytes32", name: "policySnapshotHash", type: "bytes32" }, { internalType: "bytes32", name: "vaultActionHash", type: "bytes32" }],
    name: "isAccepted",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "owner",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export const curatedRouteAdapterReadAbi = [
  {
    inputs: [{ internalType: "bytes32", name: "routeId", type: "bytes32" }],
    name: "routeInfo",
    outputs: [
      { internalType: "address", name: "router", type: "address" },
      { internalType: "address", name: "factory", type: "address" },
      { internalType: "uint8", name: "routerKind", type: "uint8" },
      { internalType: "address", name: "tokenIn", type: "address" },
      { internalType: "address", name: "tokenOut", type: "address" },
      { internalType: "bytes", name: "encodedPath", type: "bytes" },
      { internalType: "bytes", name: "encodedReversePath", type: "bytes" },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

export function createMainnetExecutorClients({
  privateKey,
  rpcUrl,
}: {
  privateKey: Hex;
  rpcUrl: string;
}): PolicyVaultExecutorClients {
  const account = privateKeyToAccount(privateKey);
  const chain = make0GMainnetChain(rpcUrl);
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });

  return {
    account,
    chain,
    executor: account.address,
    publicClient,
    walletClient,
  };
}

export async function prepareMainnetPolicyVaultTrade(
  clients: PolicyVaultExecutorClients,
  input: PolicyVaultExecutorTradeInput,
): Promise<PreparedExecutorTrade> {
  assertMainnetChain(await clients.publicClient.getChainId());
  validateTradeInput(input);

  const route = requireCuratedRoute(input.routeId);
  const token = getAddress(input.token ?? route.tokenOut);
  if (!sameAddress(token, route.tokenOut)) {
    throw new Error(`Trade token ${token} does not match curated route ${route.label} output ${route.tokenOut}`);
  }

  const isBuy = input.side === "buy";
  const tokenIn = isBuy ? ZERO_ADDRESS : token;
  const tokenOut = isBuy ? token : ZERO_ADDRESS;
  const [vaultExecutor, proofRegistry, adapter, paused, executorRevoked, policySnapshotHash, currentPolicy, allowedToken, allowedRoute] = await Promise.all([
    clients.publicClient.readContract({ address: input.vault, abi: policyVaultExecutorAbi, functionName: "executor" }),
    clients.publicClient.readContract({ address: input.vault, abi: policyVaultExecutorAbi, functionName: "proofRegistry" }),
    clients.publicClient.readContract({ address: input.vault, abi: policyVaultExecutorAbi, functionName: "adapter" }),
    clients.publicClient.readContract({ address: input.vault, abi: policyVaultExecutorAbi, functionName: "paused" }),
    clients.publicClient.readContract({ address: input.vault, abi: policyVaultExecutorAbi, functionName: "executorRevoked" }),
    clients.publicClient.readContract({ address: input.vault, abi: policyVaultExecutorAbi, functionName: "policyHash" }),
    clients.publicClient.readContract({ address: input.vault, abi: policyVaultExecutorAbi, functionName: "policy" }),
    clients.publicClient.readContract({ address: input.vault, abi: policyVaultExecutorAbi, functionName: "allowedTokens", args: [token] }),
    clients.publicClient.readContract({ address: input.vault, abi: policyVaultExecutorAbi, functionName: "allowedPools", args: [route.id] }),
  ]);

  if (!sameAddress(vaultExecutor, clients.executor)) {
    throw new Error("VAULT_EXECUTOR_PRIVATE_KEY does not match the vault executor address");
  }
  if (paused) {
    throw new Error("PolicyVault is paused");
  }
  if (executorRevoked) {
    throw new Error("PolicyVault executor is revoked");
  }
  if (!allowedToken) {
    throw new Error(`Token ${token} is not allowed by the PolicyVault`);
  }
  if (!allowedRoute) {
    throw new Error(`Route ${route.id} is not allowed by the PolicyVault`);
  }

  await validateAdapterRoute(clients.publicClient, adapter, route);

  const amountOutMin =
    input.amountOutMin ??
    (await clients.publicClient.readContract({
      address: input.vault,
      abi: policyVaultExecutorAbi,
      functionName: "minOutFor",
      args: [tokenIn, tokenOut, input.quotedAmountOut],
    }));
  const vaultMinOut = await clients.publicClient.readContract({
    address: input.vault,
    abi: policyVaultExecutorAbi,
    functionName: "minOutFor",
    args: [tokenIn, tokenOut, input.quotedAmountOut],
  });
  if (amountOutMin < vaultMinOut) {
    throw new Error("amountOutMin is below the vault minOutFor floor");
  }

  const maxDeadlineWindowSeconds = currentPolicy[4];
  const deadlineSeconds = input.deadlineSeconds ?? minBigInt(DEFAULT_DEADLINE_SECONDS, maxDeadlineWindowSeconds);
  if (deadlineSeconds === 0n || deadlineSeconds > maxDeadlineWindowSeconds) {
    throw new Error("deadlineSeconds exceeds the vault policy maxDeadlineWindowSeconds");
  }
  const latestBlock = await clients.publicClient.getBlock({ blockTag: "latest" });
  const deadline = latestBlock.timestamp + deadlineSeconds;
  const nonce = input.nonce ?? makeNonce();

  const draft = {
    actionHash: ZERO_HASH,
    amountIn: input.amountIn,
    amountOutMin,
    auditRoot: input.auditRoot,
    deadline,
    nonce,
    policySnapshotHash,
    poolId: route.id,
    quotedAmountOut: input.quotedAmountOut,
    tokenIn,
    tokenOut,
    vaultActionHash: ZERO_HASH,
  } satisfies PolicyVaultTradeRequest;

  const vaultActionHash = await clients.publicClient.readContract({
    address: input.vault,
    abi: policyVaultExecutorAbi,
    functionName: "vaultActionHashFor",
    args: [isBuy, draft],
  });
  const actionHash = await clients.publicClient.readContract({
    address: input.vault,
    abi: policyVaultExecutorAbi,
    functionName: "actionHashFor",
    args: [vaultActionHash, input.auditRoot, policySnapshotHash],
  });
  const request = {
    ...draft,
    actionHash,
    vaultActionHash,
  } satisfies PolicyVaultTradeRequest;

  const [proofRegistryOwner, proofAlreadyAccepted] = await Promise.all([
    clients.publicClient.readContract({ address: proofRegistry, abi: proofRegistryExecutorAbi, functionName: "owner" }),
    clients.publicClient.readContract({
      address: proofRegistry,
      abi: proofRegistryExecutorAbi,
      functionName: "isAccepted",
      args: [request.actionHash, request.auditRoot, request.policySnapshotHash, request.vaultActionHash],
    }),
  ]);

  const proofTransaction = proofAlreadyAccepted
    ? null
    : {
        to: proofRegistry,
        data: encodeFunctionData({
          abi: proofRegistryExecutorAbi,
          functionName: "acceptProof",
          args: [
            request.actionHash,
            request.auditRoot,
            request.policySnapshotHash,
            input.modelMetadataHash,
            input.storageRef,
            request.vaultActionHash,
            input.agentRef,
          ],
        }),
        value: 0n,
      };
  const tradeFunctionName = input.side === "buy" ? "buy" : "sell";
  const tradeTransaction = {
    to: input.vault,
    data: encodeFunctionData({
      abi: policyVaultExecutorAbi,
      functionName: tradeFunctionName,
      args: [request],
    }),
    value: 0n,
  };

  return {
    accountCanAcceptProof: sameAddress(proofRegistryOwner, clients.executor),
    adapter,
    executor: clients.executor,
    proofAlreadyAccepted,
    proofRegistry,
    proofRegistryOwner,
    proofTransaction,
    request,
    route,
    side: input.side,
    tradeFunctionName,
    tradeTransaction,
    vault: input.vault,
  };
}

export async function runMainnetPolicyVaultTrade({
  broadcast,
  clients,
  input,
}: {
  broadcast: boolean;
  clients: PolicyVaultExecutorClients;
  input: PolicyVaultExecutorTradeInput;
}): Promise<ExecutorTradeRunResult> {
  const prepared = await prepareMainnetPolicyVaultTrade(clients, input);

  if (!prepared.proofAlreadyAccepted && !prepared.accountCanAcceptProof) {
    throw new Error("ProofRegistry owner does not match VAULT_EXECUTOR_PRIVATE_KEY; executor cannot accept this proof");
  }

  if (!broadcast) {
    return { prepared };
  }

  let proofTxHash: Hex | undefined;
  if (prepared.proofTransaction !== null) {
    proofTxHash = await clients.walletClient.writeContract({
      account: clients.account,
      address: prepared.proofRegistry,
      abi: proofRegistryExecutorAbi,
      chain: clients.chain,
      functionName: "acceptProof",
      args: [
        prepared.request.actionHash,
        prepared.request.auditRoot,
        prepared.request.policySnapshotHash,
        input.modelMetadataHash,
        input.storageRef,
        prepared.request.vaultActionHash,
        input.agentRef,
      ],
    });
    await clients.publicClient.waitForTransactionReceipt({ hash: proofTxHash });
  }

  const tradeTxHash = await clients.walletClient.writeContract({
    account: clients.account,
    address: prepared.vault,
    abi: policyVaultExecutorAbi,
    chain: clients.chain,
    functionName: prepared.tradeFunctionName,
    args: [prepared.request],
  });
  await clients.publicClient.waitForTransactionReceipt({ hash: tradeTxHash });

  return {
    prepared,
    proofTxHash,
    tradeTxHash,
  };
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

function validateTradeInput(input: PolicyVaultExecutorTradeInput) {
  if (!isAddress(input.vault)) {
    throw new Error("vault must be a valid EVM address");
  }
  assertNonzeroHex32(input.auditRoot, "auditRoot");
  assertNonzeroHex32(input.modelMetadataHash, "modelMetadataHash");
  assertNonzeroHex32(input.routeId, "routeId");
  if (input.amountIn <= 0n) {
    throw new Error("amountIn must be greater than zero");
  }
  if (input.quotedAmountOut <= 0n) {
    throw new Error("quotedAmountOut must be greater than zero");
  }
  if (input.amountOutMin !== undefined && input.amountOutMin <= 0n) {
    throw new Error("amountOutMin must be greater than zero");
  }
  if (input.storageRef.trim() === "") {
    throw new Error("storageRef is required");
  }
  if (input.agentRef.trim() === "") {
    throw new Error("agentRef is required");
  }
  if (input.token !== undefined && !isAddress(input.token)) {
    throw new Error("token must be a valid EVM address");
  }
}

function requireCuratedRoute(routeId: Hex): CuratedPolicyVaultRoute {
  const route = CURATED_MAINNET_POLICY_VAULT_ROUTES.find((candidate) => candidate.id.toLowerCase() === routeId.toLowerCase());
  if (route === undefined) {
    throw new Error("routeId is not in the curated mainnet ZIA/Oku route registry");
  }
  return route;
}

async function validateAdapterRoute(
  publicClient: PublicClient,
  adapter: Address,
  route: CuratedPolicyVaultRoute,
) {
  const [router, factory, routerKind, tokenIn, tokenOut] = await publicClient.readContract({
    address: adapter,
    abi: curatedRouteAdapterReadAbi,
    functionName: "routeInfo",
    args: [route.id],
  });
  if (
    !sameAddress(router, route.router) ||
    !sameAddress(factory, route.factory) ||
    routerKind !== route.routerKind ||
    !sameAddress(tokenIn, route.path[0]) ||
    !sameAddress(tokenOut, route.tokenOut)
  ) {
    throw new Error(`On-chain adapter route metadata does not match curated route ${route.label}`);
  }
}

function assertMainnetChain(chainId: number) {
  if (chainId !== MAINNET_CHAIN_ID) {
    throw new Error(`RPC chain mismatch: expected ${MAINNET_CHAIN_ID}, got ${chainId}`);
  }
}

function assertNonzeroHex32(value: Hex, label: string) {
  if (!isHex(value, { strict: true }) || value.length !== 66 || value === ZERO_HASH) {
    throw new Error(`${label} must be a nonzero bytes32 hex value`);
  }
}

function makeNonce(): bigint {
  const randomPart = BigInt(Math.floor(Math.random() * 1_000_000));
  return BigInt(Date.now()) * 1_000_000n + randomPart;
}

function minBigInt(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function sameAddress(a: Address, b: Address) {
  return a.toLowerCase() === b.toLowerCase();
}
