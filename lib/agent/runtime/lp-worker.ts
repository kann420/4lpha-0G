import "server-only";

import { mkdir, open, readFile, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { type Address } from "viem";

import {
  listAllAgentDeployments,
  loadOgAgentWorkspace,
} from "@/lib/agent/single-agent-server";
import type {
  OgAgentDeploymentRecord,
  OgAgentWorkspace,
} from "@/lib/agent/single-agent";
import { decideLpAction } from "@/lib/agent/runtime/lp-brain";
import { buildFence, buildPoolCandidates, makeMainnetPublicClient } from "@/lib/agent/lp/lp-context";
import { runLpMintForAgent } from "@/lib/agent/lp/lp-mint";
import { runLpExitForAgent } from "@/lib/agent/lp/lp-exec";
import { findZiaLpVaultByPool } from "@/lib/contracts/zia-lp";
import { appendOgAgentLpRun, readOgAgentLpRuns } from "@/lib/agent/runtime/lp-store";
import type { OgAgentLpWorkerConfig } from "@/lib/agent/runtime/lp-config";
import type { OgAgentLpAttemptRecord, OgAgentLpRunRecord } from "@/lib/agent/runtime/types";
import { applyRuntimeLpFence, computeLpMintBudget, parseLpDecimal0G } from "@/lib/agent/lp/lp-runtime-policy";
import { buildDeterministicFallbackMintAttempts, isRetryableLpMintError, type LpMintAttempt } from "@/lib/agent/lp/lp-fallback";

const MAX_MINT_ATTEMPTS_PER_CYCLE = 4;
const AGENT_CYCLE_LOCK_DIR = join(".data", "runtime", "lp-agent-cycle-locks");
const AGENT_CYCLE_LOCK_STALE_MS = 15 * 60_000;

export interface OgAgentLpWorkerRunSummary {
  agentsErrored: number;
  agentsProcessed: number;
  blocked: number;
  dryRun: boolean;
  dryRuns: number;
  finishedAt: string;
  held: number;
  mintsExecuted: number;
  runs: OgAgentLpRunRecord[];
  selectedAgentIds: string[];
  startedAt: string;
}

// Autonomous LP mint loop — one cycle. Mirrors runOgAgentWorkerOnce
// (lib/agent/runtime/worker.ts) but mint-only: the brain (0G Compute Router)
// picks a pool + tick range + amount within the vault's on-chain fence, the
// worker pre-checks idle balance + cooldown, and runLpMintForAgent quotes +
// executes + anchors the proof. Exits (unstake/zap-out/rebalance/TP/SL/compound)
// are user-manual in this phase.
//
// The brain is called ONCE per cycle (here, for the gate decision). On an
// execute mint, the brain's pool/ticks/amount are passed to runLpMintForAgent
// as overrides so it does NOT re-call the Router — saving tokens and keeping the
// live execution aligned with the gate decision. The vault's on-chain fence +
// the A8 pre-proof drift check are the authoritative backstops for any drift
// between the gate snapshot and execution.
export async function runLpAgentWorkerOnce(
  config: OgAgentLpWorkerConfig,
): Promise<OgAgentLpWorkerRunSummary> {
  const startedAt = new Date().toISOString();
  const selected = config.killSwitchEnabled ? [] : await selectLpDeploymentsForCycle(config);
  const summary: OgAgentLpWorkerRunSummary = {
    agentsErrored: 0,
    agentsProcessed: 0,
    blocked: 0,
    dryRun: config.dryRun,
    dryRuns: 0,
    finishedAt: startedAt,
    held: 0,
    mintsExecuted: 0,
    runs: [],
    selectedAgentIds: selected.map((deployment) => deployment.id),
    startedAt,
  };

  for (const deployment of selected) {
    const result = await processLpDeploymentWithLock(config, deployment);
    summary.runs.push(result);
    summary.agentsProcessed += 1;
    if (result.status === "errored") summary.agentsErrored += 1;
    if (result.status === "blocked") summary.blocked += 1;
    if (result.status === "dry_run") summary.dryRuns += 1;
    if (result.status === "held") summary.held += 1;
    if (result.status === "executed") summary.mintsExecuted += 1;
  }

  summary.finishedAt = new Date().toISOString();
  return summary;
}

async function selectLpDeploymentsForCycle(
  config: OgAgentLpWorkerConfig,
): Promise<OgAgentDeploymentRecord[]> {
  const workspace = await loadOgAgentWorkspace({
    agentId: config.agentId,
    live: true,
    ownerAddress: config.ownerAddress,
  });

  if (config.agentId) {
    const deployment = workspace.agent.deployment;
    debugLpWorkerSelection({
      agentId: config.agentId,
      autoMint: deployment?.runtime?.automation?.autoMint,
      deploymentPaused: deployment?.paused,
      filters: deployment?.filters,
      hasDeployment: Boolean(deployment),
      status: workspace.agent.status,
    });
    if (!deployment || !isLpZiaAgent(deployment) || !isAutomationOptedIn(deployment)) {
      return [];
    }
    if (workspace.agent.status !== "armed" || deployment.paused) {
      return [];
    }
    return [deployment];
  }

  // Community default: with no specific owner configured, enumerate agents across ALL owners so every
  // user's agents run (not just the env-configured owner's), and process all of them each cycle. When
  // an owner IS configured, keep the single-owner roster + honor --all-agents for operator targeting.
  const communityMode = !config.ownerAddress;
  const rosterSource = communityMode ? await listAllAgentDeployments() : workspace.agents;
  const armed = rosterSource.filter((deployment) => !deployment.paused);
  const processAll = config.processAllAgents || communityMode;
  if (!processAll) {
    // Without --all-agents (single configured owner), pick the most recent LP-zia agent that opted in.
    let target: OgAgentDeploymentRecord | undefined;
    for (let i = armed.length - 1; i >= 0; i -= 1) {
      const deployment = armed[i];
      if (isLpZiaAgent(deployment) && isAutomationOptedIn(deployment)) {
        target = deployment;
        break;
      }
    }
    return target ? [target] : [];
  }

  const ready: OgAgentDeploymentRecord[] = [];
  for (const deployment of armed) {
    if (!isLpZiaAgent(deployment) || !isAutomationOptedIn(deployment)) continue;
    if (deployment.paused) continue;
    const agentWorkspace = await loadOgAgentWorkspace({
      agentId: deployment.id,
      live: true,
      ownerAddress: config.ownerAddress ?? deployment.owner,
    });
    if (agentWorkspace.agent.status !== "armed" || !agentWorkspace.agent.deployment) continue;
    if (!isLpVaultRunnable(agentWorkspace)) continue;
    ready.push(agentWorkspace.agent.deployment);
  }
  return ready;
}

function debugLpWorkerSelection(payload: unknown): void {
  if (process.env.OG_AGENT_LP_WORKER_DEBUG !== "true") return;
  console.info(JSON.stringify({ payload, timestamp: new Date().toISOString(), type: "lp-worker-selection" }));
}

function isLpZiaAgent(deployment: OgAgentDeploymentRecord): boolean {
  return deployment.filters.some((filterId) => filterId.toLowerCase() === "lp-zia");
}

function isAutomationOptedIn(deployment: OgAgentDeploymentRecord): boolean {
  return deployment.runtime?.automation?.autoMint === true;
}

function isLpVaultRunnable(workspace: OgAgentWorkspace): boolean {
  const vault = workspace.vault;
  if ((vault.vaultVersion ?? 1) < 3) return false;
  if (!vault.lpAdapter || !vault.lpPolicy) return false;
  return vault.ready && !vault.paused && !vault.executorRevoked;
}

async function processLpDeployment(
  config: OgAgentLpWorkerConfig,
  deployment: OgAgentDeploymentRecord,
): Promise<OgAgentLpRunRecord> {
  const startedAt = new Date().toISOString();
  const cycleId = randomUUID();
  let decision: "mint" | "hold" = "hold";
  let brainSummary: string | undefined;
  let model: string | undefined;
  let poolAddress: Address | undefined;
  let tickLower: number | undefined;
  let tickUpper: number | undefined;
  let amount0G: string | undefined;
  let lpTxHash: OgAgentLpRunRecord["lpTxHash"];
  let proofTxHash: OgAgentLpRunRecord["proofTxHash"];
  let storageWarning: string | undefined;

  try {
    const workspace = await loadOgAgentWorkspace({
      agentId: deployment.id,
      live: true,
      ownerAddress: config.ownerAddress ?? deployment.owner,
    });
    if (workspace.agent.id !== deployment.id || !workspace.agent.deployment) {
      return appendAndReturn(buildRecord({
        agentId: deployment.id, agentName: deployment.name, agentRef: deployment.agentRef,
        cycleId, startedAt, decision, brainSummary: "Agent not found in workspace.", status: "blocked",
      }));
    }
    if (config.killSwitchEnabled) {
      return appendAndReturn(buildRecord({
        agentId: deployment.id, agentName: deployment.name, agentRef: deployment.agentRef,
        cycleId, startedAt, decision, brainSummary: "Worker kill switch is enabled.", status: "blocked",
      }));
    }
    if (workspace.agent.status !== "armed") {
      return appendAndReturn(buildRecord({
        agentId: deployment.id, agentName: deployment.name, agentRef: deployment.agentRef,
        cycleId, startedAt, decision, brainSummary: `Agent is ${workspace.agent.status}, not armed.`, status: "blocked",
      }));
    }
    if (!isLpVaultRunnable(workspace)) {
      return appendAndReturn(buildRecord({
        agentId: deployment.id, agentName: deployment.name, agentRef: deployment.agentRef,
        cycleId, startedAt, decision, brainSummary: lpVaultBlockedReason(workspace), status: "blocked",
      }));
    }
    storageWarning = workspace.storage.uploadReady
      ? undefined
      : workspace.storage.warnings.join(" ") || "0G Storage upload is unavailable; execution will use fallback audit anchoring.";

    const vault = workspace.vault;
    const lpPolicy = vault.lpPolicy;
    if (!lpPolicy) {
      return appendAndReturn(buildRecord({
        agentId: deployment.id, agentName: deployment.name, agentRef: deployment.agentRef,
        cycleId, startedAt, decision, brainSummary: "Vault has no lpPolicy.", status: "blocked",
      }));
    }

    // Idle-balance + exposure gate. maxPerPosition0G is the agent's real
    // runtime cap; perLpActionCap0G is only the vault ceiling/backstop. This
    // avoids the old bottleneck where a generous vault cap (e.g. 1,000,000 0G)
    // incorrectly required the vault balance to be at least that high.
    const mintBudget = computeLpMintBudget({
      balance0G: vault.balance0G ?? "0",
      maxLpExposure0G: lpPolicy.maxLpExposure0G,
      maxPerPosition0G: deployment.runtime?.maxPerPosition0G,
      openLpExposure0G: vault.openLpExposure0G ?? "0",
      perLpActionCap0G: lpPolicy.perLpActionCap0G,
    });
    if (mintBudget.maxAmountWei <= 0n) {
      return appendAndReturn(buildRecord({
        agentId: deployment.id, agentName: deployment.name, agentRef: deployment.agentRef,
        cycleId, startedAt, decision,
        brainSummary: `No LP mint budget: limiting factor ${mintBudget.limitingFactor}; balance ${vault.balance0G ?? "0"} 0G, remaining exposure ${mintBudget.remainingLpExposure0G} 0G, agent max ${deployment.runtime?.maxPerPosition0G ?? "unset"} 0G, vault ceiling ${lpPolicy.perLpActionCap0G} 0G.`,
        status: "held",
      }));
    }

    // Cooldown gate (advisory; the vault's on-chain cooldown is the backstop).
    // Only an actually-executed mint starts the cooldown clock.
    const cooldownSeconds = Number(lpPolicy.cooldownSecondsLp);
    if (cooldownSeconds > 0) {
      const latest = (await readOgAgentLpRuns(deployment.id, 1))[0];
      if (latest && latest.status === "executed" && latest.finishedAt) {
        const ageSeconds = Math.max(0, Math.floor((Date.now() - Date.parse(latest.finishedAt)) / 1000));
        if (ageSeconds < cooldownSeconds) {
          return appendAndReturn(buildRecord({
            agentId: deployment.id, agentName: deployment.name, agentRef: deployment.agentRef,
            cycleId, startedAt, decision,
            brainSummary: `LP cooldown active: ${ageSeconds}s elapsed, cooldown ${cooldownSeconds}s.`,
            status: "held",
          }));
        }
      }
    }

    // Build candidates + fence, then ask the brain.
    const publicClient = makeMainnetPublicClient();

    // Dedup source (Bug 3): pools the agent already holds an open position in.
    // Derived from the VALIDATED sellableLpPositions list (registry-driven post
    // A1.4 + re-validated per tokenId via readLpPositionByTokenId), NOT the raw
    // registry file — so a stale cached pool from a failed registry prune cannot
    // block a pool forever (the listing filters burned/drifted entries out).
    const openPoolAddresses: Address[] = (vault.sellableLpPositions ?? [])
      .map((p) => p.poolAddress.toLowerCase() as Address);
    const openLpExposure = parseLpDecimal0G(vault.openLpExposure0G ?? "0", "openLpExposure0G");

    // Blind-hold (codex #4): the vault enforces total 0G exposure + per-action
    // cap but NOT one-NFT-per-pool, so minting when we can't see the existing
    // positions could create a duplicate pair. If the listing is empty but the
    // vault reports open exposure, hold and ask for a backfill rather than mint
    // blind. (sellableLpPositions empty + openLpExposure 0 is the genuine empty
    // case — falls through to normal mint.)
    if (openPoolAddresses.length === 0 && openLpExposure > 0n) {
      return appendAndReturn(buildRecord({
        agentId: deployment.id, agentName: deployment.name, agentRef: deployment.agentRef,
        cycleId, startedAt, decision,
        brainSummary: "Open positions exist but listing is blind; holding to avoid duplicate mint. Re-run scripts/lp-backfill-positions.ts --force.",
        status: "held",
      }));
    }

    // Agent-enforced maxPositions gate (Bug 2): the create-form filter is
    // persisted in deployment.runtime and enforced HERE, not via vault tighten.
    // The vault's on-chain maxLpExposure0G stays as the hard backstop; this is
    // the operational cap the operator set per agent. Hold when the agent
    // already has maxPositions concurrent open positions.
    const maxPositions = deployment.runtime?.maxPositions ?? 2;
    if (openPoolAddresses.length >= maxPositions) {
      return appendAndReturn(buildRecord({
        agentId: deployment.id, agentName: deployment.name, agentRef: deployment.agentRef,
        cycleId, startedAt, decision,
        brainSummary: `Max positions reached: ${openPoolAddresses.length}/${maxPositions} open. Holding.`,
        status: "held",
      }));
    }

    const pools = await buildPoolCandidates(publicClient);
    if (pools.length === 0) {
      return appendAndReturn(buildRecord({
        agentId: deployment.id, agentName: deployment.name, agentRef: deployment.agentRef,
        cycleId, startedAt, decision, brainSummary: "No zappable Zia LP pools available.", status: "held",
      }));
    }
    // Early-skip: every allowlisted pool already has an open position — no
    // diversification possible, so hold without spending a Router call.
    const openPoolSet = new Set(openPoolAddresses.map((a) => a.toLowerCase()));
    if (pools.every((p) => openPoolSet.has(p.poolAddress.toLowerCase()))) {
      return appendAndReturn(buildRecord({
        agentId: deployment.id, agentName: deployment.name, agentRef: deployment.agentRef,
        cycleId, startedAt, decision,
        brainSummary: "All allowlisted LP pools already have open positions.",
        status: "held",
      }));
    }
    const fence = applyRuntimeLpFence(buildFence(vault), deployment.runtime);
    const brainDecision = await decideLpAction({
      pools,
      fence,
      openPoolAddresses,
      vaultBalance0G: vault.balance0G ?? "0",
      readiness: {
        vaultReady: vault.ready,
        storageUploadReady: workspace.storage.uploadReady,
        vaultWarnings: storageWarning ? [...vault.warnings, storageWarning] : vault.warnings,
      },
      // Agent-enforced per-position cap (Bug 2): clamp the mint amount to the
      // operator's create-form "Max 0G/position". The vault's perLpActionCap0G
      // stays as the hard backstop; this is the tighter operational cap.
      maxPerPosition0G: deployment.runtime?.maxPerPosition0G,
      selectedModel: config.selectedModel,
    });
    brainSummary = brainDecision.summary;
    model = brainDecision.model;
    if (brainDecision.action !== "mint" || !brainDecision.poolAddress
        || brainDecision.tickLower === undefined || brainDecision.tickUpper === undefined
        || !brainDecision.amount0G) {
      decision = "hold";
      return appendAndReturn(buildRecord({
        agentId: deployment.id, agentName: deployment.name, agentRef: deployment.agentRef,
        cycleId, startedAt, decision, brainSummary, model, status: "held",
      }));
    }

    decision = "mint";
    poolAddress = brainDecision.poolAddress;
    tickLower = brainDecision.tickLower;
    tickUpper = brainDecision.tickUpper;
    amount0G = brainDecision.amount0G;
    const llmAttempt: LpMintAttempt = {
      amount0G,
      poolAddress,
      source: "llm",
      tickLower,
      tickUpper,
    };
    const fallbackAttempts = buildDeterministicFallbackMintAttempts({
      amount0G: mintBudget.maxAmount0G,
      failedPoolAddresses: [llmAttempt.poolAddress],
      fence,
      maxAttempts: MAX_MINT_ATTEMPTS_PER_CYCLE - 1,
      openPoolAddresses,
      pools,
    });
    const mintAttempts = [llmAttempt, ...fallbackAttempts].slice(0, MAX_MINT_ATTEMPTS_PER_CYCLE);

    if (config.dryRun) {
      return appendAndReturn(buildRecord({
        agentId: deployment.id, agentName: deployment.name, agentRef: deployment.agentRef,
        cycleId, startedAt, decision, brainSummary, model, poolAddress, tickLower, tickUpper, amount0G,
        storageWarning,
        attempts: [attemptRecord(llmAttempt, "dry_run")],
        status: "dry_run",
      }));
    }

    // Execute: pass each candidate pool/ticks/amount as overrides so
    // runLpMintForAgent does NOT re-call the Router. It re-loads the workspace
    // (freshest snapshot) + quotes + executes + anchors the proof.
    const attemptRecords: OgAgentLpAttemptRecord[] = [];
    let lastError: string | undefined;
    for (let attemptIndex = 0; attemptIndex < mintAttempts.length; attemptIndex += 1) {
      const attempt = mintAttempts[attemptIndex]!;
      poolAddress = attempt.poolAddress;
      tickLower = attempt.tickLower;
      tickUpper = attempt.tickUpper;
      amount0G = attempt.amount0G;
      try {
        const result = await runLpMintForAgent({
          deployment: workspace.agent.deployment,
          llmModel: config.selectedModel,
          constrainPoolAddress: attempt.poolAddress,
          overrideTickLower: attempt.tickLower,
          overrideTickUpper: attempt.tickUpper,
          overrideAmount0G: attempt.amount0G,
        });
        lpTxHash = result.lpTxHash;
        proofTxHash = result.proofTxHash;
        storageWarning = result.storageWarning ?? storageWarning;
        attemptRecords.push(attemptRecord(attempt, "executed"));

    // Chain auto-stake when the vault policy allows staking AND a Zia stake vault
    // is mapped for this pool AND there is no LP cooldown. Best-effort: a stake
    // failure does NOT fail the mint — the NFT is minted + vault-held; the owner
    // can retry via the per-position Stake button. The stake is recorded as a
    // separate run entry. The cooldown gate is required: the mint just set
    // lastLpActionAt on-chain, so for any cooldown-gated vault the stakeLp tx is
    // guaranteed to revert with LpCooldownActive — skip auto-stake and leave the
    // position unstaked for a manual Stake after the cooldown.
    let mintBrainSummary = brainSummary;
    let mintTokenId: string | undefined = result.tokenId ? String(result.tokenId) : undefined;
        if (attempt.source === "fallback") {
          mintBrainSummary = `Fallback attempt ${attemptIndex + 1}/${mintAttempts.length} succeeded after retryable guard failure.`;
        }
        if (result.storageWarning) {
          mintBrainSummary = `${mintBrainSummary ?? ""} Storage warning: ${result.storageWarning}`.trim();
        }
    if (result.tokenId && lpPolicy.allowStaking && findZiaLpVaultByPool(result.poolAddress) && cooldownSeconds === 0) {
      try {
        const stakeResult = await runLpExitForAgent({
          deployment: workspace.agent.deployment,
          kind: "stake",
          poolAddress: result.poolAddress,
          tokenId: String(result.tokenId),
          });
          storageWarning = stakeResult.storageWarning ?? storageWarning;
          if (stakeResult.storageWarning) {
            mintBrainSummary = `${mintBrainSummary ?? ""} Stake storage warning: ${stakeResult.storageWarning}`.trim();
          }
          mintBrainSummary = `${mintBrainSummary ?? ""} minted + staked`.trim();
        await appendOgAgentLpRun({
          agentId: deployment.id,
          agentName: deployment.name,
          agentRef: deployment.agentRef,
          cycleId: `${cycleId}-stake`,
          startedAt,
          finishedAt: new Date().toISOString(),
          decision: "stake",
          brainSummary: "Auto-staked after mint (NFT moved into the Zia stake vault to earn staking APR).",
          model,
          vault: workspace.agent.deployment.vault,
          poolAddress: result.poolAddress,
          tokenId: result.tokenId,
          lpTxHash: stakeResult.lpTxHash,
          proofTxHash: stakeResult.proofTxHash,
          status: "executed",
        }).catch(() => undefined);
      } catch (stakeErr) {
        // Mint succeeded; stake failed. Record the mint with a note + append a
        // dedicated stake-errored run record so the failure is structurally
        // visible (not just free-text in the mint summary). The position is
        // left unstaked + vault-held for manual recovery via the Stake route.
        const stakeErrorMsg = stakeErr instanceof Error ? stakeErr.message : String(stakeErr);
        mintBrainSummary = `${brainSummary ?? ""} minted (stake failed — use Stake to retry)`.trim();
        await appendOgAgentLpRun({
          agentId: deployment.id,
          agentName: deployment.name,
          agentRef: deployment.agentRef,
          cycleId: `${cycleId}-stake`,
          startedAt,
          finishedAt: new Date().toISOString(),
          decision: "stake",
          brainSummary: "Auto-stake after mint failed; retry via the Stake button.",
          model,
          vault: workspace.agent.deployment.vault,
          poolAddress: result.poolAddress,
          tokenId: result.tokenId,
          status: "errored",
          error: stakeErrorMsg.slice(0, 500),
        }).catch(() => undefined);
      }
    }
    return appendAndReturn(buildRecord({
      agentId: deployment.id, agentName: deployment.name, agentRef: deployment.agentRef,
      cycleId, startedAt, decision, brainSummary: mintBrainSummary, model, poolAddress, tickLower, tickUpper, amount0G,
      storageWarning,
      attempts: attemptRecords,
      tokenId: mintTokenId, lpTxHash, proofTxHash, status: "executed",
    }));
      } catch (attemptError) {
        const message = sanitizeError(attemptError);
        const retryable = isRetryableLpMintError(message);
        lastError = message;
        attemptRecords.push(attemptRecord(attempt, "errored", message, retryable));
        if (!retryable) {
          break;
        }
      }
    }

    const allFailedSummary = mintAttempts.length > 1
      ? `All ${attemptRecords.length}/${mintAttempts.length} LP mint attempts failed. Last error: ${lastError ?? "unknown error"}`
      : `LP mint attempt failed. ${lastError ?? "Unknown error"}`;
    return appendAndReturn(buildRecord({
      agentId: deployment.id, agentName: deployment.name, agentRef: deployment.agentRef,
      cycleId, startedAt, decision, brainSummary: allFailedSummary, model, poolAddress, tickLower, tickUpper, amount0G,
      storageWarning,
      attempts: attemptRecords,
      lpTxHash, proofTxHash, error: lastError, status: "errored",
    }));
  } catch (error) {
    const message = sanitizeError(error);
    return appendAndReturn(buildRecord({
      agentId: deployment.id, agentName: deployment.name, agentRef: deployment.agentRef,
      cycleId, startedAt, decision, brainSummary, model, poolAddress, tickLower, tickUpper, amount0G,
      storageWarning, lpTxHash, proofTxHash, error: message, status: "errored",
    }));
  }
}

async function processLpDeploymentWithLock(
  config: OgAgentLpWorkerConfig,
  deployment: OgAgentDeploymentRecord,
): Promise<OgAgentLpRunRecord> {
  const lock = await acquireLpAgentCycleLock(deployment.id);
  if (!lock) {
    const startedAt = new Date().toISOString();
    return appendAndReturn(buildRecord({
      agentId: deployment.id,
      agentName: deployment.name,
      agentRef: deployment.agentRef,
      cycleId: randomUUID(),
      startedAt,
      decision: "hold",
      brainSummary: "Another LP cycle is already running for this agent; skipping this cycle.",
      status: "held",
    }));
  }

  try {
    return await processLpDeployment(config, deployment);
  } finally {
    await releaseLpAgentCycleLock(lock);
  }
}

function lpVaultBlockedReason(workspace: OgAgentWorkspace): string {
  const vault = workspace.vault;
  if ((vault.vaultVersion ?? 1) < 3 || !vault.lpAdapter || !vault.lpPolicy) {
    return "LP automation requires a V3 vault with an LP adapter.";
  }
  if (!vault.ready) {
    return vault.warnings.join(" ") || "Policy Vault is not ready for autonomous execution.";
  }
  if (vault.paused) {
    return "Policy Vault is paused.";
  }
  if (vault.executorRevoked) {
    return "Policy Vault executor is revoked.";
  }
  return "Policy Vault is not ready for autonomous LP execution.";
}

function buildRecord(input: {
  agentId: string; agentName: string; agentRef?: string; cycleId: string; startedAt: string;
  decision: "mint" | "hold"; brainSummary?: string; model?: string;
  poolAddress?: Address; tickLower?: number; tickUpper?: number; amount0G?: string;
  storageWarning?: string;
  attempts?: OgAgentLpAttemptRecord[];
  tokenId?: string;
  lpTxHash?: OgAgentLpRunRecord["lpTxHash"]; proofTxHash?: OgAgentLpRunRecord["proofTxHash"];
  error?: string; status: OgAgentLpRunRecord["status"];
}): OgAgentLpRunRecord {
  return {
    agentId: input.agentId,
    agentName: input.agentName,
    agentRef: input.agentRef,
    cycleId: input.cycleId,
    startedAt: input.startedAt,
    finishedAt: new Date().toISOString(),
    decision: input.decision,
    brainSummary: input.brainSummary,
    model: input.model,
    poolAddress: input.poolAddress,
    tickLower: input.tickLower,
    tickUpper: input.tickUpper,
    amount0G: input.amount0G,
    storageWarning: input.storageWarning,
    attempts: input.attempts,
    tokenId: input.tokenId,
    lpTxHash: input.lpTxHash,
    proofTxHash: input.proofTxHash,
    status: input.status,
    error: input.error,
  };
}

function attemptRecord(
  attempt: LpMintAttempt,
  status: OgAgentLpAttemptRecord["status"],
  error?: string,
  retryable?: boolean,
): OgAgentLpAttemptRecord {
  return {
    amount0G: attempt.amount0G,
    error,
    poolAddress: attempt.poolAddress,
    retryable,
    source: attempt.source,
    status,
    tickLower: attempt.tickLower,
    tickUpper: attempt.tickUpper,
  };
}

async function appendAndReturn(record: OgAgentLpRunRecord): Promise<OgAgentLpRunRecord> {
  await appendOgAgentLpRun(record).catch(() => undefined);
  return record;
}

async function acquireLpAgentCycleLock(agentId: string): Promise<{ handle: FileHandle; path: string } | null> {
  await mkdir(AGENT_CYCLE_LOCK_DIR, { recursive: true });
  const path = join(AGENT_CYCLE_LOCK_DIR, `${safeArtifactName(agentId)}.lock`);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, "wx");
      await handle.writeFile(JSON.stringify({ agentId, lockedAt: Date.now(), pid: process.pid }), "utf8");
      return { handle, path };
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code !== "EEXIST") {
        throw error;
      }
      if (attempt === 0 && await isLpAgentCycleLockStale(path)) {
        await unlink(path).catch(() => undefined);
        continue;
      }
      return null;
    }
  }
  return null;
}

async function releaseLpAgentCycleLock(lock: { handle: FileHandle; path: string }): Promise<void> {
  await lock.handle.close().catch(() => undefined);
  await unlink(lock.path).catch(() => undefined);
}

async function isLpAgentCycleLockStale(path: string): Promise<boolean> {
  try {
    const raw = await readFile(path, "utf8");
    const payload = JSON.parse(raw || "{}") as { lockedAt?: number; pid?: number };
    if (typeof payload.pid === "number" && !isPidAlive(payload.pid)) {
      return true;
    }
    if (typeof payload.lockedAt === "number") {
      return Date.now() - payload.lockedAt > AGENT_CYCLE_LOCK_STALE_MS;
    }
    return true;
  } catch {
    return false;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function safeArtifactName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/gu, "_").slice(0, 96);
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/(?:sk|mk)-[a-zA-Z0-9._-]+/gu, "[redacted-key]").slice(0, 500);
}
