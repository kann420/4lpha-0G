import { join } from "node:path";

import { artifacts, network } from "hardhat";
import { getAddress, type Abi, type Address, type Hex } from "viem";

import {
  MAINNET_CHAIN_ID,
  requireBytecode,
  requireMainnetEnv,
  waitForTx,
  writeJsonArtifact,
} from "./mainnet-vault-utils";
import { vaultRegistryV4Abi } from "../lib/contracts/policy-vault-v4";

async function loadArtifact(contractName: string): Promise<{ abi: Abi; bytecode: Hex }> {
  const artifact = await artifacts.readArtifact(contractName);
  const bytecode = artifact.bytecode as Hex;
  if (bytecode === "0x") {
    throw new Error(`Missing bytecode for ${contractName}`);
  }
  return { abi: artifact.abi as Abi, bytecode };
}

async function main() {
  requireMainnetEnv("VaultRegistryV4 deploy");

  const { viem } = await network.create();
  const publicClient = await viem.getPublicClient();
  const chainId = await publicClient.getChainId();
  if (chainId !== MAINNET_CHAIN_ID) {
    throw new Error(`RPC chain mismatch: expected ${MAINNET_CHAIN_ID}, got ${chainId}`);
  }
  const [deployerWallet] = await viem.getWalletClients();
  const deployer = deployerWallet.account?.address;
  if (deployer === undefined) {
    throw new Error("Deployer wallet unavailable - set DEPLOYER_PRIVATE_KEY");
  }

  const { abi, bytecode } = await loadArtifact("VaultRegistryV4");
  const txHash = await deployerWallet.deployContract({ abi, bytecode, args: [] });
  const receipt = await waitForTx(publicClient, txHash, "deploy:VaultRegistryV4");
  const registry = receipt.contractAddress;
  if (registry === null || registry === undefined) {
    throw new Error("VaultRegistryV4 deploy receipt missing contractAddress");
  }
  const registryAddress = getAddress(registry);
  await requireBytecode(publicClient, registryAddress, "VaultRegistryV4");

  const [version, deployerTrio] = await Promise.all([
    publicClient.readContract({ address: registryAddress, abi: vaultRegistryV4Abi, functionName: "VERSION" }),
    publicClient.readContract({ address: registryAddress, abi: vaultRegistryV4Abi, functionName: "vaultOf", args: [deployer] }),
  ]);
  if (version !== 4n) {
    throw new Error(`VaultRegistryV4 VERSION mismatch: expected 4, got ${version.toString()}`);
  }
  const [swapVault, lpEntryVault, lpExitVault] = deployerTrio as readonly Address[];
  if (swapVault !== "0x0000000000000000000000000000000000000000" || lpEntryVault !== "0x0000000000000000000000000000000000000000" || lpExitVault !== "0x0000000000000000000000000000000000000000") {
    throw new Error("VaultRegistryV4 vaultOf(deployer) is unexpectedly occupied; trio deployment is owned by the migrate-v4 flow");
  }

  const output = {
    chainId,
    deployer,
    registry: registryAddress,
    fromBlock: receipt.blockNumber.toString(),
    status: "deployed",
    tx: txHash,
  };
  const outputPath = join(".data", "deployments", "mainnet-vault-registry-v4.json");
  await writeJsonArtifact(outputPath, output);

  console.log("0G mainnet VaultRegistryV4 deployed. Redacted artifact:", outputPath);
  console.log({ chainId, deployer, registry: registryAddress, tx: txHash });
  console.log("Verified registry.vaultOf(deployer) is (0x0, 0x0, 0x0). The deployer V4 trio is intentionally not deployed by this script.");
  console.log("Set these env vars after review:");
  console.log(`NEXT_PUBLIC_POLICY_VAULT_V4_REGISTRY_MAINNET_ADDRESS=${registryAddress}`);
  console.log(`NEXT_PUBLIC_VAULT_REGISTRY_V4_MAINNET_FROM_BLOCK=${receipt.blockNumber.toString()}`);
}

main().catch((error) => {
  console.error(`VaultRegistryV4 deploy failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
