import "dotenv/config";

import { createPublicClient, formatEther, getAddress, http, isAddress, type Address } from "viem";
import { uniqueCuratedMainnetTokens } from "@/lib/contracts/curated-routes";
import { OG_NETWORKS } from "@/lib/og/networks";
import type { AiScanResponse } from "@/lib/types/ai-scan";

const TOKEN_LIMIT = Number.parseInt(process.env.AI_SCAN_TOKEN_SMOKE_LIMIT ?? "", 10);
const WALLET_LIMIT = Number.parseInt(process.env.AI_SCAN_WALLET_SMOKE_LIMIT ?? "", 10);
const API_BASE_URL = normalizeBaseUrl(process.env.AI_SCAN_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://127.0.0.1:3001");

const tokenLimit = Number.isFinite(TOKEN_LIMIT) && TOKEN_LIMIT > 0 ? TOKEN_LIMIT : undefined;
const walletLimit = Number.isFinite(WALLET_LIMIT) && WALLET_LIMIT > 0 ? WALLET_LIMIT : 3;
const tokens = uniqueCuratedMainnetTokens().slice(0, tokenLimit);

console.log(`AI Scan smoke: ${tokens.length} curated mainnet token(s), ${walletLimit} wallet candidate(s), api=${API_BASE_URL}`);

for (const token of tokens) {
  const report = await postAiScan({
    address: token,
    mode: "honeypot",
    networkId: "mainnet",
    targetType: "token",
  });
  const routeStatus = report.routeRecommendation?.status ?? "missing";
  console.log(
    [
      "token",
      report.targetLabel,
      token,
      `score=${report.score}`,
      `verdict=${report.verdict}`,
      `route=${routeStatus}`,
    ].join(" | "),
  );
}

const walletCandidates = await findRecentWalletCandidates(walletLimit);
if (walletCandidates.length === 0) {
  throw new Error("No recent wallet candidates found in the 0G mainnet block window.");
}

for (const wallet of walletCandidates) {
  const report = await postAiScan({
    address: wallet,
    mode: "wallet-risk",
    networkId: "mainnet",
    targetType: "wallet",
  });
  const portfolio = report.sections.find((section) => section.title === "Portfolio");
  const portfolioSummary = portfolio?.items[0]?.metrics?.join(", ") ?? "portfolio unavailable";
  console.log(
    [
      "wallet",
      wallet,
      `score=${report.score}`,
      `verdict=${report.verdict}`,
      portfolioSummary,
    ].join(" | "),
  );
}

async function postAiScan(body: {
  address: Address;
  mode: "honeypot" | "wallet-risk";
  networkId: "mainnet";
  targetType: "token" | "wallet";
}): Promise<NonNullable<AiScanResponse["data"]>["report"]> {
  const response = await fetch(`${API_BASE_URL}/api/ai-scan`, {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
    },
    method: "POST",
  });
  const payload = (await response.json()) as AiScanResponse;
  if (!response.ok || !payload.data?.report) {
    throw new Error(payload.error?.message ?? `AI Scan API returned ${response.status}`);
  }
  return payload.data.report;
}

async function findRecentWalletCandidates(limit: number): Promise<Address[]> {
  const rpcUrl = resolveMainnetRpcUrl();
  const publicClient = createPublicClient({
    transport: http(rpcUrl),
  });
  const chainId = await publicClient.getChainId();
  if (chainId !== OG_NETWORKS.mainnet.chainId) {
    throw new Error(`RPC chain mismatch: expected ${OG_NETWORKS.mainnet.chainId}, received ${chainId}`);
  }

  const latestBlock = await publicClient.getBlockNumber();
  const candidates: Address[] = [];
  const seen = new Set<string>();
  for (let offset = 0; offset < 32 && candidates.length < limit; offset += 1) {
    const blockNumber = latestBlock - BigInt(offset);
    if (blockNumber < 0n) {
      break;
    }

    const block = await publicClient.getBlock({ blockNumber, includeTransactions: true });
    for (const transaction of block.transactions) {
      if (typeof transaction === "string") {
        continue;
      }
      const addresses = [transaction.from, transaction.to].filter((value): value is Address => Boolean(value && isAddress(value)));
      for (const value of addresses) {
        const address = getAddress(value);
        const key = address.toLowerCase();
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        candidates.push(address);
        console.log(`candidate wallet ${address} from block ${blockNumber.toString()} value=${formatEther(transaction.value)} 0G`);
        if (candidates.length >= limit) {
          return candidates;
        }
      }
    }
  }
  return candidates;
}

function resolveMainnetRpcUrl(): string {
  const candidates = [process.env.OG_MAINNET_RPC_URL, process.env.OG_RPC_URL, OG_NETWORKS.mainnet.rpcUrl];
  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (!value) {
      continue;
    }
    try {
      const url = new URL(value);
      if (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname))) {
        return url.toString().replace(/\/+$/u, "");
      }
    } catch {}
  }
  return OG_NETWORKS.mainnet.rpcUrl;
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  return url.toString().replace(/\/+$/u, "");
}
