import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import dotenv from "dotenv";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  formatUnits,
  getAddress,
  http,
  isAddress,
  isHex,
  keccak256,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { executeCuratedTrade } from "../lib/agent/curated-trade";
import {
  getLatestPolicyVaultFactoryVersion,
  policyVaultAgentKeyAbi,
  policyVaultFactoryAbi,
} from "../lib/contracts/policy-vault";

dotenv.config({ path: ".env.local", quiet: true });

const MAINNET_CHAIN_ID = 16661;
const OWNER = getAddress("0xd7e004cbda24e079aa3a657ba7f8e2915192a966");
const REGISTRY_PATH = join(".data", "agents", "mainnet-agents.json");

const vaultOwnerAbi = parseAbi(["function owner() view returns (address)"]);

interface AgentRecord {
  agentKey?: Hex;
  agentRef: string;
  createdAt: string;
  id: string;
  identityAddress: Address;
  name: string;
  owner: Address;
  removedAt?: string;
  tokenId: string;
}

interface AgentRegistry {
  agents?: AgentRecord[];
  removedAgents?: AgentRecord[];
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function requireFlag(name: string, expected: boolean) {
  const actual = (process.env[name] ?? "false").toLowerCase() === "true";
  if (actual !== expected) {
    throw new Error(`${name} must be ${String(expected)} for V2 agent smoke`);
  }
}

function requirePrivateKeyEnv(name: string): Hex {
  const value = requireEnv(name);
  if (!isHex(value, { strict: true }) || value.length !== 66) {
    throw new Error(`${name} must be a 32-byte hex private key`);
  }
  return value;
}

async function readRegistry(): Promise<AgentRegistry> {
  try {
    return JSON.parse(await readFile(REGISTRY_PATH, "utf8")) as AgentRegistry;
  } catch {
    return {};
  }
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function chooseAgent(registry: AgentRegistry): { record: AgentRecord; temporaryRemovedAgent: boolean } {
  const active = (registry.agents ?? [])
    .filter((record) => isAddress(record.owner) && sameAddress(record.owner, OWNER))
    .sort(compareAgentRecords);
  const activeRecord = active.at(-1);
  if (activeRecord) {
    return { record: activeRecord, temporaryRemovedAgent: false };
  }

  throw new Error("No active local AgenticID record is available for V2 smoke; removed records must not be re-enabled.");
}

function compareAgentRecords(left: AgentRecord, right: AgentRecord): number {
  const leftToken = BigInt(left.tokenId);
  const rightToken = BigInt(right.tokenId);
  if (leftToken < rightToken) return -1;
  if (leftToken > rightToken) return 1;
  return Date.parse(left.createdAt) - Date.parse(right.createdAt);
}

function agentKeyFor(record: AgentRecord): Hex {
  return record.agentKey ?? keccak256(
    encodeAbiParameters(
      [
        { name: "identityAddress", type: "address" },
        { name: "tokenId", type: "uint256" },
      ],
      [getAddress(record.identityAddress), BigInt(record.tokenId)],
    ),
  );
}

async function waitForTx(hash: Hex, label: string) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      return await publicClient.getTransactionReceipt({ hash });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("could not be found") && !message.includes("not be found")) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error(`Timed out waiting for ${label}: ${hash}`);
}

async function setAgentKeyEnabled(vault: Address, agentKey: Hex, enabled: boolean): Promise<Hex> {
  const simulation = await publicClient.simulateContract({
    account: ownerAccount.address,
    address: vault,
    abi: policyVaultAgentKeyAbi,
    functionName: "setAgentKeyEnabled",
    args: [agentKey, enabled],
  });
  const hash = await walletClient.writeContract({
    ...simulation.request,
    account: ownerAccount,
    chain,
  });
  await waitForTx(hash, `setAgentKeyEnabled:${String(enabled)}`);
  return hash;
}

async function readAgentPosition(vault: Address, agentKey: Hex, token: Address): Promise<bigint> {
  return publicClient.readContract({
    address: vault,
    abi: policyVaultAgentKeyAbi,
    functionName: "agentPositionUnits",
    args: [agentKey, token],
  });
}

async function writeArtifact(value: unknown) {
  const path = join(".data", "smoke", "mainnet-v2-agent-roundtrip.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, jsonReplacer, 2)}\n`, "utf8");
  return path;
}

function jsonReplacer(_key: string, value: unknown) {
  return typeof value === "bigint" ? value.toString() : value;
}

requireFlag("MAINNET_V2_AGENT_SMOKE_EXECUTE", true);
requireFlag("AGENT_TRADE_LIVE_ENABLED", true);

const rpcUrl = requireEnv("OG_RPC_URL");
const ownerAccount = privateKeyToAccount(requirePrivateKeyEnv("DEPLOYER_PRIVATE_KEY"));
if (!sameAddress(ownerAccount.address, OWNER)) {
  throw new Error("DEPLOYER_PRIVATE_KEY must be the owner wallet for this V2 smoke.");
}

const chain = {
  id: MAINNET_CHAIN_ID,
  name: "0G Mainnet",
  nativeCurrency: { decimals: 18, name: "0G", symbol: "0G" },
  rpcUrls: { default: { http: [rpcUrl] } },
} as const;
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
const walletClient = createWalletClient({ account: ownerAccount, chain, transport: http(rpcUrl) });

const chainId = await publicClient.getChainId();
if (chainId !== MAINNET_CHAIN_ID) {
  throw new Error(`RPC chain mismatch: expected ${MAINNET_CHAIN_ID}, got ${chainId}`);
}

const factory = getLatestPolicyVaultFactoryVersion("mainnet");
if (!factory || factory.version < 2) {
  throw new Error("FactoryV2 is not configured as the latest mainnet Policy Vault factory.");
}

const vault = await publicClient.readContract({
  address: factory.address,
  abi: policyVaultFactoryAbi,
  functionName: "vaultOf",
  args: [OWNER],
});
if (vault === zeroAddress) {
  throw new Error("Owner has no PolicyVaultV2 yet.");
}
const vaultOwner = await publicClient.readContract({
  address: vault,
  abi: vaultOwnerAbi,
  functionName: "owner",
});
if (!sameAddress(vaultOwner, OWNER)) {
  throw new Error("PolicyVaultV2 owner mismatch.");
}

const registry = await readRegistry();
const { record, temporaryRemovedAgent } = chooseAgent(registry);
const agentKey = agentKeyFor(record);
const initiallyEnabled = await publicClient.readContract({
  address: vault,
  abi: policyVaultAgentKeyAbi,
  functionName: "agentKeyEnabled",
  args: [agentKey],
});

let enableTx: Hex | undefined;
let disableTx: Hex | undefined;
let buy: Awaited<ReturnType<typeof executeCuratedTrade>> | undefined;
let sell: Awaited<ReturnType<typeof executeCuratedTrade>> | undefined;
let finalPosition: bigint | undefined;

try {
  if (!initiallyEnabled) {
    enableTx = await setAgentKeyEnabled(vault, agentKey, true);
  }

  const amount = process.env.MAINNET_V2_AGENT_SMOKE_BUY_0G?.trim() || "0.001";
  const tokenSymbol = process.env.MAINNET_V2_AGENT_SMOKE_TOKEN?.trim() || "USDC.e";
  const slippageBps = Number.parseInt(process.env.MAINNET_V2_AGENT_SMOKE_SLIPPAGE_BPS ?? "100", 10);

  buy = await executeCuratedTrade({
    agentKey,
    agentRef: record.agentRef,
    amount,
    copilotAudit: {
      model: "mainnet-v2-agent-smoke",
      policyContextHash: "script",
      promptHash: "script",
      responseHash: "script",
    },
    networkId: "mainnet",
    side: "buy",
    slippageBps,
    tokenSymbol,
    vaultAddress: vault,
  });

  const token = buy.quote.tokenAddress;
  const position = await readAgentPosition(vault, agentKey, token);
  if (position <= 0n) {
    throw new Error("Buy did not create a positive agent-scoped position.");
  }

  sell = await executeCuratedTrade({
    agentKey,
    agentRef: record.agentRef,
    amount: formatUnits(position, buy.quote.outputDecimals),
    copilotAudit: {
      model: "mainnet-v2-agent-smoke",
      policyContextHash: "script",
      promptHash: "script",
      responseHash: "script",
    },
    networkId: "mainnet",
    routeId: buy.quote.route.id,
    side: "sell",
    slippageBps,
    vaultAddress: vault,
  });

  finalPosition = await readAgentPosition(vault, agentKey, token);
} finally {
  if (!initiallyEnabled) {
    disableTx = await setAgentKeyEnabled(vault, agentKey, false).catch((error) => {
      console.error("Failed to disable temporary smoke agent key", error);
      return undefined;
    });
  }
}

const artifactPath = await writeArtifact({
  agent: {
    agentKey,
    agentRef: record.agentRef,
    id: record.id,
    name: record.name,
    temporaryRemovedAgent,
    tokenId: record.tokenId,
  },
  buy: buy ? {
    actionHash: buy.actionHash,
    proofTxHash: buy.proofTxHash,
    route: buy.quote.route.label,
    txHash: buy.executionTxHash,
  } : undefined,
  disableTx,
  enableTx,
  finalPosition: finalPosition?.toString(),
  initiallyEnabled,
  sell: sell ? {
    actionHash: sell.actionHash,
    proofTxHash: sell.proofTxHash,
    route: sell.quote.route.label,
    txHash: sell.executionTxHash,
  } : undefined,
  vault,
});

console.log("0G mainnet PolicyVaultV2 AgenticID round-trip smoke complete.", {
  agentId: record.id,
  artifactPath,
  buyTx: buy?.executionTxHash,
  disableTx,
  enableTx,
  finalPosition: finalPosition?.toString(),
  sellTx: sell?.executionTxHash,
  temporaryRemovedAgent,
  vault,
});
