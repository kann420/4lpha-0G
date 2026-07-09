// Registry-only tombstone for stale agent records.
//
// Moves an agent from the active roster into `removedAgents` in
// .data/agents/mainnet-agents.json via removeSingleOgAgentRecord. This is pure
// registry I/O — it does NOT disable the on-chain agent key, exit positions, or
// withdraw funds. Use it to clear abandoned test records that block the
// per-wallet deploy quota (assertAgentTypeQuota).
//
// SAFETY: refuses to tombstone a record whose vault still holds native 0G unless
// --force is passed, so a funded agent is never silently orphaned. Funded agents
// should be wound down with scripts/lp-cleanup-agent.ts (exit -> disable -> withdraw)
// instead.
//
// Usage:
//   node --conditions=react-server --import tsx scripts/tombstone-agent-record.ts --dry-run --id agent-0g-mainnet-7 --id agent-0g-mainnet-8
//   node --conditions=react-server --import tsx scripts/tombstone-agent-record.ts --id agent-0g-mainnet-7 --id agent-0g-mainnet-8

import dotenv from "dotenv";
import { createPublicClient, formatEther, http, type Address, type Chain } from "viem";

import { removeSingleOgAgentRecord } from "../lib/agent/single-agent-server";

dotenv.config({ path: ".env.local", quiet: true });

const preferredMainnetRpc = process.env.OG_MAINNET_RPC_URL?.trim();
if (preferredMainnetRpc) {
  process.env.OG_RPC_URL = preferredMainnetRpc;
}

interface Args {
  ids: string[];
  dryRun: boolean;
  force: boolean;
  removedBy?: Address;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { ids: [], dryRun: false, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--id") args.ids.push(readNext(argv, ++i, value));
    else if (value === "--dry-run") args.dryRun = true;
    else if (value === "--force") args.force = true;
    else if (value === "--removed-by") args.removedBy = readNext(argv, ++i, value) as Address;
    else if (value === "--help" || value === "-h") {
      console.log(
        "Usage: node --conditions=react-server --import tsx scripts/tombstone-agent-record.ts [--dry-run] [--force] --id agent-0g-mainnet-N [--id ...] [--removed-by 0x..]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  if (args.ids.length === 0) throw new Error("At least one --id agent-0g-mainnet-N is required.");
  for (const id of args.ids) {
    if (!/^agent-0g-mainnet-\d+$/u.test(id)) throw new Error(`--id must match /^agent-0g-mainnet-\\d+$/u: ${id}`);
  }
  return args;
}

function readNext(argv: string[], i: number, flag: string): string {
  const value = argv[i];
  if (value === undefined) throw new Error(`${flag} requires a value.`);
  return value;
}

function make0GMainnetChain(rpcUrl: string): Chain {
  return {
    id: 16661,
    name: "0G Mainnet",
    nativeCurrency: { decimals: 18, name: "0G", symbol: "0G" },
    rpcUrls: { default: { http: [rpcUrl] } },
    blockExplorers: { default: { name: "0G ChainScan", url: "https://chainscan.0g.ai" } },
  };
}

interface RegistryRecord {
  id: string;
  vault?: string;
  owner?: string;
  filters?: string[];
}

async function readRegistry(): Promise<{ agents: RegistryRecord[] }> {
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(".data/agents/mainnet-agents.json", "utf8");
  return JSON.parse(raw) as { agents: RegistryRecord[] };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const registry = await readRegistry();
  const rpcUrl = process.env.OG_RPC_URL?.trim() || "https://evmrpc.0g.ai";
  const client = createPublicClient({
    chain: make0GMainnetChain(rpcUrl),
    transport: http(rpcUrl, { retryCount: 2, timeout: 10_000 }),
  });

  for (const id of args.ids) {
    const record = registry.agents.find((agent) => agent.id === id);
    if (!record) {
      console.log(JSON.stringify({ id, skipped: "not-in-active-registry" }));
      continue;
    }
    const vault = record.vault as Address | undefined;
    const balance = vault ? await client.getBalance({ address: vault }).catch(() => null) : null;
    const balance0G = balance === null ? "read-failed" : formatEther(balance);
    const funded = balance !== null && balance > 0n;

    if (funded && !args.force) {
      console.log(
        JSON.stringify({
          id,
          vault,
          balance0G,
          skipped: "vault-funded — wind down with lp-cleanup-agent.ts, or pass --force",
        }),
      );
      continue;
    }

    if (args.dryRun) {
      console.log(JSON.stringify({ id, vault, balance0G, filters: record.filters, action: "would-tombstone" }));
      continue;
    }

    const removed = await removeSingleOgAgentRecord(id, undefined, args.removedBy, undefined);
    console.log(JSON.stringify({ id, vault, balance0G, tombstoned: Boolean(removed) }));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
