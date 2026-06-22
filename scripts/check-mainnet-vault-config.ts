import dotenv from "dotenv";
import {
  createPublicClient,
  formatUnits,
  getAddress,
  http,
  isAddress,
  isHex,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  CURATED_MAINNET_POLICY_VAULT_ROUTES,
  W0G_MAINNET,
  curatedMainnetRouteIds,
  uniqueCuratedMainnetTokens,
} from "../lib/contracts/curated-routes";

dotenv.config({ path: ".env.local", quiet: true });

const MAINNET_CHAIN_ID = 16661;
const MAINNET_INDEXER_HOST = "indexer-storage-turbo.0g.ai";
const MOCK_ADAPTER_KIND = keccak256(stringToHex("4LPHA_0G_MOCK_ADAPTER"));
const SINGLE_HOP_ADAPTER_KIND = keccak256(stringToHex("4LPHA_0G_UNISWAP_V3_SWAP_ROUTER02_ADAPTER"));
const ROUTE_ADAPTER_KIND = keccak256(stringToHex("4LPHA_0G_CURATED_UNISWAP_V3_ROUTE_ADAPTER"));
const OKU_SWAP_ROUTER02_0G = "0x807F4E281B7A3B324825C64ca53c69F0b418dE40" as const;
const OKU_V3_FACTORY_0G = "0xcb2436774C3e191c85056d248EF4260ce5f27A9D" as const;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
const ZERO_HASH = `0x${"00".repeat(32)}` as Hex;

const adapterAbi = [
  {
    inputs: [],
    name: "adapterKind",
    outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "swapRouter02",
    outputs: [{ internalType: "contract ISwapRouter02", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "v3Factory",
    outputs: [{ internalType: "contract IUniswapV3Factory", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "wrappedNative",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "routeCount",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "index", type: "uint256" }],
    name: "routeIdAt",
    outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
    stateMutability: "view",
    type: "function",
  },
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
  {
    inputs: [{ internalType: "bytes32", name: "routeId", type: "bytes32" }],
    name: "routeTokens",
    outputs: [{ internalType: "address[]", name: "", type: "address[]" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "bytes32", name: "routeId", type: "bytes32" }],
    name: "routePools",
    outputs: [{ internalType: "address[]", name: "", type: "address[]" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const routerAbi = [
  {
    inputs: [],
    name: "WETH9",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const v3FactoryAbi = [
  {
    inputs: [
      { internalType: "address", name: "tokenA", type: "address" },
      { internalType: "address", name: "tokenB", type: "address" },
      { internalType: "uint24", name: "fee", type: "uint24" },
    ],
    name: "getPool",
    outputs: [{ internalType: "address", name: "pool", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const v3PoolAbi = [
  {
    inputs: [],
    name: "fee",
    outputs: [{ internalType: "uint24", name: "", type: "uint24" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "token0",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "token1",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const erc20Abi = [
  {
    inputs: [{ internalType: "address", name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
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
] as const;

const policyFactoryAbi = [
  {
    inputs: [{ internalType: "address", name: "owner", type: "address" }],
    name: "vaultOf",
    outputs: [{ internalType: "address", name: "vault", type: "address" }],
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

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value.trim();
}

function requireFlag(name: string, expected: boolean) {
  const actual = (process.env[name] ?? "false").toLowerCase() === "true";
  if (actual !== expected) {
    throw new Error(`${name} must be ${String(expected)} for mainnet vault config`);
  }
}

function requireAddressEnv(name: string): Address {
  const value = requireEnv(name);
  if (!isAddress(value)) {
    throw new Error(`${name} must be a valid EVM address`);
  }
  return getAddress(value);
}

function readAddressEnv(name: string, fallback: string): Address {
  const value = process.env[name]?.trim() || fallback;
  if (!isAddress(value)) {
    throw new Error(`${name} must be a valid EVM address`);
  }
  return getAddress(value);
}

function requireHex32Env(name: string): Hex {
  const value = requireEnv(name);
  if (!isHex(value, { strict: true }) || value.length !== 66 || value === ZERO_HASH) {
    throw new Error(`${name} must be a nonzero bytes32 hex value`);
  }
  return value;
}

function requireFromBlockEnv(name: string): bigint {
  const value = requireEnv(name);
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a non-negative integer block number`);
  }
  return BigInt(value);
}

async function requireBytecode(address: Address, label: string) {
  const bytecode = await publicClient.getBytecode({ address });
  if (bytecode === undefined || bytecode === "0x") {
    throw new Error(`${label} has no deployed bytecode at ${address}`);
  }
}

function poolAddressFromPoolId(poolId: Hex): Address {
  const asBigInt = BigInt(poolId);
  if (asBigInt > (1n << 160n) - 1n) {
    throw new Error("NEXT_PUBLIC_POLICY_VAULT_ALLOWED_POOL_MAINNET_ID must encode a pool address in the low 160 bits");
  }
  return getAddress(`0x${poolId.slice(-40)}`);
}

function sameAddress(a: Address, b: Address) {
  return a.toLowerCase() === b.toLowerCase();
}

async function verifyPool({
  factory,
  fee,
  pool,
  tokenA,
  tokenB,
}: {
  factory: Address;
  fee: number;
  pool: Address;
  tokenA: Address;
  tokenB: Address;
}) {
  await Promise.all([requireBytecode(factory, "route factory"), requireBytecode(pool, "route pool"), requireBytecode(tokenA, "route token"), requireBytecode(tokenB, "route token")]);
  const [token0, token1, poolFee, factoryPool] = await Promise.all([
    publicClient.readContract({ address: pool, abi: v3PoolAbi, functionName: "token0" }),
    publicClient.readContract({ address: pool, abi: v3PoolAbi, functionName: "token1" }),
    publicClient.readContract({ address: pool, abi: v3PoolAbi, functionName: "fee" }),
    publicClient.readContract({
      address: factory,
      abi: v3FactoryAbi,
      functionName: "getPool",
      args: [tokenA, tokenB, fee],
    }),
  ]);
  const pairMatches = (sameAddress(token0, tokenA) && sameAddress(token1, tokenB)) || (sameAddress(token0, tokenB) && sameAddress(token1, tokenA));
  if (!pairMatches || poolFee !== fee || !sameAddress(factoryPool, pool)) {
    throw new Error(`Pool ${pool} is not registered for expected route hop`);
  }

  const [tokenADecimals, tokenBDecimals, tokenALiquidity, tokenBLiquidity] = await Promise.all([
    publicClient.readContract({ address: tokenA, abi: erc20Abi, functionName: "decimals" }),
    publicClient.readContract({ address: tokenB, abi: erc20Abi, functionName: "decimals" }),
    publicClient.readContract({ address: tokenA, abi: erc20Abi, functionName: "balanceOf", args: [pool] }),
    publicClient.readContract({ address: tokenB, abi: erc20Abi, functionName: "balanceOf", args: [pool] }),
  ]);
  if (tokenALiquidity === 0n || tokenBLiquidity === 0n) {
    throw new Error(`Pool ${pool} has no visible token liquidity`);
  }

  return {
    pool,
    tokenA,
    tokenB,
    tokenALiquidity: formatUnits(tokenALiquidity, tokenADecimals),
    tokenBLiquidity: formatUnits(tokenBLiquidity, tokenBDecimals),
  };
}

async function verifySingleHopAdapter(adapter: Address) {
  const allowedToken = requireAddressEnv("NEXT_PUBLIC_POLICY_VAULT_ALLOWED_TOKEN_MAINNET_ADDRESS");
  const allowedPool = requireHex32Env("NEXT_PUBLIC_POLICY_VAULT_ALLOWED_POOL_MAINNET_ID");
  const expectedRouter = readAddressEnv("NEXT_PUBLIC_POLICY_VAULT_SWAP_ROUTER02_MAINNET_ADDRESS", OKU_SWAP_ROUTER02_0G);
  const expectedV3Factory = readAddressEnv("NEXT_PUBLIC_POLICY_VAULT_UNISWAP_V3_FACTORY_MAINNET_ADDRESS", OKU_V3_FACTORY_0G);

  await Promise.all([
    requireBytecode(allowedToken, "Allowed token"),
    requireBytecode(expectedRouter, "0G SwapRouter02"),
    requireBytecode(expectedV3Factory, "0G Uniswap V3 factory"),
  ]);

  const [adapterRouter, adapterFactory, adapterWrappedNative] = await Promise.all([
    publicClient.readContract({ address: adapter, abi: adapterAbi, functionName: "swapRouter02" }),
    publicClient.readContract({ address: adapter, abi: adapterAbi, functionName: "v3Factory" }),
    publicClient.readContract({ address: adapter, abi: adapterAbi, functionName: "wrappedNative" }),
  ]);
  if (!sameAddress(adapterRouter, expectedRouter)) {
    throw new Error("Adapter SwapRouter02 does not match configured 0G router");
  }
  if (!sameAddress(adapterFactory, expectedV3Factory)) {
    throw new Error("Adapter V3 factory does not match configured 0G factory");
  }

  const routerWrappedNative = await publicClient.readContract({
    address: expectedRouter,
    abi: routerAbi,
    functionName: "WETH9",
  });
  if (!sameAddress(adapterWrappedNative, routerWrappedNative)) {
    throw new Error("Adapter wrapped native does not match SwapRouter02.WETH9()");
  }
  await requireBytecode(adapterWrappedNative, "0G wrapped native token");

  const poolAddress = poolAddressFromPoolId(allowedPool);
  const liquidity = await verifyPool({
    factory: expectedV3Factory,
    fee: Number(await publicClient.readContract({ address: poolAddress, abi: v3PoolAbi, functionName: "fee" })),
    pool: poolAddress,
    tokenA: allowedToken,
    tokenB: adapterWrappedNative,
  });

  return {
    adapterMode: "single-hop",
    allowedPool,
    allowedPoolAddress: poolAddress,
    allowedToken,
    liquidity,
    swapRouter02: expectedRouter,
    v3Factory: expectedV3Factory,
    wrappedNative: adapterWrappedNative,
  };
}

async function verifyRouteAdapter(adapter: Address) {
  const wrappedNative = await publicClient.readContract({ address: adapter, abi: adapterAbi, functionName: "wrappedNative" });
  if (!sameAddress(wrappedNative, W0G_MAINNET)) {
    throw new Error("Curated route adapter wrapped native does not match W0G");
  }

  const routeCount = await publicClient.readContract({ address: adapter, abi: adapterAbi, functionName: "routeCount" });
  if (routeCount !== BigInt(CURATED_MAINNET_POLICY_VAULT_ROUTES.length)) {
    throw new Error(`Curated route adapter has ${routeCount} routes, expected ${CURATED_MAINNET_POLICY_VAULT_ROUTES.length}`);
  }

  const routeReports = [];
  for (let i = 0; i < CURATED_MAINNET_POLICY_VAULT_ROUTES.length; i += 1) {
    const expected = CURATED_MAINNET_POLICY_VAULT_ROUTES[i];
    const routeIdAt = await publicClient.readContract({ address: adapter, abi: adapterAbi, functionName: "routeIdAt", args: [BigInt(i)] });
    if (routeIdAt !== expected.id) {
      throw new Error(`Curated route id mismatch at index ${i}`);
    }

    const [routeInfo, routeTokens, routePools] = await Promise.all([
      publicClient.readContract({ address: adapter, abi: adapterAbi, functionName: "routeInfo", args: [expected.id] }),
      publicClient.readContract({ address: adapter, abi: adapterAbi, functionName: "routeTokens", args: [expected.id] }),
      publicClient.readContract({ address: adapter, abi: adapterAbi, functionName: "routePools", args: [expected.id] }),
    ]);
    const [router, factory, routerKind, tokenIn, tokenOut] = routeInfo;
    if (
      !sameAddress(router, expected.router) ||
      !sameAddress(factory, expected.factory) ||
      routerKind !== expected.routerKind ||
      !sameAddress(tokenIn, W0G_MAINNET) ||
      !sameAddress(tokenOut, expected.tokenOut) ||
      routeTokens.length !== expected.path.length ||
      routePools.length !== expected.pools.length
    ) {
      throw new Error(`Curated route ${expected.label} metadata mismatch`);
    }

    for (let j = 0; j < routeTokens.length; j += 1) {
      if (!sameAddress(routeTokens[j], expected.path[j])) {
        throw new Error(`Curated route ${expected.label} token path mismatch`);
      }
    }
    for (let j = 0; j < routePools.length; j += 1) {
      if (!sameAddress(routePools[j], expected.pools[j])) {
        throw new Error(`Curated route ${expected.label} pool path mismatch`);
      }
    }

    await Promise.all([requireBytecode(expected.router, `${expected.venue} router`), requireBytecode(expected.factory, `${expected.venue} factory`)]);
    const liquidity = [];
    for (let j = 0; j < expected.fees.length; j += 1) {
      liquidity.push(
        await verifyPool({
          factory: expected.factory,
          fee: expected.fees[j],
          pool: expected.pools[j],
          tokenA: expected.path[j],
          tokenB: expected.path[j + 1],
        }),
      );
    }

    routeReports.push({
      confidence: expected.confidence,
      id: expected.id,
      label: expected.label,
      liquidity,
      symbol: expected.symbol,
      tokenOut: expected.tokenOut,
      venue: expected.venue,
    });
  }

  return {
    adapterMode: "curated-routes",
    allowedRouteIds: curatedMainnetRouteIds(),
    allowedTokens: uniqueCuratedMainnetTokens(),
    routeCount: routeReports.length,
    routes: routeReports,
    wrappedNative,
  };
}

if ((process.env.OG_NETWORK ?? "").toLowerCase() !== "mainnet") {
  throw new Error("Mainnet vault config check requires OG_NETWORK=mainnet");
}
if (Number(requireEnv("OG_CHAIN_ID")) !== MAINNET_CHAIN_ID) {
  throw new Error(`Mainnet vault config check requires OG_CHAIN_ID=${MAINNET_CHAIN_ID}`);
}
requireFlag("ENABLE_MAINNET_DEPLOY", true);
requireFlag("ENABLE_MOCK_DEX_ADAPTER", false);
requireFlag("ENABLE_REAL_DEX_ADAPTER", true);

const rpcUrl = requireEnv("OG_RPC_URL");
const indexerHost = new URL(requireEnv("OG_STORAGE_INDEXER_URL")).host;
if (indexerHost !== MAINNET_INDEXER_HOST) {
  throw new Error(`OG_STORAGE_INDEXER_URL host must be ${MAINNET_INDEXER_HOST}`);
}

const factory = requireAddressEnv("NEXT_PUBLIC_POLICY_VAULT_FACTORY_MAINNET_ADDRESS");
const proofRegistry = requireAddressEnv("NEXT_PUBLIC_PROOF_REGISTRY_MAINNET_ADDRESS");
const executor = requireAddressEnv("NEXT_PUBLIC_VAULT_EXECUTOR_MAINNET_ADDRESS");
const adapter = requireAddressEnv("NEXT_PUBLIC_POLICY_VAULT_ADAPTER_MAINNET_ADDRESS");
const fromBlock = requireFromBlockEnv("NEXT_PUBLIC_POLICY_VAULT_FACTORY_MAINNET_FROM_BLOCK");

const executorPrivateKey = process.env.VAULT_EXECUTOR_PRIVATE_KEY?.trim();
if (executorPrivateKey) {
  const derivedExecutor = privateKeyToAccount(executorPrivateKey as Hex).address;
  if (!sameAddress(derivedExecutor, executor)) {
    throw new Error("NEXT_PUBLIC_VAULT_EXECUTOR_MAINNET_ADDRESS does not match VAULT_EXECUTOR_PRIVATE_KEY");
  }
}

const publicClient = createPublicClient({
  transport: http(rpcUrl),
});
const chainId = await publicClient.getChainId();
if (chainId !== MAINNET_CHAIN_ID) {
  throw new Error(`RPC chain mismatch: expected ${MAINNET_CHAIN_ID}, got ${chainId}`);
}

await Promise.all([
  requireBytecode(factory, "PolicyVaultFactory"),
  requireBytecode(proofRegistry, "ProofRegistry"),
  requireBytecode(adapter, "PolicyVault adapter"),
]);

await publicClient.readContract({
  address: factory,
  abi: policyFactoryAbi,
  functionName: "vaultOf",
  args: [ZERO_ADDRESS],
});
await publicClient.readContract({
  address: proofRegistry,
  abi: ownableAbi,
  functionName: "owner",
});

const adapterKind = await publicClient.readContract({
  address: adapter,
  abi: adapterAbi,
  functionName: "adapterKind",
});
if (adapterKind === MOCK_ADAPTER_KIND) {
  throw new Error("Mainnet config points at a mock adapter kind");
}

let adapterReport;
if (adapterKind === ROUTE_ADAPTER_KIND) {
  adapterReport = await verifyRouteAdapter(adapter);
} else if (adapterKind === SINGLE_HOP_ADAPTER_KIND) {
  adapterReport = await verifySingleHopAdapter(adapter);
} else {
  throw new Error("Mainnet config must point at a reviewed Policy Vault adapter kind");
}

console.log("0G mainnet Policy Vault config passed", {
  adapter,
  adapterKind,
  chainId,
  executor,
  factory,
  fromBlock: fromBlock.toString(),
  proofRegistry,
  ...adapterReport,
});
