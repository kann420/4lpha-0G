// One-shot backfill of the server-side LP position registry for an agent that
// minted BEFORE the registry write hook existed (or whose registry drifted).
// Enumerates mint tokenIds via getLogs (the path the listing path no longer
// uses on the hot path), validates each via readLpPositionByTokenId (scalar
// token-id reads, getLogs-free), and writes the live survivors to the registry.
// After backfill, the mint/zap-out hooks keep the registry in sync — re-run only
// after drift.
//
// Read-only on-chain (no tx, no gas). Acquires the worker file lock so it can-
// not race the autonomous worker's read-modify-write registry updates.
//
// Empty-authoritative guard: if getLogs returns 0 survivors AND on-chain
// openLpExposure0G > 0, FAIL (a flaky getLogs must NOT permanently hide real
// positions behind an empty registry). Write empty only when openLpExposure0G
// === 0 or --force-empty is passed.
//
// Usage:
//   node --conditions=react-server --import tsx scripts/lp-backfill-positions.ts --agent=agent-0g-mainnet-20 --dry-run
//   node --conditions=react-server --import tsx scripts/lp-backfill-positions.ts --agent=agent-0g-mainnet-20 --force

import dotenv from "dotenv";
import { mkdir, open, unlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createPublicClient, formatEther, getAddress, http, parseAbiItem, type Address, type Chain, type Hex, type PublicClient } from "viem";

import { agentKeyForDeployment, loadOgAgentWorkspace } from "../lib/agent/single-agent-server";
import { readLpPositionByTokenId } from "../lib/agent/lp/lp-exec";
import { writeLpPositionRegistry, type LpRegistryEntry, readLpPositionRegistry } from "../lib/agent/lp/lp-position-registry";
import { policyVaultV3Abi } from "../lib/contracts/policy-vault-v3";

dotenv.config({ path: ".env.local", quiet: true });

// Prefer the dedicated mainnet RPC (quiknode) for scalar readContract; only the
// getLogs call is flaky on quiknode (5-block cap on the discover plan), so getLogs
// + the per-token validation reads below go through the PUBLIC 0G RPC instead.
const preferredMainnetRpc = process.env.OG_MAINNET_RPC_URL?.trim();
if (preferredMainnetRpc) {
  process.env.OG_RPC_URL = preferredMainnetRpc;
}

const LP_MAINNET_CHAIN_ID = 16661;

// Public 0G RPC client for getLogs + per-token reads. quiknode (OG_RPC_URL) caps
// eth_getLogs at a 5-block range + rate-limits ~52 reads/min, so backfill would
// fail/flicker on quiknode. The public RPC (documented mainnet endpoint, not a
// secret) has neither cap. Configurable via OG_PUBLIC_RPC_URL.
function makePublicRpcClient(): PublicClient {
  const rpcUrl = process.env.OG_PUBLIC_RPC_URL?.trim() || "https://evmrpc.0g.ai";
  const chain: Chain = {
    id: LP_MAINNET_CHAIN_ID,
    name: "0G Mainnet",
    nativeCurrency: { decimals: 18, name: "0G", symbol: "0G" },
    rpcUrls: { default: { http: [rpcUrl] } },
  };
  return createPublicClient({ chain, transport: http(rpcUrl) });
}

// Vault deploy block — narrows getLogs to [deployBlock, latest] so the public
// RPC range stays small + fast even for agents deployed days ago.
async function readDeployBlock(client: PublicClient, deployTxHash: Hex): Promise<bigint | undefined> {
  const receipt = await client.getTransactionReceipt({ hash: deployTxHash }).catch(() => null);
  return receipt?.blockNumber;
}

const LOCAL_WORKER_LOCK_PATH = join(process.cwd(), ".data", "runtime", "og-agent-lp-worker.lock");
const lpActionExecutedV3Event = parseAbiItem(
  "event LpActionExecutedV3(bytes32 indexed actionHash, bytes32 indexed agentKey, uint8 indexed actionType, bytes32 poolId, uint256 tokenId, uint256 amountIn0G, uint256 amountOut, int256 liquidityDelta, bytes32 auditRoot, bytes32 policySnapshotHash)",
);

const GETLOGS_ATTEMPTS = 3;
const GETLOGS_BACKOFF_MS = 10_000;

interface Args {
  agentId: string;
  dryRun: boolean;
  force: boolean;
  forceEmpty: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { agentId: "", dryRun: false, force: false, forceEmpty: false };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--agent") args.agentId = readNext(argv, ++i, value);
    else if (value === "--dry-run") args.dryRun = true;
    else if (value === "--force") args.force = true;
    else if (value === "--force-empty") args.forceEmpty = true;
    else if (value === "--help" || value === "-h") {
      console.log(
        "Usage: node --conditions=react-server --import tsx scripts/lp-backfill-positions.ts --agent=<agentId> [--dry-run] [--force] [--force-empty]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  if (!args.agentId) throw new Error("--agent=<agentId> is required.");
  return args;
}

function readNext(argv: string[], i: number, flag: string): string {
  const value = argv[i];
  if (value === undefined) throw new Error(`${flag} requires a value.`);
  return value;
}

let lockHandle: FileHandle | null = null;

async function acquireWorkerLock(): Promise<void> {
  await mkdir(dirname(LOCAL_WORKER_LOCK_PATH), { recursive: true });
  try {
    lockHandle = await open(LOCAL_WORKER_LOCK_PATH, "wx");
    await writeFile(LOCAL_WORKER_LOCK_PATH, JSON.stringify({ heartbeatAt: Date.now(), pid: process.pid, op: "lp-backfill" }), "utf8");
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "EEXIST") {
      throw new Error(
        "Another local 0G LP agent worker is already running (lock exists). Stop it before running backfill, or remove .data/runtime/og-agent-lp-worker.lock if it is stale.",
      );
    }
    throw error;
  }
}

async function releaseWorkerLock(): Promise<void> {
  if (!lockHandle) return;
  await lockHandle.close().catch(() => undefined);
  lockHandle = null;
  await unlink(LOCAL_WORKER_LOCK_PATH).catch(() => undefined);
}

async function getMintLogsWithRetry(
  publicClient: PublicClient,
  vault: Address,
  agentKey: Hex,
  fromBlock: bigint,
): Promise<readonly { args: { actionType?: number; tokenId?: bigint } }[]> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= GETLOGS_ATTEMPTS; attempt += 1) {
    try {
      const logs = await publicClient.getLogs({
        address: vault,
        event: lpActionExecutedV3Event,
        args: { agentKey },
        fromBlock,
        toBlock: "latest",
      });
      return logs as readonly { args: { actionType?: number; tokenId?: bigint } }[];
    } catch (err) {
      lastErr = err;
      console.log(JSON.stringify({ stage: "getLogs-retry", attempt, error: err instanceof Error ? err.message : String(err) }));
      if (attempt < GETLOGS_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, GETLOGS_BACKOFF_MS));
    }
  }
  throw new Error(`getLogs failed after ${GETLOGS_ATTEMPTS} attempts: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const workspace = await loadOgAgentWorkspace({ agentId: args.agentId, live: true });
  const deployment = workspace.agent.deployment;
  if (!deployment) {
    throw new Error(`No deployment (active or removed) found for ${args.agentId}.`);
  }
  const vault = deployment.vault;
  const agentKey = (deployment.agentKey ?? agentKeyForDeployment(deployment)) as Hex;

  // Refuse to clobber an existing registry without --force.
  const existing = await readLpPositionRegistry(agentKey);
  if (existing && !args.force) {
    throw new Error(
      `Registry already exists for ${args.agentId} (${existing.positions.length} entries). Re-run with --force to overwrite from getLogs.`,
    );
  }

  await acquireWorkerLock();
  try {
    // Public 0G RPC for getLogs + per-token reads (quiknode caps getLogs at a
    // 5-block range + rate-limits ~52 reads/min, so the listing flickered empty
    // on quiknode — Bug 1). The public RPC handles the full range + per-token
    // reads for 10 positions in ~1s.
    const publicRpcClient = makePublicRpcClient();

    // On-chain openLpExposure0G — the authoritative "are there positions?" signal
    // used by the empty-authoritative guard.
    const openLpExposure = (await publicRpcClient.readContract({
      address: vault,
      abi: policyVaultV3Abi,
      functionName: "openLpExposure0G",
    })) as bigint;

    // Narrow getLogs to [deployBlock, latest] so the public RPC range is small
    // + fast even for agents deployed days ago.
    const deployBlock = deployment.deployTxHash
      ? await readDeployBlock(publicRpcClient, deployment.deployTxHash)
      : undefined;
    const fromBlock = deployBlock ?? 0n;

    console.log(JSON.stringify({
      stage: "read",
      agentId: args.agentId,
      vault,
      agentKey,
      vaultVersion: workspace.vault.vaultVersion,
      openLpExposure0G: formatEther(openLpExposure),
      deployBlock: deployBlock?.toString() ?? null,
      existingEntries: existing?.positions.length ?? 0,
      dryRun: args.dryRun,
    }, null, 2));

    const logs = await getMintLogsWithRetry(publicRpcClient, vault, agentKey, fromBlock);
    const candidateIds = new Set<string>();
    for (const log of logs) {
      if (Number(log.args.actionType ?? -1) === 2 && log.args.tokenId !== undefined) {
        candidateIds.add(log.args.tokenId.toString());
      }
    }
    console.log(JSON.stringify({ stage: "getLogs", mintLogs: logs.length, candidateTokenIds: candidateIds.size }));

    // Validate each candidate via readLpPositionByTokenId (scalar token-id reads,
    // no getLogs) — filters out burned / zapped-out / drift entries and gives us
    // the authoritative poolAddress. Use the public RPC client (quiknode rate-
    // limits the ~5 reads × N positions burst).
    const survivors: LpRegistryEntry[] = [];
    for (const tokenId of candidateIds) {
      const pos = await readLpPositionByTokenId(tokenId, vault, agentKey, publicRpcClient).catch(() => undefined);
      if (pos && pos.poolAddress) {
        survivors.push({ tokenId, poolAddress: getAddress(pos.poolAddress), addedAt: new Date().toISOString() });
        console.log(JSON.stringify({ stage: "survivor", tokenId, poolAddress: pos.poolAddress, deployedNative0G: pos.deployedNative0G, staked: pos.staked }));
      } else {
        console.log(JSON.stringify({ stage: "dropped", tokenId, reason: "readLpPositionByTokenId returned undefined (burned/zapped/drift)" }));
      }
    }

    // Empty-authoritative guard: do NOT write an empty registry when the vault
    // says there is open exposure — a flaky/partial getLogs must not permanently
    // hide real positions from the listing path.
    if (survivors.length === 0 && openLpExposure > 0n && !args.forceEmpty) {
      throw new Error(
        `Backfill found 0 live positions but openLpExposure0G=${formatEther(openLpExposure)} > 0 — getLogs likely returned partial/empty. Refusing to write an empty registry. Re-run, or pass --force-empty to override.`,
      );
    }

    if (args.dryRun) {
      console.log(JSON.stringify({ stage: "dry-run", wouldWrite: survivors.length, openLpExposure0G: formatEther(openLpExposure) }, null, 2));
      return;
    }

    await writeLpPositionRegistry({
      agentKey,
      vault: vault.toLowerCase() as Address,
      positions: survivors,
      updatedAt: new Date().toISOString(),
    });
    console.log(JSON.stringify({ stage: "done", written: survivors.length, openLpExposure0G: formatEther(openLpExposure) }));
  } finally {
    await releaseWorkerLock();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
  // Best-effort lock release on failure.
  releaseWorkerLock().catch(() => undefined);
});