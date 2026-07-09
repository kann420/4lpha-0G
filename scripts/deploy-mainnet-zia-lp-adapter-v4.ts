import { join } from "node:path";

import { artifacts, network } from "hardhat";
import { getAddress, type Abi, type Hex } from "viem";

import { ZIA_LP_MAINNET, zappableZiaLpVaults } from "../lib/contracts/zia-lp";
import {
  MAINNET_CHAIN_ID,
  ZIA_LP_ADAPTER_KIND,
  lpAdapterAbi,
  readBoolEnv,
  requireBytecode,
  requireFlag,
  requireMainnetEnv,
  sameAddress,
  waitForTx,
  writeJsonArtifact,
} from "./mainnet-vault-utils";

async function loadArtifact(contractName: string): Promise<{ abi: Abi; bytecode: Hex }> {
  const artifact = await artifacts.readArtifact(contractName);
  const bytecode = artifact.bytecode as Hex;
  if (bytecode === "0x") {
    throw new Error(`Missing bytecode for ${contractName}`);
  }
  return { abi: artifact.abi as Abi, bytecode };
}

async function main() {
  requireMainnetEnv("ZiaLpAdapterV4 deploy");
  requireFlag("MAINNET_ALLOW_MOCK_LP_ADAPTER", false, "ZiaLpAdapterV4 deploy");

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

  await Promise.all([
    requireBytecode(publicClient, ZIA_LP_MAINNET.nonfungiblePositionManager, "ZiaLpAdapterV4 NFPM"),
    requireBytecode(publicClient, ZIA_LP_MAINNET.swapRouter, "ZiaLpAdapterV4 SWAP_ROUTER"),
    requireBytecode(publicClient, ZIA_LP_MAINNET.wrappedNative, "ZiaLpAdapterV4 W0G"),
    ...zappableZiaLpVaults(ZIA_LP_MAINNET.wrappedNative).flatMap((vault) => [
      requireBytecode(publicClient, vault.poolAddress, `Zia LP pool ${vault.label}`),
      requireBytecode(publicClient, vault.vaultAddress, `Zia stake vault ${vault.label}`),
    ]),
  ]);

  const plan = {
    chainId,
    deployer,
    expectedNfpm: ZIA_LP_MAINNET.nonfungiblePositionManager,
    expectedSwapRouter: ZIA_LP_MAINNET.swapRouter,
    expectedW0G: ZIA_LP_MAINNET.wrappedNative,
  };

  if (!readBoolEnv("MAINNET_DEPLOY_ZIA_LP_ADAPTER_V4")) {
    const outputPath = join(".data", "deployments", "mainnet-zia-lp-adapter-v4-deploy-plan.json");
    await writeJsonArtifact(outputPath, { ...plan, status: "dry-run" });
    console.log("Mainnet ZiaLpAdapterV4 deploy dry-run passed. No transaction sent. Redacted artifact:", outputPath);
    console.log("Set MAINNET_DEPLOY_ZIA_LP_ADAPTER_V4=true to deploy the adapter from the deployer wallet.");
    return;
  }

  const { abi, bytecode } = await loadArtifact("ZiaLpAdapterV4");
  const txHash = await deployerWallet.deployContract({ abi, bytecode, args: [] });
  const receipt = await waitForTx(publicClient, txHash, "deploy:ZiaLpAdapterV4");
  const adapter = receipt.contractAddress;
  if (adapter === null || adapter === undefined) {
    throw new Error("ZiaLpAdapterV4 deploy receipt missing contractAddress");
  }
  const adapterAddress = getAddress(adapter);
  await requireBytecode(publicClient, adapterAddress, "ZiaLpAdapterV4");

  const [kind, nfpmView, w0gView] = await Promise.all([
    publicClient.readContract({ address: adapterAddress, abi: lpAdapterAbi, functionName: "lpAdapterKind" }),
    publicClient.readContract({ address: adapterAddress, abi: lpAdapterAbi, functionName: "nfpm" }),
    publicClient.readContract({ address: adapterAddress, abi: lpAdapterAbi, functionName: "wrappedNative" }),
  ]);
  if (kind !== ZIA_LP_ADAPTER_KIND) {
    throw new Error(`ZiaLpAdapterV4 kind mismatch: expected ${ZIA_LP_ADAPTER_KIND}, got ${kind}`);
  }
  if (!sameAddress(nfpmView, ZIA_LP_MAINNET.nonfungiblePositionManager)) {
    throw new Error(`ZiaLpAdapterV4 nfpm mismatch: expected ${ZIA_LP_MAINNET.nonfungiblePositionManager}, got ${nfpmView}`);
  }
  if (!sameAddress(w0gView, ZIA_LP_MAINNET.wrappedNative)) {
    throw new Error(`ZiaLpAdapterV4 wrappedNative mismatch: expected ${ZIA_LP_MAINNET.wrappedNative}, got ${w0gView}`);
  }

  const output = {
    ...plan,
    adapter: adapterAddress,
    blockNumber: receipt.blockNumber.toString(),
    status: "deployed",
    tx: txHash,
  };
  const outputPath = join(".data", "deployments", "mainnet-zia-lp-adapter-v4.json");
  await writeJsonArtifact(outputPath, output);

  console.log("0G mainnet ZiaLpAdapterV4 deployed. Redacted artifact:", outputPath);
  console.log({ adapter: adapterAddress, chainId, deployer, tx: txHash });
  console.log("Set this env var after review:");
  console.log(`NEXT_PUBLIC_POLICY_VAULT_ZIA_LP_ADAPTER_V4_MAINNET_ADDRESS=${adapterAddress}`);
}

main().catch((error) => {
  console.error(`ZiaLpAdapterV4 deploy failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
