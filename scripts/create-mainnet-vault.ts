import { join } from "node:path";

import { decodeEventLog, formatEther, parseEther, type Address } from "viem";
import { curatedMainnetRouteIds, uniqueCuratedMainnetTokens } from "../lib/contracts/curated-routes";
import {
  MOCK_ADAPTER_KIND,
  ROUTE_ADAPTER_KIND,
  ZERO_ADDRESS,
  adapterAbi,
  assertMainnetRpc,
  createMainnetPublicClient,
  createMainnetWalletClient,
  formatPolicy,
  policyVaultAbi,
  policyVaultFactoryAbi,
  proofRegistryAbi,
  readBoolEnv,
  readMainnetVaultConfig,
  readOptionalAddressEnv,
  readPolicyFromEnv,
  requireBytecode,
  requireMainnetEnv,
  runIfDirect,
  sameAddress,
  waitForTx,
  writeJsonArtifact,
} from "./mainnet-vault-utils";

async function main() {
  requireMainnetEnv("mainnet vault creation");

  const publicClient = createMainnetPublicClient();
  const chainId = await assertMainnetRpc(publicClient);
  const { account, walletClient } = createMainnetWalletClient("DEPLOYER_PRIVATE_KEY");
  const owner = account.address;
  const explicitOwner = readOptionalAddressEnv("MAINNET_VAULT_OWNER_ADDRESS");
  if (explicitOwner !== null && !sameAddress(explicitOwner, owner)) {
    throw new Error("MAINNET_VAULT_OWNER_ADDRESS must match DEPLOYER_PRIVATE_KEY because factory.createVault requires msg.sender == owner");
  }

  const config = readMainnetVaultConfig();
  const policy = readPolicyFromEnv();
  const allowedTokens = uniqueCuratedMainnetTokens();
  const allowedPools = curatedMainnetRouteIds();

  await Promise.all([
    requireBytecode(publicClient, config.factory, "PolicyVaultFactory"),
    requireBytecode(publicClient, config.proofRegistry, "ProofRegistry"),
    requireBytecode(publicClient, config.adapter, "Policy Vault adapter"),
  ]);

  const [adapterKind, proofRegistryOwner, existingVault, ownerBalance] = await Promise.all([
    publicClient.readContract({ address: config.adapter, abi: adapterAbi, functionName: "adapterKind" }),
    publicClient.readContract({ address: config.proofRegistry, abi: proofRegistryAbi, functionName: "owner" }),
    publicClient.readContract({
      address: config.factory,
      abi: policyVaultFactoryAbi,
      functionName: "vaultOf",
      args: [owner],
    }),
    publicClient.getBalance({ address: owner }),
  ]);
  if (adapterKind === MOCK_ADAPTER_KIND) {
    throw new Error("Mainnet vault creation cannot use a mock adapter");
  }
  if (adapterKind !== ROUTE_ADAPTER_KIND) {
    throw new Error("Mainnet vault creation expects the curated route adapter");
  }
  if (!sameAddress(proofRegistryOwner, owner)) {
    throw new Error("DEPLOYER_PRIVATE_KEY must control the ProofRegistry owner for the live trade smoke proof step");
  }

  const plan = {
    adapter: config.adapter,
    adapterKind,
    allowedPoolCount: allowedPools.length,
    allowedTokenCount: allowedTokens.length,
    chainId,
    executor: config.executor,
    factory: config.factory,
    owner,
    ownerBalance0G: formatEther(ownerBalance),
    policy: formatPolicy(policy),
    proofRegistry: config.proofRegistry,
  };

  if (existingVault !== ZERO_ADDRESS) {
    const outputPath = join(".data", "deployments", "mainnet-policy-vault-create-plan.json");
    await writeJsonArtifact(outputPath, {
      ...plan,
      status: "already-created",
      vault: existingVault,
    });
    console.log("Mainnet factory already has a vault for this owner. Redacted artifact:", outputPath);
    console.log({
      chainId,
      owner,
      status: "already-created",
      vault: existingVault,
    });
    return;
  }

  if (!readBoolEnv("MAINNET_CREATE_VAULT")) {
    const outputPath = join(".data", "deployments", "mainnet-policy-vault-create-plan.json");
    await writeJsonArtifact(outputPath, {
      ...plan,
      status: "dry-run",
    });
    console.log("Mainnet vault creation dry-run passed. No transaction sent. Redacted artifact:", outputPath);
    console.log({
      allowedPoolCount: allowedPools.length,
      allowedTokenCount: allowedTokens.length,
      chainId,
      owner,
      status: "dry-run",
    });
    console.log("Set MAINNET_CREATE_VAULT=true to send createVault from the owner wallet.");
    return;
  }

  if (ownerBalance < parseEther("0.01")) {
    throw new Error("Owner wallet needs at least 0.01 0G for mainnet vault creation gas");
  }

  const createTx = await walletClient.writeContract({
    address: config.factory,
    abi: policyVaultFactoryAbi,
    functionName: "createVault",
    args: [owner, config.executor, config.adapter, config.proofRegistry, policy, allowedTokens, allowedPools, false],
  });
  const receipt = await waitForTx(publicClient, createTx, "createVault");
  const createdLog = receipt.logs
    .map((log) => {
      try {
        return decodeEventLog({ abi: policyVaultFactoryAbi, data: log.data, topics: log.topics });
      } catch {
        return null;
      }
    })
    .find((log) => log?.eventName === "VaultCreated");
  if (createdLog === null || createdLog === undefined || createdLog.eventName !== "VaultCreated") {
    throw new Error("VaultCreated event was not found in createVault receipt");
  }

  const eventVault = (createdLog.args as { vault: Address }).vault;
  const factoryVault = await publicClient.readContract({
    address: config.factory,
    abi: policyVaultFactoryAbi,
    functionName: "vaultOf",
    args: [owner],
  });
  if (!sameAddress(eventVault, factoryVault)) {
    throw new Error("Created vault event does not match factory.vaultOf(owner)");
  }
  await requireBytecode(publicClient, factoryVault, "Created PolicyVault");

  const [vaultOwner, vaultExecutor, vaultAdapter, vaultProofRegistry, mockAdapterAllowed] = await Promise.all([
    publicClient.readContract({ address: factoryVault, abi: policyVaultAbi, functionName: "owner" }),
    publicClient.readContract({ address: factoryVault, abi: policyVaultAbi, functionName: "executor" }),
    publicClient.readContract({ address: factoryVault, abi: policyVaultAbi, functionName: "adapter" }),
    publicClient.readContract({ address: factoryVault, abi: policyVaultAbi, functionName: "proofRegistry" }),
    publicClient.readContract({ address: factoryVault, abi: policyVaultAbi, functionName: "mockAdapterAllowed" }),
  ]);
  if (
    !sameAddress(vaultOwner, owner) ||
    !sameAddress(vaultExecutor, config.executor) ||
    !sameAddress(vaultAdapter, config.adapter) ||
    !sameAddress(vaultProofRegistry, config.proofRegistry) ||
    mockAdapterAllowed
  ) {
    throw new Error("Created vault configuration did not match the requested mainnet config");
  }

  const output = {
    ...plan,
    blockNumber: receipt.blockNumber.toString(),
    status: "created",
    tx: createTx,
    vault: factoryVault,
  };
  const outputPath = join(".data", "deployments", "mainnet-policy-vault.json");
  await writeJsonArtifact(outputPath, output);

  console.log("0G mainnet PolicyVault created. Redacted artifact:", outputPath);
  console.log({
    chainId,
    createVault: createTx,
    owner,
    vault: factoryVault,
  });
  console.log("Set these env vars after review:");
  console.log(`NEXT_PUBLIC_POLICY_VAULT_MAINNET_ADDRESS=${factoryVault}`);
  console.log(`POLICY_VAULT_ADDRESS=${factoryVault}`);
}

await runIfDirect(import.meta.url, main);

export { main };
