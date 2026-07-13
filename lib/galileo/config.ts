import "server-only";

import { createPublicClient, http, isAddress, isHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { GALILEO_CHAIN_ID, GALILEO_NETWORK_ID } from "./constants";

/** The only chain a Galileo trade module is allowed to resolve. Single source
 *  lives in ./constants (client-safe); re-exported here for server callers. */
export { GALILEO_CHAIN_ID, GALILEO_NETWORK_ID };

type GalileoEnv = Readonly<Record<string, string | undefined>>;

export type GalileoWriteRole = "deployer" | "proofAttestor" | "vaultAttestor" | "executor";

export interface GalileoReadConfig {
  chainId: typeof GALILEO_CHAIN_ID;
  networkId: typeof GALILEO_NETWORK_ID;
  rpcUrl: string;
  storageIndexerUrl: string;
  storageRpcUrl: string;
}

export interface GalileoStackAddresses {
  adapter: Address;
  pool: Address;
  proofRegistry: Address;
  sandboxToken: Address;
  vaultRegistry: Address;
}

export interface GalileoTradeReadConfig extends GalileoReadConfig {
  addresses: GalileoStackAddresses;
}

export interface GalileoWriteConfig extends GalileoReadConfig {
  addresses: GalileoStackAddresses;
  deployEnabled: boolean;
  tradeEnabled: boolean;
  signers: Record<GalileoWriteRole, { address: Address; privateKey: Hex }>;
}

/**
 * Reads only the explicitly named Galileo variables. In particular, this file
 * deliberately has no generic RPC/key/address fallback and no mainnet import.
 */
export function resolveGalileoReadConfig(env: GalileoEnv = process.env): GalileoReadConfig {
  requireExact(env, "OG_NETWORK", "testnet");
  requireExact(env, "OG_CHAIN_ID", String(GALILEO_CHAIN_ID));

  return {
    chainId: GALILEO_CHAIN_ID,
    networkId: GALILEO_NETWORK_ID,
    rpcUrl: requireHttpUrl(env, "OG_GALILEO_RPC_URL"),
    storageIndexerUrl: requireHttpUrl(env, "OG_GALILEO_STORAGE_INDEXER_URL"),
    storageRpcUrl: requireHttpUrl(env, "OG_GALILEO_STORAGE_RPC_URL"),
  };
}

/** Preview needs no signer and stays available while execution is disabled. */
export function resolveGalileoTradeReadConfig(env: GalileoEnv = process.env): GalileoTradeReadConfig {
  const read = resolveGalileoReadConfig(env);
  return {
    ...read,
    addresses: {
      proofRegistry: requireAddress(env, "PROOF_REGISTRY_GALILEO_ADDRESS"),
      vaultRegistry: requireAddress(env, "NEXT_PUBLIC_VAULT_REGISTRY_V4_GALILEO_ADDRESS"),
      sandboxToken: requireAddress(env, "NEXT_PUBLIC_GALILEO_SANDBOX_TOKEN_ADDRESS"),
      pool: requireAddress(env, "NEXT_PUBLIC_GALILEO_SANDBOX_POOL_ADDRESS"),
      adapter: requireAddress(env, "NEXT_PUBLIC_GALILEO_SANDBOX_ADAPTER_ADDRESS"),
    },
  };
}

/** Resolve all server-only Galileo write inputs. Feature gates are fail-closed. */
export function resolveGalileoWriteConfig(env: GalileoEnv = process.env): GalileoWriteConfig {
  const read = resolveGalileoReadConfig(env);
  const signers = {
    deployer: signerFor(env, "GALILEO_DEPLOYER_PRIVATE_KEY"),
    proofAttestor: signerFor(env, "GALILEO_PROOF_ATTESTOR_PRIVATE_KEY"),
    vaultAttestor: signerFor(env, "GALILEO_VAULT_ATTESTOR_PRIVATE_KEY"),
    executor: signerFor(env, "GALILEO_VAULT_EXECUTOR_PRIVATE_KEY"),
  };
  const distinct = new Set(Object.values(signers).map((signer) => signer.address.toLowerCase()));
  if (distinct.size !== 4) {
    throw new Error("Galileo deployer, proof attestor, vault attestor, and executor must be distinct addresses.");
  }

  return {
    ...read,
    addresses: resolveGalileoTradeReadConfig(env).addresses,
    deployEnabled: requireBoolean(env, "ENABLE_GALILEO_DEPLOY"),
    tradeEnabled: requireBoolean(env, "ENABLE_GALILEO_TRADE"),
    signers,
  };
}

/**
 * Verify the live endpoint and baseline deployed-code preconditions before a
 * Galileo write path simulates or constructs a transaction.
 */
export async function assertGalileoWritePreflight(config: GalileoWriteConfig): Promise<void> {
  const client = createPublicClient({ transport: http(config.rpcUrl) });
  const chainId = await client.getChainId();
  if (chainId !== GALILEO_CHAIN_ID) {
    throw new Error(`Galileo RPC returned chain ${chainId}; expected ${GALILEO_CHAIN_ID}.`);
  }

  const entries = Object.entries(config.addresses) as Array<[keyof GalileoStackAddresses, Address]>;
  await Promise.all(entries.map(async ([name, address]) => {
    const code = await client.getCode({ address });
    if (!code || code === "0x") throw new Error(`Galileo ${name} has no deployed bytecode.`);
  }));
}

export function assertGalileoRoute(networkId: unknown, chainId: unknown): asserts networkId is typeof GALILEO_NETWORK_ID {
  if (networkId !== GALILEO_NETWORK_ID || chainId !== GALILEO_CHAIN_ID) {
    throw new Error("Galileo route requires networkId=testnet and chainId=16602.");
  }
}

function signerFor(env: GalileoEnv, name: string): { address: Address; privateKey: Hex } {
  const privateKey = requirePrivateKey(env, name);
  return { address: privateKeyToAccount(privateKey).address, privateKey };
}

function requireExact(env: GalileoEnv, name: string, expected: string): void {
  if (env[name]?.trim().toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`${name} must be ${expected} for Galileo.`);
  }
}

function requireBoolean(env: GalileoEnv, name: string): boolean {
  const value = env[name]?.trim().toLowerCase();
  if (value !== "true" && value !== "false") throw new Error(`${name} must be exactly true or false for Galileo.`);
  return value === "true";
}

function requireHttpUrl(env: GalileoEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required Galileo env var: ${name}`);
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("unsupported protocol");
    return url.toString();
  } catch {
    throw new Error(`${name} must be an http(s) URL.`);
  }
}

function requireAddress(env: GalileoEnv, name: string): Address {
  const value = env[name]?.trim();
  if (!value || !isAddress(value, { strict: true })) throw new Error(`${name} must be a valid Galileo address.`);
  return value;
}

function requirePrivateKey(env: GalileoEnv, name: string): Hex {
  const value = env[name]?.trim();
  if (!value || !isHex(value, { strict: true }) || value.length !== 66) {
    throw new Error(`${name} must be a 32-byte private key hex string.`);
  }
  return value as Hex;
}
