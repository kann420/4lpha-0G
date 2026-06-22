"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  Activity,
  ArrowLeft,
  Brain,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  FileCheck2,
  Loader2,
  Pause,
  Pencil,
  Play,
  RefreshCcw,
  Shield,
  ShieldAlert,
  Target,
  Trash2,
  TrendingUp,
  Zap,
} from "lucide-react";
import { useSignMessage } from "wagmi";
import { AppShell } from "@/components/app/AppShell";
import { useOgNetwork } from "@/components/app/useOgNetwork";
import { AgentEmptyState, shortHash } from "@/components/agents/OgAgentWorkspace";
import { WalletConnectButton } from "@/components/wallet";
import { useWalletConnection } from "@/components/wallet/useWalletConnection";
import { AGENT_TRADE_ROUTES } from "@/lib/agent/trade-catalog";
import { buildCopilotWalletAccessMessage } from "@/lib/copilot/wallet-access";
import { getOgNetwork } from "@/lib/og/networks";
import type { AgentTradeResponse } from "@/lib/types";
import type { OgAgentLogEntry, OgAgentLogFilter, OgAgentVaultPosition, OgAgentWorkspace } from "@/lib/agent/single-agent";

const MAINNET = getOgNetwork("mainnet");
type DetailLogFilter = "all" | OgAgentLogFilter;
type PositionTab = "active" | "closed" | "recent";
type AgentOwnerAction = "arm" | "pause" | "remove" | "sell";
type AgentWalletProof = {
  address: string;
  chainId: number;
  message: string;
  signature: string;
};
type PositionRowView = {
  action: string;
  balance: string;
  canSell: boolean;
  id: string;
  lastActive: string;
  pnl: string;
  routeId?: string;
  token: string;
  total: string;
};

const LOG_FILTERS: Array<{ label: string; tone: "slate" | "cyan" | "amber" | "emerald"; value: DetailLogFilter }> = [
  { label: "All", tone: "slate", value: "all" },
  { label: "Reason", tone: "cyan", value: "reasoning" },
  { label: "Blocked", tone: "amber", value: "blocked" },
  { label: "Executed", tone: "emerald", value: "executed" },
];

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

function statusBadgeClass(status: OgAgentWorkspace["agent"]["status"] | "loading" | "mainnet only"): string {
  switch (status) {
    case "armed":
      return "border-emerald-400/20 bg-emerald-400/10 text-emerald-300";
    case "blocked":
      return "border-amber-300/20 bg-amber-300/10 text-amber-200";
    case "paused":
      return "border-yellow-300/20 bg-yellow-300/10 text-yellow-200";
    case "draft":
    case "loading":
    case "mainnet only":
    default:
      return "border-slate-400/20 bg-slate-400/10 text-slate-300";
  }
}

export function OgAgentDetailPage({ agentId }: { agentId: string }) {
  const router = useRouter();
  const { network, networkId, setNetworkId } = useOgNetwork();
  const wallet = useWalletConnection(networkId);
  const signMessage = useSignMessage();
  const [workspace, setWorkspace] = useState<OgAgentWorkspace | null>(null);
  const [positionTab, setPositionTab] = useState<PositionTab>("active");
  const [logFilter, setLogFilter] = useState<DetailLogFilter>("all");
  const [isLoading, setIsLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<AgentOwnerAction | null>(null);
  const [actionMessage, setActionMessage] = useState<string>();
  const [walletAccessByKey, setWalletAccessByKey] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const loadWorkspace = useCallback(async (options: { silent?: boolean } = {}) => {
    if (!options.silent) {
      setIsLoading(true);
    }
    setError(undefined);
    try {
      const response = await fetch(`/api/agents?agentId=${encodeURIComponent(agentId)}`, { cache: "no-store" });
      const payload = (await response.json()) as { data?: OgAgentWorkspace; error?: { message: string } };
      if (!response.ok || !payload.data) {
        throw new Error(payload.error?.message ?? "Unable to load agent workspace.");
      }
      setWorkspace(payload.data);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load agent workspace.");
    } finally {
      if (!options.silent) {
        setIsLoading(false);
      }
    }
  }, [agentId]);

  useEffect(() => {
    if (networkId !== "mainnet") {
      setError(undefined);
      setIsLoading(false);
      return;
    }
    void loadWorkspace();
  }, [loadWorkspace, networkId]);

  useEffect(() => {
    if (networkId !== "mainnet") {
      return;
    }
    const interval = window.setInterval(() => {
      void loadWorkspace({ silent: true });
    }, 6_000);
    return () => window.clearInterval(interval);
  }, [loadWorkspace, networkId]);

  const deployment = workspace?.agent.deployment;
  const agentMismatch = Boolean(workspace && (workspace.agent.id !== agentId || !workspace.agent.deployment));
  const isMainnetAgentScope = networkId === "mainnet";
  const policy = workspace?.vault.policy;
  const logs = useMemo(() => workspace?.logs ?? [], [workspace?.logs]);
  const filteredLogs = useMemo(() => filterLogs(logs, logFilter), [logFilter, logs]);
  const tradeCount = logs.filter((entry) => entry.filter === "executed" && (entry.action === "buy" || entry.action === "sell")).length;
  const openPositionCount = workspace?.vault.sellablePositions?.length ?? 0;
  const runtimeSettings = deployment?.runtime;
  const isAgentPaused = workspace?.agent.status === "paused";
  const ownerAddress = deployment?.owner ?? workspace?.vault.owner;
  const isOwnerWallet =
    Boolean(wallet.address && ownerAddress && wallet.address.toLowerCase() === ownerAddress.toLowerCase());
  const ownerActionDisabled =
    !isMainnetAgentScope ||
    !deployment ||
    !wallet.isConnected ||
    !isOwnerWallet ||
    actionLoading !== null ||
    isLoading;
  const walletActionMessage = getOwnerWalletMessage({
    isConnected: wallet.isConnected,
    isOwnerWallet,
    isWrongChain: wallet.isWrongChain,
    ownerAddress,
    walletAddress: wallet.address,
  });
  const walletAccessKey = wallet.address ? `${networkId}:${network.chainId}:${wallet.address.toLowerCase()}` : undefined;

  async function ensureOwnerWalletProof(): Promise<AgentWalletProof> {
    if (!wallet.address) {
      throw new Error("Connect the Policy Vault owner wallet first.");
    }
    if (!ownerAddress || wallet.address.toLowerCase() !== ownerAddress.toLowerCase()) {
      throw new Error("Connected wallet is not the Policy Vault owner.");
    }
    if (wallet.isWrongChain) {
      setActionMessage(`Switching wallet to ${network.networkName}.`);
      await wallet.switchToOg();
    }
    const message = buildCopilotWalletAccessMessage({
      address: wallet.address,
      chainId: network.chainId,
      networkId,
    });
    const cached = walletAccessKey ? walletAccessByKey[walletAccessKey] : undefined;
    const signature = cached ?? await signMessage.signMessageAsync({ message });
    if (walletAccessKey && !cached) {
      setWalletAccessByKey((current) => ({ ...current, [walletAccessKey]: signature }));
    }
    return {
      address: wallet.address,
      chainId: network.chainId,
      message,
      signature,
    };
  }

  async function runOwnerAgentStatusAction(action: "arm" | "pause") {
    setActionLoading(action);
    setActionMessage(action === "pause" ? "Pausing agent runtime." : "Arming agent runtime.");
    try {
      const walletProof = await ensureOwnerWalletProof();
      const response = await fetch("/api/agents/status", {
        body: JSON.stringify({
          action,
          agentId,
          networkId: "mainnet",
          wallet: walletProof,
        }),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      });
      const payload = (await response.json()) as { data?: { workspace: OgAgentWorkspace }; error?: { message: string } };
      if (!response.ok || !payload.data) {
        throw new Error(payload.error?.message ?? "Agent status update failed.");
      }
      setWorkspace(payload.data.workspace);
      setActionMessage(action === "pause" ? "Agent runtime paused. Policy Vault funds remain active." : "Agent runtime armed.");
    } catch (actionError) {
      setActionMessage(actionError instanceof Error ? sanitizeWalletError(actionError.message) : "Owner action failed.");
    } finally {
      setActionLoading(null);
    }
  }

  async function sellOpenPosition(routeId?: string) {
    setActionLoading("sell");
    setActionMessage("Preparing owner-approved sell request.");
    try {
      const walletProof = await ensureOwnerWalletProof();
      const routeIds = routeId ? [routeId] : getSellableRouteIds(workspace);
      if (routeIds.length === 0) {
        throw new Error("No sellable token balance is available in the Policy Vault.");
      }

      let submitted = 0;
      for (const currentRouteId of routeIds) {
        const route = getSellRoute(currentRouteId);
        if (!route) {
          throw new Error("Selected mainnet sell route is not available for this agent.");
        }
        const response = await fetch("/api/copilot/trade", {
          body: JSON.stringify({
            intent: "execute",
            request: {
              agentId: workspace?.agent.id ?? agentId,
              networkId: "mainnet",
              routeId: route.id,
              sellPercent: 100,
              side: "sell",
              slippageBps: getDefaultSlippageBps(policy),
            },
            wallet: walletProof,
          }),
          headers: {
            "Content-Type": "application/json",
          },
          method: "POST",
        });
        const payload = (await response.json()) as AgentTradeResponse;
        if (!response.ok || !payload.data) {
          throw new Error(payload.error?.message ?? "Sell request failed.");
        }
        if (payload.data.execution?.txHash) {
          submitted += 1;
        }
      }
      await loadWorkspace();
      setActionMessage(submitted > 0 ? `${submitted} sell request${submitted === 1 ? "" : "s"} submitted through Policy Vault.` : "Sell review completed.");
    } catch (actionError) {
      setActionMessage(actionError instanceof Error ? sanitizeWalletError(actionError.message) : "Sell request failed.");
    } finally {
      setActionLoading(null);
    }
  }

  async function removeAgent() {
    if (!window.confirm("Remove this active 0G agent record from the app? On-chain Agentic ID history remains visible.")) {
      return;
    }
    setActionLoading("remove");
    setActionMessage("Preparing owner-signed remove request.");
    try {
      const walletProof = await ensureOwnerWalletProof();
      const response = await fetch("/api/agents/remove", {
        body: JSON.stringify({
          agentId,
          networkId: "mainnet",
          wallet: walletProof,
        }),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      });
      const payload = (await response.json()) as { data?: { workspace: OgAgentWorkspace }; error?: { message: string } };
      if (!response.ok || !payload.data) {
        throw new Error(payload.error?.message ?? "Remove request failed.");
      }
      setWorkspace(payload.data.workspace);
      setActionMessage("Active agent record removed.");
      router.push("/agents");
    } catch (actionError) {
      setActionMessage(actionError instanceof Error ? sanitizeWalletError(actionError.message) : "Remove request failed.");
    } finally {
      setActionLoading(null);
    }
  }

  return (
    <AppShell network={network} networkId={networkId} onNetworkChange={setNetworkId}>
      <main className="h-full min-h-0 overflow-x-hidden overflow-y-auto">
        <div className="mx-auto w-full max-w-[1440px] px-4 pb-16 pt-4 sm:px-6 sm:pt-6 lg:px-8">
          <header className="mb-5 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="flex items-start gap-3 sm:gap-4">
              <Link
                href="/agents"
                className="mt-1 flex-shrink-0 rounded-full border border-white/8 p-2 text-slate-500 transition-colors hover:border-white/16 hover:text-white"
              >
                <ArrowLeft className="h-4 w-4 sm:h-5 sm:w-5" />
              </Link>

              <AgentDetailAvatar name={workspace?.agent.name ?? "4lpha 0G Vault Agent"} />

              <div className="min-w-0 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="text-[1.7rem] font-semibold tracking-tight text-white sm:text-2xl">
                    {workspace?.agent.name ?? "4lpha 0G Vault Agent"}
                  </h1>
                  <StatusPill
                    value={!isMainnetAgentScope ? "mainnet only" : workspace?.agent.status ?? "loading"}
                  />
                </div>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2 sm:hidden">
              <button
                type="button"
                onClick={() => {
                  if (isMainnetAgentScope) void loadWorkspace();
                }}
                disabled={!isMainnetAgentScope || isLoading}
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-white/10 text-slate-400 transition-colors hover:border-white/20 hover:text-white disabled:opacity-40"
              >
                <RefreshCcw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
                <span className="text-[12px] font-medium">Refresh</span>
              </button>
              <button
                type="button"
                onClick={() => void runOwnerAgentStatusAction(isAgentPaused ? "arm" : "pause")}
                disabled={ownerActionDisabled}
                className={cx(
                  "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45",
                  isAgentPaused
                    ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-300 hover:bg-emerald-400/14"
                    : "border-amber-400/20 bg-amber-400/10 text-amber-200 hover:bg-amber-400/14",
                )}
              >
                {actionLoading === "arm" || actionLoading === "pause" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : isAgentPaused ? (
                  <Play className="h-4 w-4" />
                ) : (
                  <Pause className="h-4 w-4" />
                )}
                {isAgentPaused ? "Arm" : "Pause"}
              </button>
              {ownerActionDisabled ? (
                <button
                  type="button"
                  disabled
                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-medium text-slate-500 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <Pencil className="h-4 w-4" />
                  Edit
                </button>
              ) : (
                <Link
                  href="/agents/create/trading"
                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-medium text-slate-300 transition-colors hover:border-white/18 hover:text-white"
                >
                  <Pencil className="h-4 w-4" />
                  Edit
                </Link>
              )}
            </div>

            <div className="hidden flex-wrap items-center gap-2 sm:flex">
              <button
                type="button"
                onClick={() => {
                  if (isMainnetAgentScope) void loadWorkspace();
                }}
                disabled={!isMainnetAgentScope || isLoading}
                className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 text-slate-400 transition-colors hover:border-white/20 hover:text-white disabled:opacity-40"
              >
                <RefreshCcw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
              </button>
              <button
                type="button"
                onClick={() => void runOwnerAgentStatusAction(isAgentPaused ? "arm" : "pause")}
                disabled={ownerActionDisabled}
                className={cx(
                  "inline-flex items-center gap-2 rounded-xl border px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45",
                  isAgentPaused
                    ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-300 hover:bg-emerald-400/14"
                    : "border-amber-400/20 bg-amber-400/10 text-amber-200 hover:bg-amber-400/14",
                )}
              >
                {actionLoading === "arm" || actionLoading === "pause" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : isAgentPaused ? (
                  <Play className="h-4 w-4" />
                ) : (
                  <Pause className="h-4 w-4" />
                )}
                {isAgentPaused ? "Arm" : "Pause"}
              </button>
              {ownerActionDisabled ? (
                <button
                  type="button"
                  disabled
                  className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-medium text-slate-500 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <Pencil className="h-4 w-4" />
                  Edit
                </button>
              ) : (
                <Link
                  href="/agents/create/trading"
                  className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-medium text-slate-300 transition-colors hover:border-white/18 hover:text-white"
                >
                  <Pencil className="h-4 w-4" />
                  Edit
                </Link>
              )}
              <button
                type="button"
                onClick={() => void removeAgent()}
                disabled={ownerActionDisabled}
                className="inline-flex items-center gap-2 rounded-xl border border-rose-400/20 bg-rose-400/10 px-4 py-2 text-sm font-medium text-rose-300 transition-colors disabled:opacity-50"
              >
                {actionLoading === "remove" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                Remove
              </button>
            </div>

            <button
              type="button"
              onClick={() => void removeAgent()}
              disabled={ownerActionDisabled}
              className="mt-2 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-rose-400/20 bg-rose-400/10 px-4 py-2 text-sm font-medium text-rose-300 transition-colors disabled:opacity-50 sm:hidden"
            >
              {actionLoading === "remove" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              Remove
            </button>
          </header>

          {!isMainnetAgentScope ? (
            <NetworkScopedDetailEmpty networkLabel={network.label} onSwitch={() => setNetworkId("mainnet")} />
          ) : null}

          {isMainnetAgentScope && error ? (
            <div className="mb-5 rounded-[22px] border border-amber-300/18 bg-amber-300/10 px-4 py-3 text-sm text-amber-100">
              {error}
            </div>
          ) : null}

          {isMainnetAgentScope && deployment && walletActionMessage ? (
            <div className="mb-5 flex flex-col gap-3 rounded-[22px] border border-amber-300/18 bg-amber-300/10 px-4 py-3 text-sm text-amber-50 sm:flex-row sm:items-center sm:justify-between">
              <span>{walletActionMessage}</span>
              <WalletConnectButton compact networkId={networkId} />
            </div>
          ) : null}

          {isMainnetAgentScope && actionMessage ? (
            <div className="mb-5 rounded-[22px] border border-cyan-300/18 bg-cyan-300/10 px-4 py-3 text-sm text-cyan-50">
              {actionMessage}
            </div>
          ) : null}

          {isMainnetAgentScope && agentMismatch ? (
            <div className="mb-5 rounded-[22px] border border-rose-300/18 bg-rose-300/10 px-4 py-3 text-sm text-rose-100">
              Unknown or removed agent id. On-chain Agentic ID history can still exist, but this local roster no longer tracks that record.
            </div>
          ) : null}

          {isMainnetAgentScope && isLoading && !workspace ? (
            <section className="rounded-[24px] border border-white/8 bg-[#101720]/92 p-5 text-sm text-slate-400">
              <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
              Loading agent state...
            </section>
          ) : isMainnetAgentScope && workspace && !deployment ? (
            <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
              <AgentEmptyState />
              <Link
                href="/agents/create/trading"
                className="inline-flex min-h-[9rem] items-center justify-center gap-2 rounded-[24px] border border-cyan-200/20 bg-cyan-300/10 px-4 text-sm font-semibold text-cyan-50 transition-colors hover:bg-cyan-300/14"
              >
                Mint Agentic ID
              </Link>
            </section>
          ) : isMainnetAgentScope && workspace ? (
            <>
              <section className="mb-6 grid grid-cols-2 gap-3 xl:grid-cols-4">
                <StatCard
                  icon={Shield}
                  label="Positions"
                  sub="Sellable token balances"
                  value={String(openPositionCount)}
                />
                <StatCard
                  icon={TrendingUp}
                  label="Open exposure"
                  sub="Vault accounting metric"
                  value={workspace.vault.openExposure0G ? `${format0G(workspace.vault.openExposure0G)} 0G` : "0 0G"}
                />
                <StatCard
                  icon={Zap}
                  label="Trades"
                  sub={`${tradeCount} executed route cycles`}
                  value={String(tradeCount)}
                />
                <StatCard
                  icon={Target}
                  label="Signal threshold"
                  sub={`${workspace.agent.deployment?.filters.length ?? 0} route filters active`}
                  value="75%"
                />
              </section>

              <div className="grid min-w-0 gap-6 xl:grid-cols-[300px_1fr_380px]">
                <aside className="min-w-0 space-y-4">
                  <section className="min-w-0 overflow-hidden rounded-[22px] border border-white/8 bg-[linear-gradient(180deg,rgba(12,17,24,0.95),rgba(7,10,15,0.86))] p-4 sm:p-5 xl:hidden">
                    <div className="mb-4">
                      <SectionLabel icon={Shield} title="Positions" />
                    </div>
                    <PositionsPanel
                      isOwnerActionDisabled={ownerActionDisabled}
                      isSellBusy={actionLoading === "sell"}
                      logs={logs}
                      onSellOpenPosition={sellOpenPosition}
                      positionTab={positionTab}
                      setPositionTab={setPositionTab}
                      workspace={workspace}
                    />
                  </section>
                  <PassportPanel workspace={workspace} />
                  <ConfigCard icon={TrendingUp} title="Entry rules">
                    <ConfigRow label="Signal threshold" value="75%" />
                    <ConfigRow label="Route filters" value={workspace.agent.deployment?.filters.join(", ") ?? "Not minted"} />
                    <ConfigRow label="Min out" value={`${policy?.defaultMinOutBps ?? 9950} bps`} />
                    <ConfigRow label="Max positions" value={`${runtimeSettings?.maxPositions ?? 2} live routes`} />
                    <ConfigRow label="Max holding" value={`${runtimeSettings?.maxHoldingMinutes ?? 30} min`} />
                    <ConfigRow label="Storage evidence" value={workspace.storage.ready ? "Synced" : "Upload ready"} highlight="positive" />
                  </ConfigCard>
                  <ConfigCard icon={ShieldAlert} title="Risk guards">
                    <ConfigRow label="Per trade cap" value={policy?.perTradeCap0G ? `${format0G(policy.perTradeCap0G)} 0G` : "--"} />
                    <ConfigRow label="Daily cap" value={policy?.dailyCap0G ? `${format0G(policy.dailyCap0G)} 0G` : "--"} />
                    <ConfigRow label="Max exposure" value={policy?.maxExposure0G ? `${format0G(policy.maxExposure0G)} 0G` : "--"} />
                    <ConfigRow label="Executor revoked" value={workspace.vault.executorRevoked ? "Yes" : "No"} highlight={workspace.vault.executorRevoked ? "negative" : "positive"} />
                    <ConfigRow label="Mock adapter" value={workspace.vault.mockAdapterAllowed ? "Allowed" : "Blocked"} highlight={workspace.vault.mockAdapterAllowed ? "negative" : "positive"} />
                  </ConfigCard>
                  <ConfigCard icon={Brain} title="LLM model">
                    <ConfigRow label="Mode" value="Single primary agent" />
                    <ConfigRow label="Router" value="0G Compute Router" highlight="positive" />
                    <ConfigRow label="Fallback" value="Server-only model pool" />
                    <ConfigRow label="Multi-agent" value="Coming soon" />
                  </ConfigCard>
                </aside>

                <section className="hidden max-h-none min-w-0 flex-col rounded-[22px] border border-white/8 bg-[linear-gradient(180deg,rgba(12,17,24,0.95),rgba(7,10,15,0.86))] p-4 xl:flex xl:max-h-[calc(100vh-260px)] xl:p-5">
                  <div className="mb-4">
                    <SectionLabel icon={Shield} title="Positions" />
                  </div>
                  <PositionsPanel
                    isOwnerActionDisabled={ownerActionDisabled}
                    isSellBusy={actionLoading === "sell"}
                    logs={logs}
                    onSellOpenPosition={sellOpenPosition}
                    positionTab={positionTab}
                    setPositionTab={setPositionTab}
                    workspace={workspace}
                  />
                </section>

                <AgentLogPanel
                  filteredLogs={filteredLogs}
                  logFilter={logFilter}
                  logs={logs}
                  onFilterChange={setLogFilter}
                />
              </div>
            </>
          ) : null}
        </div>
      </main>
    </AppShell>
  );
}

function AgentDetailAvatar({ name }: { name: string }) {
  const initial = name.trim().slice(0, 1) || "4";
  return (
    <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-cyan-200/10 bg-cyan-300/12 font-heading text-base font-semibold uppercase tracking-[0.2em] text-[var(--pulse-teal)] shadow-[0_16px_36px_rgba(0,0,0,0.25)] sm:h-14 sm:w-14">
      {initial}
    </div>
  );
}

function StatusPill({ value }: { value: OgAgentWorkspace["agent"]["status"] | "loading" | "mainnet only" }) {
  return (
    <span className={cx("rounded-full border px-2.5 py-1 text-[11px] font-medium capitalize", statusBadgeClass(value))}>
      {value}
    </span>
  );
}

function StatCard({
  icon: Icon,
  label,
  sub,
  value,
}: {
  icon: React.ElementType;
  label: string;
  sub: string;
  value: string;
}) {
  return (
    <article className="rounded-[22px] border border-white/8 bg-[linear-gradient(180deg,rgba(13,19,26,0.94),rgba(9,14,20,0.82))] p-4 shadow-[0_16px_48px_rgba(0,0,0,0.2)] sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1.5">
          <p className="truncate text-[10px] uppercase tracking-[0.24em] text-slate-500">{label}</p>
          <p className="truncate text-[1.35rem] font-semibold tracking-tight text-white tabular-nums sm:text-2xl" title={value}>
            {value}
          </p>
          <p className="truncate text-xs text-slate-400" title={sub}>{sub}</p>
        </div>
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-cyan-300/10 bg-cyan-300/10 text-[var(--pulse-teal)] sm:h-10 sm:w-10">
          <Icon className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
        </div>
      </div>
    </article>
  );
}

function PassportPanel({ workspace }: { workspace: OgAgentWorkspace }) {
  const deployment = workspace.agent.deployment;
  return (
    <section className="rounded-[22px] border border-white/8 bg-[linear-gradient(180deg,rgba(12,17,24,0.95),rgba(7,10,15,0.86))] p-4 sm:p-5">
      <SectionLabel icon={FileCheck2} title="Agentic ID Passport" />
      <p className="mt-3 text-sm leading-6 text-slate-500">0G Mainnet on-chain identity.</p>
      <div className="mt-4 rounded-[18px] border border-white/8 bg-white/[0.035] p-3">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-full border border-emerald-300/16 bg-emerald-300/10 text-emerald-200">
            <Shield className="h-4 w-4" />
          </span>
          <div>
            <span className="rounded-full border border-emerald-300/18 bg-emerald-300/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-emerald-200">
              Registered
            </span>
            <p className="mt-2 text-sm leading-6 text-slate-400">Identity is minted and linked to the Policy Vault.</p>
          </div>
        </div>
      </div>
      <div className="mt-4 space-y-2.5">
        <ConfigRow label="Standard" value={workspace.identity.label} />
        <ConfigRow label="Agent ID" value={deployment ? `#${deployment.tokenId}` : "Not minted"} />
        <ConfigRow label="Contract" value={workspace.identity.address ? shortHash(workspace.identity.address) : "--"} />
        <ConfigRow label="Vault" value={workspace.vault.vault ? shortHash(workspace.vault.vault) : "--"} />
        <ConfigRow label="Executor" value={workspace.vault.executor ? shortHash(workspace.vault.executor) : "--"} />
        <ConfigRow label="Mint tx" value={deployment ? shortHash(deployment.deployTxHash) : "--"} />
        <ConfigRow label="Storage root" value={deployment ? shortHash(deployment.storageRoot) : "--"} />
      </div>
    </section>
  );
}

function PositionsPanel({
  isOwnerActionDisabled,
  isSellBusy,
  logs,
  onSellOpenPosition,
  positionTab,
  setPositionTab,
  workspace,
}: {
  isOwnerActionDisabled: boolean;
  isSellBusy: boolean;
  logs: OgAgentLogEntry[];
  onSellOpenPosition: (routeId?: string) => Promise<void>;
  positionTab: PositionTab;
  setPositionTab: (tab: PositionTab) => void;
  workspace: OgAgentWorkspace;
}) {
  const activeRows = buildActivePositionRows(workspace);
  const closedRows = logs
    .filter((entry) => entry.filter === "executed" && (entry.action === "buy" || entry.action === "sell"))
    .map(normalizeLogPositionRow);
  const recentRows = logs
    .filter((entry) => entry.action === "buy" || entry.action === "sell" || entry.action === "proof")
    .map(normalizeLogPositionRow);
  const rows = positionTab === "active" ? activeRows : positionTab === "closed" ? closedRows : recentRows;
  const emptyMessage = getPositionEmptyMessage(workspace, positionTab);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-[280px] flex-1 gap-1 rounded-xl border border-white/8 bg-white/[0.03] p-1">
          <PositionTabButton active={positionTab === "active"} count={activeRows.length} label="Active" onClick={() => setPositionTab("active")} />
          <PositionTabButton active={positionTab === "closed"} count={closedRows.length} label="Closed" onClick={() => setPositionTab("closed")} />
          <PositionTabButton active={positionTab === "recent"} count={recentRows.length} label="Recent" onClick={() => setPositionTab("recent")} />
        </div>
        {activeRows.length ? (
          <button
            type="button"
            onClick={() => void onSellOpenPosition()}
            disabled={isOwnerActionDisabled || isSellBusy}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-rose-300/24 bg-rose-300/12 px-4 text-sm font-semibold text-rose-100 transition-colors hover:bg-rose-300/16 active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-45"
          >
            {isSellBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Sell All
          </button>
        ) : null}
      </div>

      <div className="scrollbar-subtle min-h-0 flex-1 overflow-y-auto pr-1">
        <div className="max-w-full overflow-x-auto">
          <table className="w-full min-w-[560px] border-separate border-spacing-0">
            <thead>
              <tr>
                {["Token / Last Active", "Unrealized", "Total P&L", "Balance", "Actions"].map((column) => (
                  <th key={column} className="border-b border-white/8 px-3 py-2.5 text-left text-[10px] font-medium uppercase tracking-[0.22em] text-slate-600 first:pl-0 last:pr-0 last:text-right">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length ? (
                rows.map((row) => (
                  <PositionRow
                    isSellBusy={isSellBusy}
                    key={row.id}
                    onSellOpenPosition={onSellOpenPosition}
                    row={row}
                    sellDisabled={isOwnerActionDisabled}
                  />
                ))
              ) : (
                <tr>
                  <td colSpan={5} className="py-12 text-center text-sm text-slate-500">
                    {emptyMessage}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function buildActivePositionRows(workspace: OgAgentWorkspace): PositionRowView[] {
  return (workspace.vault.sellablePositions ?? []).map((position) => normalizeVaultPositionRow(position));
}

function normalizeVaultPositionRow(position: OgAgentVaultPosition): PositionRowView {
  return {
    action: "Sell",
    balance: `${formatTokenAmount(position.amount)} ${position.symbol}`,
    canSell: BigInt(position.amountRaw) > 0n,
    id: `position-${position.tokenAddress.toLowerCase()}`,
    lastActive: "Live",
    pnl: "--",
    routeId: position.routeId,
    token: position.label,
    total: "Open",
  };
}

function normalizeLogPositionRow(row: OgAgentLogEntry): PositionRowView {
  const action = row.action;
  const isTrade = action === "buy" || action === "sell";
  return {
    action: isTrade ? action : "Review",
    balance: "settled",
    canSell: false,
    id: row.id,
    lastActive: formatRelativeTime(row.createdAt),
    pnl: "--",
    token: row.label ?? "WOG / USDC.e",
    total: row.status === "executed" ? "Submitted" : "Open",
  };
}

function getPositionEmptyMessage(workspace: OgAgentWorkspace, positionTab: PositionTab): string {
  if (positionTab === "active" && Number(workspace.vault.openExposure0G ?? "0") > 0) {
    return `No sellable token balance. Vault still reports ${format0G(workspace.vault.openExposure0G ?? "0")} 0G accounting exposure.`;
  }
  return `No ${positionTab} route positions.`;
}

function PositionRow({
  isSellBusy,
  onSellOpenPosition,
  row,
  sellDisabled,
}: {
  isSellBusy: boolean;
  onSellOpenPosition: (routeId?: string) => Promise<void>;
  row: PositionRowView;
  sellDisabled: boolean;
}) {
  const initials = row.token
    .split(/[ /-]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.slice(0, 1))
    .join("")
    .toUpperCase();
  return (
    <tr className="transition-colors hover:bg-white/[0.025]">
      <td className="py-3 pl-0 pr-3">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-xs font-bold text-slate-400">
            {initials || "0G"}
          </span>
          <div className="min-w-0">
            <p className="truncate text-[13px] font-semibold text-white">{row.token}</p>
            <p className="text-[12px] text-slate-500">{row.lastActive}</p>
          </div>
        </div>
      </td>
      <td className="px-3 py-3 text-[13px] font-semibold text-slate-300">{row.pnl}</td>
      <td className="px-3 py-3 text-[13px] font-semibold text-slate-300">{row.total}</td>
      <td className="px-3 py-3 text-right">
        <p className="whitespace-nowrap text-[13px] font-medium text-white">{row.balance}</p>
      </td>
      <td className="py-3 pl-3 pr-0 text-right">
        {row.canSell ? (
          <button
            type="button"
            onClick={() => void onSellOpenPosition(row.routeId)}
            disabled={sellDisabled || isSellBusy}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-rose-300/24 bg-rose-300/12 px-3 text-xs font-medium text-rose-100 transition-colors hover:bg-rose-300/16 active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-45"
          >
            {isSellBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Sell
          </button>
        ) : (
          <span className="inline-flex h-8 items-center rounded-lg border border-amber-400/20 bg-amber-400/10 px-3 text-xs font-medium text-amber-200">
            {row.action}
          </span>
        )}
      </td>
    </tr>
  );
}

function PositionTabButton({
  active,
  count,
  label,
  onClick,
}: {
  active: boolean;
  count: number;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-1 items-center justify-center gap-2 rounded-lg border py-2 text-[12px] font-medium transition-[transform,border-color,color] duration-150 ${
        active ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-300" : "border-transparent text-slate-500 hover:text-slate-300"
      }`}
    >
      {label}
      <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold transition-colors ${
        active ? "bg-emerald-400/20 text-emerald-300" : "bg-white/[0.04] text-slate-600"
      }`}>
        {count}
      </span>
    </button>
  );
}

function AgentLogPanel({
  filteredLogs,
  logFilter,
  logs,
  onFilterChange,
}: {
  filteredLogs: OgAgentLogEntry[];
  logFilter: DetailLogFilter;
  logs: OgAgentLogEntry[];
  onFilterChange: (filter: DetailLogFilter) => void;
}) {
  return (
    <section className="flex max-h-none min-w-0 flex-col rounded-[22px] border border-white/8 bg-[linear-gradient(180deg,rgba(12,17,24,0.95),rgba(7,10,15,0.86))] p-4 xl:max-h-[calc(100vh-260px)] xl:p-5">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <SectionLabel icon={Activity} title="Agent log" />
          <p className="mt-1 flex items-center gap-2 text-[12px] text-slate-500">
          <span className="inline-block h-2 w-2 rounded-full bg-emerald-300" />
            Audit stream ready - refresh on demand
          </p>
        </div>
      </div>

      <div className="mb-3 grid grid-cols-2 gap-1 rounded-xl border border-white/8 bg-white/[0.03] p-1 xl:grid-cols-4">
        {LOG_FILTERS.map((filter) => (
          <TabBtn
            active={logFilter === filter.value}
            count={countLogs(logs, filter.value)}
            key={filter.value}
            label={filter.label}
            onClick={() => onFilterChange(filter.value)}
            tone={filter.tone}
          />
        ))}
      </div>

      {filteredLogs.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Activity className="mb-3 h-8 w-8 text-slate-700" />
          <p className="text-sm text-slate-500">No log entries for this filter.</p>
        </div>
      ) : (
        <div className="scrollbar-subtle flex-1 space-y-3 overflow-y-auto pr-1" style={{ minHeight: 0 }}>
          {filteredLogs.map((entry) => (
            <AgentLogItem entry={entry} key={entry.id} />
          ))}
        </div>
      )}
    </section>
  );
}

function TabBtn({
  active,
  count,
  label,
  onClick,
  tone,
}: {
  active: boolean;
  count: number;
  label: string;
  onClick: () => void;
  tone: "slate" | "cyan" | "amber" | "emerald";
}) {
  const activeStyle =
    tone === "emerald"
      ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-300"
      : tone === "cyan"
        ? "border-cyan-400/20 bg-cyan-400/10 text-cyan-300"
        : tone === "amber"
          ? "border-amber-400/20 bg-amber-400/10 text-amber-200"
          : "border-white/10 bg-white/[0.06] text-white";
  const countStyle = active
    ? tone === "emerald"
      ? "bg-emerald-400/20 text-emerald-300"
      : tone === "cyan"
        ? "bg-cyan-400/20 text-cyan-300"
        : "bg-white/10 text-white"
    : "bg-white/[0.04] text-slate-600";

  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        "flex w-full min-w-0 items-center justify-center gap-1.5 rounded-lg border px-2 py-1.5 text-[11px] font-medium leading-none transition-[color,background-color,border-color] duration-150 sm:text-[12px]",
        active ? activeStyle : "border-transparent text-slate-500 hover:text-slate-300",
      )}
    >
      <span className="min-w-0 truncate">{label}</span>
      <span className={cx("shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold transition-colors", countStyle)}>
        {count}
      </span>
    </button>
  );
}

function AgentLogItem({ entry }: { entry: OgAgentLogEntry }) {
  const [expanded, setExpanded] = useState(false);
  const statusClass = logStatusClass(entry.status);
  const actionClass = logActionClass(entry.action);
  const txLink = entry.txHash ? `${MAINNET.explorerUrl}/tx/${entry.txHash}` : undefined;

  return (
    <article className="rounded-2xl border border-white/8 bg-white/[0.025] transition-colors hover:bg-white/[0.04]">
      <div className="flex items-start gap-3 p-3 sm:p-4">
        <div className={`mt-0.5 shrink-0 text-[11px] font-bold uppercase tracking-widest ${actionClass}`}>
          {entry.action === "none" ? "-" : entry.action.toUpperCase()}
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.18em] ${statusClass}`}>
              {entry.status}
            </span>
            {entry.label ? <span className="truncate text-[13px] font-medium text-white">{entry.label}</span> : null}
            <span className="ml-auto shrink-0 text-[10px] text-slate-600 sm:text-[11px]">{formatRelativeTime(entry.createdAt)}</span>
          </div>
          <p className="break-words text-[13px] leading-relaxed text-slate-400">{entry.summary}</p>
          {entry.reason ? <p className="break-words text-[12px] text-amber-400/80">{entry.reason}</p> : null}
          {txLink ? (
            <a
              href={txLink}
              rel="noreferrer"
              target="_blank"
              className="inline-flex items-center gap-1 text-[11px] text-slate-500 transition-colors hover:text-slate-300"
            >
              tx <ExternalLink className="h-3 w-3" />
            </a>
          ) : null}
          {entry.notes.length ? (
            <>
              {expanded ? (
                <ul className="mt-2 space-y-1 border-l-2 border-white/8 pl-3">
                  {entry.notes.map((note) => (
                    <li className="break-words text-[12px] leading-relaxed text-slate-500" key={note}>
                      {note}
                    </li>
                  ))}
                </ul>
              ) : null}
              <button
                type="button"
                onClick={() => setExpanded((current) => !current)}
                className="mt-1 inline-flex items-center gap-1 text-[11px] text-slate-600 transition-colors hover:text-slate-400"
              >
                {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                {expanded ? "Hide reasoning" : `${entry.notes.length} reasoning ${entry.notes.length === 1 ? "line" : "lines"}`}
              </button>
            </>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function SectionLabel({ icon: Icon, title }: { icon: React.ElementType; title: string }) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="h-4 w-4 text-slate-500" />
      <h2 className="text-sm font-semibold text-white">{title}</h2>
    </div>
  );
}

function ConfigCard({ children, icon: Icon, title }: { children: ReactNode; icon: React.ElementType; title: string }) {
  return (
    <section className="rounded-[22px] border border-white/8 bg-[linear-gradient(180deg,rgba(12,17,24,0.95),rgba(7,10,15,0.86))] p-4 sm:p-5">
      <SectionLabel icon={Icon} title={title} />
      <div className="mt-3 space-y-2.5">{children}</div>
    </section>
  );
}

function ConfigRow({
  highlight,
  label,
  value,
}: {
  highlight?: "negative" | "positive";
  label: string;
  value: string;
}) {
  const valueClass =
    highlight === "positive" ? "text-emerald-300" : highlight === "negative" ? "text-rose-300" : "text-white";
  return (
    <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <span className="text-[12px] text-slate-500">{label}</span>
      <span className={cx("break-words text-left text-[13px] font-medium sm:max-w-[60%] sm:text-right", valueClass)} title={value}>
        {value}
      </span>
    </div>
  );
}

function NetworkScopedDetailEmpty({
  networkLabel,
  onSwitch,
}: {
  networkLabel: string;
  onSwitch: () => void;
}) {
  return (
    <section className="rounded-[24px] border border-white/8 bg-[#101720]/92 p-5 lg:p-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="max-w-2xl">
          <Shield className="mb-3 h-7 w-7 text-slate-600" />
          <h2 className="text-lg font-semibold text-white">No {networkLabel} agent detail.</h2>
          <p className="mt-2 text-sm leading-6 text-slate-400">
            This Agentic ID, Policy Vault, and trade executor are deployed on 0G Mainnet only.
          </p>
        </div>
        <button
          type="button"
          onClick={onSwitch}
          className="inline-flex h-11 w-fit items-center justify-center rounded-full bg-[var(--pulse-teal)] px-4 text-sm font-semibold text-[#041015] transition-[filter,transform] hover:brightness-105 active:scale-[0.96]"
        >
          Switch to Mainnet
        </button>
      </div>
    </section>
  );
}

function filterLogs(logs: OgAgentLogEntry[], filter: DetailLogFilter): OgAgentLogEntry[] {
  if (filter === "all") return logs;
  if (filter === "reasoning") return logs.filter((entry) => entry.notes.length > 0);
  return logs.filter((entry) => entry.filter === filter);
}

function countLogs(logs: OgAgentLogEntry[], filter: DetailLogFilter): number {
  return filterLogs(logs, filter).length;
}

function logStatusClass(status: OgAgentLogEntry["status"]): string {
  if (status === "executed") return "border-emerald-300/18 bg-emerald-300/10 text-emerald-200";
  if (status === "blocked") return "border-rose-300/18 bg-rose-300/10 text-rose-200";
  if (status === "ready") return "border-cyan-300/18 bg-cyan-300/10 text-cyan-100";
  return "border-white/10 bg-white/[0.04] text-slate-400";
}

function logActionClass(action: OgAgentLogEntry["action"]): string {
  if (action === "buy") return "text-emerald-300";
  if (action === "sell") return "text-amber-300";
  if (action === "proof") return "text-cyan-300";
  return "text-slate-500";
}

function formatRelativeTime(timestamp: string): string {
  const time = Date.parse(timestamp);
  if (!Number.isFinite(time)) return "recent";
  const delta = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (delta < 60) return "Just now";
  const minutes = Math.floor(delta / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function format0G(value: string): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return value;
  if (numeric === 0) return "0";
  if (Math.abs(numeric) < 0.000001) return "<0.000001";
  return numeric.toLocaleString("en-US", {
    maximumFractionDigits: numeric < 1 ? 6 : 4,
    minimumFractionDigits: 0,
  });
}

function formatTokenAmount(value: string): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return value;
  if (numeric === 0) return "0";
  if (Math.abs(numeric) < 0.000001) return "<0.000001";
  return numeric.toLocaleString("en-US", {
    maximumFractionDigits: numeric < 1 ? 6 : 4,
    minimumFractionDigits: 0,
  });
}

function getSellableRouteIds(workspace: OgAgentWorkspace | null): string[] {
  return workspace?.vault.sellablePositions?.map((position) => position.routeId) ?? [];
}

function getSellRoute(routeId: string) {
  return AGENT_TRADE_ROUTES.find(
    (route) => route.id === routeId && route.networkId === "mainnet" && route.readiness === "ready",
  );
}

function getDefaultSlippageBps(policy: OgAgentWorkspace["vault"]["policy"]): number {
  const fromPolicy = policy ? 10_000 - policy.defaultMinOutBps : 75;
  return Math.max(1, Math.min(500, fromPolicy));
}

function getOwnerWalletMessage({
  isConnected,
  isOwnerWallet,
  isWrongChain,
  ownerAddress,
  walletAddress,
}: {
  isConnected: boolean;
  isOwnerWallet: boolean;
  isWrongChain: boolean;
  ownerAddress?: string;
  walletAddress?: string;
}): string | undefined {
  if (!ownerAddress) return "Vault owner is not available yet; owner actions are locked.";
  if (!isConnected || !walletAddress) return "Connect the Policy Vault owner wallet to sell, pause, arm, edit, or remove this agent.";
  if (!isOwnerWallet) return `Connected wallet ${shortHash(walletAddress)} is not the vault owner ${shortHash(ownerAddress)}.`;
  if (isWrongChain) return "Owner wallet is connected; action will switch to 0G Mainnet before signing.";
  return undefined;
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
