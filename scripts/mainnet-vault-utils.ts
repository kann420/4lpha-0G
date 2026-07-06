import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import dotenv from "dotenv";
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  getAddress,
  http,
  isAddress,
  isHex,
  keccak256,
  parseEther,
  stringToHex,
  type Address,
  type Chain,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { buildV3LpAllowlists, ZIA_LP_MAINNET } from "../lib/contracts/zia-lp";

dotenv.config({ path: ".env.local", quiet: true });

export const MAINNET_CHAIN_ID = 16661;
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
export const ZERO_HASH = `0x${"00".repeat(32)}` as Hex;
export const MOCK_ADAPTER_KIND = keccak256(stringToHex("4LPHA_0G_MOCK_ADAPTER"));
export const ROUTE_ADAPTER_KIND = keccak256(stringToHex("4LPHA_0G_CURATED_UNISWAP_V3_ROUTE_ADAPTER"));
export const MOCK_LP_ADAPTER_KIND = keccak256(stringToHex("4LPHA_0G_MOCK_LP_ADAPTER"));
export const ZIA_LP_ADAPTER_KIND = keccak256(stringToHex("4LPHA_0G_ZIA_LP_ADAPTER"));

export interface PolicyVaultPolicy {
  cooldownSeconds: bigint;
  dailyCap0G: bigint;
  defaultMinOutBps: number;
  maxDeadlineWindowSeconds: bigint;
  maxExposure0G: bigint;
  perTradeCap0G: bigint;
}

export const policyVaultFactoryAbi = [
  {
    inputs: [{ internalType: "address", name: "owner", type: "address" }],
    name: "vaultOf",
    outputs: [{ internalType: "address", name: "vault", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "owner", type: "address" },
      { indexed: true, internalType: "address", name: "executor", type: "address" },
      { indexed: true, internalType: "address", name: "vault", type: "address" },
      { indexed: false, internalType: "address", name: "adapter", type: "address" },
      { indexed: false, internalType: "address", name: "proofRegistry", type: "address" },
      { indexed: false, internalType: "bool", name: "mockAdapterAllowed", type: "bool" },
    ],
    name: "VaultCreated",
    type: "event",
  },
  {
    inputs: [
      { internalType: "address", name: "owner", type: "address" },
      { internalType: "address", name: "executor", type: "address" },
      { internalType: "address", name: "adapter", type: "address" },
      { internalType: "address", name: "proofRegistry", type: "address" },
      {
        components: [
          { internalType: "uint256", name: "perTradeCap0G", type: "uint256" },
          { internalType: "uint256", name: "dailyCap0G", type: "uint256" },
          { internalType: "uint256", name: "maxExposure0G", type: "uint256" },
          { internalType: "uint256", name: "cooldownSeconds", type: "uint256" },
          { internalType: "uint256", name: "maxDeadlineWindowSeconds", type: "uint256" },
          { internalType: "uint16", name: "defaultMinOutBps", type: "uint16" },
        ],
        internalType: "struct PolicyVault.Policy",
        name: "policy",
        type: "tuple",
      },
      { internalType: "address[]", name: "allowedTokens", type: "address[]" },
      { internalType: "bytes32[]", name: "allowedPools", type: "bytes32[]" },
      { internalType: "bool", name: "allowMockAdapter", type: "bool" },
    ],
    name: "createVault",
    outputs: [{ internalType: "address", name: "vault", type: "address" }],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

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

export const policyVaultAbi = [
  {
    inputs: [],
    name: "depositNative",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [],
    name: "owner",
    outputs: [{ internalType: "address", name: "", type: "address" }],
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
    name: "adapter",
    outputs: [{ internalType: "contract IPolicyVaultAdapter", name: "", type: "address" }],
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
    inputs: [],
    name: "mockAdapterAllowed",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
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
    name: "executorRevoked",
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
    inputs: [{ internalType: "address", name: "token", type: "address" }],
    name: "allowedTokens",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "bytes32", name: "poolId", type: "bytes32" }],
    name: "allowedPools",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "dailySpent0G",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "dailyWindowStart",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "lastTradeAt",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "openExposure0G",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
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
    inputs: [
      { internalType: "address", name: "tokenIn", type: "address" },
      { internalType: "address", name: "tokenOut", type: "address" },
    ],
    name: "minOutBpsFor",
    outputs: [{ internalType: "uint16", name: "", type: "uint16" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "bool", name: "isBuy", type: "bool" },
      {
        components: tradeRequestComponents,
        internalType: "struct PolicyVault.TradeRequest",
        name: "request",
        type: "tuple",
      },
    ],
    name: "vaultActionHashFor",
    outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "bytes32", name: "vaultActionHash", type: "bytes32" },
      { internalType: "bytes32", name: "auditRoot", type: "bytes32" },
      { internalType: "bytes32", name: "policySnapshotHash", type: "bytes32" },
    ],
    name: "actionHashFor",
    outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
    stateMutability: "pure",
    type: "function",
  },
  {
    inputs: [
      {
        components: tradeRequestComponents,
        internalType: "struct PolicyVault.TradeRequest",
        name: "request",
        type: "tuple",
      },
    ],
    name: "buy",
    outputs: [{ internalType: "uint256", name: "amountOut", type: "uint256" }],
    stateMutability: "payable",
    type: "function",
  },
] as const;

export const adapterAbi = [
  {
    inputs: [],
    name: "adapterKind",
    outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "bytes32", name: "routeId", type: "bytes32" }],
    name: "routeConfigured",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
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
    inputs: [
      { internalType: "address", name: "tokenIn", type: "address" },
      { internalType: "address", name: "tokenOut", type: "address" },
      { internalType: "uint256", name: "amountIn", type: "uint256" },
      { internalType: "uint256", name: "amountOutMin", type: "uint256" },
      { internalType: "bytes32", name: "poolId", type: "bytes32" },
    ],
    name: "swapExactIn",
    outputs: [{ internalType: "uint256", name: "amountOut", type: "uint256" }],
    stateMutability: "payable",
    type: "function",
  },
] as const;

export const proofRegistryAbi = [
  {
    inputs: [],
    name: "owner",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
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
    inputs: [
      { internalType: "bytes32", name: "actionHash", type: "bytes32" },
      { internalType: "bytes32", name: "auditRoot", type: "bytes32" },
      { internalType: "bytes32", name: "policySnapshotHash", type: "bytes32" },
      { internalType: "bytes32", name: "vaultActionHash", type: "bytes32" },
    ],
    name: "isAccepted",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export const erc20Abi = [
  {
    inputs: [],
    name: "decimals",
    outputs: [{ internalType: "uint8", name: "", type: "uint8" }],
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

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value.trim();
}

export function readBoolEnv(name: string, fallback = false): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (value === undefined || value === "") {
    return fallback;
  }
  return value === "true" || value === "1" || value === "yes";
}

export function requireFlag(name: string, expected: boolean, context: string) {
  const actual = readBoolEnv(name);
  if (actual !== expected) {
    throw new Error(`${name} must be ${String(expected)} for ${context}`);
  }
}

export function requireMainnetEnv(context: string) {
  if ((process.env.OG_NETWORK ?? "").toLowerCase() !== "mainnet") {
    throw new Error(`${context} requires OG_NETWORK=mainnet`);
  }
  if (Number(requireEnv("OG_CHAIN_ID")) !== MAINNET_CHAIN_ID) {
    throw new Error(`${context} requires OG_CHAIN_ID=${MAINNET_CHAIN_ID}`);
  }
  requireFlag("ENABLE_MAINNET_DEPLOY", true, context);
  requireFlag("ENABLE_MOCK_DEX_ADAPTER", false, context);
  requireFlag("ENABLE_REAL_DEX_ADAPTER", true, context);
}

export function requireAddressEnv(name: string): Address {
  const value = requireEnv(name);
  if (!isAddress(value)) {
    throw new Error(`${name} must be a valid EVM address`);
  }
  return getAddress(value);
}

export function readOptionalAddressEnv(name: string): Address | null {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") {
    return null;
  }
  if (!isAddress(value)) {
    throw new Error(`${name} must be a valid EVM address when set`);
  }
  return getAddress(value);
}

export function readPrivateKeyAccount(name: string) {
  const value = requireEnv(name);
  if (!isHex(value, { strict: true }) || value.length !== 66) {
    throw new Error(`${name} must be a 32-byte hex private key`);
  }
  return privateKeyToAccount(value as Hex);
}

export function readOptionalPrivateKeyOwner(): Address | null {
  const value = process.env.DEPLOYER_PRIVATE_KEY?.trim();
  if (value === undefined || value === "") {
    return null;
  }
  if (!isHex(value, { strict: true }) || value.length !== 66) {
    throw new Error("DEPLOYER_PRIVATE_KEY must be a 32-byte hex private key when set");
  }
  return privateKeyToAccount(value as Hex).address;
}

export function readOwnerAddress(): Address {
  const explicit = readOptionalAddressEnv("MAINNET_VAULT_OWNER_ADDRESS");
  if (explicit !== null) {
    return explicit;
  }
  const derived = readOptionalPrivateKeyOwner();
  if (derived !== null) {
    return derived;
  }
  const configuredVault = readConfiguredVaultAddress();
  if (configuredVault !== null) {
    throw new Error("Set MAINNET_VAULT_OWNER_ADDRESS to verify the configured mainnet vault against the factory");
  }
  throw new Error("Set MAINNET_VAULT_OWNER_ADDRESS or DEPLOYER_PRIVATE_KEY to discover the mainnet vault");
}

export function readConfiguredVaultAddress(): Address | null {
  return (
    readOptionalAddressEnv("NEXT_PUBLIC_POLICY_VAULT_MAINNET_ADDRESS") ??
    readOptionalAddressEnv("POLICY_VAULT_MAINNET_ADDRESS")
  );
}

export function readMainnetVaultConfig() {
  return {
    adapter: requireAddressEnv("NEXT_PUBLIC_POLICY_VAULT_ADAPTER_MAINNET_ADDRESS"),
    executor: requireAddressEnv("NEXT_PUBLIC_VAULT_EXECUTOR_MAINNET_ADDRESS"),
    factory: requireAddressEnv("NEXT_PUBLIC_POLICY_VAULT_FACTORY_MAINNET_ADDRESS"),
    proofRegistry: requireAddressEnv("NEXT_PUBLIC_PROOF_REGISTRY_MAINNET_ADDRESS"),
  };
}

export function readPolicyFromEnv(): PolicyVaultPolicy {
  return {
    cooldownSeconds: readBigIntEnv("NEXT_PUBLIC_POLICY_VAULT_MAINNET_COOLDOWN_SECONDS", 0n),
    dailyCap0G: read0GAmountEnv("NEXT_PUBLIC_POLICY_VAULT_MAINNET_DAILY_CAP_0G", "25"),
    defaultMinOutBps: readBpsEnv("NEXT_PUBLIC_POLICY_VAULT_MAINNET_DEFAULT_MIN_OUT_BPS", 9_950),
    maxDeadlineWindowSeconds: readBigIntEnv("NEXT_PUBLIC_POLICY_VAULT_MAINNET_MAX_DEADLINE_WINDOW_SECONDS", 15n * 60n),
    maxExposure0G: read0GAmountEnv("NEXT_PUBLIC_POLICY_VAULT_MAINNET_MAX_EXPOSURE_0G", "25"),
    perTradeCap0G: read0GAmountEnv("NEXT_PUBLIC_POLICY_VAULT_MAINNET_PER_TRADE_CAP_0G", "5"),
  };
}

export interface PolicyVaultV3LpPolicy {
  perLpActionCap0G: bigint;
  lpDailyCap0G: bigint;
  maxLpExposure0G: bigint;
  cooldownSecondsLp: bigint;
  lpMinOutBps: number;
  minLiquidityFloor: bigint;
  allowStaking: boolean;
}

export interface PolicyVaultV3Policy extends PolicyVaultPolicy {
  lp: PolicyVaultV3LpPolicy;
}

/// V3 policy = V2 6 swap fields + nested LpPolicy (7 fields). The constructor
/// takes this as a single nested tuple; viem encodes {lp: {...}} correctly.
export function readV3PolicyFromEnv(): PolicyVaultV3Policy {
  const base = readPolicyFromEnv();
  const lp: PolicyVaultV3LpPolicy = {
    perLpActionCap0G: read0GAmountEnv("NEXT_PUBLIC_POLICY_VAULT_V3_MAINNET_PER_LP_ACTION_CAP_0G", "2"),
    lpDailyCap0G: read0GAmountEnv("NEXT_PUBLIC_POLICY_VAULT_V3_MAINNET_LP_DAILY_CAP_0G", "10"),
    maxLpExposure0G: read0GAmountEnv("NEXT_PUBLIC_POLICY_VAULT_V3_MAINNET_MAX_LP_EXPOSURE_0G", "15"),
    cooldownSecondsLp: readBigIntEnv("NEXT_PUBLIC_POLICY_VAULT_V3_MAINNET_LP_COOLDOWN_SECONDS", 0n),
    lpMinOutBps: readBpsEnv("NEXT_PUBLIC_POLICY_VAULT_V3_MAINNET_LP_MIN_OUT_BPS", 9_500),
    minLiquidityFloor: readBigIntEnv("NEXT_PUBLIC_POLICY_VAULT_V3_MAINNET_LP_MIN_LIQUIDITY_FLOOR", 1_000_000n),
    allowStaking: readBoolEnv("NEXT_PUBLIC_POLICY_VAULT_V3_MAINNET_LP_ALLOW_STAKING", true),
  };
  return { ...base, lp };
}

/// Build the three parallel constructor arrays for the V3 LP allowlists from
/// ZIA_LP_VAULTS, filtered to W0G-leg pools (zappable single-sided from native).
export function readV3LpAllowlistsFromEnv() {
  return buildV3LpAllowlists(ZIA_LP_MAINNET.wrappedNative);
}

export function formatV3Policy(policy: PolicyVaultV3Policy) {
  return {
    ...formatPolicy(policy),
    lp: {
      perLpActionCap0G: formatEther(policy.lp.perLpActionCap0G),
      lpDailyCap0G: formatEther(policy.lp.lpDailyCap0G),
      maxLpExposure0G: formatEther(policy.lp.maxLpExposure0G),
      cooldownSecondsLp: policy.lp.cooldownSecondsLp.toString(),
      lpMinOutBps: policy.lp.lpMinOutBps,
      minLiquidityFloor: policy.lp.minLiquidityFloor.toString(),
      allowStaking: policy.lp.allowStaking,
    },
  };
}

/// Minimal LP adapter ABI for deploy-time validation (reject mock on mainnet).
export const lpAdapterAbi = [
  { inputs: [], name: "lpAdapterKind", outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "wrappedNative", outputs: [{ internalType: "address", name: "", type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "nfpm", outputs: [{ internalType: "address", name: "", type: "address" }], stateMutability: "view", type: "function" },
] as const;

export function read0GAmountEnv(name: string, fallback: string): bigint {
  const value = process.env[name]?.trim() || fallback;
  try {
    return parseEther(value);
  } catch {
    throw new Error(`${name} must be a decimal 0G amount`);
  }
}

export function readOptional0GAmountEnv(name: string): bigint | null {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") {
    return null;
  }
  try {
    return parseEther(value);
  } catch {
    throw new Error(`${name} must be a decimal 0G amount`);
  }
}

export function readBigIntEnv(name: string, fallback: bigint): bigint {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  if (!/^\d+$/u.test(value)) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return BigInt(value);
}

export function readBpsEnv(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 10_000) {
    throw new Error(`${name} must be between 1 and 10000`);
  }
  return parsed;
}

export function makeMainnetChain(rpcUrl: string): Chain {
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

export function createMainnetPublicClient() {
  const rpcUrl = requireEnv("OG_RPC_URL");
  return createPublicClient({ chain: makeMainnetChain(rpcUrl), transport: http(rpcUrl) });
}

export function createMainnetWalletClient(privateKeyEnvName: string) {
  const rpcUrl = requireEnv("OG_RPC_URL");
  const account = readPrivateKeyAccount(privateKeyEnvName);
  const chain = makeMainnetChain(rpcUrl);
  return {
    account,
    walletClient: createWalletClient({ account, chain, transport: http(rpcUrl) }),
  };
}

type MainnetPublicClient = ReturnType<typeof createMainnetPublicClient>;

export async function assertMainnetRpc(publicClient: MainnetPublicClient): Promise<number> {
  const chainId = await publicClient.getChainId();
  if (chainId !== MAINNET_CHAIN_ID) {
    throw new Error(`RPC chain mismatch: expected ${MAINNET_CHAIN_ID}, got ${chainId}`);
  }
  return chainId;
}

export async function requireBytecode(publicClient: MainnetPublicClient, address: Address, label: string) {
  const bytecode = await publicClient.getBytecode({ address });
  if (bytecode === undefined || bytecode === "0x") {
    throw new Error(`${label} has no deployed bytecode at ${address}`);
  }
}

export async function readFactoryVault(publicClient: MainnetPublicClient, factory: Address, owner: Address): Promise<Address> {
  return getAddress(
    await publicClient.readContract({
      address: factory,
      abi: policyVaultFactoryAbi,
      functionName: "vaultOf",
      args: [owner],
    }),
  );
}

export async function waitForTx(publicClient: MainnetPublicClient, hash: Hex, label: string) {
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

export function normalizePolicy(raw: unknown): PolicyVaultPolicy {
  return {
    cooldownSeconds: readBigIntField(raw, "cooldownSeconds", 3),
    dailyCap0G: readBigIntField(raw, "dailyCap0G", 1),
    defaultMinOutBps: Number(readBigIntField(raw, "defaultMinOutBps", 5)),
    maxDeadlineWindowSeconds: readBigIntField(raw, "maxDeadlineWindowSeconds", 4),
    maxExposure0G: readBigIntField(raw, "maxExposure0G", 2),
    perTradeCap0G: readBigIntField(raw, "perTradeCap0G", 0),
  };
}

export function formatPolicy(policy: PolicyVaultPolicy) {
  return {
    cooldownSeconds: policy.cooldownSeconds.toString(),
    dailyCap0G: formatEther(policy.dailyCap0G),
    defaultMinOutBps: policy.defaultMinOutBps,
    maxDeadlineWindowSeconds: policy.maxDeadlineWindowSeconds.toString(),
    maxExposure0G: formatEther(policy.maxExposure0G),
    perTradeCap0G: formatEther(policy.perTradeCap0G),
  };
}

export function sameAddress(a: Address, b: Address) {
  return a.toLowerCase() === b.toLowerCase();
}

export async function writeJsonArtifact(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, jsonReplacer, 2)}\n`, "utf8");
}

export function isDirectRun(importMetaUrl: string): boolean {
  const scriptPath = process.argv[1];
  return scriptPath !== undefined && pathToFileURL(resolve(scriptPath)).href === importMetaUrl;
}

export async function runIfDirect(importMetaUrl: string, main: () => Promise<void>) {
  if (!isDirectRun(importMetaUrl)) {
    return;
  }
  try {
    await main();
  } catch (error) {
    console.error(`Script failed: ${sanitizeError(error)}`);
    process.exitCode = 1;
  }
}

function readBigIntField(raw: unknown, key: string, index: number): bigint {
  const record = raw as Record<string, unknown>;
  const list = raw as readonly unknown[];
  const value = record[key] ?? list[index];
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number" || typeof value === "string") {
    return BigInt(value);
  }
  throw new Error(`Unable to read policy field ${key}`);
}

function jsonReplacer(_key: string, value: unknown) {
  return typeof value === "bigint" ? value.toString() : value;
}

function sleep(ms: number) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(sk|mk)-[A-Za-z0-9_-]+/gu, "$1-[redacted]")
    .replace(/0x[a-fA-F0-9]{64}/gu, "0x[redacted-32-byte-hex]")
    .replace(/(https?:\/\/)([^/@\s]+)@/gu, "$1[redacted]@");
}
