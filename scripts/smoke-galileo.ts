import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { artifacts, network } from "hardhat";
import {
  createWalletClient,
  decodeEventLog,
  getAddress,
  http,
  keccak256,
  parseEther,
  stringToHex,
  type Abi,
  type Address,
  type Chain,
  type Hex,
} from "viem";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
const GALILEO_CHAIN_ID = 16602;
const POOL_ID = keccak256(stringToHex("4LPHA_0G_MOCK_POOL"));
const AUDIT_ROOT = keccak256(stringToHex("galileo-smoke-audit-root"));
const MODEL_HASH = keccak256(stringToHex("0g-compute-router-redacted-model"));
const ZERO_HASH = `0x${"00".repeat(32)}` as Hex;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function requireAddress(value: Address | null | undefined, label: string): Address {
  if (value === undefined || value === null) {
    throw new Error(`Missing address: ${label}`);
  }
  return value;
}

async function writeDeployment(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const envChainId = Number(requireEnv("OG_CHAIN_ID"));
if (envChainId !== GALILEO_CHAIN_ID) {
  throw new Error(`This smoke script is Galileo-only. Expected ${GALILEO_CHAIN_ID}, got ${envChainId}`);
}
if ((process.env.OG_NETWORK ?? "testnet") === "mainnet") {
  throw new Error("Mainnet smoke is intentionally blocked by this script");
}
if ((process.env.ENABLE_MOCK_DEX_ADAPTER ?? "false").toLowerCase() !== "true") {
  throw new Error("Galileo smoke requires ENABLE_MOCK_DEX_ADAPTER=true");
}

const { viem } = await network.create();
const publicClient = await viem.getPublicClient();
const chainId = await publicClient.getChainId();
if (chainId !== GALILEO_CHAIN_ID) {
  throw new Error(`RPC chain mismatch: expected ${GALILEO_CHAIN_ID}, got ${chainId}`);
}

const [deployer] = await viem.getWalletClients();
const executorPrivateKey = requireEnv("VAULT_EXECUTOR_PRIVATE_KEY");
const executorAccount = await import("viem/accounts").then(({ privateKeyToAccount }) =>
  privateKeyToAccount(executorPrivateKey as Hex),
);
const executor = createWalletClient({
  account: executorAccount,
  chain: makeChain(GALILEO_CHAIN_ID, "0G Galileo Testnet"),
  transport: http(requireEnv("OG_RPC_URL")),
});
const deployerAddress = requireAddress(deployer.account?.address, "deployer");
const executorAddress = requireAddress(executor.account?.address, "executor");

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeChain(chainId: number, name: string): Chain {
  return {
    id: chainId,
    name,
    nativeCurrency: {
      decimals: 18,
      name: "0G",
      symbol: "0G",
    },
    rpcUrls: {
      default: { http: [requireEnv("OG_RPC_URL")] },
    },
  };
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

async function deployContract(contractName: string, args: readonly unknown[]): Promise<{ address: Address; abi: Abi }> {
  const artifact = await readArtifact(contractName);
  const hash = await deployer.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args,
  });
  const receipt = await waitForTx(hash, `deploy:${contractName}`);
  return { address: requireAddress(receipt.contractAddress, `deployment:${contractName}`), abi: artifact.abi };
}

const deployerBalance = await publicClient.getBalance({ address: deployerAddress });
const executorBalance = await publicClient.getBalance({ address: executorAddress });
if (deployerBalance < parseEther("0.05")) {
  throw new Error("Deployer needs at least 0.05 0G for Galileo smoke");
}
if (executorBalance < parseEther("0.01")) {
  throw new Error("Executor needs at least 0.01 0G for Galileo smoke gas");
}

const policy = {
  perTradeCap0G: (1n << 256n) - 1n,
  dailyCap0G: (1n << 256n) - 1n,
  maxExposure0G: (1n << 256n) - 1n,
  cooldownSeconds: 0n,
  maxDeadlineWindowSeconds: 1800n,
  defaultMinOutBps: 5000,
};

const registry = await deployContract("ProofRegistry", [deployerAddress]);
const token = await deployContract("MockAssetToken", [deployerAddress]);
const adapter = await deployContract("MockDexAdapter", [
  deployerAddress,
  token.address,
  parseEther("2"),
  parseEther("0.5"),
]);
await waitForTx(
  await deployer.writeContract({
    address: token.address,
    abi: token.abi,
    functionName: "setMinter",
    args: [adapter.address],
  }),
  "setMinter",
);
await waitForTx(await deployer.sendTransaction({ to: adapter.address, value: parseEther("0.02") }), "fundAdapter");

const factory = await deployContract("PolicyVaultFactory", []);
const createTx = await deployer.writeContract({
  address: factory.address,
  abi: factory.abi,
  functionName: "createVault",
  args: [deployerAddress, executorAddress, adapter.address, registry.address, policy, [token.address], [POOL_ID], true],
});
const createReceipt = await waitForTx(createTx, "createVault");
const vaultCreatedLog = createReceipt.logs
  .map((log) => {
    try {
      return decodeEventLog({ abi: factory.abi, data: log.data, topics: log.topics });
    } catch {
      return null;
    }
  })
  .find((log) => log?.eventName === "VaultCreated");
if (vaultCreatedLog === undefined || vaultCreatedLog === null || vaultCreatedLog.eventName !== "VaultCreated") {
  throw new Error("VaultCreated event not found");
}
const vaultAddress = (vaultCreatedLog.args as unknown as { vault: Address }).vault;
const vault = { address: vaultAddress, abi: (await readArtifact("PolicyVault")).abi };

const depositTx = await deployer.writeContract({
  address: vault.address,
  abi: vault.abi,
  functionName: "depositNative",
  value: parseEther("0.01"),
});
await waitForTx(depositTx, "deposit");

async function accept(request: { actionHash: Hex; policySnapshotHash: Hex; vaultActionHash: Hex }, label: string) {
  const tx = await deployer.writeContract({
    address: registry.address,
    abi: registry.abi,
    functionName: "acceptProof",
    args: [
      request.actionHash,
      AUDIT_ROOT,
      request.policySnapshotHash,
      MODEL_HASH,
      `0g-storage://redacted-smoke/${label}`,
      request.vaultActionHash,
      "agent-proof-registry:galileo-smoke",
    ],
  });
  await waitForTx(tx, `acceptProof:${label}`);
  return tx;
}

async function deadline() {
  const latest = await publicClient.getBlock({ blockTag: "latest" });
  return latest.timestamp + 600n;
}

function tradeRequest(
  isBuy: boolean,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  amountOutMin: bigint,
  deadlineValue: bigint,
) {
  return buildTradeRequest(isBuy, {
    tokenIn: getAddress(tokenIn),
    tokenOut: getAddress(tokenOut),
    amountIn,
    quotedAmountOut: amountOutMin,
    amountOutMin,
    deadline: deadlineValue,
    nonce: BigInt(Date.now()) + BigInt(Math.floor(Math.random() * 1_000_000)),
    poolId: POOL_ID,
    auditRoot: AUDIT_ROOT,
  });
}

async function buildTradeRequest(
  isBuy: boolean,
  draftInput: {
    tokenIn: Address;
    tokenOut: Address;
    amountIn: bigint;
    quotedAmountOut: bigint;
    amountOutMin: bigint;
    deadline: bigint;
    nonce: bigint;
    poolId: Hex;
    auditRoot: Hex;
  },
) {
  const policySnapshotHash = await publicClient.readContract({
    address: vault.address,
    abi: vault.abi,
    functionName: "policyHash",
  }) as Hex;
  const draft = {
    ...draftInput,
    vaultActionHash: ZERO_HASH,
    actionHash: ZERO_HASH,
    policySnapshotHash,
  };
  const vaultActionHash = await publicClient.readContract({
    address: vault.address,
    abi: vault.abi,
    functionName: "vaultActionHashFor",
    args: [isBuy, draft],
  }) as Hex;
  const actionHash = await publicClient.readContract({
    address: vault.address,
    abi: vault.abi,
    functionName: "actionHashFor",
    args: [vaultActionHash, draft.auditRoot, policySnapshotHash],
  }) as Hex;
  return {
    ...draft,
    vaultActionHash,
    actionHash,
  };
}

const buyRequest = await tradeRequest(
  true,
  ZERO_ADDRESS,
  token.address,
  parseEther("0.005"),
  parseEther("0.005"),
  await deadline(),
);
const buyProofTx = await accept(buyRequest, "buy");
const buyTx = await executor.writeContract({
  address: vault.address,
  abi: vault.abi,
  functionName: "buy",
  args: [buyRequest],
});
await waitForTx(buyTx, "buy");

const sellRequest = await tradeRequest(
  false,
  token.address,
  ZERO_ADDRESS,
  parseEther("0.01"),
  parseEther("0.005"),
  await deadline(),
);
const sellProofTx = await accept(sellRequest, "sell");
const sellTx = await executor.writeContract({
  address: vault.address,
  abi: vault.abi,
  functionName: "sell",
  args: [sellRequest],
});
await waitForTx(sellTx, "sell");

const pauseTx = await deployer.writeContract({
  address: vault.address,
  abi: vault.abi,
  functionName: "setPaused",
  args: [true],
});
await waitForTx(pauseTx, "pause");
const revokeTx = await deployer.writeContract({
  address: vault.address,
  abi: vault.abi,
  functionName: "revokeExecutor",
});
await waitForTx(revokeTx, "revoke");
const balance = await publicClient.getBalance({ address: vault.address });
const withdrawTx = await deployer.writeContract({
  address: vault.address,
  abi: vault.abi,
  functionName: "withdrawNative",
  args: [balance],
});
await waitForTx(withdrawTx, "withdraw");

const output = {
  chainId,
  deployer: deployerAddress,
  executor: executorAddress,
  factory: factory.address,
  vault: vault.address,
  proofRegistry: registry.address,
  mockAsset: token.address,
  mockAdapter: adapter.address,
  tx: {
    createVault: createTx,
    deposit: depositTx,
    buyProof: buyProofTx,
    buy: buyTx,
    sellProof: sellProofTx,
    sell: sellTx,
    pause: pauseTx,
    revoke: revokeTx,
    withdraw: withdrawTx,
  },
};

const outputPath = join(".data", "deployments", "galileo-smoke-policy-vault.json");
await writeDeployment(outputPath, output);
console.log("Galileo vault smoke passed. Redacted deployment artifact:", outputPath);
console.log({
  chainId,
  vault: vault.address,
  proofRegistry: registry.address,
  createVault: createTx,
  deposit: depositTx,
  buy: buyTx,
  sell: sellTx,
  withdraw: withdrawTx,
});
