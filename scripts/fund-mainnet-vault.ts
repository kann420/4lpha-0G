import { join } from "node:path";

import { formatEther, parseEther } from "viem";
import {
  ZERO_ADDRESS,
  assertMainnetRpc,
  createMainnetPublicClient,
  createMainnetWalletClient,
  policyVaultAbi,
  readBoolEnv,
  readConfiguredVaultAddress,
  readFactoryVault,
  readOptional0GAmountEnv,
  requireBytecode,
  requireMainnetEnv,
  runIfDirect,
  sameAddress,
  waitForTx,
  writeJsonArtifact,
} from "./mainnet-vault-utils";

async function main() {
  requireMainnetEnv("mainnet vault deposit");

  const amount = readOptional0GAmountEnv("MAINNET_VAULT_DEPOSIT_0G");
  if (amount === null) {
    throw new Error("Set MAINNET_VAULT_DEPOSIT_0G to a small deposit amount.");
  }
  const maxDeposit = parseEther("0.02");
  if (amount <= 0n || amount > maxDeposit) {
    throw new Error("MAINNET_VAULT_DEPOSIT_0G must be greater than 0 and at most 0.02 0G.");
  }
  if (!readBoolEnv("MAINNET_VAULT_DEPOSIT_EXECUTE")) {
    throw new Error("Set MAINNET_VAULT_DEPOSIT_EXECUTE=true to send the deposit transaction.");
  }

  const publicClient = createMainnetPublicClient();
  const chainId = await assertMainnetRpc(publicClient);
  const { account, walletClient } = createMainnetWalletClient("DEPLOYER_PRIVATE_KEY");
  const configuredVault = readConfiguredVaultAddress();
  const vault = configuredVault ?? (await readFactoryVault(publicClient, readFactoryFromEnv(), account.address));
  if (vault === ZERO_ADDRESS) {
    throw new Error("No mainnet vault found for the deployer wallet.");
  }
  await requireBytecode(publicClient, vault, "PolicyVault");

  const owner = await publicClient.readContract({
    address: vault,
    abi: policyVaultAbi,
    functionName: "owner",
  });
  if (!sameAddress(owner, account.address)) {
    throw new Error("DEPLOYER_PRIVATE_KEY is not the owner of the configured vault.");
  }

  const balanceBefore = await publicClient.getBalance({ address: vault });
  const txHash = await walletClient.writeContract({
    address: vault,
    abi: policyVaultAbi,
    functionName: "depositNative",
    value: amount,
  });
  await waitForTx(publicClient, txHash, "depositNative");
  const balanceAfter = await publicClient.getBalance({ address: vault });
  if (balanceAfter < balanceBefore + amount) {
    throw new Error("Vault balance did not increase by the deposit amount.");
  }

  const outputPath = join(".data", "deployments", "mainnet-policy-vault-deposit.json");
  await writeJsonArtifact(outputPath, {
    balanceAfter0G: formatEther(balanceAfter),
    balanceBefore0G: formatEther(balanceBefore),
    chainId,
    deposit0G: formatEther(amount),
    owner,
    txHash,
    vault,
  });
  console.log("0G mainnet PolicyVault deposit passed. Redacted artifact:", outputPath);
  console.log({
    balanceAfter0G: formatEther(balanceAfter),
    deposit0G: formatEther(amount),
    txHash,
    vault,
  });
}

function readFactoryFromEnv() {
  const value = process.env.NEXT_PUBLIC_POLICY_VAULT_FACTORY_MAINNET_ADDRESS?.trim();
  if (!value) {
    throw new Error("Missing NEXT_PUBLIC_POLICY_VAULT_FACTORY_MAINNET_ADDRESS.");
  }
  return value as `0x${string}`;
}

await runIfDirect(import.meta.url, main);

export { main };
