import { join } from "node:path";

import { formatEther, type Address } from "viem";
import { curatedMainnetRouteIds, uniqueCuratedMainnetTokens } from "../lib/contracts/curated-routes";
import {
  MAINNET_CHAIN_ID,
  MOCK_ADAPTER_KIND,
  ROUTE_ADAPTER_KIND,
  ZERO_ADDRESS,
  adapterAbi,
  assertMainnetRpc,
  createMainnetPublicClient,
  formatPolicy,
  normalizePolicy,
  policyVaultAbi,
  readConfiguredVaultAddress,
  readFactoryVault,
  readMainnetVaultConfig,
  readOptionalAddressEnv,
  readOptionalPrivateKeyOwner,
  requireBytecode,
  requireMainnetEnv,
  runIfDirect,
  sameAddress,
  writeJsonArtifact,
  type PolicyVaultPolicy,
} from "./mainnet-vault-utils";

async function main() {
  requireMainnetEnv("mainnet vault discovery");

  const publicClient = createMainnetPublicClient();
  const chainId = await assertMainnetRpc(publicClient);
  const config = readMainnetVaultConfig();

  await Promise.all([
    requireBytecode(publicClient, config.factory, "PolicyVaultFactory"),
    requireBytecode(publicClient, config.proofRegistry, "ProofRegistry"),
    requireBytecode(publicClient, config.adapter, "Policy Vault adapter"),
  ]);

  const adapterKind = await publicClient.readContract({
    address: config.adapter,
    abi: adapterAbi,
    functionName: "adapterKind",
  });
  if (adapterKind === MOCK_ADAPTER_KIND) {
    throw new Error("Mainnet discovery found a mock adapter kind");
  }
  if (adapterKind !== ROUTE_ADAPTER_KIND) {
    throw new Error("Mainnet discovery expects the curated route adapter for live trading");
  }

  const configuredVault = readConfiguredVaultAddress();
  const explicitOwner = readOptionalAddressEnv("MAINNET_VAULT_OWNER_ADDRESS") ?? readOptionalPrivateKeyOwner();
  let owner = explicitOwner;
  let factoryVault: Address = ZERO_ADDRESS;
  let vault: Address = configuredVault ?? ZERO_ADDRESS;

  if (owner !== null) {
    factoryVault = await readFactoryVault(publicClient, config.factory, owner);
    if (configuredVault !== null && factoryVault !== ZERO_ADDRESS && !sameAddress(configuredVault, factoryVault)) {
      throw new Error("Configured mainnet vault address does not match factory.vaultOf(owner)");
    }
    vault = configuredVault ?? factoryVault;
  } else if (configuredVault !== null) {
    await requireBytecode(publicClient, configuredVault, "Configured PolicyVault");
    owner = await publicClient.readContract({
      address: configuredVault,
      abi: policyVaultAbi,
      functionName: "owner",
    });
    factoryVault = await readFactoryVault(publicClient, config.factory, owner);
    if (!sameAddress(configuredVault, factoryVault)) {
      throw new Error("Configured mainnet vault is not the factory vault for its owner");
    }
  } else {
    throw new Error("Set MAINNET_VAULT_OWNER_ADDRESS, DEPLOYER_PRIVATE_KEY, or NEXT_PUBLIC_POLICY_VAULT_MAINNET_ADDRESS for discovery");
  }
  if (owner === null) {
    throw new Error("Unable to resolve mainnet vault owner");
  }

  if (vault === ZERO_ADDRESS) {
    const output = {
      chainId,
      factory: config.factory,
      owner,
      status: "missing",
    };
    const outputPath = join(".data", "deployments", "mainnet-policy-vault-discovery.json");
    await writeJsonArtifact(outputPath, output);
    console.log("No mainnet PolicyVault found for owner. Redacted discovery artifact:", outputPath);
    console.log({
      chainId,
      factory: config.factory,
      owner,
      vault,
    });
    return;
  }

  await requireBytecode(publicClient, vault, "PolicyVault");

  const [
    vaultOwner,
    vaultExecutor,
    vaultAdapter,
    vaultProofRegistry,
    mockAdapterAllowed,
    paused,
    executorRevoked,
    policyRaw,
    nativeBalance,
    dailySpent0G,
    dailyWindowStart,
    lastTradeAt,
    openExposure0G,
  ] = await Promise.all([
    publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "owner" }),
    publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "executor" }),
    publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "adapter" }),
    publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "proofRegistry" }),
    publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "mockAdapterAllowed" }),
    publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "paused" }),
    publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "executorRevoked" }),
    publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "policy" }),
    publicClient.getBalance({ address: vault }),
    publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "dailySpent0G" }),
    publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "dailyWindowStart" }),
    publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "lastTradeAt" }),
    publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "openExposure0G" }),
  ]);
  const policy = normalizePolicy(policyRaw);

  if (!sameAddress(vaultOwner, owner)) {
    throw new Error("Resolved vault owner does not match the requested owner");
  }
  if (!sameAddress(vaultExecutor, config.executor)) {
    throw new Error("Resolved vault executor does not match NEXT_PUBLIC_VAULT_EXECUTOR_MAINNET_ADDRESS");
  }
  if (!sameAddress(vaultAdapter, config.adapter)) {
    throw new Error("Resolved vault adapter does not match NEXT_PUBLIC_POLICY_VAULT_ADAPTER_MAINNET_ADDRESS");
  }
  if (!sameAddress(vaultProofRegistry, config.proofRegistry)) {
    throw new Error("Resolved vault proof registry does not match NEXT_PUBLIC_PROOF_REGISTRY_MAINNET_ADDRESS");
  }
  if (mockAdapterAllowed) {
    throw new Error("Mainnet vault must not allow a mock adapter");
  }

  const tokenReports = await Promise.all(
    uniqueCuratedMainnetTokens().map(async (token) => ({
      allowed: await publicClient.readContract({
        address: vault,
        abi: policyVaultAbi,
        functionName: "allowedTokens",
        args: [token],
      }),
      token,
    })),
  );
  const poolReports = await Promise.all(
    curatedMainnetRouteIds().map(async (routeId) => ({
      allowed: await publicClient.readContract({
        address: vault,
        abi: policyVaultAbi,
        functionName: "allowedPools",
        args: [routeId],
      }),
      routeId,
    })),
  );
  const disallowedTokens = tokenReports.filter((report) => !report.allowed);
  const disallowedPools = poolReports.filter((report) => !report.allowed);
  if (disallowedTokens.length > 0 || disallowedPools.length > 0) {
    throw new Error("Resolved vault does not allow the full curated mainnet route set");
  }

  const output = {
    adapter: vaultAdapter,
    adapterKind,
    chainId,
    executor: vaultExecutor,
    executorRevoked,
    factory: config.factory,
    factoryVault,
    liveTradingReady: !paused && !executorRevoked && nativeBalance > 0n,
    mockAdapterAllowed,
    nativeBalance0G: formatEther(nativeBalance),
    owner: vaultOwner,
    policy: formatPolicy(policy as PolicyVaultPolicy),
    proofRegistry: vaultProofRegistry,
    routeCount: poolReports.length,
    state: {
      dailySpent0G: formatEther(dailySpent0G),
      dailyWindowStart: dailyWindowStart.toString(),
      lastTradeAt: lastTradeAt.toString(),
      openExposure0G: formatEther(openExposure0G),
      paused,
    },
    tokenCount: tokenReports.length,
    vault,
  };
  const outputPath = join(".data", "deployments", "mainnet-policy-vault-discovery.json");
  await writeJsonArtifact(outputPath, output);

  console.log("0G mainnet PolicyVault discovery passed. Redacted artifact:", outputPath);
  console.log({
    chainId: MAINNET_CHAIN_ID,
    executorRevoked,
    factory: config.factory,
    liveTradingReady: output.liveTradingReady,
    nativeBalance0G: output.nativeBalance0G,
    owner: vaultOwner,
    paused,
    routeCount: output.routeCount,
    tokenCount: output.tokenCount,
    vault,
  });
}

await runIfDirect(import.meta.url, main);

export { main };
