import { join } from "node:path";

import { artifacts, network } from "hardhat";
import { formatEther, getAddress, type Abi, type Address, type Hex } from "viem";

import { ZIA_LP_MAINNET, zappableZiaLpVaults } from "../lib/contracts/zia-lp";
import {
  MOCK_LP_ADAPTER_KIND,
  ZIA_LP_ADAPTER_KIND,
  lpAdapterAbi,
  readBoolEnv,
  readOptionalAddressEnv,
  requireFlag,
  requireMainnetEnv,
  sameAddress,
  writeJsonArtifact,
} from "./mainnet-vault-utils";

// ZiaLpAdapter hardcodes its 0G mainnet targets as immutable constants (NFPM,
// SWAP_ROUTER, W0G). It has NO constructor arguments. We verify the chain agrees
// those constants have real bytecode before deploying, so the adapter is never
// wired to empty addresses (which would brick it and any V3 vault bound to it).

const MAINNET_CHAIN_ID = 16661;

// Mirror the constants in contracts/ZiaLpAdapter.sol. The deploy readback asserts
// these match the on-chain views, so a drift between script and contract is caught.
const EXPECTED_NFPM = ZIA_LP_MAINNET.nonfungiblePositionManager;
const EXPECTED_SWAP_ROUTER = ZIA_LP_MAINNET.swapRouter;
const EXPECTED_W0G = ZIA_LP_MAINNET.wrappedNative;

type AnyPublicClient = {
  getBytecode: (args: { address: Address }) => Promise<Hex | undefined>;
  getBalance: (args: { address: Address }) => Promise<bigint>;
  getChainId: () => Promise<number>;
  getTransactionReceipt: (args: { hash: Hex }) => Promise<{ blockNumber: bigint; contractAddress: Address | null | undefined }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readContract: (args: any) => Promise<any>;
};

async function loadArtifact(contractName: string): Promise<{ abi: Abi; bytecode: Hex }> {
  const artifact = await artifacts.readArtifact(contractName);
  const bytecode = artifact.bytecode as Hex;
  if (bytecode === "0x") {
    throw new Error(`Missing bytecode for ${contractName}`);
  }
  return { abi: artifact.abi as Abi, bytecode };
}

async function waitForTx(client: AnyPublicClient, hash: Hex, label: string) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      return await client.getTransactionReceipt({ hash });
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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requireBytecode(client: AnyPublicClient, address: Address, label: string) {
  const bytecode = await client.getBytecode({ address });
  if (bytecode === undefined || bytecode === "0x") {
    throw new Error(`${label} has no deployed bytecode at ${address}`);
  }
}

async function main() {
  requireMainnetEnv("mainnet Zia LP adapter deploy");
  // V3 vault construction rejects MOCK_LP_ADAPTER_KIND on-chain; fail fast here too.
  requireFlag("MAINNET_ALLOW_MOCK_LP_ADAPTER", false, "mainnet Zia LP adapter deploy");

  const { viem } = await network.create();
  const publicClient = await viem.getPublicClient();
  const chainId = await publicClient.getChainId();
  if (chainId !== MAINNET_CHAIN_ID) {
    throw new Error(`RPC chain mismatch: expected ${MAINNET_CHAIN_ID}, got ${chainId}`);
  }
  const [deployerWallet] = await viem.getWalletClients();
  const deployer = deployerWallet.account?.address;
  if (deployer === undefined) {
    throw new Error("Deployer wallet unavailable — set DEPLOYER_PRIVATE_KEY");
  }

  // Verify the adapter's hardcoded 0G mainnet targets actually have bytecode. If any
  // is empty, the deployed adapter would be permanently bricked (constants are immutable).
  await Promise.all([
    requireBytecode(publicClient, EXPECTED_NFPM, "ZiaLpAdapter NFPM"),
    requireBytecode(publicClient, EXPECTED_SWAP_ROUTER, "ZiaLpAdapter SWAP_ROUTER"),
    requireBytecode(publicClient, EXPECTED_W0G, "ZiaLpAdapter W0G"),
  ]);

  // Verify every zappable Zia stake vault + pool has bytecode. The V3 constructor seeds
  // these as allowedStakeVaults / allowedLpPools, so they must be live contracts.
  const zappable = zappableZiaLpVaults(EXPECTED_W0G);
  if (zappable.length === 0) {
    throw new Error("No zappable Zia LP vaults (W0G-leg) found — zia-lp.ts config is empty");
  }
  await Promise.all(
    zappable.flatMap((v) => [
      requireBytecode(publicClient, v.poolAddress, `Zia LP pool ${v.label}`),
      requireBytecode(publicClient, v.vaultAddress, `Zia stake vault ${v.label}`),
    ]),
  );

  const existingAdapter = readOptionalAddressEnv("NEXT_PUBLIC_POLICY_VAULT_ZIA_LP_ADAPTER_MAINNET_ADDRESS");
  if (existingAdapter !== null) {
    const existingCode = await publicClient.getBytecode({ address: existingAdapter });
    if (existingCode !== undefined && existingCode !== "0x" && !readBoolEnv("MAINNET_ZIA_LP_ADAPTER_REDEPLOY_FORCE")) {
      throw new Error(
        `NEXT_PUBLIC_POLICY_VAULT_ZIA_LP_ADAPTER_MAINNET_ADDRESS already set to ${existingAdapter} with live bytecode. ` +
          `Set MAINNET_ZIA_LP_ADAPTER_REDEPLOY_FORCE=true to deploy a second adapter intentionally.`,
      );
    }
  }

  const deployerBalance = await publicClient.getBalance({ address: deployer });
  if (deployerBalance < parseEtherSafe("0.005")) {
    throw new Error("Deployer wallet needs at least 0.005 0G for ZiaLpAdapter deployment gas");
  }

  const plan = {
    chainId,
    deployer,
    deployerBalance0G: formatEther(deployerBalance),
    expectedNfpm: EXPECTED_NFPM,
    expectedSwapRouter: EXPECTED_SWAP_ROUTER,
    expectedW0G: EXPECTED_W0G,
    zappableLpVaults: zappable.map((v) => ({ label: v.label, pool: v.poolAddress, vault: v.vaultAddress })),
  };

  if (!readBoolEnv("MAINNET_DEPLOY_ZIA_LP_ADAPTER")) {
    const outputPath = join(".data", "deployments", "mainnet-zia-lp-adapter-deploy-plan.json");
    await writeJsonArtifact(outputPath, { ...plan, status: "dry-run" });
    console.log("Mainnet ZiaLpAdapter deploy dry-run passed. No transaction sent. Redacted artifact:", outputPath);
    console.log({ chainId, deployer, zappableCount: zappable.length, status: "dry-run" });
    console.log("Set MAINNET_DEPLOY_ZIA_LP_ADAPTER=true to deploy the adapter from the deployer wallet.");
    return;
  }

  const { abi, bytecode } = await loadArtifact("ZiaLpAdapter");
  // No constructor args — NFPM/SWAP_ROUTER/W0G are immutable constants in the contract.
  const deployTx = await deployerWallet.deployContract({ abi, bytecode, args: [] });
  const receipt = await waitForTx(publicClient, deployTx, "deploy:ZiaLpAdapter");
  const adapterAddress = receipt.contractAddress;
  if (adapterAddress === null || adapterAddress === undefined) {
    throw new Error("ZiaLpAdapter deploy receipt missing contractAddress");
  }
  const adapter = getAddress(adapterAddress);
  await requireBytecode(publicClient, adapter, "Deployed ZiaLpAdapter");

  // Read back the identity views and assert they match the constants the contract claims.
  const [kind, nfpmView, w0gView] = await Promise.all([
    publicClient.readContract({ address: adapter, abi: lpAdapterAbi, functionName: "lpAdapterKind" }),
    publicClient.readContract({ address: adapter, abi: lpAdapterAbi, functionName: "nfpm" }),
    publicClient.readContract({ address: adapter, abi: lpAdapterAbi, functionName: "wrappedNative" }),
  ]);
  if (kind === MOCK_LP_ADAPTER_KIND) {
    throw new Error("Deployed ZiaLpAdapter reports MOCK_LP_ADAPTER_KIND — mainnet refuses mock LP adapters");
  }
  if (kind !== ZIA_LP_ADAPTER_KIND) {
    throw new Error(`Deployed ZiaLpAdapter kind mismatch: expected ${ZIA_LP_ADAPTER_KIND}, got ${kind}`);
  }
  if (!sameAddress(nfpmView, EXPECTED_NFPM)) {
    throw new Error(`Deployed ZiaLpAdapter nfpm mismatch: expected ${EXPECTED_NFPM}, got ${nfpmView}`);
  }
  if (!sameAddress(w0gView, EXPECTED_W0G)) {
    throw new Error(`Deployed ZiaLpAdapter wrappedNative mismatch: expected ${EXPECTED_W0G}, got ${w0gView}`);
  }

  const output = {
    ...plan,
    adapter,
    blockNumber: receipt.blockNumber.toString(),
    status: "deployed",
    tx: deployTx,
  };
  const outputPath = join(".data", "deployments", "mainnet-zia-lp-adapter.json");
  await writeJsonArtifact(outputPath, output);

  console.log("0G mainnet ZiaLpAdapter deployed. Redacted artifact:", outputPath);
  console.log({ adapter, chainId, deploy: deployTx, deployer });
  console.log("Set these env vars after review:");
  console.log(`NEXT_PUBLIC_POLICY_VAULT_ZIA_LP_ADAPTER_MAINNET_ADDRESS=${adapter}`);
  console.log(`POLICY_VAULT_ZIA_LP_ADAPTER_MAINNET_ADDRESS=${adapter}`);
}

function parseEtherSafe(value: string): bigint {
  // Local parse to avoid importing viem parseEther just for the balance floor check.
  const [whole, frac = ""] = value.split(".");
  if (frac.length > 18) {
    throw new Error(`parseEtherSafe: too many fractional digits in ${value}`);
  }
  return BigInt((whole + frac.padEnd(18, "0")).replace(/^0+(?=\d)/, "") || "0");
}

// Entry point: hardhat run scripts/deploy-mainnet-zia-lp-adapter.ts --network ogMainnet
main().catch((error) => {
  console.error(`ZiaLpAdapter deploy failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});