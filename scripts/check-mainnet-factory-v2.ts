import dotenv from "dotenv";
import { createPublicClient, getAddress, http, isAddress, parseAbi, zeroAddress, type Address } from "viem";

dotenv.config({ path: ".env.local", quiet: true });

const MAINNET_CHAIN_ID = 16661;

const abi = parseAbi([
  "function VERSION() view returns (uint256)",
  "function vaultOf(address owner) view returns (address)",
]);

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function readOwnerArg(): Address | null {
  const ownerFlagIndex = process.argv.findIndex((arg) => arg === "--owner");
  const value = ownerFlagIndex >= 0 ? process.argv[ownerFlagIndex + 1] : undefined;
  if (!value) {
    return null;
  }
  if (!isAddress(value)) {
    throw new Error("--owner must be a valid EVM address");
  }
  return getAddress(value);
}

const rpcUrl = requireEnv("OG_RPC_URL");
const factory = getAddress(requireEnv("NEXT_PUBLIC_POLICY_VAULT_FACTORY_V2_MAINNET_ADDRESS"));
const owner = readOwnerArg();
const publicClient = createPublicClient({ transport: http(rpcUrl) });

const chainId = await publicClient.getChainId();
if (chainId !== MAINNET_CHAIN_ID) {
  throw new Error(`RPC chain mismatch: expected ${MAINNET_CHAIN_ID}, got ${chainId}`);
}

const code = await publicClient.getCode({ address: factory });
const version = await publicClient.readContract({
  address: factory,
  abi,
  functionName: "VERSION",
});

const ownerVault = owner
  ? await publicClient.readContract({
      address: factory,
      abi,
      functionName: "vaultOf",
      args: [owner],
    })
  : null;

console.log(
  JSON.stringify(
    {
      chainId,
      factory,
      hasBytecode: Boolean(code && code !== "0x"),
      owner,
      ownerHasV2Vault: ownerVault !== null ? ownerVault !== zeroAddress : undefined,
      ownerV2Vault: ownerVault,
      version: version.toString(),
    },
    null,
    2,
  ),
);
