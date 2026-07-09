"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Pause, Play, Trash2 } from "lucide-react";
import { useSignMessage } from "wagmi";
import type { Address, Hex } from "viem";

import { AppShell } from "@/components/app/AppShell";
import { useOgNetwork } from "@/components/app/useOgNetwork";
import { LpAgentSidebar } from "@/components/agents/lp/LpAgentSidebar";
import { LpPolicyControls } from "@/components/agents/lp/LpPolicyControls";
import { LpPositionsWorkspace } from "@/components/agents/lp/LpPositionsWorkspace";
import { LpStatusPill } from "@/components/agents/lp/LpStatusPill";
import { ZiaPoweredBadge } from "@/components/agents/lp/ZiaPoweredBadge";
import { LpManualMintDialog, type ManualMintTarget } from "@/components/agents/lp/LpManualMintDialog";
import { useLpActionRequest } from "@/components/agents/lp/useLpActionRequest";
import { Skeleton } from "@/components/ui/Skeleton";
import { useAgentOwnerControls, type AgentWalletProof } from "@/components/agents/useAgentOwnerControls";
import { useWalletConnection } from "@/components/wallet/useWalletConnection";
import { MOCK_LP_AGENT_ID, MOCK_LP_AGENT_SNAPSHOT } from "@/lib/agent/lp/mock-lp-data";
import { dispatchSigmaPetReaction } from "@/lib/copilot/sigma-pet";
import type { OgAgentVaultLpPosition, OgAgentWorkspace } from "@/lib/agent/single-agent";

// LP agent detail/management page. Loads the live workspace via
// GET /api/agents/lp/[id]/snapshot and falls back to the mock snapshot only
// when the live fetch 404s (e.g. no wallet connected or agent not yet
// registered). Per-card actions (mint / stake / unstake / zap-out) are wired to
// the real routes with action-specific signed consent.

const EMPTY_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
const MOCK_AGENT_APR_BAND = { minAprPct: 6.9, maxAprPct: Infinity };

interface LiveSnapshot {
  workspace: OgAgentWorkspace;
}

interface RefreshSnapshotOptions {
  silent?: boolean;
}

export function LpAgentDetailPage({ agentId }: { agentId: string }) {
  const router = useRouter();
  const { network, networkId, setNetworkId } = useOgNetwork();
  const wallet = useWalletConnection(networkId);
  const address = wallet.address;
  const signMessage = useSignMessage();
  const isMockAgent = agentId === MOCK_LP_AGENT_ID;
  const [toast, setToast] = useState<string | null>(null);
  const [live, setLive] = useState<LiveSnapshot | null>(null);
  const [isSnapshotLoading, setIsSnapshotLoading] = useState(!isMockAgent);
  const [autoMint, setAutoMint] = useState<boolean>(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [mintTarget, setMintTarget] = useState<ManualMintTarget | null>(null);
  const [ownerAction, setOwnerAction] = useState<"pause" | "resume" | "remove" | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const [draftName, setDraftName] = useState<string | null>(null);
  useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem("lp-draft");
      if (raw) {
        const parsed = JSON.parse(raw) as { name?: string };
        if (parsed.name) setDraftName(parsed.name);
      }
    } catch {}
  }, []);

  const flash = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 2600);
  }, []);

  // Load a read-only live snapshot immediately; owner actions stay wallet-gated.
  const refreshSnapshot = useCallback(async (options: RefreshSnapshotOptions = {}) => {
    if (isMockAgent) {
      setLive(null);
      setIsSnapshotLoading(false);
      return;
    }
    if (!options.silent) {
      setIsSnapshotLoading(true);
    }
    try {
      const params = new URLSearchParams();
      if (address) params.set("wallet", address);
      const query = params.toString();
      const response = await fetch(`/api/agents/lp/${agentId}/snapshot${query ? `?${query}` : ""}`, { cache: "no-store" });
      if (!response.ok) {
        // A silent background poll that transiently fails (RPC rate limit,
        // timeout, etc.) must not blank out an already-loaded snapshot.
        if (!options.silent) setLive(null);
        return;
      }
      const json = (await response.json()) as { data?: LiveSnapshot };
      if (json.data?.workspace) {
        setLive(json.data);
        const runtimeAutoMint = json.data.workspace.agent.deployment?.runtime?.automation?.autoMint ?? false;
        setAutoMint(runtimeAutoMint);
      } else if (!options.silent) {
        setLive(null);
      }
    } catch {
      if (!options.silent) setLive(null);
    } finally {
      if (!options.silent) {
        setIsSnapshotLoading(false);
      }
    }
  }, [address, agentId, isMockAgent]);

  useEffect(() => {
    // Wait for wagmi to finish rehydrating a previously-connected wallet
    // before firing the initial fetch. Otherwise this fires once with no
    // `?wallet=` (server falls back to a non-owner vault resolve, which for
    // an LP agent is always below V3 and triggers a second full workspace
    // load server-side) and fires again moments later once `address`
    // resolves — three full workspace loads for one page visit.
    if (wallet.isReconnecting) {
      return;
    }
    void refreshSnapshot();
  }, [refreshSnapshot, wallet.isReconnecting]);

  useEffect(() => {
    if (isMockAgent) {
      return;
    }
    const interval = window.setInterval(() => {
      void refreshSnapshot({ silent: true });
    }, 30_000);
    return () => window.clearInterval(interval);
  }, [isMockAgent, refreshSnapshot]);

  const liveVault = live?.workspace.vault;
  const liveDeployment = live?.workspace.agent.deployment;
  const runtimeSettings = liveDeployment?.runtime;
  const mockVault = isMockAgent ? MOCK_LP_AGENT_SNAPSHOT.vault : undefined;
  const vaultAddress = liveDeployment?.vault ?? liveVault?.vault ?? mockVault?.vault ?? EMPTY_ADDRESS;
  const lpActionRequest = useLpActionRequest(agentId, vaultAddress);
  const status = live?.workspace.agent.status;
  const ownerAddress = liveDeployment?.owner ?? liveVault?.owner;
  const isOwnerWallet = Boolean(address && ownerAddress && address.toLowerCase() === ownerAddress.toLowerCase());
  const isPaused = status === "paused";
  const isRemoved = status === "removed";
  const vaultVersion = liveVault?.vaultVersion ?? 1;
  const agentKey = liveDeployment?.agentKey;
  const ownerControls = useAgentOwnerControls({
    agentId,
    networkId,
    ownerAddress: ownerAddress as Address | undefined,
    vaultAddress: vaultAddress !== EMPTY_ADDRESS ? vaultAddress : undefined,
    vaultVersion,
    // H8 FIX: pass the V4 trio so pause/remove toggles the agent key on ALL THREE thirds, not just
    // the canonical LpEntry vault (otherwise the key stays enabled on Swap/LpExit after remove).
    v4SwapAddress: liveVault?.v4SwapVault as Address | undefined,
    v4LpEntryAddress: liveVault?.v4LpEntryVault as Address | undefined,
    v4LpExitAddress: liveVault?.v4LpExitVault as Address | undefined,
    agentKey: agentKey as Hex | undefined,
    network,
    wallet,
    signMessage,
    setActionMessage,
  });
  const ownerActionDisabled = isMockAgent || !live || isRemoved || !wallet.isConnected || !isOwnerWallet || ownerAction !== null;

  // Resolve positions + policy from the live snapshot. Only the explicit mock
  // agent id is allowed to use mock positions; real agents must not flash fake
  // LP NFTs while the live request is still loading.
  const positions: readonly OgAgentVaultLpPosition[] = liveVault?.sellableLpPositions ?? mockVault?.sellableLpPositions ?? [];
  const allowStaking = liveVault?.lpPolicy?.allowStaking ?? mockVault?.lpPolicy?.allowStaking ?? false;
  const maxPositions = runtimeSettings?.maxPositions ?? liveVault?.lpPolicy?.lpMaxPositions ?? mockVault?.lpPolicy?.lpMaxPositions ?? 0;
  const openLpExposure0G = liveVault?.openLpExposure0G ?? mockVault?.openLpExposure0G ?? "0";
  const agentName = live?.workspace.agent.name ?? (isMockAgent ? MOCK_LP_AGENT_SNAPSHOT.agent.name : agentId);
  const lpAdapter = liveVault?.lpAdapter ?? mockVault?.lpAdapter ?? mockVault?.adapter ?? EMPTY_ADDRESS;
  const proofRegistry = liveVault?.proofRegistry ?? mockVault?.proofRegistry ?? EMPTY_ADDRESS;
  const logs = (live?.workspace.logs ?? (isMockAgent ? MOCK_LP_AGENT_SNAPSHOT.logs : []))
    .filter((log) => log.id !== "readiness-cycle");
  const totalDeployed0G = positions
    .reduce((sum, p) => sum + Number(p.deployedNative0G || 0), 0)
    .toFixed(2);
  const showLivePlaceholder = !isMockAgent && !live;
  const statusLabel = live ? "Live" : isMockAgent ? "Mock" : isSnapshotLoading ? "Loading" : "No snapshot";
  const pillValue = status === "armed" ? "armed" : status === "paused" ? "paused" : status === "removed" ? "paused" : "draft";
  const pillLabel = status === "removed" ? "Removed" : status === "paused" ? "Paused" : status === "armed" ? "Armed" : statusLabel;

  const positionPoolMap: Record<string, { label: string; poolAddress: Address; stakeVault: Address }> = {};
  for (const p of positions) {
    if (!p.stakeVault) continue;
    const key = p.poolAddress.toLowerCase();
    if (!positionPoolMap[key]) {
      positionPoolMap[key] = { label: p.poolLabel, poolAddress: p.poolAddress, stakeVault: p.stakeVault };
    }
  }
  const positionPoolList = Object.values(positionPoolMap);

  async function runExitAction(
    action: "lp-stake" | "lp-unstake" | "lp-zap-out",
    path: string,
    position: OgAgentVaultLpPosition,
    successMessage: string,
  ) {
    const key = `${position.tokenId}:${action.replace("lp-", "")}`;
    setPendingAction(key);
    dispatchSigmaPetReaction(action === "lp-stake" ? "lp.stake.start" : "lp.unstake.start", { force: true });
    try {
      const result = await lpActionRequest(action, path, { poolAddress: position.poolAddress, tokenId: position.tokenId });
      if (!result.ok) {
        dispatchSigmaPetReaction(action === "lp-stake" ? "lp.stake.fail" : "lp.unstake.fail", { force: true });
        flash(result.error ?? "Action failed.");
        return;
      }
      flash(`${successMessage} tx ${shortHash(result.data?.lpTxHash ?? "")}`);
      dispatchSigmaPetReaction(action === "lp-stake" ? "lp.stake.success" : "lp.unstake.success", { force: true });
      await refreshSnapshot();
    } finally {
      setPendingAction(null);
    }
  }

  async function runZapOutAction(position: OgAgentVaultLpPosition) {
    const key = `${position.tokenId}:zap-out`;
    setPendingAction(key);
    dispatchSigmaPetReaction("lp.zap.start", { force: true });
    try {
      if (position.staked) {
        const unstake = await lpActionRequest("lp-unstake", `/api/agents/lp/${agentId}/unstake`, {
          poolAddress: position.poolAddress,
          tokenId: position.tokenId,
        });
        if (!unstake.ok) {
          dispatchSigmaPetReaction("lp.zap.fail", { force: true });
          flash(unstake.error ?? "Unstake failed.");
          return;
        }
      }

      const zapOut = await lpActionRequest("lp-zap-out", `/api/agents/lp/${agentId}/zap-out`, {
        poolAddress: position.poolAddress,
        tokenId: position.tokenId,
      });
      if (!zapOut.ok) {
        dispatchSigmaPetReaction("lp.zap.fail", { force: true });
        flash(position.staked ? `Unstaked #${position.tokenId}; zap-out failed: ${zapOut.error ?? "Action failed."}` : (zapOut.error ?? "Action failed."));
        await refreshSnapshot();
        return;
      }
      flash(`Zapped out #${position.tokenId}. tx ${shortHash(zapOut.data?.lpTxHash ?? "")}`);
      dispatchSigmaPetReaction("lp.zap.success", { force: true });
      await refreshSnapshot();
    } finally {
      setPendingAction(null);
    }
  }

  async function fetchFreshSnapshotPositions(walletAddress: string): Promise<readonly OgAgentVaultLpPosition[]> {
    const response = await fetch(`/api/agents/lp/${agentId}/snapshot?wallet=${walletAddress}`, { cache: "no-store" });
    const json = (await response.json()) as { data?: LiveSnapshot; error?: { message?: string } };
    if (!response.ok || !json.data?.workspace) {
      throw new Error(json.error?.message ?? "Unable to verify LP positions before removal.");
    }
    setLive(json.data);
    const runtimeAutoMint = json.data.workspace.agent.deployment?.runtime?.automation?.autoMint ?? false;
    setAutoMint(runtimeAutoMint);
    return json.data.workspace.vault.sellableLpPositions ?? [];
  }

  async function onPause() {
    if (isMockAgent) {
      flash("Mock LP agent — owner actions are disabled.");
      return;
    }
    setOwnerAction("pause");
    setActionMessage("Pausing agent runtime and disabling the Policy Vault key.");
    dispatchSigmaPetReaction("lp.pause.start", { force: true });
    try {
      const proof = await ownerControls.ensureOwnerWalletProof();
      await ownerControls.setAgentKeyEnabledOnActiveVault(false);
      const nextWs = await ownerControls.postAgentStatus("pause", proof);
      setLive({ workspace: nextWs });
      setActionMessage("LP agent paused. Worker loop stopped and vault key disabled.");
      dispatchSigmaPetReaction("lp.pause.success", { force: true });
    } catch (error) {
      setActionMessage(formatActionError(error, "Pause request failed."));
      await refreshSnapshot();
    } finally {
      setOwnerAction(null);
    }
  }

  async function onResume() {
    if (isMockAgent) {
      flash("Mock LP agent — owner actions are disabled.");
      return;
    }
    setOwnerAction("resume");
    setActionMessage("Re-enabling the Policy Vault key and resuming the worker loop.");
    dispatchSigmaPetReaction("lp.resume.start", { force: true });
    try {
      const proof = await ownerControls.ensureOwnerWalletProof();
      await ownerControls.setAgentKeyEnabledOnActiveVault(true);
      const nextWs = await ownerControls.postAgentStatus("arm", proof);
      setLive({ workspace: nextWs });
      setActionMessage("LP agent resumed. Worker loop armed and vault key enabled.");
      dispatchSigmaPetReaction("lp.resume.success", { force: true });
    } catch (error) {
      setActionMessage(formatActionError(error, "Resume request failed."));
      await refreshSnapshot();
    } finally {
      setOwnerAction(null);
    }
  }

  async function onRemove() {
    if (isMockAgent) {
      flash("Mock LP agent — owner actions are disabled.");
      return;
    }
    if (positions.length === 0) {
      setOwnerAction("remove");
      dispatchSigmaPetReaction("lp.remove.clean", { force: true });
      try {
        // STEP 0 (worker-race guard): pause the worker loop BEFORE disabling
        // the key so the autonomous mint loop cannot mint a new position in
        // the window between clicking Remove and the on-chain disable being
        // mined (which would otherwise be orphaned after remove). Mirrors the
        // N>0 close-all path. Idempotent if already paused.
        const proof = await ownerControls.ensureOwnerWalletProof();
        setActionMessage("Pausing worker loop before removal.");
        const pausedWs = await ownerControls.postAgentStatus("pause", proof);
        setLive({ workspace: pausedWs });
        await disableKeyAndRemove(proof);
      } catch (error) {
        setActionMessage(formatActionError(error, "Remove request failed."));
        await refreshSnapshot();
      } finally {
        setOwnerAction(null);
      }
      return;
    }

    const confirmed = window.confirm(
      `This LP agent has ${positions.length} open position(s). To remove the agent, all positions must be closed first (unstake + zap-out, recovering 0G back to the vault). Proceed?\n\nThis will:\n1. Unstake + zap-out every open position (each requires a wallet-signed action).\n2. Disable the on-chain agent key.\n3. Mark the agent record as removed (permanent, read-only).\n\nIf ANY position fails to close, the operation will STOP immediately and the agent record will be left intact so you can retry.`,
    );
    if (!confirmed) {
      return;
    }

    setOwnerAction("remove");
    setActionMessage(`Closing ${positions.length} position(s) before removal.`);
    dispatchSigmaPetReaction("lp.remove.positions", { force: true });
    try {
      const proof = await ownerControls.ensureOwnerWalletProof();
      const startedPaused = status === "paused";
      setActionMessage("Pausing worker loop before close-all.");
      const pausedWs = await ownerControls.postAgentStatus("pause", proof);
      setLive({ workspace: pausedWs });

      let tempEnabledKey = false;
      if (startedPaused) {
        setActionMessage("Temporarily re-enabling the paused agent key for close-all.");
        await ownerControls.setAgentKeyEnabledOnActiveVault(true);
        tempEnabledKey = true;
      }

      try {
        const sortedPositions = [...positions].sort((a, b) => {
          const byPool = a.poolAddress.toLowerCase().localeCompare(b.poolAddress.toLowerCase());
          return byPool !== 0 ? byPool : a.tokenId.localeCompare(b.tokenId, undefined, { numeric: true });
        });

        for (let i = 0; i < sortedPositions.length; i += 1) {
          const position = sortedPositions[i]!;
          setPendingAction(`remove:${position.tokenId}`);
          setActionMessage(`Closing position ${i + 1}/${sortedPositions.length} (#${position.tokenId}, ${position.poolLabel}).`);
          if (position.staked) {
            const unstake = await lpActionRequest("lp-unstake", `/api/agents/lp/${agentId}/unstake`, {
              poolAddress: position.poolAddress,
              tokenId: position.tokenId,
            });
            if (!unstake.ok) {
              throw new Error(`Unstake failed for position #${position.tokenId}: ${unstake.error ?? "unknown"}. Close-all aborted; agent record left intact.`);
            }
            await sleep(8_000);
          }

          const zapOut = await lpActionRequest("lp-zap-out", `/api/agents/lp/${agentId}/zap-out`, {
            poolAddress: position.poolAddress,
            tokenId: position.tokenId,
          });
          if (!zapOut.ok) {
            throw new Error(`Zap-out failed for position #${position.tokenId}: ${zapOut.error ?? "unknown"}. Close-all aborted; agent record left intact.`);
          }
          flash(`Closed #${position.tokenId} (${i + 1}/${sortedPositions.length}).`);
          if (i < sortedPositions.length - 1) {
            setActionMessage("Cooling down 60s before next close (RPC rate limit).");
            await sleep(60_000);
          }
        }
      } finally {
        if (tempEnabledKey) {
          setActionMessage("Re-disabling the agent key after close-all.");
          try {
            await ownerControls.setAgentKeyEnabledOnActiveVault(false);
          } catch (error) {
            flash(`WARN: re-disable failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }

      await refreshSnapshot();
      const remaining = await fetchFreshSnapshotPositions(proof.address);
      if (remaining.length > 0) {
        throw new Error(`Post-loop verification failed: ${remaining.length} position(s) still open. Remove aborted; agent record left intact. Retry after positions close.`);
      }
      await disableKeyAndRemove(proof);
    } catch (error) {
      setActionMessage(formatActionError(error, "Remove request failed."));
      await refreshSnapshot();
    } finally {
      setOwnerAction(null);
      setPendingAction(null);
    }
  }

  async function disableKeyAndRemove(proof?: AgentWalletProof) {
    setActionMessage("Disabling the on-chain agent key and removing the agent record.");
    const walletProof = proof ?? await ownerControls.ensureOwnerWalletProof();
    const agentKeyDisableTxHash = await ownerControls.setAgentKeyEnabledOnActiveVault(false);
    setActionMessage("Agent key disabled. Removing the agent record.");
    await ownerControls.postAgentRemove(walletProof, agentKeyDisableTxHash);
    flash("LP agent removed.");
    dispatchSigmaPetReaction("agent.remove.success", { force: true });
    router.push("/agents");
  }

  return (
    <AppShell network={network} networkId={networkId} onNetworkChange={setNetworkId}>
      <main className="h-full min-h-0 overflow-y-auto px-4 py-5 lg:px-8 lg:py-7">
        <div className="mx-auto flex w-full max-w-[1720px] flex-col gap-5">
          {/* Header band */}
          <section
            className="animate-feed-reveal rounded-hero border border-line bg-panel-solid-strong px-5 py-5 lg:px-6"
            style={{ boxShadow: "var(--shadow-hero)", animationDelay: "0ms" }}
          >
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex flex-wrap items-center gap-3">
                <LpStatusPill value={pillValue} label={pillLabel} />
                <div className="min-w-0">
                  <h1 className="truncate text-2xl font-semibold tracking-tight text-foreground lg:text-3xl">
                    {draftName ?? agentName}
                  </h1>
                  <p className="mt-0.5 text-[11px] text-muted">LP Agent · {agentId} · {positions.length}/{maxPositions} positions</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <ZiaPoweredBadge size="md" />
                <button
                  type="button"
                  onClick={isPaused ? onResume : onPause}
                  disabled={ownerActionDisabled}
                  className={
                    isPaused
                      ? "inline-flex h-9 items-center gap-2 rounded-tile border border-green/20 bg-green/[0.1] px-3 text-sm font-semibold text-green transition-[border-color,filter,transform] hover:bg-green/[0.16] active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-50"
                      : "inline-flex h-9 items-center gap-2 rounded-tile border border-amber/20 bg-amber/[0.1] px-3 text-sm font-semibold text-amber transition-[border-color,filter,transform] hover:bg-amber/[0.16] active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-50"
                  }
                >
                  {ownerAction === "pause" || ownerAction === "resume"
                    ? <Loader2 className="h-4 w-4 animate-spin" />
                    : isPaused
                      ? <Play className="h-4 w-4" />
                      : <Pause className="h-4 w-4" />}
                  {isPaused ? "Resume" : "Pause"}
                </button>
                <button
                  type="button"
                  onClick={onRemove}
                  disabled={ownerActionDisabled}
                  className="inline-flex h-9 items-center gap-2 rounded-tile border border-rose/20 bg-rose/[0.1] px-3 text-sm font-semibold text-rose transition-[border-color,filter,transform] hover:bg-rose/[0.16] active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {ownerAction === "remove" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                  Remove
                </button>
              </div>
            </div>
            {draftName ? (
              <p className="mt-3 text-[11px] font-semibold text-primary">
                Just created: {draftName}. {live ? "Live snapshot loaded." : "Loading live snapshot."}
              </p>
            ) : null}
            {isMockAgent ? (
              <p className="mt-1 text-[11px] font-semibold text-amber">MOCK LP AGENT — owner actions (Pause / Resume / Remove) are disabled. No real vault is connected.</p>
            ) : null}
            {actionMessage ? <p className="mt-3 text-[11px] font-semibold text-amber">{actionMessage}</p> : null}
          </section>

          {/* 3-column grid → stacked on mobile. */}
          {showLivePlaceholder ? (
            isSnapshotLoading ? (
              <LpAgentDetailSkeleton />
            ) : (
              <section className="animate-feed-reveal rounded-card border border-line bg-panel-solid-strong p-5">
                <p className="text-sm font-semibold text-foreground">Live LP snapshot unavailable</p>
                <p className="mt-1 text-sm text-muted">
                  {address ? "The page is waiting for the mainnet snapshot response." : "Loading the read-only mainnet snapshot."}
                </p>
              </section>
            )
          ) : (
          <div className="grid animate-feed-reveal gap-4 lg:grid-cols-[320px_minmax(0,1fr)_420px]">
            <LpAgentSidebar
              vault={vaultAddress}
              adapter={lpAdapter}
              policyVaultV3={vaultAddress}
              proofRegistry={proofRegistry}
              maxPositions={maxPositions}
              aprBand={MOCK_AGENT_APR_BAND}
              positionPools={positionPoolList}
              positions={positions}
              identity={{
                address: live?.workspace.identity.address ?? liveDeployment?.identityAddress,
                configured: live?.workspace.identity.configured ?? Boolean(liveDeployment?.identityAddress),
                deployTxHash: liveDeployment?.deployTxHash,
                enableTxHash: liveDeployment?.agentKeyEnableTxHash,
                note: live?.workspace.identity.note,
                standard: live?.workspace.identity.label ?? liveDeployment?.standard ?? "ERC-7857",
                storageRoot: liveDeployment?.storageRoot,
                tokenId: liveDeployment?.tokenId,
                vault: vaultAddress,
              }}
            />

            <LpPositionsWorkspace
              positions={positions}
              maxPositions={maxPositions}
              totalDeployed0G={totalDeployed0G}
              openLpExposure0G={openLpExposure0G}
              allowStaking={allowStaking}
              isMockAgent={isMockAgent}
              pendingAction={pendingAction}
              onMintBootstrap={() => {
                dispatchSigmaPetReaction("lp.manual-mint.open", { force: true });
                setMintTarget({});
              }}
              onStakePosition={(position) =>
                runExitAction("lp-stake", `/api/agents/lp/${agentId}/stake`, position, `Staked #${position.tokenId}.`)
              }
              onUnstakePosition={(position) =>
                runExitAction("lp-unstake", `/api/agents/lp/${agentId}/unstake`, position, `Unstaked #${position.tokenId}.`)
              }
              onZapOutPosition={(position) => runZapOutAction(position)}
            />

            <LpPolicyControls
              agentId={agentId}
              vault={live || isMockAgent ? vaultAddress : undefined}
              autoMint={autoMint}
              isRefreshingLogs={isSnapshotLoading}
              onAutoMintChange={setAutoMint}
              onRefreshLogs={() => {
                dispatchSigmaPetReaction("lp.refresh", { force: true });
                void refreshSnapshot();
              }}
              automation={{
                autoRebalance: false,
                autoCompound: false,
                takeProfit: false,
                stopLoss: false,
              }}
              logs={logs}
            />
          </div>
          )}
        </div>

        {/* Toast */}
        {toast ? (
          <div className="pointer-events-none fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-full border border-line bg-panel-solid-strong px-4 py-2 text-sm font-semibold text-foreground shadow-[0_18px_58px_rgba(0,0,0,0.4)]">
            {toast}
          </div>
        ) : null}
      </main>

      <LpManualMintDialog
        open={Boolean(live || isMockAgent) && mintTarget !== null}
        agentId={agentId}
        vault={vaultAddress}
        target={mintTarget}
        onClose={() => setMintTarget(null)}
        onSuccess={(result) => {
          setMintTarget(null);
          const tag = result.staked
            ? `Minted + staked LP #${result.tokenId ?? "new"}`
            : result.stakeError
              ? `Minted LP #${result.tokenId ?? "new"} (stake failed — use Stake to retry)`
              : `Minted LP #${result.tokenId ?? "new"}`;
          flash(`${tag} tx ${shortHash(result.staked ? (result.stakeTxHash ?? result.lpTxHash ?? "") : (result.lpTxHash ?? ""))}`);
          dispatchSigmaPetReaction(result.staked ? "lp.mint.staked" : "lp.mint.success", { force: true });
          void refreshSnapshot();
        }}
      />
    </AppShell>
  );
}

function LpAgentDetailSkeleton() {
  return (
    <div className="grid animate-feed-reveal gap-4 lg:grid-cols-[320px_minmax(0,1fr)_420px]">
      {/* Sidebar: pool info + agent identity */}
      <div className="space-y-4">
        <div className="rounded-card border border-line bg-panel-solid-strong p-4">
          <Skeleton className="h-3 w-20" />
          <div className="mt-4 space-y-3">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="flex items-center justify-between">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-3 w-16" />
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-card border border-line bg-panel-solid-strong p-4">
          <div className="flex items-center gap-3">
            <Skeleton className="h-9 w-9 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3.5 w-24" />
              <Skeleton className="h-3 w-36" />
            </div>
          </div>
          <div className="mt-4 space-y-3">
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="flex items-center justify-between">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-3 w-20" />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Positions workspace */}
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-4 rounded-card border border-line bg-panel-solid-strong p-4">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-2.5 w-16" />
              <Skeleton className="h-5 w-20" />
            </div>
          ))}
        </div>
        <div className="rounded-card border border-line bg-panel-solid-strong p-5">
          <div className="flex items-center justify-between">
            <Skeleton className="h-5 w-32 rounded-full" />
            <Skeleton className="h-3 w-24" />
          </div>
          <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-5">
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="h-2.5 w-14" />
                <Skeleton className="h-4 w-16" />
              </div>
            ))}
          </div>
          <div className="mt-5 flex gap-3">
            <Skeleton className="h-9 w-24 rounded-full" />
            <Skeleton className="h-9 w-28 rounded-full" />
          </div>
        </div>
      </div>

      {/* Automation + agent log */}
      <div className="space-y-4">
        <div className="rounded-card border border-line bg-panel-solid-strong p-4">
          <div className="flex items-center justify-between">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-5 w-20 rounded-full" />
          </div>
          <Skeleton className="mt-3 h-3 w-full max-w-[16rem]" />
        </div>
        <div className="rounded-card border border-line bg-panel-solid-strong p-4">
          <Skeleton className="h-3 w-20" />
          <div className="mt-4 space-y-3">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="h-3.5 w-40" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-3/4" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function formatActionError(error: unknown, fallback: string): string {
  return error instanceof Error ? sanitizeWalletError(error.message) : fallback;
}

function sanitizeWalletError(message: string): string {
  if (/user rejected|user denied|rejected the request/iu.test(message)) {
    return "Wallet request was rejected.";
  }
  if (/insufficient funds/iu.test(message)) {
    return "Owner wallet does not have enough 0G for gas.";
  }
  return message.replace(/0x[a-fA-F0-9]{96,}/gu, "[redacted-hex]");
}

function shortHash(value: string): string {
  if (!value) return "";
  if (value.length <= 12) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}
