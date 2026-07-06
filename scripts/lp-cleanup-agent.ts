// Mainnet LP agent cleanup — exits all positions, disables the agent key,
// removes the agent record, and withdraws native 0G back to the owner (DEPLOYER).
//
// Real money. DEPLOYER pays gas. Step-gated: run `--phase=read` first to inspect,
// then `--phase=all` (or individual phases) to execute. Each phase logs JSON with
// tx hashes and re-reads the snapshot before continuing.
//
// Reuses the in-process route pattern from scripts/lp-mainnet-live-smoke.ts for
// unstake / zap-out / automation (signed owner consent + route validation), and
// calls library helpers directly for setAgentKeyEnabled / removeSingleOgAgentRecord
// / withdrawMainnetVaultNative.
//
// Usage:
//   node --conditions=react-server --import tsx scripts/lp-cleanup-agent.ts --phase=read
//   node --conditions=react-server --import tsx scripts/lp-cleanup-agent.ts --phase=all
//   node --conditions=react-server --import tsx scripts/lp-cleanup-agent.ts --agent-id agent-0g-mainnet-14 --phase=disable-key

import dotenv from "dotenv";
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  isAddress,
  parseEther,
  type Address,
  type Chain,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { POST as automationPost } from "../app/api/agents/lp/[id]/automation/route";
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
import { buildCopilotActionConsentMessage } from "../lib/copilot/wallet-access";
import { policyVaultV3Abi } from "../lib/contracts/policy-vault-v3";

dotenv.config({ path: ".env.local", quiet: true });

// Prefer the dedicated mainnet RPC (quiknode) over the public evmrpc.0g.ai when
// available — the public endpoint is flaky under repeated workspace reads and
// times out mid-cleanup. The URL stays in .env.local (never printed).
const preferredMainnetRpc = process.env.OG_MAINNET_RPC_URL?.trim();
if (preferredMainnetRpc) {
  process.env.OG_RPC_URL = preferredMainnetRpc;
}

const CHAIN_ID = 16661;
const DEFAULT_AGENT_ID = "agent-0g-mainnet-14";

type Phase =
  | "read"
  | "disable-automation"
  | "unstake"
  | "zap-out"
  | "disable-key"
  | "remove"
  | "withdraw"
  | "all";

interface Args {
  agentId: string;
  phase: Phase;
  withdrawAmount0G?: string; // override; default = full vault balance
}

function parseArgs(argv: string[]): Args {
  const args: Args = { agentId: DEFAULT_AGENT_ID, phase: "all" };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--agent-id") args.agentId = readNext(argv, ++i, value);
    else if (value === "--phase") args.phase = readNext(argv, ++i, value) as Phase;
    else if (value === "--withdraw-amount") args.withdrawAmount0G = readNext(argv, ++i, value);
    else if (value === "--help" || value === "-h") {
      console.log(
        "Usage: node --conditions=react-server --import tsx scripts/lp-cleanup-agent.ts [--agent-id agent-0g-mainnet-14] [--phase read|disable-automation|unstake|zap-out|disable-key|remove|withdraw|all] [--withdraw-amount 0.3]",
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

interface RouteResult<T> {
  data?: T;
  error?: { code?: string; message?: string };
  meta?: unknown;
}

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
}

async function callRoute<T>(responsePromise: Promise<Response>, label: string): Promise<T> {
  const response = await responsePromise;
  const json = (await response.json()) as RouteResult<T>;
  if (!response.ok || !json.data) {
    throw new Error(`${label} failed: ${json.error?.code ?? response.status} ${json.error?.message ?? response.statusText}`);
  }
  return json.data;
}

async function waitForLpCooldown(vault: Address, cooldownSecondsRaw: string, label: string) {
  const cooldownSeconds = Number(cooldownSecondsRaw);
  if (!Number.isFinite(cooldownSeconds) || cooldownSeconds <= 0) return;
  const publicClient = makeMainnetPublicClient();
  const lastLpActionAt = (await publicClient.readContract({
    address: vault,
    abi: policyVaultV3Abi,
    functionName: "lastLpActionAt",
  })) as bigint;
  if (lastLpActionAt === 0n) return;
  const block = await publicClient.getBlock();
  const readyAt = Number(lastLpActionAt) + cooldownSeconds + 3;
  const waitSeconds = readyAt - Number(block.timestamp);
  if (waitSeconds <= 0) return;
  console.log(JSON.stringify({ label, stage: "cooldown-wait", waitSeconds }));
  await sleep(waitSeconds * 1000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function lpExitViaRoute({
  account,
  action,
  agentId,
  owner,
  vault,
  poolAddress,
  tokenId,
  path,
}: {
  account: ReturnType<typeof privateKeyToAccount>;
  action: "lp-unstake" | "lp-zap-out";
  agentId: string;
  owner: Address;
  vault: Address;
  poolAddress: Address;
  tokenId: string;
  path: "unstake" | "zap-out";
}) {
  const nonce = issueActionNonce({ address: owner, scope: action });
  const message = buildCopilotActionConsentMessage({
    address: owner,
    agentId,
    chainId: CHAIN_ID,
    networkId: "mainnet",
    action,
    vault,
    poolAddress,
    tokenId,
    nonce: nonce.nonce,
    expiresAt: nonce.expiresAt,
  });
  const signature = await account.signMessage({ message });
  const route = path === "unstake" ? unstakePost : zapOutPost;
  return callRoute<{ amountOutMin?: string; lpTxHash?: Hex; proofTxHash?: Hex; tokenId?: string }>(
    route(
      jsonRequest(`http://localhost/api/agents/lp/${agentId}/${path}`, {
        expiresAt: nonce.expiresAt,
        nonce: nonce.nonce,
        poolAddress,
        tokenId,
        wallet: { address: owner, chainId: CHAIN_ID, message, signature },
      }),
      { params: Promise.resolve({ id: agentId }) },
    ),
    path,
  );
}

async function disableAutomationViaRoute({
  account,
  agentId,
  owner,
  vault,
}: {
  account: ReturnType<typeof privateKeyToAccount>;
  agentId: string;
  owner: Address;
  vault: Address;
}) {
  const nonce = issueActionNonce({ address: owner, scope: "lp-automation" });
  const message = buildCopilotActionConsentMessage({
    address: owner,
    agentId,
    chainId: CHAIN_ID,
    networkId: "mainnet",
    action: "lp-automation",
    vault,
    automationEnabled: false,
    nonce: nonce.nonce,
    expiresAt: nonce.expiresAt,
  });
  const signature = await account.signMessage({ message });
  return callRoute<{ autoMint: boolean; agentId: string }>(
    automationPost(
      jsonRequest(`http://localhost/api/agents/lp/${agentId}/automation`, {
        autoMint: false,
        expiresAt: nonce.expiresAt,
        nonce: nonce.nonce,
        wallet: { address: owner, chainId: CHAIN_ID, message, signature },
      }),
      { params: Promise.resolve({ id: agentId }) },
    ),
    "automation",
  );
}

async function readState(agentId: string, owner: Address) {
  const workspace = await loadOgAgentWorkspace({ agentId, live: true, ownerAddress: owner });
  if (!workspace.agent.deployment) {
    throw new Error(`No deployed agent found for ${agentId}.`);
  }
  const deployment = workspace.agent.deployment;
  const publicClient = makeMainnetPublicClient();
  const vaultBalance = await publicClient.getBalance({ address: deployment.vault });
  const ownerBalance = await publicClient.getBalance({ address: owner });
  const agentKey = deployment.agentKey ?? agentKeyForDeployment(deployment);
  const agentKeyEnabled = await publicClient
    .readContract({
      address: deployment.vault,
      abi: policyVaultV3Abi,
      functionName: "agentKeyEnabled",
      args: [agentKey],
    })
    .catch(() => "read-failed");
  return {
    deployment,
    positions: (workspace.vault.sellableLpPositions ?? []) as OgAgentVaultLpPosition[],
    vault: deployment.vault,
    vaultBalance0G: formatEther(vaultBalance),
    ownerBalance0G: formatEther(ownerBalance),
    agentKey,
    agentKeyEnabled,
    autoMint: deployment.runtime?.automation?.autoMint ?? false,
    paused: workspace.vault.paused,
    executorRevoked: workspace.vault.executorRevoked,
    status: workspace.agent.status,
    cooldownSecondsLp: workspace.vault.lpPolicy?.cooldownSecondsLp ?? "0",
    allowStaking: workspace.vault.lpPolicy?.allowStaking ?? false,
  };
}

function printState(state: Awaited<ReturnType<typeof readState>>, stage: string) {
  console.log(
    JSON.stringify(
      {
        stage,
        agentId: state.deployment.id,
        vault: state.vault,
        status: state.status,
        autoMint: state.autoMint,
        paused: state.paused,
        executorRevoked: state.executorRevoked,
        agentKeyEnabled: state.agentKeyEnabled,
        vaultBalance0G: state.vaultBalance0G,
        ownerBalance0G: state.ownerBalance0G,
        cooldownSecondsLp: state.cooldownSecondsLp,
        allowStaking: state.allowStaking,
        positions: state.positions.map((p) => ({
          tokenId: p.tokenId,
          pool: p.poolLabel,
          poolAddress: p.poolAddress,
          staked: p.staked,
          liquidity: p.liquidity,
          deployedNative0G: p.deployedNative0G,
        })),
      },
      null,
      2,
    ),
  );
}

async function disableAgentKey(state: Awaited<ReturnType<typeof readState>>, owner: Address): Promise<Hex> {
  const rpcUrl = process.env.OG_RPC_URL?.trim();
  if (!rpcUrl) throw new Error("OG_RPC_URL is required.");
  const chain = make0GMainnetChain(rpcUrl);
  const deployer = privateKeyToAccount(readPrivateKeyEnv("DEPLOYER_PRIVATE_KEY"));
  if (getAddress(deployer.address) !== getAddress(owner)) {
    throw new Error("DEPLOYER_PRIVATE_KEY must match the owner address resolved for this agent.");
  }
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl, { retryCount: 0, timeout: 8_000 }) });
  const walletClient = createWalletClient({ account: deployer, chain, transport: http(rpcUrl) });
  console.log(JSON.stringify({ stage: "disable-key", agentKey: state.agentKey, vault: state.vault, action: "setAgentKeyEnabled(false)" }));
  const txHash = await walletClient.writeContract({
    address: state.vault,
    abi: policyVaultV3Abi,
    functionName: "setAgentKeyEnabled",
    args: [state.agentKey, false],
    account: deployer,
    chain,
  });
  console.log(JSON.stringify({ stage: "disable-key", txHash, action: "submitted" }));
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 2 });
  if (receipt.status !== "success") {
    throw new Error(`disable-key tx reverted: ${txHash}`);
  }
  const after = (await publicClient.readContract({
    address: state.vault,
    abi: policyVaultV3Abi,
    functionName: "agentKeyEnabled",
    args: [state.agentKey],
  })) as boolean;
  if (after !== false) {
    throw new Error(`agentKeyEnabled is still true after disable-key tx ${txHash}`);
  }
  console.log(JSON.stringify({ stage: "disable-key", txHash, agentKeyEnabled: after, status: "confirmed" }));
  return txHash;
}

function getAddress(value: string): Address {
  return value as Address;
}

async function withdrawNative(owner: Address, amount0G: string) {
  console.log(JSON.stringify({ stage: "withdraw", amount0G, owner }));
  const result = await withdrawMainnetVaultNative({ owner, amount0G });
  console.log(
    JSON.stringify({
      stage: "withdraw",
      txHash: result.txHash,
      amount0G: result.amount0G,
      balanceBefore0G: result.balanceBefore0G,
      balanceAfter0G: result.balanceAfter0G,
      vault: result.vault,
    }),
  );
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!/^agent-0g-mainnet-\d+$/u.test(args.agentId)) {
    throw new Error("--agent-id must match /^agent-0g-mainnet-\\d+$/u");
  }
  const account = privateKeyToAccount(readPrivateKeyEnv("DEPLOYER_PRIVATE_KEY"));
  const owner = account.address as Address;

  const phase = args.phase;
  const want = (p: Phase) => phase === p || phase === "all";

  // read is always run first (inspect + capture deployment).
  const state = await readState(args.agentId, owner);
  printState(state, "read");

  if (phase === "read") return;

  if (want("disable-automation") && state.autoMint) {
    const res = await disableAutomationViaRoute({ account, agentId: args.agentId, owner, vault: state.vault });
    console.log(JSON.stringify({ stage: "disable-automation", autoMint: res.autoMint }));
  }

  // Unstake every staked position.
  if (want("unstake")) {
    const stakedPositions = state.positions.filter((p) => p.staked);
    if (stakedPositions.length === 0) {
      console.log(JSON.stringify({ stage: "unstake", skipped: "no-staked-positions" }));
    }
    for (const position of stakedPositions) {
      await waitForLpCooldown(state.vault, state.cooldownSecondsLp, `unstake-${position.tokenId}`);
      const result = await lpExitViaRoute({
        account,
        action: "lp-unstake",
        agentId: args.agentId,
        owner,
        vault: state.vault,
        poolAddress: position.poolAddress,
        tokenId: position.tokenId,
        path: "unstake",
      });
      console.log(
        JSON.stringify({
          stage: "unstake",
          tokenId: position.tokenId,
          lpTxHash: result.lpTxHash,
          proofTxHash: result.proofTxHash,
        }),
      );
    }
  }

  // Re-read after unstake to get fresh liquidity + positions list.
  let postUnstake = state;
  if (want("unstake") || want("zap-out")) {
    postUnstake = await readState(args.agentId, owner);
    if (want("unstake")) printState(postUnstake, "read-after-unstake");
  }

  // Zap-out every remaining (unstaked) position with liquidity > 0.
  if (want("zap-out")) {
    const zappable = postUnstake.positions.filter((p) => !p.staked && BigInt(p.liquidity || "0") > 0n);
    if (zappable.length === 0) {
      console.log(JSON.stringify({ stage: "zap-out", skipped: "no-zappable-positions" }));
    }
    for (const position of zappable) {
      await waitForLpCooldown(state.vault, state.cooldownSecondsLp, `zap-out-${position.tokenId}`);
      const result = await lpExitViaRoute({
        account,
        action: "lp-zap-out",
        agentId: args.agentId,
        owner,
        vault: state.vault,
        poolAddress: position.poolAddress,
        tokenId: position.tokenId,
        path: "zap-out",
      });
      console.log(
        JSON.stringify({
          stage: "zap-out",
          tokenId: position.tokenId,
          lpTxHash: result.lpTxHash,
          proofTxHash: result.proofTxHash,
          amountOutMin: result.amountOutMin,
        }),
      );
    }
  }

  // Re-read after zap-out to confirm positions cleared + new vault balance.
  let postZap = postUnstake;
  if (want("zap-out") || want("disable-key") || want("remove") || want("withdraw")) {
    postZap = await readState(args.agentId, owner);
    if (want("zap-out")) printState(postZap, "read-after-zap-out");
  }

  if (want("disable-key")) {
    const alreadyDisabled = postZap.agentKeyEnabled === false;
    if (alreadyDisabled) {
      console.log(JSON.stringify({ stage: "disable-key", skipped: "already-disabled" }));
    } else {
      await disableAgentKey(postZap, owner);
    }
  }

  if (want("remove")) {
    console.log(JSON.stringify({ stage: "remove", agentId: args.agentId }));
    const removed = await removeSingleOgAgentRecord(args.agentId, postZap.deployment, owner, undefined);
    console.log(JSON.stringify({ stage: "remove", removed: Boolean(removed), agentId: args.agentId }));
  }

  if (want("withdraw")) {
    const finalState = await readState(args.agentId, owner);
    const balance0G = BigInt(Math.floor(Number(finalState.vaultBalance0G) * 1e18));
    const amount0G = args.withdrawAmount0G ?? formatEther(balance0G);
    if (parseEther(amount0G) <= 0n) {
      console.log(JSON.stringify({ stage: "withdraw", skipped: "vault-balance-zero", vaultBalance0G: finalState.vaultBalance0G }));
    } else {
      await withdrawNative(owner, amount0G);
      const after = await readState(args.agentId, owner).catch(() => null);
      if (after) {
        console.log(
          JSON.stringify({
            stage: "withdraw",
            ownerBalance0G: after.ownerBalance0G,
            vaultBalance0G: after.vaultBalance0G,
          }),
        );
      }
    }
  }

  console.log(JSON.stringify({ stage: "done", phase }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});