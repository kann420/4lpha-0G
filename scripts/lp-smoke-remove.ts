// Mainnet LP remove smoke test — mirrors the LpAgentDetailPage Remove handler
// server-side using the DEPLOYER (owner) key. Flow:
//   STEP 0: status-pause (off-chain deployment.paused=true, key STAYS enabled so
//           zap-out works) — worker-race guard so the autonomous loop cannot
//           mint a new position mid-close that would be orphaned after remove.
//   close-all: per position (sorted by pool): unstake (if staked) -> zap-out.
//           40s sleep BEFORE each route's live load (quiknode 429 guard — each
//           loadOgAgentWorkspace({live:true}) is ~12 on-chain reads, and quiknode
//           429s at ~52 reads/min under burst; 40s spacing keeps it ~18/min).
//           Throw on any failure -> abort, record + remaining positions intact.
//   verify: 40s sleep + re-read; if positions remain, ABORT (do not remove).
//   disable-key: on-chain setAgentKeyEnabled(false).
//   remove: removeSingleOgAgentRecord (file-only, no on-chain load).
//   withdraw: full vault native 0G back to owner.
//
// Real on-chain txs, real gas, IRREVERSIBLE. No commit. DEPLOYER pays gas +
// must be the agent's vault owner. Reuses the in-process route pattern from
// lp-cleanup-agent.ts (signed owner action-consent + route validation) and
// library helpers for setAgentKeyEnabled / removeSingleOgAgentRecord /
// withdrawMainnetVaultNative.
//
// Usage:
//   node --conditions=react-server --import tsx scripts/lp-smoke-remove.ts --agent-id agent-0g-mainnet-23

import dotenv from "dotenv";
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  parseEther,
  type Address,
  type Chain,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { POST as statusPost } from "../app/api/agents/status/route";
import { POST as unstakePost } from "../app/api/agents/lp/[id]/unstake/route";
import { POST as zapOutPost } from "../app/api/agents/lp/[id]/zap-out/route";
import { makeMainnetPublicClient } from "../lib/agent/lp/lp-context";
import { withdrawMainnetVaultNative } from "../lib/agent/mainnet-vault-withdraw";
import {
  agentKeyForDeployment,
  loadOgAgentWorkspace,
  removeSingleOgAgentRecord,
} from "../lib/agent/single-agent-server";
import type { OgAgentDeploymentRecord, OgAgentVaultLpPosition } from "../lib/agent/single-agent";
import { issueActionNonce } from "../lib/copilot/action-nonce-store";
import { buildCopilotActionConsentMessage, buildCopilotWalletAccessMessage } from "../lib/copilot/wallet-access";
import { policyVaultV3Abi } from "../lib/contracts/policy-vault-v3";

dotenv.config({ path: ".env.local", quiet: true });

// Use the PUBLIC 0G mainnet RPC (evmrpc.0g.ai) for the remove flow — quiknode
// is in a sustained 429 rate-limit window (per-second burst cap) that fails even
// isolated workspace loads (a single loadOgAgentWorkspace bursts ~12 reads in
// <1s, exceeding the per-second cap). Public has no hard per-second limit; the
// retry config below + 60s pacing handle its transient flakiness. Both
// makeMainnetPublicClient (lp-context) and create0GPublicClient
// (single-agent-server, used by the in-process routes) read OG_RPC_URL, so
// setting it here covers the routes too (they run in-process).
process.env.OG_RPC_URL = "https://evmrpc.0g.ai";
process.env.OG_MAINNET_RPC_URL = "https://evmrpc.0g.ai";
process.env.OG_RPC_RETRY_COUNT = "8";
process.env.OG_RPC_RETRY_DELAY_MS = "700";
process.env.OG_PUBLIC_RPC_RETRY_COUNT = "8";
process.env.OG_PUBLIC_RPC_RETRY_DELAY_MS = "700";

const CHAIN_ID = 16661;
const RATE_LIMIT_SLEEP_MS = 30_000;

function parseArgs(argv: string[]): { agentId: string } {
  let agentId = "agent-0g-mainnet-23";
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--agent-id") {
      agentId = argv[++i];
      if (!agentId) throw new Error("--agent-id requires a value.");
    } else if (value === "--help" || value === "-h") {
      console.log("Usage: lp-smoke-remove.ts --agent-id agent-0g-mainnet-23");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  if (!/^agent-0g-mainnet-\d+$/u.test(agentId)) {
    throw new Error("--agent-id must match /^agent-0g-mainnet-\\d+$/u");
  }
  return { agentId };
}

function readPrivateKeyEnv(name: string): Hex {
  const value = process.env[name]?.trim();
  if (!value || !/^0x[0-9a-fA-F]{64}$/u.test(value)) {
    throw new Error(`${name} must be a 0x-prefixed 32-byte private key.`);
  }
  return value as Hex;
}

function make0GMainnetChain(rpcUrl: string): Chain {
  return {
    id: CHAIN_ID,
    name: "0G Mainnet",
    nativeCurrency: { decimals: 18, name: "0G", symbol: "0G" },
    rpcUrls: { default: { http: [rpcUrl] } },
    blockExplorers: { default: { name: "0G ChainScan", url: "https://chainscan.0g.ai" } },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(stage: string, data: Record<string, unknown>) {
  console.log(JSON.stringify({ stage, ...data }));
}

async function rateLimitSleep(before: string) {
  log("rate-limit-sleep", { before, waitSeconds: RATE_LIMIT_SLEEP_MS / 1000 });
  await sleep(RATE_LIMIT_SLEEP_MS);
}

async function statusPause(agentId: string, owner: Address, account: ReturnType<typeof privateKeyToAccount>) {
  const message = buildCopilotWalletAccessMessage({ address: owner, chainId: CHAIN_ID, networkId: "mainnet" });
  const signature = await account.signMessage({ message });
  const request = new Request("http://localhost/api/agents/status", {
    body: JSON.stringify({ action: "pause", agentId, networkId: "mainnet", wallet: { address: owner, chainId: CHAIN_ID, message, signature } }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const response = await statusPost(request);
  const json = (await response.json()) as { data?: unknown; error?: { code?: string; message?: string } };
  if (!response.ok || !json.data) {
    throw new Error(`status:pause failed: ${json.error?.code ?? response.status} ${json.error?.message ?? response.statusText}`);
  }
  return json.data as { deployment: OgAgentDeploymentRecord };
}

async function lpExit({
  account, action, agentId, owner, vault, poolAddress, tokenId, path,
}: {
  account: ReturnType<typeof privateKeyToAccount>;
  action: "lp-unstake" | "lp-zap-out";
  agentId: string; owner: Address; vault: Address; poolAddress: Address; tokenId: string; path: "unstake" | "zap-out";
}) {
  const nonce = issueActionNonce({ address: owner, scope: action });
  const message = buildCopilotActionConsentMessage({
    address: owner, agentId, chainId: CHAIN_ID, networkId: "mainnet", action, vault, poolAddress, tokenId,
    nonce: nonce.nonce, expiresAt: nonce.expiresAt,
  });
  const signature = await account.signMessage({ message });
  const route = path === "unstake" ? unstakePost : zapOutPost;
  const response = await route(
    new Request(`http://localhost/api/agents/lp/${agentId}/${path}`, {
      body: JSON.stringify({ expiresAt: nonce.expiresAt, nonce: nonce.nonce, poolAddress, tokenId, wallet: { address: owner, chainId: CHAIN_ID, message, signature } }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    }),
    { params: Promise.resolve({ id: agentId }) },
  );
  const json = (await response.json()) as { data?: { lpTxHash?: Hex; proofTxHash?: Hex; amountOutMin?: string }; error?: { code?: string; message?: string } };
  if (!response.ok || !json.data) {
    throw new Error(`${path} failed for tokenId ${tokenId}: ${json.error?.code ?? response.status} ${json.error?.message ?? response.statusText}`);
  }
  return json.data;
}

async function readState(agentId: string, owner: Address) {
  const workspace = await loadOgAgentWorkspace({ agentId, live: true, ownerAddress: owner });
  const deployment = workspace.agent.deployment;
  if (!deployment) throw new Error(`No deployed agent for ${agentId}.`);
  const publicClient = makeMainnetPublicClient();
  const agentKey = (deployment.agentKey ?? agentKeyForDeployment(deployment)) as Hex;
  const agentKeyEnabled = await publicClient
    .readContract({ address: deployment.vault, abi: policyVaultV3Abi, functionName: "agentKeyEnabled", args: [agentKey] })
    .catch(() => "read-failed" as const);
  const vaultBalance = await publicClient.getBalance({ address: deployment.vault });
  return {
    deployment, vault: deployment.vault, agentKey, agentKeyEnabled,
    status: workspace.agent.status, paused: deployment.paused,
    vaultBalance0G: formatEther(vaultBalance),
    positions: (workspace.vault.sellableLpPositions ?? []) as OgAgentVaultLpPosition[],
  };
}

async function disableKey(state: Awaited<ReturnType<typeof readState>>, owner: Address): Promise<Hex> {
  const rpcUrl = process.env.OG_RPC_URL?.trim();
  if (!rpcUrl) throw new Error("OG_RPC_URL is required.");
  const chain = make0GMainnetChain(rpcUrl);
  const deployer = privateKeyToAccount(readPrivateKeyEnv("DEPLOYER_PRIVATE_KEY"));
  if (deployer.address.toLowerCase() !== owner.toLowerCase()) {
    throw new Error("DEPLOYER_PRIVATE_KEY must match the agent owner address.");
  }
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl, { retryCount: 0, timeout: 8_000 }) });
  const walletClient = createWalletClient({ account: deployer, chain, transport: http(rpcUrl) });
  const txHash = await walletClient.writeContract({
    address: state.vault, abi: policyVaultV3Abi, functionName: "setAgentKeyEnabled", args: [state.agentKey, false], account: deployer, chain,
  });
  log("disable-key", { txHash, action: "submitted" });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 2 });
  if (receipt.status !== "success") throw new Error(`disable-key tx reverted: ${txHash}`);
  const after = (await publicClient.readContract({ address: state.vault, abi: policyVaultV3Abi, functionName: "agentKeyEnabled", args: [state.agentKey] })) as boolean;
  if (after !== false) throw new Error(`agentKeyEnabled still true after ${txHash}`);
  log("disable-key", { txHash, agentKeyEnabled: after, status: "confirmed" });
  return txHash;
}

async function finalize(agentId: string, owner: Address, state: Awaited<ReturnType<typeof readState>>) {
  const disableTx = await disableKey(state, owner);
  log("remove", { action: "begin" });
  const removed = await removeSingleOgAgentRecord(agentId, state.deployment, owner, disableTx);
  log("remove", { removed: Boolean(removed), agentId, disableTx });
  // 40s before withdraw's balance reads (rate-limit guard).
  await rateLimitSleep("withdraw");
  const balanceWei = parseEther(state.vaultBalance0G);
  if (balanceWei > 0n) {
    log("withdraw", { amount0G: state.vaultBalance0G });
    const w = await withdrawMainnetVaultNative({ owner, amount0G: state.vaultBalance0G });
    log("withdraw", { txHash: w.txHash, amount0G: w.amount0G, balanceBefore0G: w.balanceBefore0G, balanceAfter0G: w.balanceAfter0G });
  } else {
    log("withdraw", { skipped: "vault-balance-zero" });
  }
  log("done", { agentId, note: "Agent retired: positions closed, key disabled, record removed (read-only), vault native withdrawn to owner." });
}

async function main() {
  const { agentId } = parseArgs(process.argv.slice(2));
  const account = privateKeyToAccount(readPrivateKeyEnv("DEPLOYER_PRIVATE_KEY"));
  const owner = account.address as Address;
  log("start", { agentId, owner });

  // Initial read (first load — no sleep before).
  const initial = await readState(agentId, owner);
  log("initial-state", {
    status: initial.status, paused: initial.paused, agentKeyEnabled: initial.agentKeyEnabled,
    vault: initial.vault, vaultBalance0G: initial.vaultBalance0G,
    positions: initial.positions.map((p) => ({ tokenId: p.tokenId, pool: p.poolLabel, staked: p.staked, liquidity: p.liquidity })),
  });

  // STEP 0: off-chain status-pause (worker-race guard). Key stays enabled for zap-out.
  await rateLimitSleep("status-pause");
  log("step0", { action: "status-pause" });
  const paused = await statusPause(agentId, owner, account);
  log("step0", { action: "status-pause-done", paused: paused.deployment.paused });

  if (initial.positions.length === 0) {
    log("close-all", { skipped: "no-positions", note: "Going straight to verify + disable-key + remove + withdraw." });
    await rateLimitSleep("verify");
    const postClose = await readState(agentId, owner);
    log("verify", { positionsRemaining: postClose.positions.length, vaultBalance0G: postClose.vaultBalance0G });
    if (postClose.positions.length > 0) {
      throw new Error(`ABORT: ${postClose.positions.length} positions appeared before remove — not removing. Remaining: ${postClose.positions.map((p) => p.tokenId).join(",")}`);
    }
    await finalize(agentId, owner, postClose);
    return;
  }

  // Close-all: sort by pool so same-pool positions are spaced by the sleep.
  const sorted = [...initial.positions].sort((a, b) => (a.poolLabel ?? "").localeCompare(b.poolLabel ?? ""));
  for (let i = 0; i < sorted.length; i += 1) {
    const position = sorted[i]!;
    log("close-all", { position: i + 1, of: sorted.length, tokenId: position.tokenId, pool: position.poolLabel, staked: position.staked });

    if (position.staked) {
      await rateLimitSleep(`unstake-${position.tokenId}`);
      const unstakeRes = await lpExit({ account, action: "lp-unstake", agentId, owner, vault: initial.vault, poolAddress: position.poolAddress, tokenId: position.tokenId, path: "unstake" });
      log("close-all", { stage: "unstake-done", tokenId: position.tokenId, lpTxHash: unstakeRes.lpTxHash, proofTxHash: unstakeRes.proofTxHash });
    }

    // 40s before zap-out load (rate-limit + unstake indexing).
    await rateLimitSleep(`zap-out-${position.tokenId}`);
    const zapRes = await lpExit({ account, action: "lp-zap-out", agentId, owner, vault: initial.vault, poolAddress: position.poolAddress, tokenId: position.tokenId, path: "zap-out" });
    log("close-all", { stage: "zap-out-done", tokenId: position.tokenId, lpTxHash: zapRes.lpTxHash, proofTxHash: zapRes.proofTxHash, amountOutMin: zapRes.amountOutMin });
  }

  // Post-loop verification: 40s sleep then re-read + confirm 0 positions.
  await rateLimitSleep("verify");
  const postClose = await readState(agentId, owner);
  log("verify", { positionsRemaining: postClose.positions.length, vaultBalance0G: postClose.vaultBalance0G });
  if (postClose.positions.length > 0) {
    throw new Error(`ABORT: ${postClose.positions.length} positions remain after close-all — not removing. Remaining: ${postClose.positions.map((p) => p.tokenId).join(",")}`);
  }

  await finalize(agentId, owner, postClose);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});