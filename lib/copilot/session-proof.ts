import "server-only";

import { isHex, type Hex } from "viem";
import { createPublicClient, createWalletClient, http, keccak256, toBytes, type Chain } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { getProofRegistryAddress } from "@/lib/contracts/policy-vault";
import { proofRegistryAbi } from "@/lib/contracts/proof-registry-abi";
import type { OgNetworkId } from "@/lib/types";

/**
 * Anchor a saved Copilot session's proof on 0G mainnet via ProofRegistry.acceptProof.
 *
 * The DEPLOYER_PRIVATE_KEY (ProofRegistry owner) pays gas. Chat sessions have no
 * vault action, so `vaultActionHash` is a synthetic deterministic non-zero stand-in
 * and `agentRef` is a fixed chat-scoped label. All five bytes32 fields are non-zero
 * by construction; `actionHash` is unique per sessionId.
 *
 * FAIL-CLOSED: if the anchor tx fails or the receipt reverts, this throws and the
 * caller (the save route) must NOT write a registry record (no orphans).
 */

const MAINNET_CHAIN_ID = 16661;
const AGENT_REF = "4lpha-agent:copilot-session:v1";
const VAULT_ACTION_TAG = "copilot-session-v1";

export interface AnchorSessionProofInput {
  sessionId: string;
  rootHash: Hex;
  storageRef: string;
  model: string;
  routerBaseUrl: string;
  networkId: OgNetworkId;
  chainId: number;
  wallet: string;
  createdAt: string;
}

export interface AnchorSessionProofResult {
  proofTxHash: Hex;
  actionHash: Hex;
  policySnapshotHash: Hex;
  modelMetadataHash: Hex;
  vaultActionHash: Hex;
  agentRef: string;
}

export async function anchorSessionProof(
  input: AnchorSessionProofInput,
): Promise<AnchorSessionProofResult> {
  if (input.chainId !== MAINNET_CHAIN_ID) {
    throw new Error(`Copilot session proof anchoring requires 0G mainnet (chain ${MAINNET_CHAIN_ID}).`);
  }
  if (!isHex(input.rootHash, { strict: true }) || input.rootHash.length !== 66) {
    throw new Error("auditRoot (rootHash) must be a 32-byte hex string.");
  }

  const proofRegistry = getProofRegistryAddress("mainnet");
  if (!proofRegistry) {
    throw new Error("NEXT_PUBLIC_PROOF_REGISTRY_MAINNET_ADDRESS is not configured.");
  }

  const actionHash = hashJson({
    kind: "copilot-session",
    sessionId: input.sessionId,
    wallet: input.wallet.toLowerCase(),
    networkId: input.networkId,
    createdAt: input.createdAt,
  });
  const policySnapshotHash = hashJson({
    mode: "saved",
    networkId: input.networkId,
    chainId: input.chainId,
    savedAt: input.createdAt,
    policyVersion: 1,
  });
  const modelMetadataHash = hashJson({
    model: input.model,
    routerBaseUrl: input.routerBaseUrl,
    provider: "0g-compute-router",
    sessionMode: "saved",
  });
  const vaultActionHash = keccak256(toBytes(`${VAULT_ACTION_TAG}:${input.sessionId}`));

  const rpcUrl = requireEnv("OG_RPC_URL");
  const privateKey = readPrivateKeyEnv("DEPLOYER_PRIVATE_KEY");
  const chain = make0GMainnetChain(rpcUrl);
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const account = privateKeyToAccount(privateKey);
  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });

  const simulation = await publicClient.simulateContract({
    account: account.address,
    address: proofRegistry,
    abi: proofRegistryAbi,
    functionName: "acceptProof",
    args: [
      actionHash,
      input.rootHash,
      policySnapshotHash,
      modelMetadataHash,
      input.storageRef,
      vaultActionHash,
      AGENT_REF,
    ],
  });
  const proofTxHash = (await walletClient.writeContract({
    ...simulation.request,
    account,
    chain,
  })) as Hex;

  await waitForReceipt(publicClient, proofTxHash);

  return {
    proofTxHash,
    actionHash,
    policySnapshotHash,
    modelMetadataHash,
    vaultActionHash,
    agentRef: AGENT_REF,
  };
}

function make0GMainnetChain(rpcUrl: string): Chain {
  return {
    id: MAINNET_CHAIN_ID,
    name: "0G Mainnet",
    nativeCurrency: { decimals: 18, name: "0G", symbol: "0G" },
    rpcUrls: { default: { http: [rpcUrl] } },
  };
}

async function waitForReceipt(
  publicClient: ReturnType<typeof createPublicClient>,
  hash: Hex,
): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const receipt = await publicClient.getTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        throw new Error(`Copilot session proof transaction reverted: ${hash}`);
      }
      return;
    } catch (error) {
      if (!isReceiptPendingError(error)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  throw new Error(`Timed out waiting for Copilot session proof receipt: ${hash}`);
}

function isReceiptPendingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.toLowerCase().includes("receipt") &&
    message.toLowerCase().includes("not") &&
    message.toLowerCase().includes("found")
  );
}

function hashJson(value: unknown): Hex {
  return keccak256(toBytes(stableJson(value)));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  if (typeof value === "bigint") {
    return JSON.stringify(value.toString());
  }
  return JSON.stringify(value);
}

function readPrivateKeyEnv(name: string): Hex {
  const value = requireEnv(name);
  if (!isHex(value, { strict: true }) || value.length !== 66) {
    throw new Error(`${name} must be a 32-byte private key hex string.`);
  }
  return value as Hex;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}