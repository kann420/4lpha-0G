import "server-only";

import { randomUUID } from "node:crypto";
import { parseEther, type Address } from "viem";

import {
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
import type { OgAgentLpRunRecord } from "@/lib/agent/runtime/types";

export interface OgAgentLpWorkerRunSummary {
  agentsErrored: number;
  agentsProcessed: number;
  blocked: number;
  dryRun: boolean;
  dryRuns: number;
  finishedAt: string;
  held: number;
  mintsExecuted: number;
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
    selectedAgentIds: selected.map((deployment) => deployment.id),
    startedAt,
  };

  for (const deployment of selected) {
    const result = await processLpDeployment(config, deployment);
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
    if (!deployment || !isLpZiaAgent(deployment) || !isAutomationOptedIn(deployment)) {
      return [];
    }
    if (workspace.agent.status !== "armed" || deployment.paused) {
      return [];
    }
    return [deployment];
  }

  const armed = workspace.agents.filter((deployment) => !deployment.paused);
  if (!config.processAllAgents) {
    // Without --all-agents, pick the most recent LP-zia agent that has opted in.
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
    if (!workspace.storage.uploadReady) {
      return appendAndReturn(buildRecord({
        agentId: deployment.id, agentName: deployment.name, agentRef: deployment.agentRef,
        cycleId, startedAt, decision,
        brainSummary: workspace.storage.warnings.join(" ") || "0G Storage upload is not ready for audit bundles.",
        status: "blocked",
      }));
    }

    const vault = workspace.vault;
    const lpPolicy = vault.lpPolicy;
    if (!lpPolicy) {
      return appendAndReturn(buildRecord({
        agentId: deployment.id, agentName: deployment.name, agentRef: deployment.agentRef,
        cycleId, startedAt, decision, brainSummary: "Vault has no lpPolicy.", status: "blocked",
      }));
    }

    // Idle-balance + exposure gate. The vault enforces on-chain; this avoids
    // spending a Router call + quote when there is clearly nothing to deploy.
    const balance0G = parseEther(vault.balance0G ?? "0");
    const perLpActionCap = parseEther(lpPolicy.perLpActionCap0G);
    const remainingLpExposure = parseEther(
      (parseEther(lpPolicy.maxLpExposure0G) - parseEther(vault.openLpExposure0G ?? "0") > 0n)
        ? (parseEther(lpPolicy.maxLpExposure0G) - parseEther(vault.openLpExposure0G ?? "0")).toString()
        : "0",
    );
    if (balance0G < perLpActionCap || remainingLpExposure <= 0n) {
      return appendAndReturn(buildRecord({
        agentId: deployment.id, agentName: deployment.name, agentRef: deployment.agentRef,
        cycleId, startedAt, decision,
        brainSummary: `Idle balance ${vault.balance0G ?? "0"} 0G below per-action cap ${lpPolicy.perLpActionCap0G} 0G or no exposure headroom.`,
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
    const pools = await buildPoolCandidates(publicClient);
    if (pools.length === 0) {
      return appendAndReturn(buildRecord({
        agentId: deployment.id, agentName: deployment.name, agentRef: deployment.agentRef,
        cycleId, startedAt, decision, brainSummary: "No zappable Zia LP pools available.", status: "held",
      }));
    }
    const fence = buildFence(vault);
    const brainDecision = await decideLpAction({
      pools,
      fence,
      vaultBalance0G: vault.balance0G ?? "0",
      readiness: {
        vaultReady: vault.ready,
        storageUploadReady: workspace.storage.uploadReady,
        vaultWarnings: vault.warnings,
      },
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

    if (config.dryRun) {
      return appendAndReturn(buildRecord({
        agentId: deployment.id, agentName: deployment.name, agentRef: deployment.agentRef,
        cycleId, startedAt, decision, brainSummary, model, poolAddress, tickLower, tickUpper, amount0G,
        status: "dry_run",
      }));
    }

    // Execute: pass the brain's pool/ticks/amount as overrides so
    // runLpMintForAgent does NOT re-call the Router. It re-loads the workspace
    // (freshest snapshot) + quotes + executes + anchors the proof.
    const result = await runLpMintForAgent({
      deployment: workspace.agent.deployment,
      llmModel: config.selectedModel,
      constrainPoolAddress: brainDecision.poolAddress,
      overrideTickLower: brainDecision.tickLower,
      overrideTickUpper: brainDecision.tickUpper,
      overrideAmount0G: brainDecision.amount0G,
    });
    lpTxHash = result.lpTxHash;
    proofTxHash = result.proofTxHash;

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
    if (result.tokenId && lpPolicy.allowStaking && findZiaLpVaultByPool(result.poolAddress) && cooldownSeconds === 0) {
      try {
        const stakeResult = await runLpExitForAgent({
          deployment: workspace.agent.deployment,
          kind: "stake",
          poolAddress: result.poolAddress,
          tokenId: String(result.tokenId),
        });
        mintBrainSummary = `${brainSummary ?? ""} minted + staked`.trim();
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
      tokenId: mintTokenId, lpTxHash, proofTxHash, status: "executed",
    }));
  } catch (error) {
    const message = sanitizeError(error);
    return appendAndReturn(buildRecord({
      agentId: deployment.id, agentName: deployment.name, agentRef: deployment.agentRef,
      cycleId, startedAt, decision, brainSummary, model, poolAddress, tickLower, tickUpper, amount0G,
      lpTxHash, proofTxHash, error: message, status: "errored",
    }));
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
    tokenId: input.tokenId,
    lpTxHash: input.lpTxHash,
    proofTxHash: input.proofTxHash,
    status: input.status,
    error: input.error,
  };
}

async function appendAndReturn(record: OgAgentLpRunRecord): Promise<OgAgentLpRunRecord> {
  await appendOgAgentLpRun(record).catch(() => undefined);
  return record;
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/(?:sk|mk)-[a-zA-Z0-9._-]+/gu, "[redacted-key]").slice(0, 500);
}