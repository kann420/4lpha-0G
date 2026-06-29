import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { artifacts, network } from "hardhat";
import { parseEther, zeroAddress, type Abi, type Address, type Hex } from "viem";

const MAINNET_CHAIN_ID = 16661;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function requireFlag(name: string, expected: boolean) {
  const actual = (process.env[name] ?? "false").toLowerCase() === "true";
  if (actual !== expected) {
    throw new Error(`${name} must be ${String(expected)} for Agentic ID deploy`);
  }
}

function requireAddress(value: Address | null | undefined, label: string): Address {
  if (value === undefined || value === null) {
    throw new Error(`Missing address: ${label}`);
  }
  return value;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTx(hash: Hex, label: string) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const receipt = await publicClient.getTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        throw new Error(`${label} transaction reverted: ${hash}`);
      }
      return receipt;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.toLowerCase().includes("receipt") || !message.toLowerCase().includes("not")) {
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

async function writeDeployment(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

if ((process.env.OG_NETWORK ?? "").toLowerCase() !== "mainnet") {
  throw new Error("Agentic ID deploy requires OG_NETWORK=mainnet");
}
if (Number(requireEnv("OG_CHAIN_ID")) !== MAINNET_CHAIN_ID) {
  throw new Error(`Agentic ID deploy requires OG_CHAIN_ID=${MAINNET_CHAIN_ID}`);
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
const balance = await publicClient.getBalance({ address: deployerAddress });
if (balance < parseEther("0.005")) {
  throw new Error("Deployer needs at least 0.005 0G for Agentic ID deploy gas");
}

const artifact = await readArtifact("AgenticID");
const txHash = await deployer.deployContract({
  abi: artifact.abi,
  bytecode: artifact.bytecode,
  args: [deployerAddress, "4lpha 0G Agentic ID", "4OGAI", zeroAddress],
});
const receipt = await waitForTx(txHash, "AgenticID deploy");
const agenticId = requireAddress(receipt.contractAddress, "AgenticID deployment");

const output = {
  agenticId,
  chainId,
  deployer: deployerAddress,
  standard: "ERC-7857",
  txHash,
};
const outputPath = join(".data", "deployments", "mainnet-agentic-id.json");
await writeDeployment(outputPath, output);

console.log("0G mainnet Agentic ID contract deployed. Redacted deployment artifact:", outputPath);
console.log({
  agenticId,
  chainId,
  deployer: deployerAddress,
});
console.log("Set this env var after review:");
console.log(`AGENT_IDENTITY_ADDRESS=${agenticId}`);
