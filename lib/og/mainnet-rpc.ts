import { fallback, http, type Transport } from "viem";

function toInt(value: string | undefined, fallbackValue: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallbackValue;
}

/**
 * Shared 0G mainnet transport.
 *
 * PRIMARY = public `evmrpc.0g.ai` (`OG_RPC_URL`) — it has NO daily request cap, so it is the safe
 * default for sustained agent/worker load. FALLBACK = quiknode (`OG_MAINNET_RPC_URL`) — faster and
 * JSON-RPC-batched, but it has a daily request quota (returns "daily request limit reached" once
 * exhausted, which is NOT a network failure and so does not always trigger viem's fallback). Keeping
 * quiknode as the fallback means a quiknode outage/cap can never stall the whole system.
 *
 * The public leg stays un-batched (the public RPC may not support JSON-RPC batches); the quiknode
 * fallback leg keeps batching. `retryCount`/`retryDelay` come from `OG_RPC_RETRY_COUNT` /
 * `OG_RPC_RETRY_DELAY_MS` so a transient 429/5xx/network error backs off (viem never retries reverts).
 * Pass `primaryOverride` to force a specific primary URL.
 */
export function makeMainnetTransport(primaryOverride?: string): Transport {
  const publicRpc = (primaryOverride ?? process.env.OG_RPC_URL)?.trim() || undefined;
  const quiknode = process.env.OG_MAINNET_RPC_URL?.trim() || undefined;
  const retryCount = toInt(process.env.OG_RPC_RETRY_COUNT, 3);
  const retryDelay = toInt(process.env.OG_RPC_RETRY_DELAY_MS, 800);
  const base = { retryCount, retryDelay, timeout: 20_000 } as const;

  const transports: Transport[] = [];
  if (publicRpc) {
    transports.push(http(publicRpc, base)); // un-batched: public RPC may not support JSON-RPC batches
  }
  if (quiknode && quiknode !== publicRpc) {
    transports.push(http(quiknode, { ...base, batch: { batchSize: 15, wait: 20 } }));
  }
  if (transports.length === 0) {
    throw new Error("No mainnet RPC configured (set OG_RPC_URL or OG_MAINNET_RPC_URL).");
  }
  // rank:false keeps the public RPC as the fixed primary (quiknode only used on failure),
  // rather than viem probing latency and possibly promoting the daily-capped quiknode.
  return transports.length === 1 ? transports[0] : fallback(transports, { rank: false });
}
