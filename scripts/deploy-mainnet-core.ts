import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { artifacts, network } from "hardhat";
import { parseEther, type Abi, type Address, type Hex } from "viem";

const MAINNET_CHAIN_ID = 16661;

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

function requireFlag(name: string, expected: boolean) {
  const actual = (process.env[name] ?? "false").toLowerCase() === "true";
  if (actual !== expected) {
    throw new Error(`${name} must be ${String(expected)} for mainnet core deploy`);
  }
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

if ((process.env.OG_NETWORK ?? "").toLowerCase() !== "mainnet") {
  throw new Error("Mainnet core deploy requires OG_NETWORK=mainnet");
}
if (Number(requireEnv("OG_CHAIN_ID")) !== MAINNET_CHAIN_ID) {
  throw new Error(`Mainnet core deploy requires OG_CHAIN_ID=${MAINNET_CHAIN_ID}`);
}
requireEnv("DEPLOYER_PRIVATE_KEY");
requireFlag("ENABLE_MAINNET_DEPLOY", true);
requireFlag("ENABLE_MOCK_DEX_ADAPTER", false);
requireFlag("ENABLE_REAL_DEX_ADAPTER", true);

const { viem } = await network.create();
const publicClient = await viem.getPublicClient();
const chainId = await publicClient.getChainId();
if (chainId !== MAINNET_CHAIN_ID) {
  throw new Error(`RPC chain mismatch: expected ${MAINNET_CHAIN_ID}, got ${chainId}`);
}

const [deployer] = await viem.getWalletClients();
const deployerAddress = requireAddress(deployer.account?.address, "deployer");
const deployerBalance = await publicClient.getBalance({ address: deployerAddress });
if (deployerBalance < parseEther("0.02")) {
  throw new Error("Deployer needs at least 0.02 0G for mainnet core deploy gas");
}

const proofRegistry = await deployContract("ProofRegistry", [deployerAddress]);
const factory = await deployContract("PolicyVaultFactory", []);
const fromBlock = proofRegistry.blockNumber < factory.blockNumber ? proofRegistry.blockNumber : factory.blockNumber;

const output = {
  chainId,
  deployer: deployerAddress,
  factory: factory.address,
  proofRegistry: proofRegistry.address,
  fromBlock: fromBlock.toString(),
  tx: {
    factory: factory.txHash,
    proofRegistry: proofRegistry.txHash,
  },
};

const outputPath = join(".data", "deployments", "mainnet-policy-vault-core.json");
await writeDeployment(outputPath, output);

console.log("0G mainnet Policy Vault core deployed. Redacted deployment artifact:", outputPath);
console.log({
  chainId,
  factory: factory.address,
  proofRegistry: proofRegistry.address,
  fromBlock: fromBlock.toString(),
});
console.log("Set these public env vars after review:");
console.log(`NEXT_PUBLIC_POLICY_VAULT_FACTORY_MAINNET_ADDRESS=${factory.address}`);
console.log(`NEXT_PUBLIC_PROOF_REGISTRY_MAINNET_ADDRESS=${proofRegistry.address}`);
console.log(`NEXT_PUBLIC_POLICY_VAULT_FACTORY_MAINNET_FROM_BLOCK=${fromBlock.toString()}`);
