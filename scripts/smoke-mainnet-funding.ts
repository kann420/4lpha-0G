import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import dotenv from "dotenv";
import {
  createPublicClient,
  createWalletClient,
  http,
  isAddress,
  parseEther,
  type Address,
  type Chain,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { curatedMainnetRouteIds, uniqueCuratedMainnetTokens } from "../lib/contracts/curated-routes";

dotenv.config({ path: ".env.local", quiet: true });

const MAINNET_CHAIN_ID = 16661;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
const policyVaultFactoryAbi = [
  {
    inputs: [{ internalType: "address", name: "owner", type: "address" }],
    name: "vaultOf",
    outputs: [{ internalType: "address", name: "vault", type: "address" }],
    stateMutability: "view",
    type: "function",
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
const policyVaultAbi = [
  {
    inputs: [],
    name: "depositNative",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "amount", type: "uint256" }],
    name: "withdrawNative",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "bool", name: "value", type: "bool" }],
    name: "setPaused",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "revokeExecutor",
    outputs: [],
    stateMutability: "nonpayable",
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
    throw new Error(`${name} must be ${String(expected)} for mainnet funding smoke`);
  }
}

function requireAddressEnv(name: string): Address {
  const value = requireEnv(name);
  if (!isAddress(value)) {
    throw new Error(`${name} must be a valid EVM address`);
  }
  return value;
}

function read0GAmountEnv(name: string, fallback: string): bigint {
  const value = process.env[name]?.trim() || fallback;
  try {
    return parseEther(value);
  } catch {
    throw new Error(`${name} must be a decimal 0G amount`);
  }
}

function readBigIntEnv(name: string, fallback: bigint): bigint {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  if (!/^\d+$/u.test(value)) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return BigInt(value);
}

function readBpsEnv(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 10_000) {
    throw new Error(`${name} must be between 1 and 10000`);
  }
  return parsed;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function makeMainnetChain(rpcUrl: string): Chain {
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

async function writeSmoke(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

if ((process.env.OG_NETWORK ?? "").toLowerCase() !== "mainnet") {
  throw new Error("Mainnet funding smoke requires OG_NETWORK=mainnet");
}
if (Number(requireEnv("OG_CHAIN_ID")) !== MAINNET_CHAIN_ID) {
  throw new Error(`Mainnet funding smoke requires OG_CHAIN_ID=${MAINNET_CHAIN_ID}`);
}
requireFlag("ENABLE_MAINNET_DEPLOY", true);
requireFlag("ENABLE_MOCK_DEX_ADAPTER", false);
requireFlag("ENABLE_REAL_DEX_ADAPTER", true);

const smokeDepositText = requireEnv("MAINNET_SMOKE_DEPOSIT_0G");
const smokeDeposit = parseEther(smokeDepositText);
if (smokeDeposit <= 0n || smokeDeposit > parseEther("0.05")) {
  throw new Error("MAINNET_SMOKE_DEPOSIT_0G must be greater than 0 and at most 0.05");
}

const rpcUrl = requireEnv("OG_RPC_URL");
const chain = makeMainnetChain(rpcUrl);
const account = privateKeyToAccount(requireEnv("DEPLOYER_PRIVATE_KEY") as Hex);
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });

const chainId = await publicClient.getChainId();
if (chainId !== MAINNET_CHAIN_ID) {
  throw new Error(`RPC chain mismatch: expected ${MAINNET_CHAIN_ID}, got ${chainId}`);
}

const factory = requireAddressEnv("NEXT_PUBLIC_POLICY_VAULT_FACTORY_MAINNET_ADDRESS");
const proofRegistry = requireAddressEnv("NEXT_PUBLIC_PROOF_REGISTRY_MAINNET_ADDRESS");
const executor = requireAddressEnv("NEXT_PUBLIC_VAULT_EXECUTOR_MAINNET_ADDRESS");
const adapter = requireAddressEnv("NEXT_PUBLIC_POLICY_VAULT_ADAPTER_MAINNET_ADDRESS");
const allowedTokens = uniqueCuratedMainnetTokens();
const allowedPools = curatedMainnetRouteIds();
const policy = {
  cooldownSeconds: readBigIntEnv("NEXT_PUBLIC_POLICY_VAULT_MAINNET_COOLDOWN_SECONDS", 15n * 60n),
  dailyCap0G: read0GAmountEnv("NEXT_PUBLIC_POLICY_VAULT_MAINNET_DAILY_CAP_0G", "0.1"),
  defaultMinOutBps: readBpsEnv("NEXT_PUBLIC_POLICY_VAULT_MAINNET_DEFAULT_MIN_OUT_BPS", 9_950),
  maxDeadlineWindowSeconds: readBigIntEnv("NEXT_PUBLIC_POLICY_VAULT_MAINNET_MAX_DEADLINE_WINDOW_SECONDS", 15n * 60n),
  maxExposure0G: read0GAmountEnv("NEXT_PUBLIC_POLICY_VAULT_MAINNET_MAX_EXPOSURE_0G", "0.25"),
  perTradeCap0G: read0GAmountEnv("NEXT_PUBLIC_POLICY_VAULT_MAINNET_PER_TRADE_CAP_0G", "0.05"),
};

let vault = await publicClient.readContract({
  address: factory,
  abi: policyVaultFactoryAbi,
  functionName: "vaultOf",
  args: [account.address],
});

const tx: Record<string, Hex> = {};
if (vault === ZERO_ADDRESS) {
  tx.createVault = await walletClient.writeContract({
    address: factory,
    abi: policyVaultFactoryAbi,
    functionName: "createVault",
    args: [account.address, executor, adapter, proofRegistry, policy, allowedTokens, allowedPools, false],
  });
  await waitForTx(tx.createVault, "createVault");
  vault = await publicClient.readContract({
    address: factory,
    abi: policyVaultFactoryAbi,
    functionName: "vaultOf",
    args: [account.address],
  });
  if (vault === ZERO_ADDRESS) {
    throw new Error("Factory did not resolve a vault after createVault");
  }
}

const owner = await publicClient.readContract({
  address: vault,
  abi: policyVaultAbi,
  functionName: "owner",
});
if (owner.toLowerCase() !== account.address.toLowerCase()) {
  throw new Error("Resolved vault is not owned by the deployer wallet");
}

const before = await publicClient.getBalance({ address: vault });
tx.deposit = await walletClient.writeContract({
  address: vault,
  abi: policyVaultAbi,
  functionName: "depositNative",
  value: smokeDeposit,
});
await waitForTx(tx.deposit, "deposit");
const afterDeposit = await publicClient.getBalance({ address: vault });
if (afterDeposit < before + smokeDeposit) {
  throw new Error("Vault balance did not increase by the smoke deposit amount");
}

tx.pause = await walletClient.writeContract({
  address: vault,
  abi: policyVaultAbi,
  functionName: "setPaused",
  args: [true],
});
await waitForTx(tx.pause, "pause");
tx.resume = await walletClient.writeContract({
  address: vault,
  abi: policyVaultAbi,
  functionName: "setPaused",
  args: [false],
});
await waitForTx(tx.resume, "resume");

tx.withdraw = await walletClient.writeContract({
  address: vault,
  abi: policyVaultAbi,
  functionName: "withdrawNative",
  args: [smokeDeposit],
});
await waitForTx(tx.withdraw, "withdraw");
const afterWithdraw = await publicClient.getBalance({ address: vault });
if (afterWithdraw !== before) {
  throw new Error("Vault balance did not return to the pre-smoke value after withdrawal");
}

if ((process.env.MAINNET_SMOKE_REVOKE_EXECUTOR ?? "false").toLowerCase() === "true") {
  tx.revoke = await walletClient.writeContract({
    address: vault,
    abi: policyVaultAbi,
    functionName: "revokeExecutor",
  });
  await waitForTx(tx.revoke, "revoke");
}

const output = {
  chainId,
  owner: account.address,
  smokeDeposit0G: smokeDepositText,
  tx,
  vault,
};
const outputPath = join(".data", "smoke", "mainnet-funding.json");
await writeSmoke(outputPath, output);

console.log("0G mainnet funding smoke passed. Redacted artifact:", outputPath);
console.log({
  chainId,
  deposit: tx.deposit,
  owner: account.address,
  vault,
  withdraw: tx.withdraw,
});
