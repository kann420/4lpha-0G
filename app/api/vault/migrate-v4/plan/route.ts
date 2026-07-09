import { NextResponse } from "next/server";
import {
  createPublicClient,
  getAddress,
  http,
  isAddress,
  sha256,
  stringToBytes,
  zeroAddress,
  type Address,
  type Chain,
  type Hex,
} from "viem";
import { z } from "zod";

import {
  readMainnetV3VaultRegistry,
  resolveMainnetV4VaultForOwner,
  resolveMainnetVaultVersionsForOwner,
} from "@/lib/agent/mainnet-vault-resolver";
import { agentKeyForDeployment, OgAgentDeployError } from "@/lib/agent/agent-deploy-common";
import type { OgAgentDeploymentRecord, OgRemovedAgentRecord } from "@/lib/agent/single-agent";
import {
  hashVaultInventory,
  inventoryV3Vault,
  type V3VaultInventory,
} from "@/lib/agent/vault-migrate-v4";
import { canonicalize, type V4VaultTrio } from "@/lib/agent/vault-migrate-v4-shared";
import { policyVaultAbi } from "@/lib/contracts/policy-vault";
import { policyVaultV3Abi } from "@/lib/contracts/policy-vault-v3";
import { getOgNetwork } from "@/lib/og/networks";

export const runtime = "nodejs";

const MAINNET_CHAIN_ID = 16661;

const requestSchema = z.object({
  wallet: z.object({
    address: z.string().trim().refine((value) => isAddress(value), "invalid address"),
    chainId: z.number().int().positive(),
  }),
});

interface AgentRecordSummary {
  agentId: string;
  agentKey: Hex;
}

export async function POST(request: Request) {
  const parsed = requestSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return planError("invalid_request", "V4 migration plan request was not valid.", 400);
  }
  if (parsed.data.wallet.chainId !== MAINNET_CHAIN_ID) {
    return planError("mainnet_required", `Migrate to V4 requires 0G mainnet (${MAINNET_CHAIN_ID}).`, 409);
  }

  const owner = getAddress(parsed.data.wallet.address);
  const network = getOgNetwork("mainnet");
  const rpcUrl = process.env.OG_RPC_URL?.trim() || network.rpcUrl;
  const publicClient = createPublicClient({ chain: make0GMainnetChain(rpcUrl), transport: http(rpcUrl) });
  const chainId = await publicClient.getChainId();
  if (chainId !== MAINNET_CHAIN_ID) {
    return planError("chain_mismatch", `RPC chain mismatch: expected ${MAINNET_CHAIN_ID}, got ${chainId}.`, 500);
  }

  try {
    const [v4, v3Source, v2Versions, roster] = await Promise.all([
      resolveMainnetV4VaultForOwner(owner, undefined, publicClient),
      resolveLatestV3Source(owner, publicClient),
      resolveMainnetVaultVersionsForOwner(owner, publicClient),
      readAgentRoster(),
    ]);
    const source = v3Source ?? v2Versions.at(-1) ?? null;
    const agentRecords = source ? agentRecordsForVault(roster, source.vault) : [];
    const blockingIssues: string[] = [];
    let inventory: V3VaultInventory | null = null;
    let inventoryHash: Hex | null = null;

    if (source?.version === 3) {
      inventory = await inventoryV3Vault({ publicClient }, source.vault, agentRecords.map((record) => record.agentId));
      inventoryHash = hashVaultInventory(inventory);
    }

    if (!source && v4) {
      blockingIssues.push("already_v4");
    }
    if (!source && !v4) {
      blockingIssues.push("no_legacy_vault");
    }

    const plan = {
      agentKeys: agentRecords.map((record) => record.agentKey),
      blockingIssues,
      inventory: inventory
        ? {
            fromBlock: inventory.fromBlock,
            nativeBalance0G: inventory.nativeBalance0G,
            nfts: inventory.nfts,
            scannedToBlock: inventory.scannedToBlock,
            tokenBalances: inventory.tokenBalances,
          }
        : null,
      inventoryHash,
      needsV4Deploy: !v4,
      source: source ? { vault: source.vault, version: source.version } : null,
      v4Trio: v4 ? normalizeV4Trio(v4) : null,
    };
    const planHash = sha256(stringToBytes(canonicalize(plan))) as Hex;
    return NextResponse.json({ data: { ...plan, planHash }, meta: { chainId, network: "mainnet" } });
  } catch (error) {
    if (error instanceof OgAgentDeployError) {
      return planError(error.code, error.message, error.status);
    }
    return planError("plan_failed", error instanceof Error ? error.message : "Unable to build V4 migration plan.", 500);
  }
}

async function resolveLatestV3Source(owner: Address, publicClient: ReturnType<typeof createPublicClient>) {
  const registry = await readMainnetV3VaultRegistry();
  const entries = registry
    .filter((entry) => entry.owner.toLowerCase() === owner.toLowerCase())
    .filter((entry) => isAddress(entry.vault));
  const entry = entries.at(-1);
  if (!entry) return null;
  const vault = getAddress(entry.vault);
  const onChainOwner = await publicClient.readContract({
    address: vault,
    abi: policyVaultV3Abi,
    functionName: "owner",
  }).catch(() => null) as Address | null;
  if (!onChainOwner || onChainOwner.toLowerCase() !== owner.toLowerCase()) {
    return null;
  }
  return { vault, version: 3 };
}

async function readAgentRoster(): Promise<Array<OgAgentDeploymentRecord | OgRemovedAgentRecord>> {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const raw = await readFile(join(process.cwd(), ".data", "agents", "mainnet-agents.json"), "utf8").catch(() => "{\"agents\":[]}");
  const parsed = JSON.parse(raw) as { agents?: OgAgentDeploymentRecord[]; removedAgents?: OgRemovedAgentRecord[] };
  return [...(parsed.agents ?? []), ...(parsed.removedAgents ?? [])];
}

function agentRecordsForVault(records: Array<OgAgentDeploymentRecord | OgRemovedAgentRecord>, vault: Address): AgentRecordSummary[] {
  return records
    .filter((record) => record.vault && record.vault.toLowerCase() === vault.toLowerCase())
    .map((record) => ({ agentId: record.id, agentKey: record.agentKey ?? agentKeyForDeployment(record) }));
}

function normalizeV4Trio(input: V4VaultTrio): V4VaultTrio {
  return {
    lpEntryVault: getAddress(input.lpEntryVault),
    lpExitVault: getAddress(input.lpExitVault),
    swapVault: getAddress(input.swapVault),
  };
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

function planError(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message } }, { status });
}

function make0GMainnetChain(rpcUrl: string): Chain {
  return {
    id: MAINNET_CHAIN_ID,
    name: "0G Mainnet",
    nativeCurrency: { decimals: 18, name: "0G", symbol: "0G" },
    rpcUrls: { default: { http: [rpcUrl] } },
  };
}
