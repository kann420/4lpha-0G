import "server-only";

import {
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  isAddress,
  isHex,
  parseAbiItem,
  parseEther,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  OgAgentDeployError,
  deploySingleOgAgent,
  loadOgAgentWorkspace,
  agentKeyForDeployment,
} from "@/lib/agent/single-agent-server";
import { assertLpMainnetEnv, LP_MAINNET_CHAIN_ID } from "@/lib/agent/lp/lp-env-gate";
import {
  buildTightenPolicyCall,
  translateLpFence,
  type LpFenceLpPolicy,
} from "@/lib/agent/lp/lp-fence";
import { normalizePolicyVaultV3Policy, policyVaultV3Abi, type PolicyVaultV3Policy } from "@/lib/contracts/policy-vault-v3";
import { policyVaultV4LpEntryAbi, policyVaultV4SwapAbi } from "@/lib/contracts/policy-vault-v4";
import type { OgAgentDeploymentRecord } from "@/lib/agent/single-agent";
import { runLpAgentWorkerOnce, type OgAgentLpWorkerRunSummary } from "@/lib/agent/runtime/lp-worker";
import type { OgAgentLpRunRecord } from "@/lib/agent/runtime/types";

// LP Agent deploy orchestrator — multi-step mainnet tx flow, each step gated by
// `confirmedSteps` in the request body (the per-step user-confirmation gate).
// The vault has NO multicall, so each on-chain action is a separate signed tx.
//
// Step 1 (mint-agentic-id + enable-agent-key): delegated to `deploySingleOgAgent`
//   with filterIds:['lp-zia']. DEPLOYER pays gas. Returns the deployment record.
// Step 2 (tighten-policy): onlyOwner `tightenPolicy` with the UI fence translated
//   via Gap 5. Only when DEPLOYER is the vault owner. `buildTightenPolicyCall`
//   throws `cannot_loosen_policy` BEFORE `simulateContract` (no gas spent on a
//   loosening attempt). Skipped (tightened=false) when the UI fence equals the
//   current policy.
// Step 3 (deposit-native): `depositNative(value)` from the owner wallet. DEPLOYER
//   funds gas + the deposited 0G. Only when 'deposit-native' ∈ confirmedSteps.
// Step 4 (first-mint, optional): `decideLpAction` (Gap 2) → `quoteLpMint` (Gap 3)
//   → `executeMainnetPolicyVaultLpAction`. Failure here MUST NOT roll back step 1
//   (the AgenticID mint is already on-chain); the orchestrator returns
//   `stepsExecuted` + a clear `firstMintError`.

export type LpDeployStep =
  | "mint-agentic-id"
  | "enable-agent-key"
  | "tighten-policy"
  | "deposit-native"
  | "fund-lp-entry-from-v4-swap"
  | "first-mint";

export interface LpDeployFence {
  maxPositions: number;
  maxPerPosition0G: string;
  minAprPct: number;
  maxAprPct: number | null;
}

export interface LpDeployInput {
  name: string;
  ownerAddress: Address;
  lpFence: LpDeployFence;
  depositNative0G: string;
  fundLpEntryFromSwap0G: string;
  llmModel?: string;
  confirmedSteps: LpDeployStep[];
  triggerFirstMint: boolean;
}

export interface LpDeployResult {
  deployment: OgAgentDeploymentRecord;
  tightenTxHash?: Hex;
  depositTxHash?: Hex;
  lpEntryFundFromSwap?: {
    amount0G: string;
    depositTxHash?: Hex;
    withdrawTxHash?: Hex;
    alreadyFunded?: boolean;
    resumedFromOwner?: boolean;
  };
  firstMint?: {
    lpTxHash: Hex;
    tokenId?: string;
    liquidity?: string;
  };
  firstMintError?: string;
  firstMintRun?: OgAgentLpRunRecord;
  firstMintSummary?: OgAgentLpWorkerRunSummary;
  stepsExecuted: LpDeployStep[];
}

const FIRST_MINT_CYCLE_TIMEOUT_MS = 5 * 60_000;

export async function deployLpAgent(input: LpDeployInput): Promise<LpDeployResult> {
  // Deploy mode gate — mainnet, real adapter, no mock. The execute-mode gate
  // (AGENT_TRADE_LIVE_ENABLED) is only required for step 4.
  assertLpMainnetEnv("deploy");

  const name = input.name.trim();
  if (name.length < 3 || name.length > 80) {
    throw new OgAgentDeployError("Agent name must be between 3 and 80 characters.", "invalid_agent_name", 400);
  }
  if (!isAddress(input.ownerAddress)) {
    throw new OgAgentDeployError("ownerAddress is not a valid address.", "invalid_owner", 400);
  }
  if (!/^\d+(\.\d{1,18})?$/u.test(input.depositNative0G.trim())) {
    throw new OgAgentDeployError("depositNative0G must be a positive decimal with <= 18 fractional digits.", "invalid_request", 400);
  }
  if (!/^\d+(\.\d{1,18})?$/u.test(input.fundLpEntryFromSwap0G.trim())) {
    throw new OgAgentDeployError("fundLpEntryFromSwap0G must be a positive decimal with <= 18 fractional digits.", "invalid_request", 400);
  }
  if (input.lpFence.maxPositions < 1 || input.lpFence.maxPositions > 3 || !Number.isInteger(input.lpFence.maxPositions)) {
    throw new OgAgentDeployError("maxPositions must be an integer 1..3.", "invalid_request", 400);
  }
  if (!/^\d+(\.\d{1,18})?$/u.test(input.lpFence.maxPerPosition0G.trim())) {
    throw new OgAgentDeployError("maxPerPosition0G must be a positive decimal with <= 18 fractional digits.", "invalid_request", 400);
  }

  const confirmed = new Set(input.confirmedSteps);
  if (confirmed.has("tighten-policy")) {
    throw new OgAgentDeployError(
      "tighten-policy is deprecated for LP agents. maxPositions and maxPerPosition0G are stored in agent runtime; remove tighten-policy and resubmit.",
      "deprecated_step",
      400,
    );
  }
  const stepsExecuted: LpDeployStep[] = [];
  const depositRequested = parseEther(input.depositNative0G.trim()) > 0n;
  const fundFromSwapRequested = parseEther(input.fundLpEntryFromSwap0G.trim()) > 0n;

  // --- Step 1: mint Agentic ID + enable agent key (delegated) ---
  // deploySingleOgAgent handles mint + setAgentKeyEnabled(true) when the deployer
  // is the vault owner (memory: mintAgent never enables the key; deploy must).
  // We always require 'mint-agentic-id' to be confirmed; 'enable-agent-key' is
  // folded into the same delegated call (deploySingleOgAgent does both), so we
  // require both to be present for the mint step to run.
  if (!confirmed.has("mint-agentic-id")) {
    throw new OgAgentDeployError("confirmedSteps must include 'mint-agentic-id'.", "missing_confirmation", 400);
  }
  if (!confirmed.has("enable-agent-key")) {
    throw new OgAgentDeployError("confirmedSteps must include 'enable-agent-key'.", "missing_confirmation", 400);
  }
  const deployment = await deploySingleOgAgent({
    allowZeroVaultBalance: depositRequested || fundFromSwapRequested,
    filterIds: ["lp-zia"],
    name,
    ownerAddress: input.ownerAddress,
    // LP agents default to autoMint=true at deploy — the autonomous worker mints
    // positions within the vault's on-chain fence when the agent has idle
    // balance and is off cooldown. The owner can toggle it off via the
    // automation route / the detail-page toggle.
    // The create-form filter (maxPositions + maxPerPosition0G) is persisted here
    // and enforced AGENT-side (brain/worker), NOT via vault tightenPolicy — the
    // vault keeps the owner's generous on-chain caps as a hard backstop. Bug 2.
    runtime: {
      automation: { autoMint: true },
      maxAprPct: input.lpFence.maxAprPct,
      minAprPct: input.lpFence.minAprPct,
      maxPositions: input.lpFence.maxPositions,
      maxPerPosition0G: input.lpFence.maxPerPosition0G.trim(),
    },
  });
  stepsExecuted.push("mint-agentic-id");
  const runtime = makeDeployerRuntime();
  const agentKey = deployment.agentKey ?? agentKeyForDeployment(deployment);
  const agentKeyEnabled = await runtime.publicClient.readContract({
    address: deployment.vault,
    abi: policyVaultV3Abi,
    functionName: "agentKeyEnabled",
    args: [agentKey],
  });
  if (agentKeyEnabled !== true) {
    throw new OgAgentDeployError("LP agent key was minted but is not enabled on the Policy Vault.", "agent_key_not_enabled", 409);
  }
  stepsExecuted.push("enable-agent-key");

  // Steps 2-3 require the DEPLOYER to be the vault owner (tightenPolicy +
  // depositNative are onlyOwner). If they differ, the orchestrator returns the
  // mint result + a 403-style signal so the UI can tell the owner to run those
  // steps themselves. For the demo (memory: owner 0xd7e0 == deployer) this path
  // is not exercised, but the guard is the safety net.
  const deployerIsVaultOwner = runtime.deployer.address.toLowerCase() === deployment.owner.toLowerCase();

  if (!deployerIsVaultOwner) {
    if (confirmed.has("deposit-native")) {
      throw new OgAgentDeployError(
        "owner-required-for-deposit: the deployer key is not the vault owner; the owner must run deposit-native themselves.",
        "owner_required",
        403,
      );
    }
    // Mint-only deploy (non-owner deployer). Return the deployment; steps 2-3
    // were not requested.
    return { deployment, stepsExecuted };
  }

  // --- Step 2: deposit native ---
  const tightenTxHash: Hex | undefined = undefined;
  let depositTxHash: Hex | undefined;
  let lpEntryFundFromSwap: LpDeployResult["lpEntryFundFromSwap"];
  if (confirmed.has("deposit-native")) {
    depositTxHash = await runDepositNative(runtime, deployment.vault, input.depositNative0G);
    stepsExecuted.push("deposit-native");
  }
  if (confirmed.has("fund-lp-entry-from-v4-swap")) {
    if (!deployment.v4SwapVault || (deployment.vaultVersion ?? 1) < 4) {
      throw new OgAgentDeployError("fund-lp-entry-from-v4-swap requires a V4 Policy Vault trio.", "invalid_request", 400);
    }
    lpEntryFundFromSwap = await runFundLpEntryFromSwap(runtime, deployment.v4SwapVault, deployment.vault, input.fundLpEntryFromSwap0G);
    stepsExecuted.push("fund-lp-entry-from-v4-swap");
  }

  // --- Step 3 (optional): first mint ---
  let firstMint: LpDeployResult["firstMint"];
  let firstMintError: string | undefined;
  let firstMintRun: OgAgentLpRunRecord | undefined;
  let firstMintSummary: OgAgentLpWorkerRunSummary | undefined;
  if (input.triggerFirstMint && confirmed.has("first-mint")) {
    if (process.env.AGENT_TRADE_LIVE_ENABLED !== "true") {
      firstMintError = "first-mint skipped: AGENT_TRADE_LIVE_ENABLED is not true";
    } else {
      try {
        const mint = await runFirstMintCycle(deployment, input.ownerAddress, input.llmModel);
        firstMintSummary = mint.summary;
        firstMintRun = mint.run;
        firstMint = mint.firstMint;
        if (firstMint) {
          stepsExecuted.push("first-mint");
        } else {
          firstMintError = summarizeFirstMintCycle(mint.summary, mint.run, deployment.id);
        }
      } catch (err) {
        // Step 1 is already on-chain and irreversible — do NOT rethrow.
        firstMintError = err instanceof Error ? err.message : "first-mint failed";
      }
    }
  }

  return {
    deployment,
    tightenTxHash,
    depositTxHash,
    lpEntryFundFromSwap,
    firstMint,
    firstMintError,
    firstMintRun,
    firstMintSummary,
    stepsExecuted,
  };
}

// --- Step 2 impl ---
// Exported so the "apply policy to existing vault" route
// (app/api/agents/lp/[id]/policy/route.ts) can reuse the exact tighten path
// the deploy flow uses — same runtime, same can-only-tighten enforcement.
export async function runTightenPolicy(
  runtime: DeployerRuntime,
  vault: Address,
  fence: LpDeployFence,
): Promise<Hex | undefined> {
  const currentPolicy = await readCurrentPolicy(runtime.publicClient, vault);
  const uiFenceLp = translateLpFence(
    { maxPositions: fence.maxPositions, maxPerPosition0G: fence.maxPerPosition0G },
    currentPolicy.lp,
  );
  const { nextPolicy, tightened } = buildTightenPolicyCall(currentPolicy, uiFenceLp as LpFenceLpPolicy);
  if (!tightened) return undefined; // no gas needed — UI fence == current policy

  // buildTightenPolicyCall already threw on any loosen attempt; the vault's
  // on-chain tighten enforcement is the backstop.
  // The ABI's `tightenPolicy` arg is a named struct (components with field
  // names), so viem resolves the expected arg as the object shape, not a
  // positional tuple. Pass the typed PolicyVaultV3Policy object directly.
  const simulation = await runtime.publicClient.simulateContract({
    account: runtime.deployer.address,
    address: vault,
    abi: policyVaultV3Abi,
    functionName: "tightenPolicy",
    args: [nextPolicy],
  });
  const txHash = await runtime.walletClient.writeContract({
    ...simulation.request,
    account: runtime.deployer,
    chain: runtime.chain,
  });
  await waitForReceipt(runtime.publicClient, txHash, "tightenPolicy");
  return txHash;
}

// --- Step 3 impl ---
async function runFundLpEntryFromSwap(
  runtime: DeployerRuntime,
  swapVault: Address,
  lpEntryVault: Address,
  amount0G: string,
): Promise<{ amount0G: string; depositTxHash?: Hex; withdrawTxHash?: Hex; alreadyFunded?: boolean; resumedFromOwner?: boolean }> {
  const amount = parseEther(amount0G.trim());
  if (amount <= 0n) {
    throw new OgAgentDeployError("fundLpEntryFromSwap0G must be > 0.", "invalid_request", 400);
  }

  const [swapBalance, lpEntryBalanceBefore, deployerBalanceBefore] = await Promise.all([
    runtime.publicClient.getBalance({ address: swapVault }),
    runtime.publicClient.getBalance({ address: lpEntryVault }),
    runtime.publicClient.getBalance({ address: runtime.deployer.address }),
  ]);
  if (lpEntryBalanceBefore >= amount) {
    return { amount0G: "0", alreadyFunded: true };
  }

  const missingAmount = amount - lpEntryBalanceBefore;
  const gasBuffer = parseEther("0.001");
  let withdrawTxHash: Hex | undefined;
  let resumedFromOwner = false;

  const canResumeFromOwner =
    deployerBalanceBefore >= missingAmount + gasBuffer &&
    (await hasRecentMatchingSwapWithdrawal(runtime, swapVault, missingAmount));

  if (canResumeFromOwner) {
    resumedFromOwner = true;
  } else {
    if (swapBalance < missingAmount) {
      throw new OgAgentDeployError(
        `V4 Swap balance ${formatEther(swapBalance)} 0G is below requested LP Entry funding ${formatEther(missingAmount)} 0G.`,
        "insufficient_balance",
        402,
      );
    }

    const withdrawSimulation = await runtime.publicClient.simulateContract({
      account: runtime.deployer.address,
      address: swapVault,
      abi: policyVaultV4SwapAbi,
      functionName: "withdrawNative",
      args: [missingAmount],
    });
    withdrawTxHash = await runtime.walletClient.writeContract({
      ...withdrawSimulation.request,
      account: runtime.deployer,
      chain: runtime.chain,
    });
    await waitForReceipt(runtime.publicClient, withdrawTxHash, "withdrawNative:V4Swap");
  }

  const deployerBalance = await runtime.publicClient.getBalance({ address: runtime.deployer.address });
  if (deployerBalance < missingAmount + gasBuffer) {
    throw new OgAgentDeployError(
      "Deployer balance after V4 Swap withdraw is insufficient for LP Entry deposit + gas.",
      "insufficient_balance",
      402,
    );
  }

  const depositSimulation = await runtime.publicClient.simulateContract({
    account: runtime.deployer.address,
    address: lpEntryVault,
    abi: policyVaultV4LpEntryAbi,
    functionName: "depositNative",
    args: [],
    value: missingAmount,
  });
  const depositTxHash = await runtime.walletClient.writeContract({
    ...depositSimulation.request,
    account: runtime.deployer,
    chain: runtime.chain,
    value: missingAmount,
  });
  await waitForReceipt(runtime.publicClient, depositTxHash, "depositNative:V4LpEntry");

  const lpEntryBalanceAfter = await runtime.publicClient.getBalance({ address: lpEntryVault });
  if (lpEntryBalanceAfter < amount) {
    throw new OgAgentDeployError("LP Entry balance delta was below the requested V4 Swap funding amount.", "tx_reverted", 500);
  }

  return { amount0G: formatEther(missingAmount), depositTxHash, withdrawTxHash, resumedFromOwner };
}

const nativeWithdrawnEvent = parseAbiItem("event NativeWithdrawn(address indexed recipient, uint256 amount)");

async function hasRecentMatchingSwapWithdrawal(
  runtime: DeployerRuntime,
  swapVault: Address,
  amount: bigint,
): Promise<boolean> {
  const latestBlock = await runtime.publicClient.getBlockNumber();
  const fromBlock = latestBlock > 10_000n ? latestBlock - 10_000n : 0n;
  const logs = await runtime.publicClient.getLogs({
    address: swapVault,
    event: nativeWithdrawnEvent,
    args: { recipient: runtime.deployer.address },
    fromBlock,
    toBlock: latestBlock,
  });
  return logs.some((log) => log.args.amount === amount);
}

async function runDepositNative(
  runtime: DeployerRuntime,
  vault: Address,
  depositNative0G: string,
): Promise<Hex> {
  const value = parseEther(depositNative0G.trim());
  if (value <= 0n) {
    throw new OgAgentDeployError("depositNative0G must be > 0.", "invalid_request", 400);
  }
  const deployerBalance = await runtime.publicClient.getBalance({ address: runtime.deployer.address });
  // Conservative: require the deposit + a small gas buffer. The exact gas cost
  // is bounded by the simulation; this preflight prevents a revert at write time.
  if (deployerBalance < value + parseEther("0.001")) {
    throw new OgAgentDeployError(
      "Deployer balance is insufficient for deposit + gas. Fund the DEPLOYER wallet before deposit-native.",
      "insufficient_balance",
      402,
    );
  }
  const simulation = await runtime.publicClient.simulateContract({
    account: runtime.deployer.address,
    address: vault,
    abi: policyVaultV3Abi,
    functionName: "depositNative",
    args: [],
    value,
  });
  const txHash = await runtime.walletClient.writeContract({
    ...simulation.request,
    account: runtime.deployer,
    chain: runtime.chain,
    value,
  });
  await waitForReceipt(runtime.publicClient, txHash, "depositNative");
  return txHash;
}

// --- Step 4 impl ---
// Deploy-time first-mint uses the exact same targeted worker path as autonomous
// LP cycles. That keeps deploy-first behavior aligned with fallback attempts,
// runtime maxPerPosition0G/maxPositions filters, dedup, run records, and
// auto-stake. It deliberately does not rely on the background worker selector.
async function runFirstMintCycle(
  deployment: OgAgentDeploymentRecord,
  ownerAddress: Address,
  llmModel?: string,
): Promise<{
  firstMint?: LpDeployResult["firstMint"];
  run?: OgAgentLpRunRecord;
  summary: OgAgentLpWorkerRunSummary;
}> {
  const summary = await withTimeout(
    runLpAgentWorkerOnce({
      agentId: deployment.id,
      dryRun: false,
      intervalMs: 30_000,
      killSwitchEnabled: false,
      maxCycles: 1,
      once: true,
      ownerAddress,
      processAllAgents: false,
      selectedModel: llmModel,
    }),
    FIRST_MINT_CYCLE_TIMEOUT_MS,
    "first-mint cycle",
  );
  const run = summary.runs.find((entry) => entry.agentId === deployment.id && entry.decision === "mint") ?? summary.runs[0];
  return {
    firstMint: firstMintFromRun(run),
    run,
    summary,
  };
}

function firstMintFromRun(run: OgAgentLpRunRecord | undefined): LpDeployResult["firstMint"] | undefined {
  if (!run || run.status !== "executed" || run.decision !== "mint" || !run.lpTxHash) {
    return undefined;
  }
  return {
    lpTxHash: run.lpTxHash,
    tokenId: run.tokenId,
  };
}

function summarizeFirstMintCycle(
  summary: OgAgentLpWorkerRunSummary,
  run: OgAgentLpRunRecord | undefined,
  agentId: string,
): string {
  if (!summary.selectedAgentIds.includes(agentId)) {
    return `first-mint did not select ${agentId}; agent may be paused, removed, or auto-mint disabled.`;
  }
  if (!run) {
    return "first-mint cycle completed without a run record.";
  }
  const detail = run.error || run.brainSummary || "LP worker did not execute a mint.";
  return `first-mint ${run.status}: ${detail}`;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

// --- runtime + helpers ---

export interface DeployerRuntime {
  chain: Chain;
  rpcUrl: string;
  publicClient: PublicClient;
  walletClient: WalletClient;
  deployer: ReturnType<typeof privateKeyToAccount>;
}

export function makeDeployerRuntime(): DeployerRuntime {
  const rpcUrl = process.env.OG_RPC_URL?.trim();
  if (!rpcUrl) throw new OgAgentDeployError("OG_RPC_URL is required for LP deploy.", "missing_env", 500);
  const chain = make0GMainnetChain(rpcUrl);
  const deployerKey = readPrivateKeyEnv("DEPLOYER_PRIVATE_KEY");
  const deployer = privateKeyToAccount(deployerKey);
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account: deployer, chain, transport: http(rpcUrl) });
  return { chain, rpcUrl, publicClient, walletClient, deployer };
}

function make0GMainnetChain(rpcUrl: string): Chain {
  return {
    id: LP_MAINNET_CHAIN_ID,
    name: "0G Mainnet",
    nativeCurrency: { decimals: 18, name: "0G", symbol: "0G" },
    rpcUrls: { default: { http: [rpcUrl] } },
  };
}

export async function readCurrentPolicy(publicClient: PublicClient, vault: Address): Promise<PolicyVaultV3Policy> {
  const raw = (await publicClient.readContract({
    address: vault,
    abi: policyVaultV3Abi,
    functionName: "policy",
  })) as unknown;
  return normalizePolicyVaultV3Policy(raw);
}

function readPrivateKeyEnv(name: string): Hex {
  const value = process.env[name]?.trim();
  if (!value || !isHex(value, { strict: true }) || value.length !== 66) {
    throw new OgAgentDeployError(`${name} must be a 32-byte private key hex string.`, "missing_env", 500);
  }
  return value as Hex;
}

async function waitForReceipt(publicClient: PublicClient, hash: Hex, label: string): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const receipt = await publicClient.getTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        throw new OgAgentDeployError(`${label} transaction reverted: ${hash}`, "tx_reverted", 500);
      }
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.toLowerCase().includes("not found")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  throw new OgAgentDeployError(`Timed out waiting for ${label} receipt: ${hash}`, "tx_timeout", 500);
}

// Re-export so the deploy route can build a workspace response without a second
// import site.
export { loadOgAgentWorkspace, agentKeyForDeployment };
