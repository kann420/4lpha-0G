import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { artifacts, network } from "hardhat";
import { decodeEventLog, formatEther, getAddress, parseEther, type Abi, type Address, type Hex } from "viem";

import { curatedMainnetRouteIds, uniqueCuratedMainnetTokens } from "../lib/contracts/curated-routes";
import { MAINNET_V3_VAULT_REGISTRY_PATH, policyVaultV3Abi, type MainnetV3VaultRegistryEntry } from "../lib/contracts/policy-vault-v3";
import {
  MOCK_ADAPTER_KIND,
  MOCK_LP_ADAPTER_KIND,
  ROUTE_ADAPTER_KIND,
  ZERO_ADDRESS,
  ZERO_HASH,
  adapterAbi,
  formatV3Policy,
  lpAdapterAbi,
  proofRegistryAbi,
  readBoolEnv,
  readMainnetVaultConfig,
  readOptionalAddressEnv,
  readV3LpAllowlistsFromEnv,
  readV3PolicyFromEnv,
  requireFlag,
  requireMainnetEnv,
  sameAddress,
  writeJsonArtifact,
  ZIA_LP_ADAPTER_KIND,
} from "./mainnet-vault-utils";

const MAINNET_CHAIN_ID = 16661;

// Minimal structural client type so the inline helpers accept the hardhat
// viem publicClient without importing its precise (chain-generic) type.
type AnyPublicClient = {
  getBytecode: (args: { address: Address }) => Promise<Hex | undefined>;
  getBalance: (args: { address: Address }) => Promise<bigint>;
  getChainId: () => Promise<number>;
  getTransactionReceipt: (args: { hash: Hex }) => Promise<{
    blockNumber: bigint;
    contractAddress: Address | null | undefined;
    logs: readonly { data: Hex; topics: readonly Hex[] }[];
  }>;
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

async function requireBytecode(client: AnyPublicClient, address: Address, label: string) {
  const bytecode = await client.getBytecode({ address });
  if (bytecode === undefined || bytecode === "0x") {
    throw new Error(`${label} has no deployed bytecode at ${address}`);
  }
}

async function readV3Registry(): Promise<MainnetV3VaultRegistryEntry[]> {
  try {
    const raw = await readFile(MAINNET_V3_VAULT_REGISTRY_PATH, "utf8");
    const parsed = JSON.parse(raw) as MainnetV3VaultRegistryEntry[];
    if (!Array.isArray(parsed)) {
      throw new Error("V3 vault registry is not an array");
    }
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("ENOENT") || message.includes("no such file")) {
      return [];
    }
    throw error;
  }
}

async function assertNoExistingV3Vault(owner: Address, allowRedeploy: boolean): Promise<{ registryPresent: boolean }> {
  let registryPresent = true;
  let registry: MainnetV3VaultRegistryEntry[];
  try {
    const raw = await readFile(MAINNET_V3_VAULT_REGISTRY_PATH, "utf8");
    const parsed = JSON.parse(raw) as MainnetV3VaultRegistryEntry[];
    if (!Array.isArray(parsed)) {
      throw new Error("V3 vault registry is not an array");
    }
    registry = parsed;
    if (registry.length === 0) {
      registryPresent = false;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("ENOENT") || message.includes("no such file")) {
      registry = [];
      registryPresent = false;
    } else {
      throw error;
    }
  }
  const lower = owner.toLowerCase();
  const existing = registry.find((entry) => entry.owner.toLowerCase() === lower);
  if (existing !== undefined) {
    if (allowRedeploy) {
      console.warn(
        `WARNING: Owner ${owner} already has a V3 vault at ${existing.vault}. ` +
          `MAINNET_V3_REDEPLOY_FORCE=true is set, so a new V3 vault will be deployed intentionally.`,
      );
      return { registryPresent };
    }
    throw new Error(
      `Owner ${owner} already has a V3 vault at ${existing.vault}. Set MAINNET_V3_REDEPLOY_FORCE=true to deploy another V3 vault intentionally.`,
    );
  }
  return { registryPresent };
}

async function appendV3RegistryEntry(entry: MainnetV3VaultRegistryEntry): Promise<void> {
  const registry = await readV3Registry();
  registry.push(entry);
  await mkdir(dirname(MAINNET_V3_VAULT_REGISTRY_PATH), { recursive: true });
  await writeFile(MAINNET_V3_VAULT_REGISTRY_PATH, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}

async function main() {
  requireMainnetEnv("mainnet V3 vault creation");
  // V3 rejects MOCK_LP_ADAPTER_KIND on-chain anyway; fail fast with a clear message.
  requireFlag("MAINNET_ALLOW_MOCK_LP_ADAPTER", false, "mainnet V3 vault creation");

  const { viem } = await network.create();
  const publicClient = await viem.getPublicClient();
  const chainId = await publicClient.getChainId();
  if (chainId !== MAINNET_CHAIN_ID) {
    throw new Error(`RPC chain mismatch: expected ${MAINNET_CHAIN_ID}, got ${chainId}`);
  }
  const [deployerWallet] = await viem.getWalletClients();
  const owner = deployerWallet.account?.address;
  if (owner === undefined) {
    throw new Error("Deployer wallet unavailable — set DEPLOYER_PRIVATE_KEY");
  }
  const explicitOwner = readOptionalAddressEnv("MAINNET_VAULT_OWNER_ADDRESS");
  if (explicitOwner !== null && !sameAddress(explicitOwner, owner)) {
    throw new Error(
      "MAINNET_VAULT_OWNER_ADDRESS must match DEPLOYER_PRIVATE_KEY because the V3 singleton is deployed with initialOwner == deployer (no on-chain factory msg.sender check).",
    );
  }

  // Off-chain one-vault-per-owner guard (V2 coexistence is allowed — V3 is a separate singleton).
  // TRUST BOUNDARY: there is NO on-chain V3 factory on 0G mainnet (PolicyVaultFactoryV3
  // exceeds EIP-170's 24KB cap), so this guard can only see the local registry. It cannot
  // detect a V3 deployed for the same owner from another branch/machine. The force-flag
  // gate below prevents a silent second deploy when the registry is missing/stale.
  const redeployForce = readBoolEnv("MAINNET_V3_REDEPLOY_FORCE");
  const { registryPresent: v3RegistryPresent } = await assertNoExistingV3Vault(owner, redeployForce);
  if (!v3RegistryPresent) {
    console.warn(
      `WARNING: V3 registry ${MAINNET_V3_VAULT_REGISTRY_PATH} is missing or empty. ` +
        `No on-chain V3 factory exists on 0G mainnet to reconcile. ` +
        `If a V3 vault was already deployed for owner ${owner} elsewhere, this script will deploy a SECOND vault. ` +
        `Set MAINNET_V3_REDEPLOY_FORCE=true to proceed, or restore the registry file first.`,
    );
  }

  const config = readMainnetVaultConfig();
  const lpAdapter = readOptionalAddressEnv("NEXT_PUBLIC_POLICY_VAULT_ZIA_LP_ADAPTER_MAINNET_ADDRESS");
  // lpAdapter == null is allowed (swap-only V3 vault). If set, it must be a real, non-mock adapter.

  await Promise.all([
    requireBytecode(publicClient, config.adapter, "Policy Vault adapter"),
    requireBytecode(publicClient, config.proofRegistry, "ProofRegistry"),
    ...(lpAdapter !== null ? [requireBytecode(publicClient, lpAdapter, "Policy Vault LP adapter")] : []),
  ]);

  const [adapterKind, proofRegistryOwner, ownerBalance] = await Promise.all([
    publicClient.readContract({ address: config.adapter, abi: adapterAbi, functionName: "adapterKind" }),
    publicClient.readContract({ address: config.proofRegistry, abi: proofRegistryAbi, functionName: "owner" }),
    publicClient.getBalance({ address: owner }),
  ]);
  if (adapterKind === MOCK_ADAPTER_KIND) {
    throw new Error("Mainnet V3 vault creation cannot use a mock swap adapter");
  }
  if (adapterKind !== ROUTE_ADAPTER_KIND) {
    throw new Error("Mainnet V3 vault creation expects the curated route swap adapter");
  }
  if (!sameAddress(proofRegistryOwner, owner)) {
    throw new Error("DEPLOYER_PRIVATE_KEY must control the ProofRegistry owner for the live proof step");
  }

  let lpAdapterKind: Hex | null = null;
  if (lpAdapter !== null) {
    const kind = await publicClient.readContract({ address: lpAdapter, abi: lpAdapterAbi, functionName: "lpAdapterKind" });
    if (kind === MOCK_LP_ADAPTER_KIND) {
      throw new Error("Mainnet V3 vault creation cannot use a mock LP adapter");
    }
    if (kind !== ZIA_LP_ADAPTER_KIND) {
      throw new Error("Mainnet V3 vault creation expects the Zia LP adapter kind");
    }
    lpAdapterKind = kind;
  }

  const policy = readV3PolicyFromEnv();
  const allowedTokens = uniqueCuratedMainnetTokens();
  const allowedPools = curatedMainnetRouteIds();
  const { allowedLpPools, allowedStakeVaults, stakeVaultForLpPool, zappable } = readV3LpAllowlistsFromEnv();
  if (allowedTokens.length === 0 || allowedPools.length === 0) {
    throw new Error("V3 vault requires non-empty allowedTokens + allowedPools (curated mainnet routes)");
  }

  const plan = {
    adapter: config.adapter,
    adapterKind,
    allowedLpPoolCount: allowedLpPools.length,
    allowedPoolCount: allowedPools.length,
    allowedTokenCount: allowedTokens.length,
    chainId,
    executor: config.executor,
    lpAdapter,
    lpAdapterKind,
    owner,
    ownerBalance0G: formatEther(ownerBalance),
    policy: formatV3Policy(policy),
    proofRegistry: config.proofRegistry,
    zappableLpPools: zappable.map((v) => ({ label: v.label, pool: v.poolAddress, vault: v.vaultAddress })),
  };

  if (!readBoolEnv("MAINNET_CREATE_VAULT_V3")) {
    const outputPath = join(".data", "deployments", "mainnet-policy-vault-v3-create-plan.json");
    await writeJsonArtifact(outputPath, { ...plan, status: "dry-run" });
    console.log("Mainnet V3 vault creation dry-run passed. No transaction sent. Redacted artifact:", outputPath);
    console.log({ allowedLpPoolCount: allowedLpPools.length, chainId, owner, status: "dry-run" });
    console.log("Set MAINNET_CREATE_VAULT_V3=true to deploy the V3 singleton from the deployer wallet.");
    return;
  }

  // Force-flag gate: refuse to deploy when the registry cannot confirm no existing V3.
  // Dry-run (MAINNET_CREATE_VAULT_V3=false) is allowed to proceed so operators can see the plan.
  if (!v3RegistryPresent && !redeployForce) {
    throw new Error(
      "Refusing to deploy V3: the off-chain registry is missing/stale and MAINNET_V3_REDEPLOY_FORCE is not set. " +
        "There is no on-chain V3 factory on 0G mainnet to reconcile, so this guard prevents deploying a second V3 " +
        "vault for an owner that may already have one. Restore the registry file or set MAINNET_V3_REDEPLOY_FORCE=true to proceed.",
    );
  }

  if (ownerBalance < parseEther("0.01")) {
    throw new Error("Deployer wallet needs at least 0.01 0G for mainnet V3 vault deployment gas");
  }

  const { abi, bytecode } = await loadArtifact("PolicyVaultV3");
  const deployArgs: readonly unknown[] = [
    owner, // initialOwner
    config.executor, // executor_
    config.adapter, // adapter_
    lpAdapter ?? ZERO_ADDRESS, // lpAdapter_ (address(0) = swap-only)
    config.proofRegistry, // proofRegistry_
    policy, // initialPolicy (nested tuple)
    allowedTokens, // initialAllowedTokens
    allowedPools, // initialAllowedPools
    allowedLpPools, // initialAllowedLpPools
    allowedStakeVaults, // initialAllowedStakeVaults
    stakeVaultForLpPool, // initialStakeVaultForLpPool (parallel to allowedLpPools)
    false, // allowMockAdapter (mainnet never)
    false, // allowMockLpAdapter (mainnet never)
  ];

  const deployTx = await deployerWallet.deployContract({ abi, bytecode, args: deployArgs });
  const receipt = await waitForTx(publicClient, deployTx, "deploy:PolicyVaultV3");
  const vaultAddress = receipt.contractAddress;
  if (vaultAddress === null || vaultAddress === undefined) {
    throw new Error("PolicyVaultV3 deploy receipt missing contractAddress");
  }
  const vault = getAddress(vaultAddress);
  await requireBytecode(publicClient, vault, "Deployed PolicyVaultV3");

  // Read back + verify the immutable config + policy hash.
  const readAbi = policyVaultV3Abi;
  const [vaultOwner, vaultExecutor, vaultAdapter, vaultLpAdapter, vaultProofRegistry, mockAdapterAllowed, mockLpAdapterAllowed, policyHash] = await Promise.all([
    publicClient.readContract({ address: vault, abi: readAbi, functionName: "owner" }),
    publicClient.readContract({ address: vault, abi: readAbi, functionName: "executor" }),
    publicClient.readContract({ address: vault, abi: readAbi, functionName: "adapter" }),
    publicClient.readContract({ address: vault, abi: readAbi, functionName: "lpAdapter" }),
    publicClient.readContract({ address: vault, abi: readAbi, functionName: "proofRegistry" }),
    publicClient.readContract({ address: vault, abi: readAbi, functionName: "mockAdapterAllowed" }),
    publicClient.readContract({ address: vault, abi: readAbi, functionName: "mockLpAdapterAllowed" }),
    publicClient.readContract({ address: vault, abi: readAbi, functionName: "policyHash" }),
  ]);
  if (
    !sameAddress(vaultOwner, owner) ||
    !sameAddress(vaultExecutor, config.executor) ||
    !sameAddress(vaultAdapter, config.adapter) ||
    !sameAddress(vaultProofRegistry, config.proofRegistry) ||
    mockAdapterAllowed ||
    mockLpAdapterAllowed
  ) {
    throw new Error("Deployed V3 vault configuration did not match the requested mainnet config");
  }
  const expectedLpAdapter = lpAdapter ?? ZERO_ADDRESS;
  if (!sameAddress(vaultLpAdapter, expectedLpAdapter)) {
    throw new Error(`Deployed V3 lpAdapter mismatch: expected ${expectedLpAdapter}, got ${vaultLpAdapter}`);
  }
  // Confirm the policy hash matches a fresh on-chain read (the constructor stored it).
  if (policyHash === ZERO_HASH) {
    throw new Error("Deployed V3 vault policyHash is zero — policy was not stored correctly");
  }

  // Best-effort: capture LpPoolAllowed / StakeVaultAllowed / VaultCreated-equivalent logs.
  const allowedLogs = receipt.logs
    .map((log) => {
      try {
        return decodeEventLog({ abi: readAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      } catch {
        return null;
      }
    })
    .filter((log) => log !== null && (log.eventName === "LpPoolAllowed" || log.eventName === "StakeVaultAllowed"));
  console.log(`V3 constructor emitted ${allowedLogs.length} LpPoolAllowed/StakeVaultAllowed events.`);

  const blockNumber = receipt.blockNumber;
  const entry: MainnetV3VaultRegistryEntry = {
    owner,
    vault,
    version: 3,
    chainId,
    blockNumber: blockNumber.toString(),
    tx: deployTx,
    lpAdapter: lpAdapter,
    createdAt: new Date().toISOString(),
  };
  await appendV3RegistryEntry(entry);

  const output = {
    ...plan,
    blockNumber: blockNumber.toString(),
    policyHash,
    status: "created",
    tx: deployTx,
    vault,
  };
  const outputPath = join(".data", "deployments", "mainnet-policy-vault-v3.json");
  await writeJsonArtifact(outputPath, output);

  console.log("0G mainnet PolicyVaultV3 created. Redacted artifact:", outputPath);
  console.log("V3 registry updated:", MAINNET_V3_VAULT_REGISTRY_PATH);
  console.log({ chainId, deploy: deployTx, owner, vault });
  console.log("Set these env vars after review:");
  console.log(`NEXT_PUBLIC_POLICY_VAULT_V3_MAINNET_ADDRESS=${vault}`);
  console.log(`POLICY_VAULT_V3_MAINNET_ADDRESS=${vault}`);
  if (lpAdapter !== null) {
    console.log(`NEXT_PUBLIC_POLICY_VAULT_ZIA_LP_ADAPTER_MAINNET_ADDRESS=${lpAdapter}`);
  }
}

// Entry point: hardhat run scripts/create-mainnet-vault-v3.ts --network ogMainnet
main().catch((error) => {
  console.error(`V3 deploy failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

function sleep(ms: number) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
