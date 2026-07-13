import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getAddress, isAddress, isHex, keccak256, stringToHex, type Address, type Hex } from "viem";

export const GALILEO_CHAIN_ID = 16602;
export const GALILEO_POOL_ID = keccak256(stringToHex("4LPHA_GALILEO_0G_MUSDC_V1"));
export const GALILEO_STACK_SCHEMA_VERSION = 1;
export const GALILEO_STACK_ARTIFACT_PATH = ".data/deployments/galileo-trade-stack.json";
// A deterministic Hardhat deployment is useful for local UI and contract
// testing, but it must never be mistaken for a public Galileo deployment.
export const GALILEO_LOCAL_STACK_ARTIFACT_PATH = ".data/deployments/galileo-trade-stack.local.json";

export type GalileoTradeStackArtifact = {
  schemaVersion: number;
  network: "testnet";
  chainId: number;
  declaration: {
    containsNoSecrets: true;
    containsNoSignatures: true;
    containsNoRpcCredentials: true;
    containsNoMainnetIdentifiers: true;
  };
  deploymentBlock: string;
  deployer: Address;
  roles: { proofAttestor: Address; vaultAttestor: Address; executor: Address };
  contracts: { proofRegistry: Address; vaultRegistry: Address; token: Address; pool: Address; adapter: Address };
  pool: { id: Hex; initialNativeReserve: string; initialTokenReserve: string; feeBps: number };
  runtimeCodeHashes: Record<"proofRegistry" | "vaultRegistry" | "token" | "pool" | "adapter" | "vaultRuntimeTemplate", Hex>;
  configuration: { proofRegistryOwner: Address; vaultRegistryOwner: Address; poolAdapter: Address; registryAdapter: Address };
  transactions: Record<"proofRegistry" | "vaultRegistry" | "token" | "pool" | "adapter" | "configureRegistryAdapter" | "setPoolAdapter" | "mintPoolToken" | "approvePoolToken" | "seedPoolLiquidity" | "transferProofRegistryOwnership" | "transferVaultRegistryOwnership", Hex>;
};

export function requireAddress(value: string, label: string): Address {
  if (!isAddress(value)) throw new Error(`${label} must be a valid EVM address`);
  return getAddress(value);
}

export function requireHex32(value: string, label: string): Hex {
  if (!isHex(value, { strict: true }) || value.length !== 66) throw new Error(`${label} must be bytes32`);
  return value as Hex;
}

export async function readGalileoTradeStackArtifact(path = GALILEO_STACK_ARTIFACT_PATH): Promise<GalileoTradeStackArtifact> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null) throw new Error("Galileo deployment artifact must be an object");
  const artifact = parsed as GalileoTradeStackArtifact;
  if (artifact.schemaVersion !== GALILEO_STACK_SCHEMA_VERSION || artifact.network !== "testnet" || artifact.chainId !== GALILEO_CHAIN_ID) {
    throw new Error("Galileo deployment artifact is not a supported 16602 testnet artifact");
  }
  if (!artifact.declaration?.containsNoSecrets || !artifact.declaration.containsNoSignatures || !artifact.declaration.containsNoRpcCredentials || !artifact.declaration.containsNoMainnetIdentifiers) {
    throw new Error("Galileo deployment artifact declaration is invalid");
  }
  for (const [label, address] of Object.entries({ deployer: artifact.deployer, ...artifact.roles, ...artifact.contracts })) requireAddress(address, label);
  if (artifact.pool.id !== GALILEO_POOL_ID || artifact.pool.feeBps !== 30) throw new Error("Galileo deployment artifact pool metadata is invalid");
  return artifact;
}

export async function writeGalileoTradeStackArtifact(artifact: GalileoTradeStackArtifact, path = GALILEO_STACK_ARTIFACT_PATH) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}
