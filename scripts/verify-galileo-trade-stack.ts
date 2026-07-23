import dotenv from "dotenv";
import { createPublicClient, getAddress, http, keccak256, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { GALILEO_CHAIN_ID, GALILEO_STACK_ARTIFACT_PATH, readGalileoTradeStackArtifact } from "./galileo-trade-stack-artifact";

dotenv.config({ path: ".env.local", quiet: true });
const requireEnv = (name: string) => { const value = process.env[name]?.trim(); if (!value) throw new Error(`Missing required env var: ${name}`); return value; };
const requireFlag = (name: string, expected: boolean) => { if (((process.env[name] ?? "false").toLowerCase() === "true") !== expected) throw new Error(`${name} must be ${expected}`); };
const same = (a: Address, b: Address) => a.toLowerCase() === b.toLowerCase();
const ownableAbi = [{ type: "function", name: "owner", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" }] as const;
const poolAbi = [{ type: "function", name: "adapter", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" }, { type: "function", name: "nativeReserve", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" }, { type: "function", name: "tokenReserve", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" }] as const;
const registryAbi = [...ownableAbi, { type: "function", name: "expectedAdapter", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" }, { type: "function", name: "adapterConfigured", inputs: [], outputs: [{ type: "bool" }], stateMutability: "view" }] as const;

async function main() {
  if ((process.env.OG_NETWORK ?? "").toLowerCase() !== "testnet" || Number(requireEnv("OG_CHAIN_ID")) !== GALILEO_CHAIN_ID) throw new Error("Galileo stack verifier requires OG_NETWORK=testnet and OG_CHAIN_ID=16602");
  requireFlag("ENABLE_MAINNET_DEPLOY", false);
  const rpcUrl = requireEnv("OG_GALILEO_RPC_URL");
  const artifact = await readGalileoTradeStackArtifact(process.env.GALILEO_TRADE_STACK_ARTIFACT_PATH || GALILEO_STACK_ARTIFACT_PATH);
  const client = createPublicClient({ transport: http(rpcUrl) });
  if (await client.getChainId() !== GALILEO_CHAIN_ID) throw new Error("OG_GALILEO_RPC_URL did not resolve to chain 16602");
  const roles = [artifact.deployer, artifact.roles.proofAttestor, artifact.roles.vaultAttestor, artifact.roles.executor];
  if (new Set(roles.map((address) => address.toLowerCase())).size !== roles.length) throw new Error("Artifact role addresses are not distinct");
  for (const [name, address] of Object.entries(artifact.contracts)) {
    const code = await client.getBytecode({ address });
    if (!code || code === "0x" || keccak256(code) !== artifact.runtimeCodeHashes[name as keyof typeof artifact.contracts]) throw new Error(`${name} bytecode does not match the artifact`);
  }
  const [proofOwner, registryOwner, registryAdapter, configured, poolAdapter, nativeReserve, tokenReserve] = await Promise.all([
    client.readContract({ address: artifact.contracts.proofRegistry, abi: ownableAbi, functionName: "owner" }), client.readContract({ address: artifact.contracts.vaultRegistry, abi: ownableAbi, functionName: "owner" }),
    client.readContract({ address: artifact.contracts.vaultRegistry, abi: registryAbi, functionName: "expectedAdapter" }), client.readContract({ address: artifact.contracts.vaultRegistry, abi: registryAbi, functionName: "adapterConfigured" }),
    client.readContract({ address: artifact.contracts.pool, abi: poolAbi, functionName: "adapter" }), client.readContract({ address: artifact.contracts.pool, abi: poolAbi, functionName: "nativeReserve" }), client.readContract({ address: artifact.contracts.pool, abi: poolAbi, functionName: "tokenReserve" }),
  ]);
  if (!same(proofOwner, artifact.roles.proofAttestor) || !same(registryOwner, artifact.roles.vaultAttestor) || !same(registryAdapter, artifact.contracts.adapter) || !configured || !same(poolAdapter, artifact.contracts.adapter) || nativeReserve !== BigInt(artifact.pool.initialNativeReserve) || tokenReserve !== BigInt(artifact.pool.initialTokenReserve)) throw new Error("Galileo shared stack configuration differs from the artifact");
  for (const [env, address] of Object.entries({ PROOF_REGISTRY_GALILEO_ADDRESS: artifact.contracts.proofRegistry, NEXT_PUBLIC_VAULT_REGISTRY_V4_GALILEO_ADDRESS: artifact.contracts.vaultRegistry, NEXT_PUBLIC_GALILEO_SANDBOX_TOKEN_ADDRESS: artifact.contracts.token, NEXT_PUBLIC_GALILEO_SANDBOX_POOL_ADDRESS: artifact.contracts.pool, NEXT_PUBLIC_GALILEO_SANDBOX_ADAPTER_ADDRESS: artifact.contracts.adapter })) {
    if (!process.env[env] || !same(getAddress(requireEnv(env)), address)) throw new Error(`${env} must match the verified Galileo artifact`);
  }
  const keyRoles = { GALILEO_DEPLOYER_PRIVATE_KEY: artifact.deployer, GALILEO_PROOF_ATTESTOR_PRIVATE_KEY: artifact.roles.proofAttestor, GALILEO_VAULT_ATTESTOR_PRIVATE_KEY: artifact.roles.vaultAttestor, GALILEO_VAULT_EXECUTOR_PRIVATE_KEY: artifact.roles.executor };
  for (const [env, expected] of Object.entries(keyRoles)) if (!same(privateKeyToAccount(requireEnv(env) as Hex).address, expected)) throw new Error(`${env} does not match its artifact role`);
  console.log("Galileo trade stack artifact and on-chain configuration verified", { chainId: GALILEO_CHAIN_ID, artifact: GALILEO_STACK_ARTIFACT_PATH });
}
main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
