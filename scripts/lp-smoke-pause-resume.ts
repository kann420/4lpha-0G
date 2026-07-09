// Mainnet LP pause/resume smoke test — exercises the same code paths the
// LpAgentDetailPage Pause/Resume buttons trigger, but server-side using the
// DEPLOYER (owner) key from env (the browser wallet cannot be driven headless).
//
// Flow: baseline worker dry-run -> PAUSE (status route + on-chain
// setAgentKeyEnabled(false)) -> worker dry-run (expect skip) -> RESUME
// (setAgentKeyEnabled(true) + status route "arm") -> worker dry-run (expect
// select). STOPS before remove — remove is run separately via
// lp-cleanup-agent.ts after explicit confirmation (it closes live positions
// and permanently retires the agent).
//
// Real on-chain txs (setAgentKeyEnabled x2, gas) — reversible. No commit.
// DEPLOYER pays gas. DEPLOYER must be the agent's vault owner.
//
// Usage:
//   node --conditions=react-server --import tsx scripts/lp-smoke-pause-resume.ts --agent-id agent-0g-mainnet-23

import dotenv from "dotenv";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Chain,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { POST as statusPost } from "../app/api/agents/status/route";
import { makeMainnetPublicClient } from "../lib/agent/lp/lp-context";
import {
  agentKeyForDeployment,
  loadOgAgentWorkspace,
} from "../lib/agent/single-agent-server";
import type { OgAgentDeploymentRecord } from "../lib/agent/single-agent";
import { buildCopilotWalletAccessMessage } from "../lib/copilot/wallet-access";
import { policyVaultV3Abi } from "../lib/contracts/policy-vault-v3";
import { runLpAgentWorkerOnce } from "../lib/agent/runtime/lp-worker";
import type { OgAgentLpWorkerConfig } from "../lib/agent/runtime/lp-config";

dotenv.config({ path: ".env.local", quiet: true });

// Prefer the dedicated mainnet RPC (quiknode) over the flaky public endpoint.
const preferredMainnetRpc = process.env.OG_MAINNET_RPC_URL?.trim();
if (preferredMainnetRpc) {
  process.env.OG_RPC_URL = preferredMainnetRpc;
}

const CHAIN_ID = 16661;

function parseArgs(argv: string[]): { agentId: string } {
  let agentId = "agent-0g-mainnet-23";
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--agent-id") {
      agentId = argv[++i];
      if (!agentId) throw new Error("--agent-id requires a value.");
    } else if (value === "--help" || value === "-h") {
      console.log("Usage: lp-smoke-pause-resume.ts --agent-id agent-0g-mainnet-23");
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

async function callStatusRoute(
  action: "arm" | "pause",
  agentId: string,
  owner: Address,
  account: ReturnType<typeof privateKeyToAccount>,
) {
  const message = buildCopilotWalletAccessMessage({
    address: owner,
    chainId: CHAIN_ID,
    networkId: "mainnet",
  });
  const signature = await account.signMessage({ message });
  const request = new Request("http://localhost/api/agents/status", {
    body: JSON.stringify({
      action,
      agentId,
      networkId: "mainnet",
      wallet: { address: owner, chainId: CHAIN_ID, message, signature },
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const response = await statusPost(request);
  const json = (await response.json()) as { data?: unknown; error?: { code?: string; message?: string } };
  if (!response.ok || !json.data) {
    throw new Error(`status:${action} failed: ${json.error?.code ?? response.status} ${json.error?.message ?? response.statusText}`);
  }
  return json.data as { deployment: OgAgentDeploymentRecord; workspace: unknown };
}

async function setAgentKeyEnabled(
  vault: Address,
  agentKey: Hex,
  enabled: boolean,
  owner: Address,
): Promise<Hex> {
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
    address: vault,
    abi: policyVaultV3Abi,
    functionName: "setAgentKeyEnabled",
    args: [agentKey, enabled],
    account: deployer,
    chain,
  });
  log("setAgentKeyEnabled", { enabled, txHash, action: "submitted" });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 2 });
  if (receipt.status !== "success") {
    throw new Error(`setAgentKeyEnabled(${enabled}) tx reverted: ${txHash}`);
  }
  const after = (await publicClient.readContract({
    address: vault,
    abi: policyVaultV3Abi,
    functionName: "agentKeyEnabled",
    args: [agentKey],
  })) as boolean;
  if (after !== enabled) {
    throw new Error(`agentKeyEnabled is ${after} after tx (expected ${enabled}): ${txHash}`);
  }
  log("setAgentKeyEnabled", { enabled, txHash, agentKeyEnabled: after, status: "confirmed" });
  return txHash;
}

async function readCompactState(agentId: string, owner: Address) {
  const workspace = await loadOgAgentWorkspace({ agentId, live: true, ownerAddress: owner });
  const deployment = workspace.agent.deployment;
  if (!deployment) throw new Error(`No deployed agent for ${agentId}.`);
  const publicClient = makeMainnetPublicClient();
  const agentKey = (deployment.agentKey ?? agentKeyForDeployment(deployment)) as Hex;
  const agentKeyEnabled = await publicClient
    .readContract({
      address: deployment.vault,
      abi: policyVaultV3Abi,
      functionName: "agentKeyEnabled",
      args: [agentKey],
    })
    .catch(() => "read-failed");
  return {
    status: workspace.agent.status,
    paused: deployment.paused,
    agentKey,
    agentKeyEnabled,
    vault: deployment.vault,
    positions: (workspace.vault.sellableLpPositions ?? []).map((p) => ({
      tokenId: p.tokenId,
      pool: p.poolLabel,
      staked: p.staked,
      liquidity: p.liquidity,
    })),
  };
}

async function runWorkerDryRun(agentId: string, owner: Address) {
  const config: OgAgentLpWorkerConfig = {
    agentId,
    dryRun: true,
    once: true,
    intervalMs: 60_000,
    killSwitchEnabled: false,
    processAllAgents: false,
    ownerAddress: owner,
  };
  const summary = await runLpAgentWorkerOnce(config);
  return {
    selectedAgentIds: summary.selectedAgentIds,
    agentsProcessed: summary.agentsProcessed,
    dryRuns: summary.dryRuns,
    held: summary.held,
    blocked: summary.blocked,
    errored: summary.agentsErrored,
    mintsExecuted: summary.mintsExecuted,
  };
}

async function main() {
  const { agentId } = parseArgs(process.argv.slice(2));
  const account = privateKeyToAccount(readPrivateKeyEnv("DEPLOYER_PRIVATE_KEY"));
  const owner = account.address as Address;
  log("start", { agentId, owner });

  // Baseline state + worker cycle (armed -> expect select).
  const baseline = await readCompactState(agentId, owner);
  log("baseline-state", baseline);
  if (baseline.status !== "armed") {
    log("baseline-warn", { note: `Agent is ${baseline.status}, not armed. Pause/resume still exercised.`, positions: baseline.positions.length });
  }
  const baselineWorker = await runWorkerDryRun(agentId, owner);
  log("baseline-worker", baselineWorker);

  // PAUSE: on-chain disable first (funds protected) then off-chain pause.
  log("pause", { action: "begin" });
  const pauseKeyTx = await setAgentKeyEnabled(baseline.vault, baseline.agentKey, false, owner);
  const pauseStatus = await callStatusRoute("pause", agentId, owner, account);
  log("pause", { action: "status-route-done", paused: (pauseStatus.deployment as OgAgentDeploymentRecord).paused });
  await sleep(2_000);
  const pausedState = await readCompactState(agentId, owner);
  log("paused-state", pausedState);

  // Worker cycle while paused -> expect selectedAgentIds: [] (worker stops).
  const pausedWorker = await runWorkerDryRun(agentId, owner);
  log("paused-worker", pausedWorker);

  // RESUME: on-chain enable first then off-chain arm.
  log("resume", { action: "begin" });
  const resumeKeyTx = await setAgentKeyEnabled(baseline.vault, baseline.agentKey, true, owner);
  const resumeStatus = await callStatusRoute("arm", agentId, owner, account);
  log("resume", { action: "status-route-done", paused: (resumeStatus.deployment as OgAgentDeploymentRecord).paused });
  await sleep(2_000);
  const resumedState = await readCompactState(agentId, owner);
  log("resumed-state", resumedState);

  // Worker cycle after resume -> expect selectedAgentIds contains agentId.
  const resumedWorker = await runWorkerDryRun(agentId, owner);
  log("resumed-worker", resumedWorker);

  // Verdict.
  const pauseOk = pausedState.status === "paused" && pausedState.agentKeyEnabled === false && pausedWorker.selectedAgentIds.length === 0;
  const resumeOk = resumedState.status === "armed" && resumedState.agentKeyEnabled === true && resumedWorker.selectedAgentIds.includes(agentId);
  log("verdict", {
    pauseOk,
    resumeOk,
    pauseKeyTx,
    resumeKeyTx,
    note: "Remove NOT run. Run lp-cleanup-agent.ts --phase all separately after confirmation to close positions + retire the agent.",
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});