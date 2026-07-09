// Bulk registry tombstone for EVERY active agent of the given owner wallets (or all owners).
//
// Unlike scripts/tombstone-agent-record.ts (which only sees agents already written into this
// registry), this reconstructs each owner's roster with includeOnChain: true, so it also
// tombstones agents that were minted from another environment (e.g. a local dev machine) and
// only exist on-chain — the exact case where a local-only "Remove" never tombstoned the agent
// in the prod registry, so it keeps re-appearing on the web.
//
// This is pure registry I/O: it does NOT disable the on-chain agent key, exit positions, or move
// funds. It refuses to tombstone an agent whose vault(s) still hold native 0G unless --force, so
// a funded agent is never silently orphaned (wind those down with scripts/lp-cleanup-agent.ts).
//
// Dry-run by default — pass --execute to actually write.
//
// MUST run inside the Railway container (via `railway ssh`) so it writes the prod volume
// registry at $OG_AGENT_DATA_DIR/mainnet-agents.json, not a local file.
//
// Usage (inside the container):
//   npm run tombstone:owners                 # dry-run, ALL owners
//   npm run tombstone:owners -- --execute     # write, ALL owners
//   npm run tombstone:owners -- --owner 0xabc... --owner 0xdef... --execute
//   npm run tombstone:owners -- --execute --force   # also tombstone funded vaults (careful)

import dotenv from "dotenv";
import { createPublicClient, formatEther, getAddress, http, isAddress, type Address, type Chain } from "viem";

import { listAllActiveAgentsIncludingOnChain, removeSingleOgAgentRecord } from "../lib/agent/single-agent-server";
import type { OgAgentDeploymentRecord } from "../lib/agent/single-agent";

dotenv.config({ path: ".env.local", quiet: true });

const preferredMainnetRpc = process.env.OG_MAINNET_RPC_URL?.trim();
if (preferredMainnetRpc) {
  process.env.OG_RPC_URL = preferredMainnetRpc;
}

interface Args {
  owners: Set<string>;
  execute: boolean;
  force: boolean;
  removedBy?: Address;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { owners: new Set(), execute: false, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--owner") {
      const owner = readNext(argv, ++i, value);
      if (!isAddress(owner)) throw new Error(`--owner must be a valid address: ${owner}`);
      args.owners.add(getAddress(owner).toLowerCase());
    } else if (value === "--execute") args.execute = true;
    else if (value === "--dry-run") args.execute = false;
    else if (value === "--force") args.force = true;
    else if (value === "--removed-by") {
      const by = readNext(argv, ++i, value);
      if (!isAddress(by)) throw new Error(`--removed-by must be a valid address: ${by}`);
      args.removedBy = getAddress(by);
    } else if (value === "--help" || value === "-h") {
      console.log(
        "Usage: npm run tombstone:owners -- [--dry-run|--execute] [--force] [--owner 0x.. ...] [--removed-by 0x..]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
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

function vaultAddresses(record: OgAgentDeploymentRecord): Address[] {
  const raw = [record.vault, record.v4SwapVault, record.v4LpEntryVault, record.v4LpExitVault];
  const seen = new Set<string>();
  const out: Address[] = [];
  for (const address of raw) {
    if (!address) continue;
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(address);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rpcUrl = process.env.OG_RPC_URL?.trim() || "https://evmrpc.0g.ai";
  const client = createPublicClient({
    chain: make0GMainnetChain(rpcUrl),
    transport: http(rpcUrl, { retryCount: 3, timeout: 12_000 }),
  });

  const all = await listAllActiveAgentsIncludingOnChain();
  const targets = args.owners.size === 0
    ? all
    : all.filter((record) => args.owners.has(record.owner.toLowerCase()));

  console.log(
    JSON.stringify({
      mode: args.execute ? "execute" : "dry-run",
      ownerFilter: args.owners.size === 0 ? "ALL" : [...args.owners],
      activeAgentsFound: all.length,
      targeted: targets.length,
    }),
  );

  let tombstoned = 0;
  let skippedFunded = 0;
  for (const record of targets) {
    const vaults = vaultAddresses(record);
    const balances = await Promise.all(
      vaults.map((address) => client.getBalance({ address }).catch(() => null)),
    );
    let total = 0n;
    let readFailed = false;
    for (const balance of balances) {
      if (balance === null) {
        readFailed = true;
        continue;
      }
      if (balance > 0n) total += balance;
    }
    const funded = total > 0n;

    const base = {
      id: record.id,
      name: record.name,
      owner: record.owner,
      filters: record.filters,
      balance0G: formatEther(total),
      balanceReadIncomplete: readFailed || undefined,
    };

    if (funded && !args.force) {
      skippedFunded += 1;
      console.log(JSON.stringify({ ...base, skipped: "vault-funded — pass --force to tombstone anyway" }));
      continue;
    }

    if (!args.execute) {
      console.log(JSON.stringify({ ...base, action: "would-tombstone" }));
      continue;
    }

    const removed = await removeSingleOgAgentRecord(record.id, record, args.removedBy, undefined);
    if (removed) tombstoned += 1;
    console.log(JSON.stringify({ ...base, tombstoned: Boolean(removed) }));
  }

  console.log(
    JSON.stringify({
      done: true,
      mode: args.execute ? "execute" : "dry-run",
      targeted: targets.length,
      tombstoned,
      skippedFunded,
    }),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
