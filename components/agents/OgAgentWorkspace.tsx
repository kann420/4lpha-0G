"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Bot,
  Database,
  Droplets,
  FileCheck2,
  LayoutGrid,
  LayoutList,
  MessageSquare,
  Plus,
  RefreshCcw,
  Shield,
  TrendingUp,
} from "lucide-react";
import { AgentRouteTradePanel } from "@/components/app/AgentRouteTradePanel";
import { AppShell } from "@/components/app/AppShell";
import {
  COPILOT_MOBILE_PANEL_CLASS,
  EmbeddedCopilotRail,
  type EmbeddedCopilotMessage,
} from "@/components/app/EmbeddedCopilotRail";
import { useOgNetwork } from "@/components/app/useOgNetwork";
import { useWalletConnection } from "@/components/wallet/useWalletConnection";
import { Skeleton } from "@/components/ui/Skeleton";
import { readTestnetRehearsals, type TestnetRehearsalRecord } from "@/lib/agent/testnet-rehearsal";
import type { OgAgentDeploymentRecord, OgAgentWorkspace, OgRemovedAgentRecord } from "@/lib/agent/single-agent";
import type { CopilotContextItem } from "@/lib/types";

type RosterFilter = "all" | "armed" | "paused" | "blocked" | "draft" | "removed";
type RosterView = "grid" | "table";
type RosterDeployment = OgAgentDeploymentRecord | OgRemovedAgentRecord;

const FILTERS: Array<{ label: string; value: RosterFilter }> = [
  { label: "All", value: "all" },
  { label: "Armed", value: "armed" },
  { label: "Paused", value: "paused" },
  { label: "Blocked", value: "blocked" },
  { label: "Draft", value: "draft" },
  { label: "Removed", value: "removed" },
];

const AGENT_INITIAL_MESSAGES: EmbeddedCopilotMessage[] = [];

function isLpAgentDeployment(deployment: RosterDeployment): boolean {
  return deployment.filters.includes("lp-zia");
}

function getAgentDetailHref(deployment: RosterDeployment): string {
  return isLpAgentDeployment(deployment) ? `/agents/lp/${deployment.id}` : `/agents/${deployment.id}`;
}

export function OgAgentWorkspace() {
  const { network, networkId, setNetworkId } = useOgNetwork();
  const wallet = useWalletConnection(networkId);
  const [workspace, setWorkspace] = useState<OgAgentWorkspace | null>(null);
  const [error, setError] = useState<string>();
  const [isLoading, setIsLoading] = useState(true);
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const [activeFilter, setActiveFilter] = useState<RosterFilter>("all");
  const [rosterView, setRosterView] = useState<RosterView>("grid");
  const [testnetRehearsals, setTestnetRehearsals] = useState<TestnetRehearsalRecord[]>([]);

  async function loadWorkspace() {
    if (!wallet.address) {
      setWorkspace(null);
      setError(undefined);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    setError(undefined);
    try {
      const params = new URLSearchParams({
        live: "1",
        ownerAddress: wallet.address,
      });
      const response = await fetch(`/api/agents?${params.toString()}`, { cache: "no-store" });
      const payload = (await response.json()) as { data?: OgAgentWorkspace; error?: { message: string } };
      if (!response.ok || !payload.data) {
        throw new Error(payload.error?.message ?? "Unable to load agent workspace.");
      }
      setWorkspace(payload.data);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load agent workspace.");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    if (networkId !== "mainnet") {
      setError(undefined);
      setIsLoading(false);
      return;
    }
    void loadWorkspace();
  }, [networkId, wallet.address]);

  useEffect(() => {
    if (networkId !== "testnet") {
      return;
    }
    function refreshRehearsals() {
      setTestnetRehearsals(readTestnetRehearsals());
    }
    refreshRehearsals();
    window.addEventListener("storage", refreshRehearsals);
    window.addEventListener("4lpha-0g-testnet-rehearsal-change", refreshRehearsals);
    return () => {
      window.removeEventListener("storage", refreshRehearsals);
      window.removeEventListener("4lpha-0g-testnet-rehearsal-change", refreshRehearsals);
    };
  }, [networkId]);

  const isMainnetAgentScope = networkId === "mainnet";
  const scopedWorkspace = isMainnetAgentScope ? workspace : null;
  const agentDeployments = scopedWorkspace?.agents ?? [];
  const removedDeployments = scopedWorkspace?.removedAgents ?? [];

  const visibleDeployments = useMemo(() => {
    if (!scopedWorkspace) return [];
    if (activeFilter === "removed") return removedDeployments;
    return agentDeployments.filter(
      (deployment) => activeFilter === "all" || getDeploymentRosterStatus(deployment, scopedWorkspace) === activeFilter,
    );
  }, [activeFilter, agentDeployments, removedDeployments, scopedWorkspace]);

  const health = isMainnetAgentScope ? buildHealth(scopedWorkspace) : buildTestnetRehearsalHealth(testnetRehearsals);
  const copilotContext = useMemo(
    () => buildWorkspaceCopilotContext(scopedWorkspace, network.label, isLoading && isMainnetAgentScope),
    [isLoading, isMainnetAgentScope, network.label, scopedWorkspace],
  );
  return (
    <AppShell network={network} networkId={networkId} onNetworkChange={setNetworkId}>
      <main className="h-full min-h-0 overflow-hidden px-3 py-4 lg:px-8">
        <div className="mx-auto grid h-full min-h-0 w-full max-w-7xl gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
          <div className="scrollbar-subtle min-h-0 overflow-y-auto pr-1">
            <div className="flex flex-col gap-5">
              <section className="rounded-[24px] border border-line bg-panel-solid-strong px-4 py-5 shadow-[0_28px_100px_rgba(0,0,0,0.24)] lg:rounded-[30px] lg:px-8 lg:py-6">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
              <div className="max-w-[36rem] space-y-2.5">
                <p className="text-[11px] uppercase tracking-[0.32em] text-primary/60">
                  {isMainnetAgentScope ? "Agent workspace" : "Testnet rehearsal"}
                </p>
                <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl lg:text-4xl">
                  {isMainnetAgentScope ? "Create your Agent" : "Mock adapter rehearsal"}
                </h1>
                <p className="max-w-2xl text-sm leading-6 text-muted lg:text-base">
                  {isMainnetAgentScope
                    ? "Single 0G trading agent backed by Policy Vault execution and Agentic ID evidence."
                    : "Create local Galileo agents, preview policy-bound routes, and trigger mock adapter execution without touching mainnet funds."}
                </p>
              </div>

              <div className="flex flex-col gap-3 sm:items-start lg:min-w-[24.25rem] lg:items-end">
                <div className="flex flex-nowrap items-center gap-2.5 lg:gap-3">
                  <div className="inline-flex h-12 items-center justify-center rounded-full border border-line bg-panel px-4 text-xs uppercase tracking-[0.24em] text-muted">
                    {isMainnetAgentScope ? "0G / POLICY VAULT / ERC-7857" : "0G / TESTNET / MOCK"}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      if (isMainnetAgentScope) {
                        void loadWorkspace();
                      } else {
                        setTestnetRehearsals(readTestnetRehearsals());
                      }
                    }}
                    className="inline-flex h-12 items-center rounded-full border border-line bg-panel px-4 text-sm font-medium text-foreground transition-colors hover:bg-panel active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <RefreshCcw className={`mr-2 h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
                    Refresh
                  </button>
                </div>
                {isMainnetAgentScope ? (
                  <Link
                    href="/agents/create"
                    className="inline-flex h-12 items-center rounded-full bg-primary px-5 text-sm font-semibold text-on-primary transition-[filter,transform] hover:brightness-105 active:scale-[0.96]"
                  >
                    <Plus className="mr-1 h-4 w-4" />
                    Create Agent
                  </Link>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <Link
                      href="/agents/create"
                      className="inline-flex h-12 items-center rounded-full bg-primary px-5 text-sm font-semibold text-on-primary transition-[filter,transform] hover:brightness-105 active:scale-[0.96]"
                    >
                      <Plus className="mr-1 h-4 w-4" />
                      Trading
                    </Link>
                    <Link
                      href="/agents/create/lp"
                      className="inline-flex h-12 items-center rounded-full border border-line bg-panel px-5 text-sm font-semibold text-foreground transition-colors hover:bg-panel-strong"
                    >
                      <Droplets className="mr-1 h-4 w-4" />
                      LP
                    </Link>
                  </div>
                )}
              </div>
            </div>
              </section>

              {error ? (
                <div className="rounded-[22px] border border-amber/20 bg-amber/10 px-4 py-3 text-sm text-amber">
                  {error}
                </div>
              ) : null}

              <HealthStrip items={health} />

              {!isMainnetAgentScope ? (
                <>
                  <TestnetRehearsalPanel records={testnetRehearsals} />
                  <AgentRouteTradePanel
                    networkId={networkId}
                    networkLabel={network.networkName}
                  />
                </>
              ) : null}

              {isMainnetAgentScope ? (
              <section className="flex flex-col gap-5">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div className="space-y-1.5">
                <h2 className="text-xl font-semibold text-foreground">Agents</h2>
                <p className="text-sm text-muted">Track live status, positions, last action of agents.</p>
              </div>

              <div className="flex flex-col gap-2 lg:items-end">
                <div className="scrollbar-subtle -mx-1 flex items-center gap-2 overflow-x-auto px-1 pb-1 lg:mx-0 lg:flex-wrap lg:justify-end lg:overflow-visible lg:px-0 lg:pb-0">
                  {FILTERS.map((filter) => {
                    const active = activeFilter === filter.value;
                    return (
                      <button
                        key={filter.value}
                        type="button"
                        onClick={() => setActiveFilter(filter.value)}
                        className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                          active
                            ? "bg-primary/12 text-primary"
                            : "bg-panel text-muted hover:bg-panel-strong hover:text-foreground"
                        }`}
                      >
                        {filter.label}
                      </button>
                    );
                  })}
                </div>

                <div className="inline-flex w-fit rounded-full border border-line bg-panel p-1">
                  <button
                    type="button"
                    aria-pressed={rosterView === "grid"}
                    onClick={() => setRosterView("grid")}
                    className={`inline-flex h-8 items-center gap-2 rounded-full px-3 text-xs font-medium transition-colors ${
                      rosterView === "grid" ? "bg-primary/12 text-primary" : "text-muted hover:text-foreground"
                    }`}
                  >
                    <LayoutGrid className="h-3.5 w-3.5" />
                    Grid
                  </button>
                  <button
                    type="button"
                    aria-pressed={rosterView === "table"}
                    onClick={() => setRosterView("table")}
                    className={`inline-flex h-8 items-center gap-2 rounded-full px-3 text-xs font-medium transition-colors ${
                      rosterView === "table" ? "bg-primary/12 text-primary" : "text-muted hover:text-foreground"
                    }`}
                  >
                    <LayoutList className="h-3.5 w-3.5" />
                    Table
                  </button>
                </div>
              </div>
            </div>

            {isLoading && isMainnetAgentScope ? (
              <div className="grid gap-4 xl:grid-cols-2">
                {Array.from({ length: 4 }, (_, index) => (
                  <AgentCardSkeleton key={index} index={index} />
                ))}
              </div>
            ) : scopedWorkspace && visibleDeployments.length ? (
              rosterView === "grid" ? (
                <div className="grid gap-4 xl:grid-cols-2">
                  {visibleDeployments.map((deployment, index) => (
                    <AgentCard
                      deployment={deployment}
                      identityLabel={scopedWorkspace.identity.label}
                      index={index}
                      logs={scopedWorkspace.logs}
                      key={deployment.id}
                      networkLabel="0G Mainnet"
                      status={getDeploymentRosterStatus(deployment, scopedWorkspace)}
                      vault={scopedWorkspace.vault}
                    />
                  ))}
                </div>
              ) : (
                <AgentTable deployments={visibleDeployments} workspace={scopedWorkspace} />
              )
            ) : (
              <NetworkEmptyState
                activeFilter={activeFilter}
                isMainnet={isMainnetAgentScope}
                isWalletConnected={Boolean(wallet.address)}
                networkLabel={network.label}
              />
            )}
              </section>
              ) : null}
            </div>
          </div>

          <aside className="hidden h-full min-h-0 xl:block">
            <EmbeddedCopilotRail
              context={copilotContext}
              description="Review 0G agent state and execution blockers."
              initialMessages={AGENT_INITIAL_MESSAGES}
              networkId={networkId}
              networkLabel={network.label}
              placeholder="Ask for identity, vault, or route readiness..."
              sendIcon="message"
            />
          </aside>
        </div>
      </main>

      <button
        type="button"
        aria-label="Open copilot"
        onClick={() => setMobileChatOpen(true)}
        className="fixed bottom-5 right-4 z-40 inline-flex items-center justify-center gap-2 rounded-full border border-line bg-panel-solid-strong/92 px-4 py-3 text-sm font-medium text-foreground shadow-[0_16px_48px_rgba(0,0,0,0.35)] transition-colors hover:border-line-strong hover:text-foreground max-sm:h-12 max-sm:w-12 max-sm:px-0 xl:hidden"
      >
        <MessageSquare className="h-4 w-4 text-primary" />
        <span className="max-sm:hidden">Open copilot</span>
      </button>

      {mobileChatOpen ? (
        <div className="fixed inset-0 z-50 bg-background/82 px-3 py-4 xl:hidden">
          <div className="flex h-full flex-col justify-end">
            <div className={COPILOT_MOBILE_PANEL_CLASS}>
              <EmbeddedCopilotRail
                context={copilotContext}
                description="Review 0G agent state and execution blockers."
                initialMessages={AGENT_INITIAL_MESSAGES}
                isMobile
                networkId={networkId}
                networkLabel={network.label}
                onClose={() => setMobileChatOpen(false)}
                placeholder="Ask for identity, vault, or route readiness..."
                sendIcon="message"
              />
            </div>
          </div>
        </div>
      ) : null}
    </AppShell>
  );
}

function buildHealth(workspace: OgAgentWorkspace | null) {
  const deployedCount = workspace?.agents.length ?? 0;
  const deployed = deployedCount > 0;
  const lpFundingOnly = workspace ? isManagedLpFundingOnlyWorkspace(workspace) : false;
  const vaultReady = workspace?.vault.ready === true || workspace?.agent.status === "armed" || lpFundingOnly;
  const vaultWarnings = lpFundingOnly ? 0 : workspace?.vault.warnings.length ?? 0;
  const warnings = vaultWarnings + (workspace?.storage.warnings.length ?? 0);
  const openPositions = (workspace?.vault.sellablePositions?.length ?? 0) + (workspace?.vault.sellableLpPositions?.length ?? 0);
  return [
    {
      detail: `${deployedCount} total agent${deployedCount === 1 ? "" : "s"}`,
      label: "Live agents",
      tone: deployed ? "positive" : "neutral",
      value: String(deployedCount),
    },
    {
      detail: deployed ? (vaultReady ? "Execution cycles can fire" : "Vault needs review") : "No active Agentic ID",
      label: "Running now",
      tone: vaultReady && deployed ? "positive" : "warning",
      value: vaultReady && deployed ? String(deployedCount) : "0",
    },
    {
      detail: openPositions > 0 ? "Positions currently being managed" : "No open positions right now",
      label: "Open positions",
      tone: openPositions > 0 ? "positive" : "neutral",
      value: String(openPositions),
    },
    {
      detail: "No realized PnL tracked yet",
      label: "Net PnL",
      tone: "neutral",
      value: "0 0G",
    },
    {
      detail: warnings ? "Review the flagged agent or wallet state" : "No blockers detected",
      label: "Attention needed",
      tone: warnings ? "warning" : "positive",
      value: String(warnings),
    },
  ] as const;
}

function buildTestnetRehearsalHealth(records: readonly TestnetRehearsalRecord[]) {
  const tradingCount = records.filter((record) => record.kind === "trading").length;
  const lpCount = records.filter((record) => record.kind === "lp").length;
  return [
    {
      detail: "Local browser session only",
      label: "Rehearsals",
      tone: records.length ? "positive" : "neutral",
      value: String(records.length),
    },
    {
      detail: tradingCount ? "Mock adapter route ready" : "Create a trading rehearsal",
      label: "Trading",
      tone: tradingCount ? "positive" : "neutral",
      value: String(tradingCount),
    },
    {
      detail: lpCount ? "Mock LP workspace ready" : "Create an LP rehearsal",
      label: "LP agents",
      tone: lpCount ? "positive" : "neutral",
      value: String(lpCount),
    },
    {
      detail: "Agentic ID is disabled",
      label: "Identity",
      tone: "neutral",
      value: "off",
    },
    {
      detail: "0G Storage upload is disabled",
      label: "Storage",
      tone: "neutral",
      value: "off",
    },
  ] as const;
}

function format0GMetric(value: string): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return value.length > 12 ? shortHash(value) : value;
  }
  if (numeric === 0) {
    return "0";
  }
  if (Math.abs(numeric) < 0.000001) {
    return "<0.000001";
  }
  return numeric.toLocaleString("en-US", {
    maximumFractionDigits: numeric < 1 ? 6 : 4,
    minimumFractionDigits: 0,
  });
}

function formatIntegerMetric(value: string): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return value;
  }
  return numeric.toLocaleString("en-US");
}

function formatRelativeTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return "recently";
  }
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (elapsedSeconds < 60) {
    return "now";
  }
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) {
    return `${elapsedMinutes}m ago`;
  }
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return `${elapsedHours}h ago`;
  }
  const elapsedDays = Math.floor(elapsedHours / 24);
  return `${elapsedDays}d ago`;
}

function buildWorkspaceCopilotContext(
  workspace: OgAgentWorkspace | null,
  networkLabel: string,
  loading: boolean,
): CopilotContextItem[] {
  if (!workspace) {
    return [
      {
        kind: "trade",
        label: "Agent",
        value: loading ? "loading" : `none on ${networkLabel}`,
      },
    ];
  }

  return [
    {
      kind: "trade",
      label: "Agent",
      value: `${workspace.agents.length} ${workspace.agent.status}`,
    },
    {
      kind: "proof",
      label: "Identity",
      value: workspace.agent.deployment ? `#${workspace.agent.deployment.tokenId}` : "not minted",
    },
    {
      kind: "policy",
      label: "Vault",
      value: workspace.vault.vault ? shortHash(workspace.vault.vault) : "not configured",
    },
  ];
}

function NetworkEmptyState({
  activeFilter,
  isMainnet,
  isWalletConnected,
  networkLabel,
}: {
  activeFilter: RosterFilter;
  isMainnet: boolean;
  isWalletConnected: boolean;
  networkLabel: string;
}) {
  if (isMainnet && !isWalletConnected) {
    return (
      <div className="rounded-[28px] border border-line bg-panel-solid-strong p-6 shadow-[0_0_0_1px_rgba(255,255,255,0.04)]">
        <Bot className="mb-3 h-7 w-7 text-muted" />
        <p className="text-sm font-semibold text-foreground">Connect your wallet to view your agents.</p>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
          Agents are scoped to the connected Policy Vault owner wallet. Connect a wallet to load your roster.
        </p>
      </div>
    );
  }

  const title = isMainnet
    ? activeFilter === "removed"
      ? "No removed 0G agents."
      : activeFilter === "all"
      ? "No active 0G agent."
      : "No agents match this view."
    : `No ${networkLabel} agent deployed.`;
  const detail = isMainnet
    ? activeFilter === "removed"
      ? "Removed Agentic ID records will appear here as read-only history."
      : activeFilter === "draft"
      ? "Draft setup lives in the create flow. The roster only shows minted Agentic ID records."
      : "Create a new agent to mint an Agentic ID and attach it to the Policy Vault."
    : "The armed Agentic ID and Policy Vault are scoped to 0G Mainnet, so they stay hidden while Testnet is selected.";

  return (
    <div className="rounded-[28px] border border-line bg-panel-solid-strong p-6 shadow-[0_0_0_1px_rgba(255,255,255,0.04)]">
      <Bot className="mb-3 h-7 w-7 text-muted" />
      <p className="text-sm font-semibold text-foreground">{title}</p>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">{detail}</p>
      {isMainnet && activeFilter !== "removed" ? (
        <Link
          href="/agents/create"
          className="mt-5 inline-flex h-10 items-center gap-2 rounded-full bg-primary px-4 text-sm font-semibold text-on-primary transition-[filter,transform] hover:brightness-105 active:scale-[0.96]"
        >
          <Plus className="h-4 w-4" />
          Create Agent
        </Link>
      ) : null}
    </div>
  );
}

function TestnetRehearsalPanel({ records }: { records: readonly TestnetRehearsalRecord[] }) {
  return (
    <section className="rounded-[28px] border border-amber/20 bg-amber/[0.06] p-5 shadow-[0_18px_58px_rgba(0,0,0,0.18)]">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="max-w-3xl">
          <p className="text-[11px] font-semibold uppercase tracking-[0.26em] text-amber">Testnet rehearsal / mock adapter</p>
          <h2 className="mt-2 text-xl font-semibold text-foreground">Galileo flow without mainnet side effects</h2>
          <p className="mt-2 text-sm leading-6 text-muted">
            These records live only in this browser session. They do not mint ERC-7857 Agentic ID, upload to 0G Storage, or move mainnet funds.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/agents/create"
            className="inline-flex h-10 items-center gap-2 rounded-full bg-primary px-4 text-sm font-semibold text-on-primary transition-[filter,transform] hover:brightness-105 active:scale-[0.96]"
          >
            <TrendingUp className="h-4 w-4" />
            Trading
          </Link>
          <Link
            href="/agents/create/lp"
            className="inline-flex h-10 items-center gap-2 rounded-full border border-line bg-panel px-4 text-sm font-semibold text-foreground transition-colors hover:bg-panel-strong"
          >
            <Droplets className="h-4 w-4" />
            LP
          </Link>
        </div>
      </div>

      <div className="mt-5 grid gap-3 lg:grid-cols-2">
        {records.length ? (
          records.map((record) => (
            <Link
              key={`${record.kind}:${record.id}`}
              href={record.detailHref}
              className="rounded-[22px] border border-line bg-panel-solid-strong p-4 transition-[border-color,transform] hover:-translate-y-0.5 hover:border-line-strong"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-base font-semibold text-foreground">{record.name}</p>
                  <p className="mt-1 text-xs font-semibold uppercase tracking-[0.18em] text-muted">
                    {record.kind === "lp" ? "LP Agent" : "Trading Agent"} · Galileo · mock
                  </p>
                </div>
                <span className="rounded-full border border-green/20 bg-green/10 px-2.5 py-1 text-[11px] font-semibold text-green">
                  ready
                </span>
              </div>
              <div className="mt-4 grid gap-2 sm:grid-cols-3">
                <AgentMetric label="Adapter" value={record.adapter} />
                <AgentMetric label="Identity" value={record.identity} />
                <AgentMetric label="Storage" value={record.storage} />
              </div>
              <p className="mt-3 text-xs leading-5 text-muted">
                Created {formatRelativeTime(record.createdAt)}. Open to continue the mock rehearsal.
              </p>
            </Link>
          ))
        ) : (
          <div className="rounded-[22px] border border-line bg-panel p-4 lg:col-span-2">
            <p className="text-sm font-semibold text-foreground">No local rehearsal yet</p>
            <p className="mt-1 text-sm leading-6 text-muted">
              Start a Trading or LP rehearsal from the buttons above. The result will appear here without any server deploy call.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

function HealthStrip({
  items,
}: {
  items: readonly { detail: string; label: string; tone: "neutral" | "positive" | "warning"; value: string }[];
}) {
  return (
    <section className="grid gap-3 rounded-[24px] border border-line bg-panel-solid-strong p-3 shadow-[0_20px_60px_rgba(0,0,0,0.22)] sm:grid-cols-2 lg:rounded-[28px] lg:p-4 xl:grid-cols-5">
      {items.map((item) => {
        const toneClass = item.tone === "positive" ? "text-green" : item.tone === "warning" ? "text-amber" : "text-muted";
        return (
          <article key={item.label} className="min-w-0 rounded-[18px] border border-line bg-panel px-3 py-3 lg:rounded-[22px] lg:px-4 lg:py-3.5">
            <p className="text-[10px] uppercase tracking-[0.24em] text-muted">{item.label}</p>
            <p className="mt-2 text-2xl font-semibold tracking-tight text-foreground" title={item.value}>
              {item.value}
            </p>
            <p className={`mt-1 text-sm ${toneClass}`} title={item.detail}>
              {item.detail}
            </p>
          </article>
        );
      })}
    </section>
  );
}

function getDeploymentRosterStatus(
  deployment: RosterDeployment,
  workspace: OgAgentWorkspace,
): OgAgentWorkspace["agent"]["status"] {
  if ("removedAt" in deployment) return "removed";
  if (deployment.paused) return "paused";
  if (workspace.agent.deployment?.id === deployment.id) return workspace.agent.status;
  if (!workspace.vault.ready || workspace.vault.paused || workspace.vault.executorRevoked) return "blocked";
  return "armed";
}

function isManagedLpFundingOnlyWorkspace(workspace: OgAgentWorkspace): boolean {
  return hasManagedLpPosition(workspace.vault) && hasOnlyLpFundingWarnings(workspace.vault);
}

function hasManagedLpPosition(vault: OgAgentWorkspace["vault"]): boolean {
  return (vault.sellableLpPositions?.length ?? 0) > 0;
}

function hasOnlyLpFundingWarnings(vault: OgAgentWorkspace["vault"]): boolean {
  return Boolean(
    vault.paused !== true &&
      vault.executorRevoked !== true &&
      vault.warnings.length > 0 &&
      vault.warnings.every(isLpFundingWarning),
  );
}

function isLpFundingWarning(warning: string): boolean {
  return warning === "Policy Vault has no 0G balance." || warning.startsWith("LP Entry has no 0G balance;");
}

function AgentCard({
  deployment,
  identityLabel,
  index,
  logs,
  networkLabel,
  status,
  vault,
}: {
  deployment: RosterDeployment;
  identityLabel: OgAgentWorkspace["identity"]["label"];
  index: number;
  logs: OgAgentWorkspace["logs"];
  networkLabel: string;
  status: OgAgentWorkspace["agent"]["status"];
  vault: OgAgentWorkspace["vault"];
}) {
  const statusClass =
    status === "armed"
      ? "border-green/15 bg-green/10 text-green"
      : status === "paused"
        ? "border-yellow/15 bg-yellow/10 text-yellow"
      : status === "removed"
        ? "border-rose/15 bg-rose/10 text-rose"
      : status === "blocked"
        ? "border-amber/15 bg-amber/10 text-amber"
        : "border-line/15 bg-panel-strong/10 text-muted";
  const tradeCount = logs.filter((entry) => entry.filter === "executed" && (entry.action === "buy" || entry.action === "sell")).length;
  const lastTrade = logs.find((entry) => entry.action === "buy" || entry.action === "sell");
  const lastAction = lastTrade ? `${lastTrade.action} ${formatRelativeTime(lastTrade.createdAt)}` : `proof ${formatRelativeTime(deployment.createdAt)}`;
  const isLpAgent = isLpAgentDeployment(deployment);
  const openPositions = isLpAgent ? (vault.sellableLpPositions?.length ?? 0) : (vault.sellablePositions?.length ?? 0);
  const maxPositions = deployment.runtime?.maxPositions ?? 0;
  const sourceCount = deployment.filters.length;
  const isRemoved = "removedAt" in deployment;
  const lpFundingOnly = isLpAgent && status === "armed" && hasManagedLpPosition(vault) && hasOnlyLpFundingWarnings(vault);
  const needsAttention = status === "blocked" || vault.paused === true || vault.executorRevoked === true || (!lpFundingOnly && vault.warnings.length > 0);
  const statusNote = needsAttention
    ? vault.warnings[0] ?? (vault.paused ? "Paused by operator" : vault.executorRevoked ? "Executor revoked by owner" : "Review vault readiness")
    : isRemoved
      ? `Removed ${formatRelativeTime(deployment.removedAt)}. Read-only history; cannot resume or edit.`
    : "Policy Vault ready with proof-bound execution.";

  return (
    <article
      className="animate-feed-reveal rounded-[24px] border border-line bg-panel-solid-strong p-4 shadow-[0_22px_64px_rgba(0,0,0,0.22)] transition-[transform,border-color] duration-200 hover:-translate-y-0.5 hover:border-line-strong lg:rounded-[28px] lg:p-5"
      style={{ animationDelay: `${index * 60}ms` }}
    >
      <div className="flex items-start justify-between gap-4">
        <Link href={getAgentDetailHref(deployment)} className="flex min-w-0 flex-1 items-start gap-3 text-left">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-primary/20 bg-primary/12 font-heading text-sm font-semibold uppercase tracking-[0.2em] text-primary">
            {deployment.tokenId}
          </div>
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="truncate text-base font-semibold text-foreground">{deployment.name}</h3>
              <AgentTypeBadge isLpAgent={isLpAgent} />
              <span className={`rounded-full border px-2.5 py-1 text-[11px] font-medium capitalize ${statusClass}`}>
                {status}
              </span>
            </div>
            <p className="text-sm leading-5 text-muted">
              {isLpAgent
                ? "Zia LP agent for mint, stake, unstake, and zap-out through Policy Vault."
                : "0G Policy Vault trading agent with proof-bound Agentic ID evidence."}
            </p>
          </div>
        </Link>

        <Link
          href={getAgentDetailHref(deployment)}
          className="hidden items-center gap-1 rounded-full border border-line px-3 py-1.5 text-xs text-muted transition-colors hover:border-line-strong hover:text-foreground sm:inline-flex"
        >
          View
          <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>

      <div className="mt-5 grid gap-4 border-y border-line py-4 text-sm sm:grid-cols-4">
        <div className="space-y-1">
          <p className="text-[10px] uppercase tracking-[0.24em] text-muted">Positions</p>
          <p className="font-semibold text-foreground">{openPositions}</p>
        </div>
        <div className="space-y-1">
          <p className="text-[10px] uppercase tracking-[0.24em] text-muted">PnL</p>
          <p className="font-semibold text-muted">0 0G</p>
        </div>
        <div className="space-y-1">
          <p className="text-[10px] uppercase tracking-[0.24em] text-muted">Trades</p>
          <p className="font-semibold text-foreground">{tradeCount}</p>
        </div>
        <div className="space-y-1">
          <p className="text-[10px] uppercase tracking-[0.24em] text-muted">Last action</p>
          <p className="text-muted">{lastAction}</p>
        </div>
      </div>

      <div className={`mt-4 rounded-2xl border px-4 py-3 text-sm ${needsAttention ? "border-amber/20 bg-amber/10 text-amber" : "border-line bg-panel text-muted"}`}>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded-full border px-2.5 py-1 text-[11px] font-medium ${needsAttention ? "border-amber/20 bg-amber/10 text-amber" : "border-primary/20 bg-primary/10 text-primary"}`}>
            {needsAttention ? "Review" : "Proof ready"}
          </span>
          <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted">
            {identityLabel}
          </span>
        </div>
        <p className="mt-2">{statusNote}</p>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] uppercase tracking-[0.2em] text-muted">
          <span>{networkLabel}</span>
          <span>Policy vault</span>
          <span>{sourceCount} source{sourceCount === 1 ? "" : "s"}</span>
          {maxPositions > 0 ? <span>{openPositions}/{maxPositions} positions</span> : null}
        </div>
        <Link
          href={getAgentDetailHref(deployment)}
          className="inline-flex h-9 shrink-0 items-center gap-2 rounded-full border border-line bg-panel px-3 text-sm text-foreground transition-[background-color,border-color,transform] hover:bg-panel-strong active:scale-[0.96] sm:hidden"
        >
          View
          <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    </article>
  );
}

function AgentTypeBadge({ isLpAgent }: { isLpAgent: boolean }) {
  return isLpAgent ? (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-blue/20 bg-blue/10 px-2.5 py-1 text-[11px] font-medium text-blue">
      <Droplets className="h-3 w-3" />
      LP Agent
    </span>
  ) : (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-primary/20 bg-primary/10 px-2.5 py-1 text-[11px] font-medium text-primary">
      <TrendingUp className="h-3 w-3" />
      Trading Agent
    </span>
  );
}

function AgentCardSkeleton({ index }: { index: number }) {
  return (
    <div
      className="animate-feed-reveal rounded-[24px] border border-line bg-panel-solid-strong p-4 shadow-[0_22px_64px_rgba(0,0,0,0.22)] lg:rounded-[28px] lg:p-5"
      style={{ animationDelay: `${index * 60}ms` }}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <Skeleton className="h-11 w-11 shrink-0 rounded-2xl" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex items-center gap-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-5 w-16 rounded-full" />
            </div>
            <Skeleton className="h-3.5 w-full max-w-[22rem]" />
          </div>
        </div>
        <Skeleton className="hidden h-7 w-16 rounded-full sm:block" />
      </div>

      <div className="mt-5 grid gap-4 border-y border-line py-4 sm:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="space-y-1.5">
            <Skeleton className="h-2.5 w-14" />
            <Skeleton className="h-4 w-10" />
          </div>
        ))}
      </div>

      <Skeleton className="mt-4 h-16 w-full rounded-2xl" />

      <div className="mt-4 flex items-center justify-between gap-3">
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-9 w-20 rounded-full" />
      </div>
    </div>
  );
}

function AgentTable({
  deployments,
  workspace,
}: {
  deployments: RosterDeployment[];
  workspace: OgAgentWorkspace;
}) {
  return (
    <div className="overflow-hidden rounded-[24px] border border-line bg-panel-solid-strong">
      <div className="grid grid-cols-[1fr_0.7fr_0.6fr_0.8fr_auto] gap-3 border-b border-line px-4 py-3 text-[10px] uppercase tracking-[0.2em] text-muted">
        <span>Agent</span>
        <span>Type</span>
        <span>Status</span>
        <span>Vault</span>
        <span>Action</span>
      </div>
      {deployments.map((deployment) => (
        <div key={deployment.id} className="grid grid-cols-[1fr_0.7fr_0.6fr_0.8fr_auto] items-center gap-3 border-b border-line px-4 py-4 last:border-b-0">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-foreground">{deployment.name}</p>
            <p className="truncate text-xs text-muted">{deployment.agentRef}</p>
          </div>
          <AgentTypeBadge isLpAgent={isLpAgentDeployment(deployment)} />
          <span className="text-sm capitalize text-muted">{getDeploymentRosterStatus(deployment, workspace)}</span>
          <span className="truncate font-mono text-xs text-muted">{deployment.vault ? shortHash(deployment.vault) : "--"}</span>
          <Link href={getAgentDetailHref(deployment)} className="inline-flex h-9 items-center rounded-full border border-line px-3 text-sm text-foreground hover:bg-panel">
            Open
          </Link>
        </div>
      ))}
    </div>
  );
}

function AgentMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[16px] border border-line bg-background/20 px-3 py-2">
      <p className="text-[10px] uppercase tracking-[0.22em] text-muted">{label}</p>
      <p className="mt-1 truncate font-mono text-xs font-semibold text-foreground" title={value}>
        {value}
      </p>
    </div>
  );
}

export function IdentitySummary({ workspace }: { workspace: OgAgentWorkspace }) {
  return (
    <section className="rounded-[22px] border border-line bg-panel-solid-strong p-4 sm:p-5">
      <div className="mb-4 flex items-center gap-2">
        <FileCheck2 className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-semibold text-foreground">Agentic ID</h2>
      </div>
      <div className="space-y-2.5">
        <ConfigRow label="Standard" value={workspace.identity.label} />
        <ConfigRow label="Contract" value={workspace.identity.address ? shortHash(workspace.identity.address) : "Not configured"} />
        <ConfigRow label="Token" value={workspace.agent.deployment ? `#${workspace.agent.deployment.tokenId}` : "Not minted"} />
        <ConfigRow label="Storage root" value={workspace.agent.deployment ? shortHash(workspace.agent.deployment.storageRoot) : "pending"} />
      </div>
      <p className="mt-4 text-xs leading-5 text-muted">{workspace.identity.note}</p>
    </section>
  );
}

export function VaultSummary({ workspace }: { workspace: OgAgentWorkspace }) {
  return (
    <section className="rounded-[22px] border border-line bg-panel-solid-strong p-4 sm:p-5">
      <div className="mb-4 flex items-center gap-2">
        <Shield className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-semibold text-foreground">Policy Vault</h2>
      </div>
      <div className="space-y-2.5">
        <ConfigRow label="Vault" value={workspace.vault.vault ? shortHash(workspace.vault.vault) : "--"} />
        <ConfigRow label="Balance" value={workspace.vault.balance0G ? `${workspace.vault.balance0G} 0G` : "--"} />
        <ConfigRow label="Paused" value={workspace.vault.paused ? "Yes" : "No"} />
        <ConfigRow label="Executor revoked" value={workspace.vault.executorRevoked ? "Yes" : "No"} />
        <ConfigRow label="Mock adapter" value={workspace.vault.mockAdapterAllowed ? "Allowed" : "Blocked"} />
      </div>
      {workspace.vault.warnings.length ? (
        <div className="mt-4 rounded-2xl border border-amber/15 bg-amber/10 px-3 py-2 text-xs leading-5 text-amber">
          {workspace.vault.warnings.join(" ")}
        </div>
      ) : null}
    </section>
  );
}

export function StorageSummary({ workspace }: { workspace: OgAgentWorkspace }) {
  return (
    <section className="rounded-[22px] border border-line bg-panel-solid-strong p-4 sm:p-5">
      <div className="mb-4 flex items-center gap-2">
        <Database className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-semibold text-foreground">0G Storage</h2>
      </div>
      <div className="space-y-2.5">
        <ConfigRow label="Upload ready" value={workspace.storage.uploadReady ? "Yes" : "No"} />
        <ConfigRow label="Retrieval synced" value={workspace.storage.ready ? "Yes" : "No"} />
        <ConfigRow label="Nodes checked" value={String(workspace.storage.nodesChecked)} />
        <ConfigRow label="Chain block" value={workspace.storage.chainBlockNumber ?? "--"} />
        <ConfigRow label="Storage height" value={workspace.storage.latestLogSyncHeight ?? "--"} />
        <ConfigRow label="Lag" value={workspace.storage.lagBlocks !== undefined ? `${workspace.storage.lagBlocks} blocks` : "--"} />
      </div>
      {workspace.storage.warnings.length ? (
        <div className="mt-4 rounded-2xl border border-amber/15 bg-amber/10 px-3 py-2 text-xs leading-5 text-amber">
          {workspace.storage.warnings.join(" ")}
        </div>
      ) : null}
    </section>
  );
}

export function ConfigRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <span className="text-[12px] text-muted">{label}</span>
      <span className="break-words text-left font-mono text-[13px] font-medium text-foreground sm:max-w-[60%] sm:text-right" title={value}>
        {value}
      </span>
    </div>
  );
}

export function AgentEmptyState() {
  return (
    <div className="rounded-[28px] border border-line bg-panel-solid-strong p-6 text-sm text-muted">
      <Bot className="mb-3 h-7 w-7 text-muted" />
      No Agentic ID is minted for the single 0G trading agent yet.
    </div>
  );
}

export function EvidencePill({ icon, label, value }: { icon: "database" | "proof"; label: string; value: string }) {
  const Icon = icon === "database" ? Database : FileCheck2;
  return (
    <div className="rounded-[16px] border border-line bg-background/20 px-3 py-2">
      <div className="flex items-center gap-1.5 text-muted">
        <Icon className="h-3.5 w-3.5" />
        <span className="text-[10px] uppercase tracking-[0.18em]">{label}</span>
      </div>
      <p className="mt-1 truncate font-mono text-xs font-semibold text-foreground" title={value}>
        {shortHash(value)}
      </p>
    </div>
  );
}

export function shortHash(value: string): string {
  if (!value.startsWith("0x") || value.length <= 14) {
    return value.length > 28 ? `${value.slice(0, 14)}...${value.slice(-8)}` : value;
  }
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}
