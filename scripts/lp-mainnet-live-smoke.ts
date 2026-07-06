import dotenv from "dotenv";
import { formatEther, isAddress, isHex, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { POST as deployLpAgentPost } from "../app/api/agents/lp/deploy/route";
import { GET as mintDefaultsGet } from "../app/api/agents/lp/[id]/mint/defaults/route";
import { POST as mintPost } from "../app/api/agents/lp/[id]/mint/route";
import { POST as stakePost } from "../app/api/agents/lp/[id]/stake/route";
import { POST as unstakePost } from "../app/api/agents/lp/[id]/unstake/route";
import { POST as zapOutPost } from "../app/api/agents/lp/[id]/zap-out/route";
import { buildFence, buildPoolCandidates, makeMainnetPublicClient } from "../lib/agent/lp/lp-context";
import { decideLpAction } from "../lib/agent/runtime/lp-brain";
import type { OgAgentDeploymentRecord } from "../lib/agent/single-agent";
import { loadOgAgentWorkspace } from "../lib/agent/single-agent-server";
import { issueActionNonce } from "../lib/copilot/action-nonce-store";
import {
  buildCopilotActionConsentMessage,
  buildLpDeployActionConsentMessage,
  normalizeLpDeployConsentSteps,
  type LpDeployConsentStep,
} from "../lib/copilot/wallet-access";
import { policyVaultV3Abi } from "../lib/contracts/policy-vault-v3";

dotenv.config({ path: ".env.local", quiet: true });

const DEFAULT_AMOUNT_0G = "0.005";

interface Args {
  agentId?: string;
  amount0G: string;
  deposit0G: string;
  poolAddress?: Address;
  skipExits: boolean;
  skipMint: boolean;
  tokenId?: string;
}

interface RouteResult<T> {
  data?: T;
  error?: { code?: string; message?: string };
  meta?: unknown;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const account = privateKeyToAccount(readPrivateKeyEnv("DEPLOYER_PRIVATE_KEY"));
  const owner = account.address;
  const chainId = 16661;
  const createdAt = new Date().toISOString().replace(/[-:]/gu, "").slice(0, 13);
  const name = `Codex LP smoke ${createdAt}`;
  const publicClient = makeMainnetPublicClient();

  console.log(JSON.stringify({ agentId: args.agentId, amount0G: args.amount0G, deposit0G: args.deposit0G, owner, stage: "start" }));

  const deployment = args.agentId
    ? await readExistingDeployment(args.agentId, owner)
    : await deployLpAgentViaRoute({
        account,
        chainId,
        deposit0G: args.deposit0G,
        name,
        owner,
      });
  const agentId = deployment.id;
  console.log(JSON.stringify({
    agentId,
    deployTxHash: deployment.deployTxHash,
    stage: args.agentId ? "using-existing-agent" : "deploy",
    tokenId: deployment.tokenId,
  }));

  const workspace = await loadOgAgentWorkspace({ agentId, live: true, ownerAddress: owner });
  const reasoning = await runReasoningCheck(agentId, owner);
  console.log(JSON.stringify({ agentId, reasoning, stage: "llm-reasoning" }));

  let minted: {
    amount0G?: string;
    lpTxHash?: Hex;
    poolAddress?: Address;
    tokenId?: string;
    staked?: boolean;
    stakeTxHash?: Hex;
    stakeError?: string;
  };
  if (args.skipMint) {
    if (!args.tokenId || !args.poolAddress) {
      console.log(JSON.stringify({ agentId, stage: "done", skipped: "mint/exits" }));
      return;
    }
    minted = { poolAddress: args.poolAddress, tokenId: args.tokenId };
    console.log(JSON.stringify({ agentId, poolAddress: minted.poolAddress, stage: "using-existing-position", tokenId: minted.tokenId }));
  } else {
    await waitForLpCooldownIfNeeded(publicClient, deployment.vault, workspace.vault.lpPolicy?.cooldownSecondsLp ?? "0", "before-mint");

    const defaults = await mintDefaultsViaRoute(agentId, owner);
    const amount0G = boundedAmount(args.amount0G, defaults.maxAmount0G);
    minted = await mintViaRoute({
      account,
      agentId,
      amount0G,
      chainId,
      defaults,
      owner,
      vault: deployment.vault,
    });
    console.log(JSON.stringify({
      agentId,
      amount0G: minted.amount0G,
      lpTxHash: minted.lpTxHash,
      poolAddress: minted.poolAddress,
      stage: "mint",
      tokenId: minted.tokenId,
      staked: minted.staked,
      stakeTxHash: minted.stakeTxHash,
      stakeError: minted.stakeError,
    }));
  }

  if (args.skipExits) {
    console.log(JSON.stringify({ agentId, stage: "done", skipped: "stake/unstake/zap-out" }));
    return;
  }
  if (!minted.tokenId || !minted.poolAddress) {
    throw new Error("Mint route did not return tokenId/poolAddress; cannot continue exit smoke.");
  }

  // The mint route now auto-stakes when allowStaking + a Zia stake vault are
  // present. Skip the explicit stake step (it would revert with "already
  // staked") when the mint already staked; go straight to unstake.
  if (minted.staked !== true) {
    await waitForLpCooldownIfNeeded(publicClient, deployment.vault, workspace.vault.lpPolicy?.cooldownSecondsLp ?? "0", "before-stake");
    const staked = await lpExitViaRoute({
      account,
      action: "lp-stake",
      agentId,
      chainId,
      owner,
      path: "stake",
      poolAddress: minted.poolAddress,
      tokenId: minted.tokenId,
      vault: deployment.vault,
    });
    console.log(JSON.stringify({ agentId, lpTxHash: staked.lpTxHash, proofTxHash: staked.proofTxHash, stage: "stake", tokenId: minted.tokenId }));
  } else {
    console.log(JSON.stringify({ agentId, stage: "stake", skipped: "auto-staked-during-mint", stakeTxHash: minted.stakeTxHash, tokenId: minted.tokenId }));
  }

  const unstaked = await lpExitViaRoute({
    account,
    action: "lp-unstake",
    agentId,
    chainId,
    owner,
    path: "unstake",
    poolAddress: minted.poolAddress,
    tokenId: minted.tokenId,
    vault: deployment.vault,
  });
  console.log(JSON.stringify({ agentId, lpTxHash: unstaked.lpTxHash, proofTxHash: unstaked.proofTxHash, stage: "unstake", tokenId: minted.tokenId }));

  const zapped = await lpExitViaRoute({
    account,
    action: "lp-zap-out",
    agentId,
    chainId,
    owner,
    path: "zap-out",
    poolAddress: minted.poolAddress,
    tokenId: minted.tokenId,
    vault: deployment.vault,
  });
  console.log(JSON.stringify({
    agentId,
    amountOutMin: zapped.amountOutMin,
    lpTxHash: zapped.lpTxHash,
    proofTxHash: zapped.proofTxHash,
    stage: "zap-out",
    tokenId: minted.tokenId,
  }));

  console.log(JSON.stringify({ agentId, stage: "done" }));
}

async function readExistingDeployment(agentId: string, owner: Address): Promise<OgAgentDeploymentRecord> {
  const workspace = await loadOgAgentWorkspace({ agentId, live: true, ownerAddress: owner });
  if (!workspace.agent.deployment) {
    throw new Error(`No deployed agent found for ${agentId}.`);
  }
  if (!workspace.agent.deployment.filters.includes("lp-zia")) {
    throw new Error(`${agentId} is not an LP agent.`);
  }
  return workspace.agent.deployment;
}

async function deployLpAgentViaRoute({
  account,
  chainId,
  deposit0G,
  name,
  owner,
}: {
  account: ReturnType<typeof privateKeyToAccount>;
  chainId: number;
  deposit0G: string;
  name: string;
  owner: Address;
}) {
  const confirmedSteps: LpDeployConsentStep[] = ["mint-agentic-id", "enable-agent-key"];
  if (!isZeroDecimal(deposit0G)) {
    confirmedSteps.push("deposit-native");
  }
  const normalizedSteps = normalizeLpDeployConsentSteps(confirmedSteps);
  const nonce = issueActionNonce({ address: owner, scope: "lp-agent-deploy" });
  const body = {
    confirmedSteps: normalizedSteps,
    depositNative0G: deposit0G,
    lpFence: {
      maxAprPct: null,
      maxPerPosition0G: DEFAULT_AMOUNT_0G,
      maxPositions: 1,
      minAprPct: 0,
    },
    name,
    triggerFirstMint: false,
  };
  const message = buildLpDeployActionConsentMessage({
    address: owner,
    chainId,
    networkId: "mainnet",
    vault: process.env.POLICY_VAULT_V3_MAINNET_ADDRESS?.trim() || process.env.NEXT_PUBLIC_POLICY_VAULT_V3_MAINNET_ADDRESS?.trim() || "",
    agentName: body.name,
    maxPositions: body.lpFence.maxPositions,
    maxPerPosition0G: body.lpFence.maxPerPosition0G,
    minAprPct: body.lpFence.minAprPct,
    maxAprPct: body.lpFence.maxAprPct,
    depositNative0G: body.depositNative0G,
    confirmedSteps: body.confirmedSteps,
    triggerFirstMint: body.triggerFirstMint,
    nonce: nonce.nonce,
    expiresAt: nonce.expiresAt,
  });
  const signature = await account.signMessage({ message });
  const result = await callRoute<{ deployment?: { id?: string; deployTxHash?: Hex; tokenId?: string; vault?: Address } }>(
    deployLpAgentPost(
      jsonRequest("http://localhost/api/agents/lp/deploy", {
        ...body,
        expiresAt: nonce.expiresAt,
        nonce: nonce.nonce,
        wallet: { address: owner, chainId, message, signature },
      }),
    ),
    "deploy",
  );
  const deployment = result.deployment;
  if (!deployment?.id || !deployment.deployTxHash || !deployment.tokenId || !deployment.vault) {
    throw new Error("Deploy route returned an incomplete deployment payload.");
  }
  return deployment as { id: string; deployTxHash: Hex; tokenId: string; vault: Address };
}

async function runReasoningCheck(agentId: string, owner: Address) {
  const workspace = await loadOgAgentWorkspace({ agentId, live: true, ownerAddress: owner });
  if (!workspace.agent.deployment) throw new Error("Cannot run reasoning without a deployed agent.");
  const publicClient = makeMainnetPublicClient();
  const pools = await buildPoolCandidates(publicClient);
  const decision = await decideLpAction({
    pools,
    fence: buildFence(workspace.vault),
    vaultBalance0G: workspace.vault.balance0G ?? "0",
    readiness: {
      vaultReady: workspace.vault.ready,
      storageUploadReady: workspace.storage.uploadReady,
      vaultWarnings: workspace.vault.warnings,
    },
  });
  return {
    action: decision.action,
    confidence: decision.confidence,
    model: decision.model,
    poolAddress: decision.poolAddress,
    source: decision.source,
    summary: decision.summary,
    trace: decision.trace
      ? {
          provider: decision.trace.provider,
          requestId: decision.trace.requestId,
          teeVerified: decision.trace.teeVerified,
        }
      : undefined,
  };
}

async function mintDefaultsViaRoute(agentId: string, owner: Address) {
  const url = `http://localhost/api/agents/lp/${agentId}/mint/defaults?wallet=${owner}`;
  return callRoute<{
    currentTick: number;
    defaultAmount0G: string;
    maxAmount0G: string;
    poolAddress: Address;
    poolLabel: string;
    tickLower: number;
    tickUpper: number;
  }>(mintDefaultsGet(new Request(url), { params: Promise.resolve({ id: agentId }) }), "mint-defaults");
}

async function mintViaRoute({
  account,
  agentId,
  amount0G,
  chainId,
  defaults,
  owner,
  vault,
}: {
  account: ReturnType<typeof privateKeyToAccount>;
  agentId: string;
  amount0G: string;
  chainId: number;
  defaults: Awaited<ReturnType<typeof mintDefaultsViaRoute>>;
  owner: Address;
  vault: Address;
}) {
  const nonce = issueActionNonce({ address: owner, scope: "lp-mint" });
  const message = buildCopilotActionConsentMessage({
    address: owner,
    agentId,
    amount0G,
    chainId,
    networkId: "mainnet",
    action: "lp-mint",
    vault,
    poolAddress: defaults.poolAddress,
    tickLower: defaults.tickLower,
    tickUpper: defaults.tickUpper,
    nonce: nonce.nonce,
    expiresAt: nonce.expiresAt,
  });
  const signature = await account.signMessage({ message });
  return callRoute<{
    amount0G: string;
    liquidity?: string;
    lpTxHash?: Hex;
    poolAddress?: Address;
    tickLower?: number;
    tickUpper?: number;
    tokenId?: string;
    staked?: boolean;
    stakeTxHash?: Hex;
    stakeError?: string;
  }>(
    mintPost(
      jsonRequest(`http://localhost/api/agents/lp/${agentId}/mint`, {
        amount0G,
        expiresAt: nonce.expiresAt,
        nonce: nonce.nonce,
        poolAddress: defaults.poolAddress,
        tickLower: defaults.tickLower,
        tickUpper: defaults.tickUpper,
        wallet: { address: owner, chainId, message, signature },
      }),
      { params: Promise.resolve({ id: agentId }) },
    ),
    "mint",
  );
}

async function lpExitViaRoute({
  account,
  action,
  agentId,
  chainId,
  owner,
  path,
  poolAddress,
  tokenId,
  vault,
}: {
  account: ReturnType<typeof privateKeyToAccount>;
  action: "lp-stake" | "lp-unstake" | "lp-zap-out";
  agentId: string;
  chainId: number;
  owner: Address;
  path: "stake" | "unstake" | "zap-out";
  poolAddress: Address;
  tokenId: string;
  vault: Address;
}) {
  const nonce = issueActionNonce({ address: owner, scope: action });
  const message = buildCopilotActionConsentMessage({
    address: owner,
    agentId,
    chainId,
    networkId: "mainnet",
    action,
    vault,
    poolAddress,
    tokenId,
    nonce: nonce.nonce,
    expiresAt: nonce.expiresAt,
  });
  const signature = await account.signMessage({ message });
  const route =
    path === "stake"
      ? stakePost
      : path === "unstake"
        ? unstakePost
        : zapOutPost;
  return callRoute<{
    amountOutMin?: string;
    lpTxHash?: Hex;
    proofTxHash?: Hex;
    tokenId?: string;
  }>(
    route(
      jsonRequest(`http://localhost/api/agents/lp/${agentId}/${path}`, {
        expiresAt: nonce.expiresAt,
        nonce: nonce.nonce,
        poolAddress,
        tokenId,
        wallet: { address: owner, chainId, message, signature },
      }),
      { params: Promise.resolve({ id: agentId }) },
    ),
    path,
  );
}

async function callRoute<T>(responsePromise: Promise<Response>, label: string): Promise<T> {
  const response = await responsePromise;
  const json = (await response.json()) as RouteResult<T>;
  if (!response.ok || !json.data) {
    throw new Error(`${label} failed: ${json.error?.code ?? response.status} ${json.error?.message ?? response.statusText}`);
  }
  return json.data;
}

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
}

async function waitForLpCooldownIfNeeded(
  publicClient: ReturnType<typeof makeMainnetPublicClient>,
  vault: Address,
  cooldownSecondsRaw: string,
  label: string,
) {
  const cooldownSeconds = Number(cooldownSecondsRaw);
  if (!Number.isFinite(cooldownSeconds) || cooldownSeconds <= 0) return;
  const lastLpActionAt = await publicClient.readContract({
    address: vault,
    abi: policyVaultV3Abi,
    functionName: "lastLpActionAt",
  }) as bigint;
  if (lastLpActionAt === 0n) return;
  const block = await publicClient.getBlock();
  const readyAt = Number(lastLpActionAt) + cooldownSeconds + 3;
  const waitSeconds = readyAt - Number(block.timestamp);
  if (waitSeconds <= 0) return;
  console.log(JSON.stringify({ label, stage: "cooldown-wait", waitSeconds }));
  await sleep(waitSeconds * 1000);
}

function boundedAmount(requested: string, maxAmount: string): string {
  const requestedWei = parseEther(requested);
  const maxWei = parseEther(maxAmount);
  if (maxWei <= 0n) throw new Error("Mint maxAmount0G is zero.");
  return formatEther(requestedWei <= maxWei ? requestedWei : maxWei);
}

function parseArgs(argv: string[]): Args {
  const args: Args = { amount0G: DEFAULT_AMOUNT_0G, deposit0G: "0", skipExits: false, skipMint: false };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--agent-id") args.agentId = readNext(argv, ++i, value);
    else if (value === "--amount") args.amount0G = readNext(argv, ++i, value);
    else if (value === "--deposit") args.deposit0G = readNext(argv, ++i, value);
    else if (value === "--pool-address") {
      const poolAddress = readNext(argv, ++i, value);
      if (!isAddress(poolAddress)) throw new Error("--pool-address must be a valid address.");
      args.poolAddress = poolAddress;
    }
    else if (value === "--token-id") args.tokenId = readNext(argv, ++i, value);
    else if (value === "--skip-exits") args.skipExits = true;
    else if (value === "--skip-mint") args.skipMint = true;
    else if (value === "--help" || value === "-h") {
      console.log("Usage: node --conditions=react-server --import tsx scripts/lp-mainnet-live-smoke.ts [--agent-id agent-0g-mainnet-N] [--amount 0.005] [--deposit 0.02] [--skip-mint --token-id 123 --pool-address 0x...] [--skip-exits]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  if (!/^\d+(?:\.\d{1,18})?$/u.test(args.amount0G) || parseEther(args.amount0G) <= 0n) {
    throw new Error("--amount must be a positive 0G decimal with <=18 fractional digits.");
  }
  if (!/^\d+(?:\.\d{1,18})?$/u.test(args.deposit0G)) {
    throw new Error("--deposit must be a non-negative 0G decimal with <=18 fractional digits.");
  }
  if (args.tokenId !== undefined && !/^\d+$/u.test(args.tokenId)) {
    throw new Error("--token-id must be a positive integer string.");
  }
  return args;
}

function isZeroDecimal(value: string): boolean {
  return parseEther(value) === 0n;
}

function readNext(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function readPrivateKeyEnv(name: string): Hex {
  const value = process.env[name]?.trim();
  if (!value || !isHex(value, { strict: true }) || value.length !== 66) {
    throw new Error(`${name} must be a 0x-prefixed 32-byte private key.`);
  }
  return value as Hex;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
