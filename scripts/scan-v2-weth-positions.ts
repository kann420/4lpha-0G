// Scan PolicyVaultV2 TradeExecutedV2 events on the deployer's V2 vault to
// attribute the WETH positionUnits to specific agentKeys. Used to find the
// orphaned agentKey that owns the WETH balance not covered by active agents.
//
// Read-only. No broadcast.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import dotenv from "dotenv";
dotenv.config({ path: ".env.local", quiet: true });

import { createPublicClient, getAddress, http, parseAbiItem, type Address, type Chain, type Hex } from "viem";

const MAINNET_CHAIN_ID = 16661;
const WETH: Address = getAddress("0x564770837Ef8bbF077cFe54E5f6106538c815B22");
const USDC_E: Address = getAddress("0x1f3AA82227281cA364bFb3d253B0f1af1Da6473E");

function makeChain(rpcUrl: string): Chain {
  return {
    id: MAINNET_CHAIN_ID,
    name: "0G Mainnet",
    nativeCurrency: { decimals: 18, name: "0G", symbol: "0G" },
    rpcUrls: { default: { http: [rpcUrl] } },
  };
}

const TRADE_EVENT = parseAbiItem(
  "event TradeExecutedV2(bytes32 indexed actionHash, bytes32 indexed agentKey, bool indexed isBuy, address token, uint256 amountIn, uint256 amountOut, bytes32 auditRoot, bytes32 policySnapshotHash)",
);

async function main() {
  const rpcUrl = process.env.OG_RPC_URL;
  if (!rpcUrl) throw new Error("Missing OG_RPC_URL");
  const vault = getAddress("0x20b45F0BC16837173a9090C6e9E991214ECc9f0d");
  const client = createPublicClient({ chain: makeChain(rpcUrl), transport: http(rpcUrl) });

  const latest = await client.getBlockNumber();
  const fromBlock = 37476922n; // V2 factory deploy block; vault created after this.
  console.log(`Scanning ${vault} from block ${fromBlock} to ${latest} for TradeExecutedV2...`);

  // Scan in chunks to avoid RPC limits.
  const CHUNK = 5000n;
  const perKey = new Map<string, { bought: bigint; sold: bigint; buys: number; sells: number }>();
  const perKeyToken = new Map<string, Map<string, { bought: bigint; sold: bigint }>>();

  for (let from = fromBlock; from <= latest; from += CHUNK) {
    const to = from + CHUNK - 1n > latest ? latest : from + CHUNK - 1n;
    let logs;
    try {
      logs = await client.getLogs({
        address: vault,
        event: TRADE_EVENT,
        fromBlock: from,
        toBlock: to,
      });
    } catch (e) {
      console.log(`  chunk ${from}-${to} error: ${(e as Error).message.slice(0, 120)}`);
      // Retry smaller
      for (let f2 = from; f2 <= to; f2 += 1000n) {
        const t2 = f2 + 999n > to ? to : f2 + 999n;
        try {
          const l2 = await client.getLogs({ address: vault, event: TRADE_EVENT, fromBlock: f2, toBlock: t2 });
          processLogs(l2, perKey, perKeyToken);
        } catch {}
      }
      continue;
    }
    processLogs(logs, perKey, perKeyToken);
    if (logs.length > 0) console.log(`  chunk ${from}-${to}: ${logs.length} logs`);
  }

  console.log("\nPer-agentKey net (all tokens):");
  for (const [key, v] of perKey) {
    console.log(`  key=${key} buys=${v.buys} bought=${v.bought.toString()} sells=${v.sells} sold=${v.sold.toString()} net=${(v.bought - v.sold).toString()}`);
  }

  console.log("\nPer-agentKey per-token (WETH + USDC.e only):");
  for (const [key, tokens] of perKeyToken) {
    for (const [token, v] of tokens) {
      if (token.toLowerCase() !== WETH.toLowerCase() && token.toLowerCase() !== USDC_E.toLowerCase()) continue;
      console.log(`  key=${key.slice(0, 10)}... token=${token} bought=${v.bought.toString()} sold=${v.sold.toString()} net=${(v.bought - v.sold).toString()}`);
    }
  }
}

function processLogs(
  logs: readonly { data: Hex; topics: readonly Hex[] }[],
  perKey: Map<string, { bought: bigint; sold: bigint; buys: number; sells: number }>,
  perKeyToken: Map<string, Map<string, { bought: bigint; sold: bigint }>>,
) {
  for (const log of logs) {
    // topics: [eventSig, actionHash, agentKey, isBuy]
    const agentKey = (log.topics[2] ?? "0x") as string;
    const isBuyTopic = (log.topics[3] ?? "0x") as string;
    const isBuy = isBuyTopic.toLowerCase() === "0x" + "0".repeat(63) + "1";
    // data: token (address, padded 32) + amountIn (uint256) + amountOut (uint256) + auditRoot + policySnapshotHash
    const token = ("0x" + log.data.slice(26, 66)) as Address;
    const amountIn = BigInt("0x" + log.data.slice(66, 130));
    const amountOut = BigInt("0x" + log.data.slice(130, 194));
    const entry = perKey.get(agentKey) ?? { bought: 0n, sold: 0n, buys: 0, sells: 0 };
    if (isBuy) {
      entry.bought += amountOut;
      entry.buys += 1;
    } else {
      entry.sold += amountIn;
      entry.sells += 1;
    }
    perKey.set(agentKey, entry);

    const tokMap = perKeyToken.get(agentKey) ?? new Map<string, { bought: bigint; sold: bigint }>();
    const tokEntry = tokMap.get(token.toLowerCase()) ?? { bought: 0n, sold: 0n };
    if (isBuy) tokEntry.bought += amountOut;
    else tokEntry.sold += amountIn;
    tokMap.set(token.toLowerCase(), tokEntry);
    perKeyToken.set(agentKey, tokMap);
  }
}

main().catch((e) => {
  console.error(`Scan failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});