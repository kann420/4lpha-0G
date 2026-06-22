"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Bot,
  Database,
  FileCheck2,
  LayoutGrid,
  LayoutList,
  Loader2,
  MessageSquare,
  Plus,
  RefreshCcw,
  Shield,
} from "lucide-react";
import { AppShell } from "@/components/app/AppShell";
import {
  COPILOT_MOBILE_PANEL_CLASS,
  EmbeddedCopilotRail,
  type EmbeddedCopilotMessage,
} from "@/components/app/EmbeddedCopilotRail";
import { useOgNetwork } from "@/components/app/useOgNetwork";
import type { OgAgentDeploymentRecord, OgAgentWorkspace } from "@/lib/agent/single-agent";
import type { CopilotContextItem } from "@/lib/types";

type RosterFilter = "all" | "armed" | "paused" | "blocked" | "draft";
type RosterView = "grid" | "table";

const FILTERS: Array<{ label: string; value: RosterFilter }> = [
  { label: "All", value: "all" },
  { label: "Armed", value: "armed" },
  { label: "Paused", value: "paused" },
  { label: "Blocked", value: "blocked" },
  { label: "Draft", value: "draft" },
];

const AGENT_INITIAL_MESSAGES: EmbeddedCopilotMessage[] = [];

export function OgAgentWorkspace() {
  const { network, networkId, setNetworkId } = useOgNetwork();
  const [workspace, setWorkspace] = useState<OgAgentWorkspace | null>(null);
  const [error, setError] = useState<string>();
  const [isLoading, setIsLoading] = useState(true);
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const [activeFilter, setActiveFilter] = useState<RosterFilter>("all");
  const [rosterView, setRosterView] = useState<RosterView>("grid");

  async function loadWorkspace() {
    setIsLoading(true);
    setError(undefined);
    try {
      const response = await fetch("/api/agents", { cache: "no-store" });
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
  }, [networkId]);

  const isMainnetAgentScope = networkId === "mainnet";
  const scopedWorkspace = isMainnetAgentScope ? workspace : null;
  const agentDeployments = scopedWorkspace?.agents ?? [];
  const rosterStatus = scopedWorkspace?.agent.status ?? "draft";

  const visibleDeployments = useMemo(() => {
    if (!scopedWorkspace) return [];
    return agentDeployments.filter(() => activeFilter === "all" || rosterStatus === activeFilter);
  }, [activeFilter, agentDeployments, rosterStatus, scopedWorkspace]);

  const health = isMainnetAgentScope ? buildHealth(scopedWorkspace) : buildNetworkEmptyHealth(network.label);
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
              <section className="rounded-[24px] border border-white/8 bg-[linear-gradient(135deg,rgba(11,16,23,0.96),rgba(6,10,15,0.84))] px-4 py-5 shadow-[0_28px_100px_rgba(0,0,0,0.24)] lg:rounded-[30px] lg:px-8 lg:py-6">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
              <div className="max-w-[36rem] space-y-2.5">
                <p className="text-[11px] uppercase tracking-[0.32em] text-cyan-200/60">Agent workspace</p>
                <h1 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl lg:text-4xl">
                  Create your Agent
                </h1>
                <p className="max-w-2xl text-sm leading-6 text-slate-400 lg:text-base">
                  Single 0G trading agent backed by Policy Vault execution and Agentic ID evidence.
                </p>
              </div>

              <div className="flex flex-col gap-3 sm:items-start lg:min-w-[24.25rem] lg:items-end">
                <div className="flex flex-nowrap items-center gap-2.5 lg:gap-3">
                  <div className="inline-flex h-12 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] px-4 text-xs uppercase tracking-[0.24em] text-slate-400">
                    0G / POLICY VAULT / ERC-7857
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      if (isMainnetAgentScope) void loadWorkspace();
                    }}
                    disabled={!isMainnetAgentScope}
                    className="inline-flex h-12 items-center rounded-full border border-white/10 bg-white/[0.04] px-4 text-sm font-medium text-slate-200 transition-colors hover:bg-white/[0.06] active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <RefreshCcw className={`mr-2 h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
                    Refresh
                  </button>
                </div>
                {isMainnetAgentScope ? (
                  <Link
                    href="/agents/create"
                    className="inline-flex h-12 items-center rounded-full bg-[var(--pulse-teal)] px-5 text-sm font-semibold text-[#041015] transition-[filter,transform] hover:brightness-105 active:scale-[0.96]"
                  >
                    <Plus className="mr-1 h-4 w-4" />
                    Create Agent
                  </Link>
                ) : (
                  <button
                    type="button"
                    onClick={() => setNetworkId("mainnet")}
                    className="inline-flex h-12 items-center rounded-full bg-[var(--pulse-teal)] px-5 text-sm font-semibold text-[#041015] transition-[filter,transform] hover:brightness-105 active:scale-[0.96]"
                  >
                    View Mainnet Agent
                  </button>
                )}
              </div>
            </div>
              </section>

              {error ? (
                <div className="rounded-[22px] border border-amber-300/18 bg-amber-300/10 px-4 py-3 text-sm text-amber-100">
                  {error}
                </div>
              ) : null}

              <HealthStrip items={health} />

              <section className="flex flex-col gap-5">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div className="space-y-1.5">
                <h2 className="text-xl font-semibold text-white">Agents</h2>
                <p className="text-sm text-slate-400">Track live status, identity evidence, and vault readiness.</p>
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
                            ? "bg-cyan-300/12 text-[var(--pulse-teal)]"
                            : "bg-white/[0.05] text-slate-400 hover:bg-white/[0.08] hover:text-white"
                        }`}
                      >
                        {filter.label}
                      </button>
                    );
                  })}
                </div>

                <div className="inline-flex w-fit rounded-full border border-white/8 bg-white/[0.04] p-1">
                  <button
                    type="button"
                    aria-pressed={rosterView === "grid"}
                    onClick={() => setRosterView("grid")}
                    className={`inline-flex h-8 items-center gap-2 rounded-full px-3 text-xs font-medium transition-colors ${
                      rosterView === "grid" ? "bg-cyan-300/12 text-[var(--pulse-teal)]" : "text-slate-400 hover:text-white"
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
                      rosterView === "table" ? "bg-cyan-300/12 text-[var(--pulse-teal)]" : "text-slate-400 hover:text-white"
                    }`}
                  >
                    <LayoutList className="h-3.5 w-3.5" />
                    Table
                  </button>
                </div>
              </div>
            </div>

            {isLoading && isMainnetAgentScope ? (
              <div className="rounded-[28px] border border-white/8 bg-[linear-gradient(180deg,rgba(13,19,26,0.94),rgba(9,14,20,0.82))] p-6 text-sm text-slate-400">
                <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
                Loading agents...
              </div>
            ) : scopedWorkspace && visibleDeployments.length ? (
              rosterView === "grid" ? (
                <div className="grid justify-start gap-4 sm:grid-cols-[repeat(auto-fill,minmax(17rem,19.5rem))]">
                  {visibleDeployments.map((deployment) => (
                    <AgentCard
                      deployment={deployment}
                      identityLabel={scopedWorkspace.identity.label}
                      key={deployment.id}
                      networkLabel="0G Mainnet"
                      status={rosterStatus}
                      vault={scopedWorkspace.vault}
                    />
                  ))}
                </div>
              ) : (
                <AgentTable deployments={visibleDeployments} status={rosterStatus} vault={scopedWorkspace.vault} />
              )
            ) : (
              <NetworkEmptyState activeFilter={activeFilter} isMainnet={isMainnetAgentScope} networkLabel={network.label} />
            )}
              </section>
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
        className="fixed bottom-5 right-4 z-40 inline-flex items-center justify-center gap-2 rounded-full border border-white/12 bg-[#0b141b]/92 px-4 py-3 text-sm font-medium text-slate-200 shadow-[0_16px_48px_rgba(0,0,0,0.35)] transition-colors hover:border-white/20 hover:text-white max-sm:h-12 max-sm:w-12 max-sm:px-0 xl:hidden"
      >
        <MessageSquare className="h-4 w-4 text-[var(--pulse-teal)]" />
        <span className="max-sm:hidden">Open copilot</span>
      </button>

      {mobileChatOpen ? (
        <div className="fixed inset-0 z-50 bg-[#010509]/82 px-3 py-4 xl:hidden">
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
  const vaultReady = workspace?.vault.ready === true;
  const storageReady = workspace?.storage.ready === true;
  const storageUploadReady = workspace?.storage.uploadReady === true;
  const warnings = (workspace?.vault.warnings.length ?? 0) + (workspace?.storage.warnings.length ?? 0);
  const perTradeCap = workspace?.vault.policy?.perTradeCap0G;
  const storageLag = workspace?.storage.lagBlocks;
  return [
    {
      detail: deployed ? "Agentic ID minted" : "No Agentic ID minted",
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
      detail: "Policy-bound exposure",
      label: "Open exposure",
      tone: "neutral",
      value: `${format0GMetric(workspace?.vault.openExposure0G ?? "0")} 0G`,
    },
    {
      detail: workspace?.vault.balance0G ? "Policy Vault balance" : "No vault balance loaded",
      label: "Vault balance",
      tone: vaultReady ? "positive" : "warning",
      value: workspace?.vault.balance0G ? `${format0GMetric(workspace.vault.balance0G)} 0G` : "--",
    },
    {
      detail: warnings ? `${warnings} blocker${warnings === 1 ? "" : "s"} to review` : "Per-trade vault cap",
      label: "Policy cap",
      tone: warnings ? "warning" : "positive",
      value: perTradeCap ? `${format0GMetric(perTradeCap)} 0G` : "--",
    },
    {
      detail: storageReady
        ? "Retrieval synced"
        : storageUploadReady && storageLag !== undefined
          ? `${formatIntegerMetric(storageLag)} block lag`
          : storageUploadReady
            ? "Direct upload available"
            : "Storage unavailable",
      label: "0G Storage",
      tone: storageUploadReady ? "positive" : "warning",
      value: storageReady ? "Synced" : storageUploadReady ? "Upload ready" : "--",
    },
  ] as const;
}

function buildNetworkEmptyHealth(networkLabel: string) {
  return [
    {
      detail: `No ${networkLabel} agent`,
      label: "Live agents",
      tone: "neutral",
      value: "0",
    },
    {
      detail: "Mainnet agent hidden",
      label: "Running now",
      tone: "neutral",
      value: "0",
    },
    {
      detail: "No vault exposure",
      label: "Open exposure",
      tone: "neutral",
      value: "0 0G",
    },
    {
      detail: "No network vault",
      label: "Vault balance",
      tone: "neutral",
      value: "--",
    },
    {
      detail: "Mainnet policy only",
      label: "Policy cap",
      tone: "neutral",
      value: "--",
    },
    {
      detail: "No agent evidence",
      label: "0G Storage",
      tone: "neutral",
      value: "--",
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
  networkLabel,
}: {
  activeFilter: RosterFilter;
  isMainnet: boolean;
  networkLabel: string;
}) {
  const title = isMainnet
    ? activeFilter === "all"
      ? "No active 0G agent."
      : "No agents match this view."
    : `No ${networkLabel} agent deployed.`;
  const detail = isMainnet
    ? activeFilter === "draft"
      ? "Draft setup lives in the create flow. The roster only shows minted Agentic ID records."
      : "Create a new agent to mint an Agentic ID and attach it to the Policy Vault."
    : "The armed Agentic ID and Policy Vault are scoped to 0G Mainnet, so they stay hidden while Testnet is selected.";

  return (
    <div className="rounded-[28px] border border-white/8 bg-[linear-gradient(180deg,rgba(12,17,24,0.95),rgba(7,10,15,0.86))] p-6 shadow-[0_0_0_1px_rgba(255,255,255,0.04)]">
      <Bot className="mb-3 h-7 w-7 text-slate-600" />
      <p className="text-sm font-semibold text-white">{title}</p>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">{detail}</p>
      {isMainnet ? (
        <Link
          href="/agents/create"
          className="mt-5 inline-flex h-10 items-center gap-2 rounded-full bg-[var(--pulse-teal)] px-4 text-sm font-semibold text-[#041015] transition-[filter,transform] hover:brightness-105 active:scale-[0.96]"
        >
          <Plus className="h-4 w-4" />
          Create Agent
        </Link>
      ) : null}
    </div>
  );
}

function HealthStrip({
  items,
}: {
  items: readonly { detail: string; label: string; tone: "neutral" | "positive" | "warning"; value: string }[];
}) {
  return (
    <section className="grid gap-3 rounded-[24px] border border-white/8 bg-[linear-gradient(180deg,rgba(12,17,24,0.94),rgba(8,12,18,0.9))] p-3 shadow-[0_20px_60px_rgba(0,0,0,0.22)] sm:grid-cols-2 lg:grid-cols-3 lg:rounded-[28px] lg:p-4 2xl:grid-cols-6">
      {items.map((item) => {
        const toneClass = item.tone === "positive" ? "text-emerald-300" : item.tone === "warning" ? "text-amber-200" : "text-slate-400";
        return (
          <article key={item.label} className="min-w-0 rounded-[18px] border border-white/8 bg-white/[0.03] px-3 py-3 lg:rounded-[22px] lg:px-4 lg:py-3.5">
            <p className="truncate text-[10px] uppercase tracking-[0.22em] text-slate-500">{item.label}</p>
            <p className="mt-2 truncate text-xl font-semibold tracking-tight text-white" title={item.value}>
              {item.value}
            </p>
            <p className={`mt-1 truncate text-sm ${toneClass}`} title={item.detail}>
              {item.detail}
            </p>
          </article>
        );
      })}
    </section>
  );
}

function AgentCard({
  deployment,
  identityLabel,
  networkLabel,
  status,
  vault,
}: {
  deployment: OgAgentDeploymentRecord;
  identityLabel: OgAgentWorkspace["identity"]["label"];
  networkLabel: string;
  status: OgAgentWorkspace["agent"]["status"];
  vault: OgAgentWorkspace["vault"];
}) {
  const statusClass =
    status === "armed"
      ? "border-emerald-400/15 bg-emerald-400/10 text-emerald-300"
      : status === "paused"
        ? "border-yellow-300/15 bg-yellow-300/10 text-yellow-200"
      : status === "blocked"
        ? "border-amber-300/15 bg-amber-300/10 text-amber-200"
        : "border-slate-400/15 bg-slate-400/10 text-slate-300";

  return (
    <article className="animate-feed-reveal group flex aspect-square min-h-[19rem] w-full max-w-[19.5rem] flex-col rounded-[28px] border border-white/8 bg-[linear-gradient(180deg,rgba(12,17,24,0.96),rgba(7,10,15,0.88))] p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.04),0_22px_64px_rgba(0,0,0,0.22)] transition-[transform,border-color,box-shadow] duration-200 hover:-translate-y-0.5 hover:border-white/14 hover:shadow-[0_0_0_1px_rgba(255,255,255,0.08),0_28px_76px_rgba(0,0,0,0.28)]">
      <div className="flex items-start justify-between gap-3">
        <Link href={`/agents/${deployment.id}`} className="flex min-w-0 flex-1 items-start gap-3 text-left">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-cyan-200/10 bg-cyan-300/12 font-heading text-sm font-semibold uppercase tracking-[0.2em] text-[var(--pulse-teal)] transition-[border-color,background-color] duration-200 group-hover:border-cyan-200/18 group-hover:bg-cyan-300/16">
            {deployment.tokenId}
          </div>
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold text-white">{deployment.name}</h3>
            <p className="mt-1 line-clamp-2 text-sm leading-5 text-slate-400">0G Policy Vault trading agent</p>
          </div>
        </Link>
        <span className={`shrink-0 rounded-full border px-2.5 py-1 text-xs font-medium capitalize ${statusClass}`}>
          {status}
        </span>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <AgentMetric label="Network" value={networkLabel} />
        <AgentMetric label="Vault" value={vault.vault ? shortHash(vault.vault) : "--"} />
        <AgentMetric label="Identity" value={`#${deployment.tokenId}`} />
        <AgentMetric label="Evidence" value={shortHash(deployment.storageRoot)} />
      </div>

      <div className="mt-3 rounded-[18px] border border-cyan-300/12 bg-cyan-300/[0.045] px-3 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate rounded-full border border-cyan-300/15 bg-cyan-300/10 px-2 py-0.5 text-[10px] font-medium text-cyan-200">
            {identityLabel}
          </span>
          <span className="shrink-0 font-mono text-[10px] text-slate-500">proof-bound</span>
        </div>
        <p className="mt-2 truncate text-xs leading-5 text-slate-400" title={deployment.agentRef}>
          Agent ref {shortHash(deployment.agentRef)}
        </p>
      </div>

      <div className="mt-auto flex items-center justify-between gap-3 border-t border-white/8 pt-3">
        <div className="min-w-0 text-[10px] uppercase tracking-[0.2em] text-slate-500">
          <p className="truncate">0G Mainnet</p>
          <p className="mt-1 truncate">Policy Vault</p>
        </div>
        <Link
          href={`/agents/${deployment.id}`}
          className="inline-flex h-9 shrink-0 items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] pl-3 pr-2.5 text-sm text-slate-200 transition-[background-color,border-color,transform] hover:bg-white/[0.07] active:scale-[0.96]"
        >
          Review
          <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
    </article>
  );
}

function AgentTable({
  deployments,
  status,
  vault,
}: {
  deployments: OgAgentDeploymentRecord[];
  status: OgAgentWorkspace["agent"]["status"];
  vault: OgAgentWorkspace["vault"];
}) {
  return (
    <div className="overflow-hidden rounded-[24px] border border-white/8 bg-[linear-gradient(180deg,rgba(12,17,24,0.95),rgba(7,10,15,0.86))]">
      <div className="grid grid-cols-[1.1fr_0.7fr_0.8fr_auto] gap-3 border-b border-white/8 px-4 py-3 text-[10px] uppercase tracking-[0.2em] text-slate-500">
        <span>Agent</span>
        <span>Status</span>
        <span>Vault</span>
        <span>Action</span>
      </div>
      {deployments.map((deployment) => (
        <div key={deployment.id} className="grid grid-cols-[1.1fr_0.7fr_0.8fr_auto] items-center gap-3 border-b border-white/8 px-4 py-4 last:border-b-0">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-white">{deployment.name}</p>
            <p className="truncate text-xs text-slate-500">{deployment.agentRef}</p>
          </div>
          <span className="text-sm capitalize text-slate-300">{status}</span>
          <span className="truncate font-mono text-xs text-slate-300">{vault.vault ? shortHash(vault.vault) : "--"}</span>
          <Link href={`/agents/${deployment.id}`} className="inline-flex h-9 items-center rounded-full border border-white/10 px-3 text-sm text-slate-200 hover:bg-white/[0.06]">
            Open
          </Link>
        </div>
      ))}
    </div>
  );
}

function AgentMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[16px] border border-white/8 bg-black/20 px-3 py-2">
      <p className="text-[10px] uppercase tracking-[0.22em] text-slate-500">{label}</p>
      <p className="mt-1 truncate font-mono text-xs font-semibold text-slate-100" title={value}>
        {value}
      </p>
    </div>
  );
}

export function IdentitySummary({ workspace }: { workspace: OgAgentWorkspace }) {
  return (
    <section className="rounded-[22px] border border-white/8 bg-[linear-gradient(180deg,rgba(12,17,24,0.95),rgba(7,10,15,0.86))] p-4 sm:p-5">
      <div className="mb-4 flex items-center gap-2">
        <FileCheck2 className="h-4 w-4 text-[var(--pulse-teal)]" />
        <h2 className="text-sm font-semibold text-white">Agentic ID</h2>
      </div>
      <div className="space-y-2.5">
        <ConfigRow label="Standard" value={workspace.identity.label} />
        <ConfigRow label="Contract" value={workspace.identity.address ? shortHash(workspace.identity.address) : "Not configured"} />
        <ConfigRow label="Token" value={workspace.agent.deployment ? `#${workspace.agent.deployment.tokenId}` : "Not minted"} />
        <ConfigRow label="Storage root" value={workspace.agent.deployment ? shortHash(workspace.agent.deployment.storageRoot) : "pending"} />
      </div>
      <p className="mt-4 text-xs leading-5 text-slate-500">{workspace.identity.note}</p>
    </section>
  );
}

export function VaultSummary({ workspace }: { workspace: OgAgentWorkspace }) {
  return (
    <section className="rounded-[22px] border border-white/8 bg-[linear-gradient(180deg,rgba(12,17,24,0.95),rgba(7,10,15,0.86))] p-4 sm:p-5">
      <div className="mb-4 flex items-center gap-2">
        <Shield className="h-4 w-4 text-[var(--pulse-teal)]" />
        <h2 className="text-sm font-semibold text-white">Policy Vault</h2>
      </div>
      <div className="space-y-2.5">
        <ConfigRow label="Vault" value={workspace.vault.vault ? shortHash(workspace.vault.vault) : "--"} />
        <ConfigRow label="Balance" value={workspace.vault.balance0G ? `${workspace.vault.balance0G} 0G` : "--"} />
        <ConfigRow label="Paused" value={workspace.vault.paused ? "Yes" : "No"} />
        <ConfigRow label="Executor revoked" value={workspace.vault.executorRevoked ? "Yes" : "No"} />
        <ConfigRow label="Mock adapter" value={workspace.vault.mockAdapterAllowed ? "Allowed" : "Blocked"} />
      </div>
      {workspace.vault.warnings.length ? (
        <div className="mt-4 rounded-2xl border border-amber-300/15 bg-amber-300/8 px-3 py-2 text-xs leading-5 text-amber-100">
          {workspace.vault.warnings.join(" ")}
        </div>
      ) : null}
    </section>
  );
}

export function StorageSummary({ workspace }: { workspace: OgAgentWorkspace }) {
  return (
    <section className="rounded-[22px] border border-white/8 bg-[linear-gradient(180deg,rgba(12,17,24,0.95),rgba(7,10,15,0.86))] p-4 sm:p-5">
      <div className="mb-4 flex items-center gap-2">
        <Database className="h-4 w-4 text-[var(--pulse-teal)]" />
        <h2 className="text-sm font-semibold text-white">0G Storage</h2>
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
        <div className="mt-4 rounded-2xl border border-amber-300/15 bg-amber-300/8 px-3 py-2 text-xs leading-5 text-amber-100">
          {workspace.storage.warnings.join(" ")}
        </div>
      ) : null}
    </section>
  );
}

export function ConfigRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <span className="text-[12px] text-slate-500">{label}</span>
      <span className="break-words text-left font-mono text-[13px] font-medium text-white sm:max-w-[60%] sm:text-right" title={value}>
        {value}
      </span>
    </div>
  );
}

export function AgentEmptyState() {
  return (
    <div className="rounded-[28px] border border-white/8 bg-[linear-gradient(180deg,rgba(12,17,24,0.95),rgba(7,10,15,0.86))] p-6 text-sm text-slate-400">
      <Bot className="mb-3 h-7 w-7 text-slate-600" />
      No Agentic ID is minted for the single 0G trading agent yet.
    </div>
  );
}

export function EvidencePill({ icon, label, value }: { icon: "database" | "proof"; label: string; value: string }) {
  const Icon = icon === "database" ? Database : FileCheck2;
  return (
    <div className="rounded-[16px] border border-white/8 bg-black/20 px-3 py-2">
      <div className="flex items-center gap-1.5 text-slate-500">
        <Icon className="h-3.5 w-3.5" />
        <span className="text-[10px] uppercase tracking-[0.18em]">{label}</span>
      </div>
      <p className="mt-1 truncate font-mono text-xs font-semibold text-slate-100" title={value}>
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
