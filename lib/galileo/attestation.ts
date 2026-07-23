import "server-only";

import { readFile } from "node:fs/promises";
import { createPublicClient, getAddress, http, keccak256, type Address, type Hex } from "viem";

import { galileoSandboxPoolAbi, galileoVaultAbi, galileoVaultRegistryAbi } from "@/lib/contracts/policy-vault-v4-galileo";
import { GALILEO_CHAIN_ID, assertGalileoWritePreflight, type GalileoWriteConfig } from "@/lib/galileo/config";

const ownableAbi = [{ type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const;
const adapterAbi = [{ type: "function", name: "pool", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }, { type: "function", name: "registry", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const;

/** Runtime gate for every Galileo write. Missing/stale artifacts are failures. */
export async function assertGalileoStackIntegrity(config: GalileoWriteConfig, vault?: Address): Promise<void> {
  await assertGalileoWritePreflight(config);
  const artifact = await readArtifact();
  const client = createPublicClient({ transport: http(config.rpcUrl) });
  if (await client.getChainId() !== GALILEO_CHAIN_ID) throw new Error("Galileo stack is on the wrong chain.");
  const expected = { proofRegistry: config.addresses.proofRegistry, vaultRegistry: config.addresses.vaultRegistry, token: config.addresses.sandboxToken, pool: config.addresses.pool, adapter: config.addresses.adapter };
  for (const [name, address] of Object.entries(expected)) {
    if (artifact.contracts[name as keyof typeof artifact.contracts].toLowerCase() !== address.toLowerCase()) throw new Error("Galileo environment does not match its deployed artifact.");
    const code = await client.getCode({ address });
    if (!code || keccak256(code) !== artifact.runtimeCodeHashes[name as keyof typeof artifact.runtimeCodeHashes]) throw new Error("Galileo runtime code does not match its deployed artifact.");
  }
  const roles = [config.signers.deployer.address, config.signers.proofAttestor.address, config.signers.vaultAttestor.address, config.signers.executor.address];
  if (new Set(roles.map((value) => value.toLowerCase())).size !== 4) throw new Error("Galileo write roles are not distinct.");
  const [proofOwner, registryOwner, poolAdapter, adapterPool, adapterRegistry, expectedAdapter, expectedProofRegistry, expectedToken, expectedPoolId] = await Promise.all([
    client.readContract({ address: config.addresses.proofRegistry, abi: ownableAbi, functionName: "owner" }), client.readContract({ address: config.addresses.vaultRegistry, abi: ownableAbi, functionName: "owner" }), client.readContract({ address: config.addresses.pool, abi: galileoSandboxPoolAbi, functionName: "adapter" }), client.readContract({ address: config.addresses.adapter, abi: adapterAbi, functionName: "pool" }), client.readContract({ address: config.addresses.adapter, abi: adapterAbi, functionName: "registry" }), client.readContract({ address: config.addresses.vaultRegistry, abi: galileoVaultRegistryAbi, functionName: "expectedAdapter" }), client.readContract({ address: config.addresses.vaultRegistry, abi: galileoVaultRegistryAbi, functionName: "expectedProofRegistry" }), client.readContract({ address: config.addresses.vaultRegistry, abi: galileoVaultRegistryAbi, functionName: "expectedToken" }), client.readContract({ address: config.addresses.vaultRegistry, abi: galileoVaultRegistryAbi, functionName: "expectedPoolId" }),
  ]);
  if (getAddress(proofOwner).toLowerCase() !== config.signers.proofAttestor.address.toLowerCase() || getAddress(registryOwner).toLowerCase() !== config.signers.vaultAttestor.address.toLowerCase() || getAddress(poolAdapter).toLowerCase() !== config.addresses.adapter.toLowerCase() || getAddress(adapterPool).toLowerCase() !== config.addresses.pool.toLowerCase() || getAddress(adapterRegistry).toLowerCase() !== config.addresses.vaultRegistry.toLowerCase() || getAddress(expectedAdapter).toLowerCase() !== config.addresses.adapter.toLowerCase() || getAddress(expectedProofRegistry).toLowerCase() !== config.addresses.proofRegistry.toLowerCase() || getAddress(expectedToken).toLowerCase() !== config.addresses.sandboxToken.toLowerCase() || expectedPoolId !== artifact.pool.id) throw new Error("Galileo cross-contract configuration is invalid.");
  if (vault) {
    const [attested, owner, executor, adapter, proofRegistry, tokenAllowed, poolAllowed, mockAllowed] = await Promise.all([
      client.readContract({ address: config.addresses.vaultRegistry, abi: galileoVaultRegistryAbi, functionName: "isAttestedVault", args: [vault] }), client.readContract({ address: vault, abi: galileoVaultAbi, functionName: "owner" }), client.readContract({ address: vault, abi: galileoVaultAbi, functionName: "executor" }), client.readContract({ address: vault, abi: galileoVaultAbi, functionName: "swapAdapter" }), client.readContract({ address: vault, abi: galileoVaultAbi, functionName: "proofRegistry" }), client.readContract({ address: vault, abi: galileoVaultAbi, functionName: "allowedTokens", args: [config.addresses.sandboxToken] }), client.readContract({ address: vault, abi: galileoVaultAbi, functionName: "allowedPools", args: [artifact.pool.id] }), client.readContract({ address: vault, abi: galileoVaultAbi, functionName: "mockAdapterAllowed" }),
    ]);
    if (!attested || getAddress(owner) === "0x0000000000000000000000000000000000000000" || getAddress(executor).toLowerCase() !== config.signers.executor.address.toLowerCase() || getAddress(adapter).toLowerCase() !== config.addresses.adapter.toLowerCase() || getAddress(proofRegistry).toLowerCase() !== config.addresses.proofRegistry.toLowerCase() || !tokenAllowed || !poolAllowed || mockAllowed) throw new Error("Galileo vault integrity gate rejected the vault.");
  }
}

type Artifact = { chainId: number; network: "testnet"; contracts: Record<"proofRegistry" | "vaultRegistry" | "token" | "pool" | "adapter", Address>; pool: { id: Hex }; runtimeCodeHashes: Record<"proofRegistry" | "vaultRegistry" | "token" | "pool" | "adapter", Hex> };
async function readArtifact(): Promise<Artifact> {
  let raw: unknown;
  try { raw = JSON.parse(await readFile(".data/deployments/galileo-trade-stack.json", "utf8")); } catch { throw new Error("Galileo deployment artifact is unavailable."); }
  const artifact = raw as Partial<Artifact>;
  if (artifact.chainId !== GALILEO_CHAIN_ID || artifact.network !== "testnet" || !artifact.contracts || !artifact.pool || !artifact.runtimeCodeHashes) throw new Error("Galileo deployment artifact is invalid.");
  return artifact as Artifact;
}
