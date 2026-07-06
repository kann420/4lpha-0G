"use client";

import { useCallback, useEffect, useState } from "react";
import { Pause, Trash2 } from "lucide-react";
import { useAccount } from "wagmi";
import type { Address } from "viem";

import { AppShell } from "@/components/app/AppShell";
import { useOgNetwork } from "@/components/app/useOgNetwork";
import { LpAgentSidebar } from "@/components/agents/lp/LpAgentSidebar";
import { LpPolicyControls } from "@/components/agents/lp/LpPolicyControls";
import { LpPositionsWorkspace } from "@/components/agents/lp/LpPositionsWorkspace";
import { LpStatusPill } from "@/components/agents/lp/LpStatusPill";
import { ZiaPoweredBadge } from "@/components/agents/lp/ZiaPoweredBadge";
import { LpManualMintDialog, type ManualMintTarget } from "@/components/agents/lp/LpManualMintDialog";
import { useLpActionRequest } from "@/components/agents/lp/useLpActionRequest";
import { MOCK_LP_AGENT_ID, MOCK_LP_AGENT_SNAPSHOT } from "@/lib/agent/lp/mock-lp-data";
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
  const { network, networkId, setNetworkId } = useOgNetwork();
  const { address } = useAccount();
  const isMockAgent = agentId === MOCK_LP_AGENT_ID;
  const [toast, setToast] = useState<string | null>(null);
  const [live, setLive] = useState<LiveSnapshot | null>(null);
  const [isSnapshotLoading, setIsSnapshotLoading] = useState(!isMockAgent);
  const [autoMint, setAutoMint] = useState<boolean>(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [mintTarget, setMintTarget] = useState<ManualMintTarget | null>(null);

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

  // Load the live snapshot when a wallet is connected. Without a wallet the
  // snapshot route cannot resolve the owner's vault, so the page falls back to
  // the mock snapshot (clearly labeled) rather than blocking the UI.
  const refreshSnapshot = useCallback(async (options: RefreshSnapshotOptions = {}) => {
    if (isMockAgent) {
      setLive(null);
      setIsSnapshotLoading(false);
      return;
    }
    if (!address) {
      setLive(null);
      setIsSnapshotLoading(false);
      return;
    }
    if (!options.silent) {
      setIsSnapshotLoading(true);
    }
    try {
      const response = await fetch(`/api/agents/lp/${agentId}/snapshot?wallet=${address}`);
      if (!response.ok) {
        setLive(null);
        return;
      }
      const json = (await response.json()) as { data?: LiveSnapshot };
      if (json.data?.workspace) {
        setLive(json.data);
        const runtimeAutoMint = json.data.workspace.agent.deployment?.runtime?.automation?.autoMint ?? false;
        setAutoMint(runtimeAutoMint);
      } else {
        setLive(null);
      }
    } catch {
      setLive(null);
    } finally {
      if (!options.silent) {
        setIsSnapshotLoading(false);
      }
    }
  }, [address, agentId, isMockAgent]);

  useEffect(() => {
    void refreshSnapshot();
  }, [refreshSnapshot]);

  useEffect(() => {
    if (isMockAgent || !address) {
      return;
    }
    const interval = window.setInterval(() => {
      void refreshSnapshot({ silent: true });
    }, 30_000);
    return () => window.clearInterval(interval);
  }, [address, isMockAgent, refreshSnapshot]);

  const liveVault = live?.workspace.vault;
  const liveDeployment = live?.workspace.agent.deployment;
  const mockVault = isMockAgent ? MOCK_LP_AGENT_SNAPSHOT.vault : undefined;
  const vaultAddress = liveDeployment?.vault ?? liveVault?.vault ?? mockVault?.vault ?? EMPTY_ADDRESS;
  const lpActionRequest = useLpActionRequest(agentId, vaultAddress);

  // Resolve positions + policy from the live snapshot. Only the explicit mock
  // agent id is allowed to use mock positions; real agents must not flash fake
  // LP NFTs while the live request is still loading.
  const positions: readonly OgAgentVaultLpPosition[] = liveVault?.sellableLpPositions ?? mockVault?.sellableLpPositions ?? [];
  const allowStaking = liveVault?.lpPolicy?.allowStaking ?? mockVault?.lpPolicy?.allowStaking ?? false;
  const maxPositions = liveVault?.lpPolicy?.lpMaxPositions ?? mockVault?.lpPolicy?.lpMaxPositions ?? 0;
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
    try {
      const result = await lpActionRequest(action, path, { poolAddress: position.poolAddress, tokenId: position.tokenId });
      if (!result.ok) {
        flash(result.error ?? "Action failed.");
        return;
      }
      flash(`${successMessage} tx ${shortHash(result.data?.lpTxHash ?? "")}`);
      await refreshSnapshot();
    } finally {
      setPendingAction(null);
    }
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
                <LpStatusPill value={live ? "armed" : isMockAgent || isSnapshotLoading ? "draft" : "paused"} label={statusLabel} />
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
                  className="inline-flex h-9 items-center gap-2 rounded-tile border border-amber/20 bg-amber/[0.1] px-3 text-sm font-semibold text-amber transition-[border-color,filter,transform] hover:bg-amber/[0.16] active:scale-[0.96]"
                >
                  <Pause className="h-4 w-4" />
                  Pause
                </button>
                <button
                  type="button"
                  className="inline-flex h-9 items-center gap-2 rounded-tile border border-rose/20 bg-rose/[0.1] px-3 text-sm font-semibold text-rose transition-[border-color,filter,transform] hover:bg-rose/[0.16] active:scale-[0.96]"
                >
                  <Trash2 className="h-4 w-4" />
                  Remove
                </button>
              </div>
            </div>
            {draftName ? (
              <p className="mt-3 text-[11px] font-semibold text-primary">
                Just created: {draftName}. {live ? "Live snapshot loaded." : "Connect a wallet to load the live snapshot; showing mock fallback."}
              </p>
            ) : null}
          </section>

          {/* 3-column grid → stacked on mobile. */}
          {showLivePlaceholder ? (
            <section className="animate-feed-reveal rounded-card border border-line bg-panel-solid-strong p-5">
              <p className="text-sm font-semibold text-foreground">
                {isSnapshotLoading ? "Loading live LP snapshot" : "Live LP snapshot unavailable"}
              </p>
              <p className="mt-1 text-sm text-muted">
                {address ? "The page is waiting for the mainnet snapshot response." : "Connect the owner wallet to load this LP agent."}
              </p>
            </section>
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
              onMintBootstrap={() => setMintTarget({})}
              onStakePosition={(position) =>
                runExitAction("lp-stake", `/api/agents/lp/${agentId}/stake`, position, `Staked #${position.tokenId}.`)
              }
              onUnstakePosition={(position) =>
                runExitAction("lp-unstake", `/api/agents/lp/${agentId}/unstake`, position, `Unstaked #${position.tokenId}.`)
              }
              onZapOutPosition={(position) =>
                runExitAction("lp-zap-out", `/api/agents/lp/${agentId}/zap-out`, position, `Zapped out #${position.tokenId}.`)
              }
            />

            <LpPolicyControls
              agentId={agentId}
              vault={live || isMockAgent ? vaultAddress : undefined}
              autoMint={autoMint}
              isRefreshingLogs={isSnapshotLoading}
              onAutoMintChange={setAutoMint}
              onRefreshLogs={() => void refreshSnapshot()}
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
          void refreshSnapshot();
        }}
      />
    </AppShell>
  );
}

function shortHash(value: string): string {
  if (!value) return "";
  if (value.length <= 12) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}
