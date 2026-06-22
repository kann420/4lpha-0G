import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { artifacts, network } from "hardhat";
import { getAddress, isAddress, parseEther, type Abi, type Address, type Hex } from "viem";
import {
  CURATED_MAINNET_POLICY_VAULT_ROUTES,
  W0G_MAINNET,
} from "../lib/contracts/curated-routes";

const MAINNET_CHAIN_ID = 16661;

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

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value.trim();
}

function requireAddress(value: Address | null | undefined, label: string): Address {
  if (value === undefined || value === null) {
    throw new Error(`Missing address: ${label}`);
  }
  return value;
}

function requireFlag(name: string, expected: boolean) {
  const actual = (process.env[name] ?? "false").toLowerCase() === "true";
  if (actual !== expected) {
    throw new Error(`${name} must be ${String(expected)} for mainnet adapter deploy`);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requireBytecode(address: Address, label: string) {
  const bytecode = await publicClient.getBytecode({ address });
  if (bytecode === undefined || bytecode === "0x") {
    throw new Error(`${label} has no deployed bytecode at ${address}`);
  }
}

async function waitForTx(hash: Hex, label: string) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      return await publicClient.getTransactionReceipt({ hash });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("could not be found") && !message.includes("not be found")) {
        throw error;
      }
      await sleep(1000);
    }
  }
  throw new Error(`Timed out waiting for ${label} receipt: ${hash}`);
}

async function readArtifact(contractName: string): Promise<{ abi: Abi; bytecode: Hex }> {
  const artifact = await artifacts.readArtifact(contractName);
  const bytecode = artifact.bytecode as Hex;
  if (bytecode === "0x") {
    throw new Error(`Missing bytecode for ${contractName}`);
  }
  return { abi: artifact.abi as Abi, bytecode };
}

async function deployContract(contractName: string, args: readonly unknown[]): Promise<{ address: Address; abi: Abi; blockNumber: bigint; txHash: Hex }> {
  const artifact = await readArtifact(contractName);
  const txHash = await deployer.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args,
  });
  const receipt = await waitForTx(txHash, `deploy:${contractName}`);
  return {
    abi: artifact.abi,
    address: requireAddress(receipt.contractAddress, `deployment:${contractName}`),
    blockNumber: receipt.blockNumber,
    txHash,
  };
}

async function writeDeployment(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function uniqueAddresses(values: readonly Address[]): Address[] {
  const seen = new Set<string>();
  const result: Address[] = [];
  for (const value of values) {
    const normalized = getAddress(value);
    const key = normalized.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(normalized);
    }
  }
  return result;
}

async function verifyCuratedRoute(route: (typeof CURATED_MAINNET_POLICY_VAULT_ROUTES)[number]) {
  await Promise.all([
    requireBytecode(route.router, `${route.venue} router ${route.label}`),
    requireBytecode(route.factory, `${route.venue} factory ${route.label}`),
    ...route.path.map((token) => requireBytecode(token, `${route.symbol} route token ${token}`)),
    ...route.pools.map((pool) => requireBytecode(pool, `${route.symbol} route pool ${pool}`)),
  ]);

  for (let i = 0; i < route.fees.length; i += 1) {
    const [token0, token1, fee, factoryPool] = await Promise.all([
      publicClient.readContract({ address: route.pools[i], abi: v3PoolAbi, functionName: "token0" }),
      publicClient.readContract({ address: route.pools[i], abi: v3PoolAbi, functionName: "token1" }),
      publicClient.readContract({ address: route.pools[i], abi: v3PoolAbi, functionName: "fee" }),
      publicClient.readContract({
        address: route.factory,
        abi: v3FactoryAbi,
        functionName: "getPool",
        args: [route.path[i], route.path[i + 1], route.fees[i]],
      }),
    ]);
    const pairMatches =
      (token0.toLowerCase() === route.path[i].toLowerCase() && token1.toLowerCase() === route.path[i + 1].toLowerCase()) ||
      (token1.toLowerCase() === route.path[i].toLowerCase() && token0.toLowerCase() === route.path[i + 1].toLowerCase());
    if (!pairMatches || fee !== route.fees[i] || factoryPool.toLowerCase() !== route.pools[i].toLowerCase()) {
      throw new Error(`Route ${route.label} pool ${route.pools[i]} is not registered for hop ${i}`);
    }
  }
}

if ((process.env.OG_NETWORK ?? "").toLowerCase() !== "mainnet") {
  throw new Error("Mainnet adapter deploy requires OG_NETWORK=mainnet");
}
if (Number(requireEnv("OG_CHAIN_ID")) !== MAINNET_CHAIN_ID) {
  throw new Error(`Mainnet adapter deploy requires OG_CHAIN_ID=${MAINNET_CHAIN_ID}`);
}
requireEnv("DEPLOYER_PRIVATE_KEY");
requireFlag("ENABLE_MAINNET_DEPLOY", true);
requireFlag("ENABLE_MOCK_DEX_ADAPTER", false);
requireFlag("ENABLE_REAL_DEX_ADAPTER", true);

if (!isAddress(W0G_MAINNET)) {
  throw new Error("Invalid W0G route registry address");
}

const { viem } = await network.create();
const publicClient = await viem.getPublicClient();
const chainId = await publicClient.getChainId();
if (chainId !== MAINNET_CHAIN_ID) {
  throw new Error(`RPC chain mismatch: expected ${MAINNET_CHAIN_ID}, got ${chainId}`);
}

await Promise.all(CURATED_MAINNET_POLICY_VAULT_ROUTES.map((route) => verifyCuratedRoute(route)));

const [deployer] = await viem.getWalletClients();
const deployerAddress = requireAddress(deployer.account?.address, "deployer");
const deployerBalance = await publicClient.getBalance({ address: deployerAddress });
if (deployerBalance < parseEther("0.01")) {
  throw new Error("Deployer needs at least 0.01 0G for mainnet route adapter deploy gas");
}

const routeConfigs = CURATED_MAINNET_POLICY_VAULT_ROUTES.map((route) => ({
  factory: route.factory,
  fees: [...route.fees],
  path: [...route.path],
  pools: [...route.pools],
  routeId: route.id,
  router: route.router,
  routerKind: route.routerKind,
}));

const adapter = await deployContract("CuratedUniswapV3RouteAdapter", [W0G_MAINNET, routeConfigs]);

const output = {
  adapter: adapter.address,
  blockNumber: adapter.blockNumber.toString(),
  chainId,
  deployer: deployerAddress,
  routes: CURATED_MAINNET_POLICY_VAULT_ROUTES.map((route) => ({
    confidence: route.confidence,
    factory: route.factory,
    fees: route.fees,
    id: route.id,
    label: route.label,
    path: route.path,
    pools: route.pools,
    router: route.router,
    routerKind: route.routerKind,
    symbol: route.symbol,
    tokenOut: route.tokenOut,
    venue: route.venue,
  })),
  routeTokens: uniqueAddresses(CURATED_MAINNET_POLICY_VAULT_ROUTES.map((route) => route.tokenOut)),
  tx: adapter.txHash,
  wrappedNative: W0G_MAINNET,
};

const outputPath = join(".data", "deployments", "mainnet-policy-vault-adapter.json");
await writeDeployment(outputPath, output);

console.log("0G mainnet curated route adapter deployed. Redacted deployment artifact:", outputPath);
console.log({
  adapter: adapter.address,
  chainId,
  routeCount: CURATED_MAINNET_POLICY_VAULT_ROUTES.length,
  wrappedNative: W0G_MAINNET,
});
console.log("Set this public env var after review:");
console.log(`NEXT_PUBLIC_POLICY_VAULT_ADAPTER_MAINNET_ADDRESS=${adapter.address}`);
