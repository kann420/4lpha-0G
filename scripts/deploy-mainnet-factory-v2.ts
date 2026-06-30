import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { artifacts, network } from "hardhat";
import { isAddress, parseEther, type Abi, type Address, type Hex } from "viem";

const MAINNET_CHAIN_ID = 16661;

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

function readOptionalAddressEnv(name: string): Address | null {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") {
    return null;
  }
  if (!isAddress(value)) {
    throw new Error(`${name} must be a valid EVM address when set`);
  }
  return value as Address;
}

function requireFlag(name: string, expected: boolean) {
  const actual = (process.env[name] ?? "false").toLowerCase() === "true";
  if (actual !== expected) {
    throw new Error(`${name} must be ${String(expected)} for mainnet FactoryV2 deploy`);
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

async function deployContract(
  contractName: string,
  args: readonly unknown[],
): Promise<{ address: Address; abi: Abi; blockNumber: bigint; txHash: Hex }> {
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
  throw new Error("Mainnet FactoryV2 deploy requires OG_NETWORK=mainnet");
}
if (Number(requireEnv("OG_CHAIN_ID")) !== MAINNET_CHAIN_ID) {
  throw new Error(`Mainnet FactoryV2 deploy requires OG_CHAIN_ID=${MAINNET_CHAIN_ID}`);
}
requireEnv("DEPLOYER_PRIVATE_KEY");
requireFlag("ENABLE_MAINNET_DEPLOY", true);

const proofRegistry = readOptionalAddressEnv("NEXT_PUBLIC_PROOF_REGISTRY_MAINNET_ADDRESS");
const previousFactoryV2 = readOptionalAddressEnv("NEXT_PUBLIC_POLICY_VAULT_FACTORY_V2_MAINNET_ADDRESS");

const { viem } = await network.create();
const publicClient = await viem.getPublicClient();
const chainId = await publicClient.getChainId();
if (chainId !== MAINNET_CHAIN_ID) {
  throw new Error(`RPC chain mismatch: expected ${MAINNET_CHAIN_ID}, got ${chainId}`);
}

if (previousFactoryV2 !== null) {
  const code = await publicClient.getCode({ address: previousFactoryV2 });
  if (code !== undefined && code !== "0x") {
    throw new Error("FactoryV2 is already configured and has bytecode. Clear NEXT_PUBLIC_POLICY_VAULT_FACTORY_V2_MAINNET_ADDRESS to redeploy intentionally.");
  }
}

const [deployer] = await viem.getWalletClients();
const deployerAddress = requireAddress(deployer.account?.address, "deployer");
const deployerBalance = await publicClient.getBalance({ address: deployerAddress });
if (deployerBalance < parseEther("0.005")) {
  throw new Error("Deployer needs at least 0.005 0G for mainnet FactoryV2 deploy gas");
}

const factory = await deployContract("PolicyVaultFactoryV2", []);
const fromBlock = factory.blockNumber;
const version = await publicClient.readContract({
  address: factory.address,
  abi: factory.abi,
  functionName: "VERSION",
});
if (version !== 2n) {
  throw new Error(`Unexpected FactoryV2 version: ${String(version)}`);
}

const output = {
  chainId,
  deployer: deployerAddress,
  factory: factory.address,
  fromBlock: fromBlock.toString(),
  proofRegistry,
  tx: factory.txHash,
  blockNumber: factory.blockNumber.toString(),
  version: version.toString(),
};

const outputPath = join(".data", "deployments", "mainnet-policy-vault-factory-v2.json");
await writeDeployment(outputPath, output);

console.log("0G mainnet PolicyVaultFactoryV2 deployed. Redacted deployment artifact:", outputPath);
console.log({
  chainId,
  factory: factory.address,
  fromBlock: fromBlock.toString(),
  proofRegistry,
  version: version.toString(),
});
console.log("Set these public env vars after review:");
console.log(`NEXT_PUBLIC_POLICY_VAULT_FACTORY_V2_MAINNET_ADDRESS=${factory.address}`);
console.log(`NEXT_PUBLIC_POLICY_VAULT_FACTORY_V2_MAINNET_FROM_BLOCK=${fromBlock.toString()}`);
