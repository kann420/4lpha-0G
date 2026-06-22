import { network } from "hardhat";

const GALILEO_CHAIN_ID = 16602;
const MAINNET_CHAIN_ID = 16661;
const GALILEO_INDEXER_HOST = "indexer-storage-testnet-turbo.0g.ai";
const MAINNET_INDEXER_HOST = "indexer-storage-turbo.0g.ai";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function requireBool(name: string): boolean {
  return requireEnv(name).toLowerCase() === "true";
}

function expectedStorageHost(chainId: number) {
  return chainId === MAINNET_CHAIN_ID ? MAINNET_INDEXER_HOST : GALILEO_INDEXER_HOST;
}

const ogNetwork = process.env.OG_NETWORK ?? "testnet";
const chainId = Number(requireEnv("OG_CHAIN_ID"));
const rpcUrl = requireEnv("OG_RPC_URL");
const indexerUrl = requireEnv("OG_STORAGE_INDEXER_URL");
const mockEnabled = (process.env.ENABLE_MOCK_DEX_ADAPTER ?? "false").toLowerCase() === "true";
const realEnabled = (process.env.ENABLE_REAL_DEX_ADAPTER ?? "false").toLowerCase() === "true";

if (![GALILEO_CHAIN_ID, MAINNET_CHAIN_ID].includes(chainId)) {
  throw new Error(`Unsupported OG_CHAIN_ID ${chainId}`);
}

if (ogNetwork === "mainnet" || chainId === MAINNET_CHAIN_ID) {
  if (ogNetwork !== "mainnet" || !requireBool("ENABLE_MAINNET_DEPLOY")) {
    throw new Error("Mainnet requires OG_NETWORK=mainnet and ENABLE_MAINNET_DEPLOY=true");
  }
  if (mockEnabled) {
    throw new Error("Mock adapter is blocked on mainnet");
  }
  if (!realEnabled) {
    throw new Error("Mainnet requires ENABLE_REAL_DEX_ADAPTER=true");
  }
}

if (realEnabled && mockEnabled) {
  throw new Error("Enable either real DEX adapter or mock DEX adapter, not both");
}

const indexerHost = new URL(indexerUrl).host;
if (indexerHost !== expectedStorageHost(chainId)) {
  throw new Error(`Storage indexer host ${indexerHost} does not match OG_CHAIN_ID ${chainId}`);
}

const { viem } = await network.create();
const publicClient = await viem.getPublicClient();
const liveChainId = await publicClient.getChainId();
if (liveChainId !== chainId) {
  throw new Error(`RPC chain mismatch: expected ${chainId}, got ${liveChainId}`);
}

if (!rpcUrl.startsWith("https://") && liveChainId !== 31337) {
  throw new Error("OG_RPC_URL must use HTTPS outside local development");
}

console.log("0G preflight passed", {
  chainId: liveChainId,
  network: ogNetwork,
  mockEnabled,
  storageIndexerHost: indexerHost,
});
