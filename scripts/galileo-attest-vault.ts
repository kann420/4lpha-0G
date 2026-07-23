/**
 * Attest a user-deployed Galileo Swap Vault so the sandbox adapter will accept
 * it. The browser deliberately cannot self-attest: only the dedicated vault
 * attestor (the GalileoVaultRegistryV4 owner) may call attestVault.
 *
 *   npm run attest:galileo:vault -- 0xVaultAddress          # dry run (default)
 *   ENABLE_GALILEO_VAULT_ATTEST=true npm run attest:galileo:vault -- 0xVault
 *
 * Testnet-only and fail-closed: it requires OG_NETWORK=testnet, chain 16602 from
 * the live RPC, and refuses to broadcast unless the explicit flag is set. The
 * registry re-checks every one of these conditions on-chain, so a look-alike
 * vault reverts even if this script were wrong.
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local", quiet: true });

import { createPublicClient, createWalletClient, getAddress, http, isAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { galileoVaultAbi, galileoVaultRegistryAbi } from "../lib/contracts/policy-vault-v4-galileo";
import { assertGalileoWritePreflight, resolveGalileoWriteConfig, GALILEO_CHAIN_ID } from "../lib/galileo/config";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Registry views the shared client ABI does not expose (attestor-only tooling). */
const registryAttestorAbi = [
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "adapterConfigured", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "vaultImplementationCodeHash", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "expectedPoolId", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "expectedToken", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "expectedExecutor", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "expectedProofRegistry", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "expectedAdapter", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function resolveVaultArg(): Address {
  const raw = (process.argv[2] ?? process.env.GALILEO_ATTEST_VAULT_ADDRESS ?? "").trim();
  if (!raw) throw new Error("Pass the vault address: npm run attest:galileo:vault -- 0xVaultAddress");
  if (!isAddress(raw, { strict: false })) throw new Error(`Not a valid address: ${raw}`);
  return getAddress(raw);
}

async function main() {
  const vault = resolveVaultArg();
  const broadcast = (process.env.ENABLE_GALILEO_VAULT_ATTEST ?? "false").toLowerCase() === "true";
  if ((process.env.ENABLE_MAINNET_DEPLOY ?? "false").toLowerCase() === "true") {
    throw new Error("ENABLE_MAINNET_DEPLOY must be false for a Galileo attestation");
  }

  // resolveGalileoWriteConfig enforces OG_NETWORK=testnet, OG_CHAIN_ID=16602,
  // the four distinct Galileo signers, and the dedicated Galileo endpoints.
  const config = resolveGalileoWriteConfig();
  await assertGalileoWritePreflight(config);

  const client = createPublicClient({ transport: http(config.rpcUrl) });
  const attestor = privateKeyToAccount(config.signers.vaultAttestor.privateKey);
  const registry = config.addresses.vaultRegistry;

  const [registryOwner, adapterConfigured, implementationCodeHash, expectedPoolId, expectedToken, expectedExecutor, expectedProofRegistry, expectedAdapter] = await Promise.all([
    client.readContract({ address: registry, abi: registryAttestorAbi, functionName: "owner" }),
    client.readContract({ address: registry, abi: registryAttestorAbi, functionName: "adapterConfigured" }),
    client.readContract({ address: registry, abi: registryAttestorAbi, functionName: "vaultImplementationCodeHash" }),
    client.readContract({ address: registry, abi: registryAttestorAbi, functionName: "expectedPoolId" }),
    client.readContract({ address: registry, abi: registryAttestorAbi, functionName: "expectedToken" }),
    client.readContract({ address: registry, abi: registryAttestorAbi, functionName: "expectedExecutor" }),
    client.readContract({ address: registry, abi: registryAttestorAbi, functionName: "expectedProofRegistry" }),
    client.readContract({ address: registry, abi: registryAttestorAbi, functionName: "expectedAdapter" }),
  ]);
  if (!same(registryOwner, attestor.address)) {
    throw new Error(`GALILEO_VAULT_ATTESTOR_PRIVATE_KEY (${attestor.address}) is not the registry owner (${registryOwner})`);
  }
  if (!adapterConfigured) throw new Error("Registry adapter is not configured; the stack deploy did not complete");

  if (await client.readContract({ address: registry, abi: galileoVaultRegistryAbi, functionName: "isAttestedVault", args: [vault] })) {
    console.log(`Vault ${vault} is already attested; nothing to do.`);
    return;
  }

  const code = await client.getCode({ address: vault });
  if (!code || code === "0x") throw new Error(`No bytecode at ${vault}`);
  const [vaultOwner, executor, adapter, proofRegistry, vaultRegistry, mockAllowed, tokenAllowed, poolAllowed] = await Promise.all([
    client.readContract({ address: vault, abi: galileoVaultAbi, functionName: "owner" }),
    client.readContract({ address: vault, abi: galileoVaultAbi, functionName: "executor" }),
    client.readContract({ address: vault, abi: galileoVaultAbi, functionName: "swapAdapter" }),
    client.readContract({ address: vault, abi: galileoVaultAbi, functionName: "proofRegistry" }),
    client.readContract({ address: vault, abi: galileoVaultAbi, functionName: "vaultRegistry" }),
    client.readContract({ address: vault, abi: galileoVaultAbi, functionName: "mockAdapterAllowed" }),
    client.readContract({ address: vault, abi: galileoVaultAbi, functionName: "allowedTokens", args: [expectedToken] }),
    client.readContract({ address: vault, abi: galileoVaultAbi, functionName: "allowedPools", args: [expectedPoolId] }),
  ]);

  const failures: string[] = [];
  if (vaultOwner === ZERO_ADDRESS) failures.push("vault owner is the zero address");
  if (!same(executor, expectedExecutor)) failures.push(`executor ${executor} != expected ${expectedExecutor}`);
  if (!same(adapter, expectedAdapter)) failures.push(`swapAdapter ${adapter} != expected ${expectedAdapter}`);
  if (!same(proofRegistry, expectedProofRegistry)) failures.push(`proofRegistry ${proofRegistry} != expected ${expectedProofRegistry}`);
  if (!same(vaultRegistry, registry)) failures.push(`vaultRegistry ${vaultRegistry} != ${registry}`);
  if (mockAllowed) failures.push("mockAdapterAllowed is true");
  if (!tokenAllowed) failures.push("sandbox token is not allowlisted on the vault");
  if (!poolAllowed) failures.push("sandbox pool id is not allowlisted on the vault");
  if (failures.length) throw new Error(`Vault configuration does not match the Galileo stack:\n  - ${failures.join("\n  - ")}`);

  const registered = await client.readContract({ address: registry, abi: galileoVaultRegistryAbi, functionName: "vaultOf", args: [vaultOwner] });
  if (registered !== ZERO_ADDRESS) {
    throw new Error(`Owner ${vaultOwner} already has registered vault ${registered}; the registry allows one vault per owner`);
  }

  console.log("Galileo vault attestation preflight", {
    attestor: attestor.address,
    chainId: GALILEO_CHAIN_ID,
    owner: vaultOwner,
    registry,
    vault,
    // The registry pins this exact hash; a look-alike implementation reverts.
    implementationCodeHashPinned: implementationCodeHash,
  });

  if (!broadcast) {
    console.log("Dry run only. Re-run with ENABLE_GALILEO_VAULT_ATTEST=true to broadcast attestVault.");
    return;
  }

  const wallet = createWalletClient({ account: attestor, chain: undefined, transport: http(config.rpcUrl) });
  const hash: Hex = await wallet.writeContract({
    account: attestor,
    address: registry,
    abi: galileoVaultRegistryAbi,
    chain: null,
    functionName: "attestVault",
    args: [vault],
  });
  console.log(`attestVault submitted: ${hash}`);
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`attestVault reverted (${hash})`);
  const attested = await client.readContract({ address: registry, abi: galileoVaultRegistryAbi, functionName: "isAttestedVault", args: [vault] });
  if (!attested) throw new Error("attestVault succeeded but the registry does not report the vault as attested");
  console.log(`Vault ${vault} attested for owner ${vaultOwner} in block ${receipt.blockNumber}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
