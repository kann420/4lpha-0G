"use client";

import { useMemo, useState } from "react";
import {
  ChevronRight,
  LayoutGrid,
  LayoutList,
  MessageSquare,
  Pause,
  Play,
  Plus,
  RefreshCcw,
  Sparkles,
} from "lucide-react";
import { AgentRouteTradePanel } from "@/components/app/AgentRouteTradePanel";
import { AppShell } from "@/components/app/AppShell";
import { COPILOT_MOBILE_PANEL_CLASS, EmbeddedCopilotRail } from "@/components/app/EmbeddedCopilotRail";
import { useOgNetwork } from "@/components/app/useOgNetwork";
import type { EmbeddedCopilotMessage } from "@/components/app/EmbeddedCopilotRail";
import type { AgentTradePreview, CopilotContextItem } from "@/lib/types";

const AGENT_CHAT_MESSAGES: EmbeddedCopilotMessage[] = [];

const FILTERS = [
  { label: "All", value: "all" },
  { label: "Armed", value: "armed" },
  { label: "Paused", value: "paused" },
  { label: "Draft", value: "draft" },
] as const;

const AGENTS = [
  {
    id: "agent-aura",
    name: "Aura Guard",
    status: "armed",
    strategy: "0G policy momentum",
    capital: "2.40 0G",
    pnl: "+0.18 0G",
    risk: "low",
    runs: "18",
    evidence: "audit-042",
    note: "Healthy and validating policy proofs normally.",
  },
  {
    id: "agent-kepler",
    name: "Kepler Watch",
    status: "paused",
    strategy: "Evidence-first observation",
    capital: "0.00 0G",
    pnl: "0.00 0G",
    risk: "medium",
    runs: "7",
    evidence: "audit-040",
    note: "Paused by operator until storage retrieval is reviewed.",
  },
  {
    id: "agent-nova",
    name: "Nova Sentinel",
    status: "armed",
    strategy: "Vault guard monitor",
    capital: "0.42 0G",
    pnl: "+0.04 0G",
    risk: "low",
    runs: "11",
    evidence: "audit-041",
    note: "Watching proof freshness and adapter allowlists.",
  },
] as const;

type AgentFilter = (typeof FILTERS)[number]["value"];
type RosterView = "grid" | "table";

export function AgentsSurface() {
  const { network, networkId, setNetworkId } = useOgNetwork();
  const [activeFilter, setActiveFilter] = useState<AgentFilter>("all");
  const [busyAgentId, setBusyAgentId] = useState<string>();
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const [rosterView, setRosterView] = useState<RosterView>("grid");
  const [tradePreview, setTradePreview] = useState<AgentTradePreview | null>(null);

  const visibleAgents = useMemo(
    () => AGENTS.filter((agent) => activeFilter === "all" || agent.status === activeFilter),
    [activeFilter],
  );
  const copilotContext = useMemo(() => buildTradeCopilotContext(tradePreview), [tradePreview]);

  const healthItems = [
    { detail: `${AGENTS.length} total agents`, label: "Live agents", tone: "positive", value: "2" },
    { detail: "Execution cycles can fire now", label: "Running now", tone: "positive", value: "2" },
    { detail: "Proof-bound positions", label: "Open positions", tone: "neutral", value: "2" },
    { detail: "Net modeled edge", label: "Net PnL", tone: "positive", value: "+0.22 0G" },
    { detail: "No blockers detected", label: "Attention needed", tone: "positive", value: "0" },
  ] as const;

  return (
    <AppShell network={network} networkId={networkId} onNetworkChange={setNetworkId}>
      <main className="h-full min-h-0 overflow-hidden px-3 py-4 lg:px-8">
        <div className="mx-auto grid h-full min-h-0 w-full max-w-7xl gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
          <div className="scrollbar-subtle min-h-0 overflow-y-auto pr-1">
            <div className="flex flex-col gap-5 lg:gap-6">
              <section className="rounded-[24px] border border-line bg-panel-solid-strong px-4 py-5 shadow-[0_28px_100px_rgba(0,0,0,0.24)] lg:rounded-[30px] lg:px-8 lg:py-6">
                <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
                  <div className="max-w-[20rem] space-y-2.5">
                    <p className="text-[11px] uppercase tracking-[0.32em] text-primary/60">
                      Agent workspace
                    </p>
                    <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:whitespace-nowrap sm:text-3xl lg:text-4xl">
                      Create your Agent
                    </h1>
                    <p className="max-w-2xl text-sm leading-6 text-muted lg:text-base">
                      Monitor 0G trading agents and policy proof status from the same control surface.
                    </p>
                  </div>

                  <div className="flex flex-col gap-3 sm:items-start lg:min-w-[24.25rem] lg:items-end">
                    <div className="flex flex-nowrap items-center gap-2.5 lg:gap-3">
                      <div className="inline-flex h-12 items-center justify-center rounded-full border border-line bg-panel px-4 text-xs uppercase tracking-[0.24em] text-muted">
                        0G / STORAGE / VAULT
                      </div>
                      <button
                        type="button"
                        className="inline-flex h-12 items-center rounded-full border border-line bg-panel px-4 text-sm font-medium text-foreground transition-colors hover:bg-panel-strong"
                      >
                        <RefreshCcw className="mr-2 h-4 w-4" />
                        Refresh
                      </button>
                    </div>
                    <button
                      type="button"
                      className="inline-flex h-12 items-center rounded-full bg-primary px-5 text-sm font-semibold text-on-primary transition-[filter,transform] hover:brightness-105 active:scale-[0.96]"
                    >
                      <Plus className="mr-1 h-4 w-4" />
                      Create Agent
                    </button>
                  </div>
                </div>
              </section>

              <HealthStrip items={healthItems} />

              <AgentRouteTradePanel
                networkId={networkId}
                networkLabel={network.networkName}
                onPreviewChange={setTradePreview}
              />

              <section className="flex flex-col gap-5">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                  <div className="space-y-1.5">
                    <h2 className="text-xl font-semibold text-foreground">Agents</h2>
                    <p className="text-sm text-muted">
                      Track live status, proof evidence, and last action of agents
                    </p>
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
                                ? "bg-primary/10 text-primary"
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
                          rosterView === "grid"
                            ? "bg-primary/10 text-primary"
                            : "text-muted hover:text-foreground"
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
                          rosterView === "table"
                            ? "bg-primary/10 text-primary"
                            : "text-muted hover:text-foreground"
                        }`}
                      >
                        <LayoutList className="h-3.5 w-3.5" />
                        Table
                      </button>
                    </div>
                  </div>
                </div>

                <div className={rosterView === "grid" ? "grid gap-4 xl:grid-cols-2" : "grid gap-4"}>
                  {visibleAgents.map((agent, index) => (
                    <AgentCard
                      key={agent.id}
                      agent={agent}
                      busy={busyAgentId === agent.id}
                      index={index}
                      onAction={(agentId) => setBusyAgentId((current) => (current === agentId ? undefined : agentId))}
                    />
                  ))}
                </div>
              </section>
            </div>
          </div>

          <aside className="hidden h-full min-h-0 xl:block">
            <EmbeddedCopilotRail
              context={copilotContext}
              description="Review 0G agent runs, policy proofs, and execution blockers."
              initialMessages={AGENT_CHAT_MESSAGES}
              networkId={networkId}
              networkLabel={network.label}
              placeholder="Ask for an agent review, proof summary, or execution blocker..."
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
                description="Review 0G agent runs, policy proofs, and execution blockers."
                initialMessages={AGENT_CHAT_MESSAGES}
                isMobile
                networkId={networkId}
                networkLabel={network.label}
                onClose={() => setMobileChatOpen(false)}
                placeholder="Ask for an agent review, proof summary, or execution blocker..."
                sendIcon="message"
              />
            </div>
          </div>
        </div>
      ) : null}
    </AppShell>
  );
}

function buildTradeCopilotContext(preview: AgentTradePreview | null): CopilotContextItem[] | undefined {
  if (!preview) {
    return undefined;
  }

  return [
    {
      kind: "route",
      label: "Route",
      value: `${preview.quote.routeLabel} via ${preview.quote.venue}`,
    },
    {
      kind: "quote",
      label: "Quote",
      value: `${preview.quote.amountIn} ${preview.quote.inputToken} to ${preview.quote.expectedAmountOut} ${preview.quote.outputToken}`,
    },
    {
      kind: "proof",
      label: "Policy",
      value: `${preview.proofBundle.policyDecision} ${shortContextHash(preview.proofBundle.policyDecisionHash)}`,
    },
    {
      kind: "audit",
      label: "Storage root",
      value: shortContextHash(preview.proofBundle.storageRoot),
    },
  ];
}

function HealthStrip({
  items,
}: {
  items: readonly { detail: string; label: string; tone: "neutral" | "positive" | "warning"; value: string }[];
}) {
  return (
    <section className="grid gap-3 rounded-[24px] border border-line bg-panel-solid-strong p-3 shadow-[0_20px_60px_rgba(0,0,0,0.22)] sm:grid-cols-2 lg:rounded-[28px] lg:p-4 xl:grid-cols-5">
      {items.map((item) => {
        const toneClass =
          item.tone === "positive" ? "text-green" : item.tone === "warning" ? "text-amber" : "text-muted";
        return (
          <article
            key={item.label}
            className="rounded-[18px] border border-line bg-panel px-3 py-3 lg:rounded-[22px] lg:px-4 lg:py-3.5"
          >
            <p className="text-[10px] uppercase tracking-[0.24em] text-muted">{item.label}</p>
            <p className="mt-2 text-2xl font-semibold tracking-tight text-foreground">{item.value}</p>
            <p className={`mt-1 text-sm ${toneClass}`}>{item.detail}</p>
          </article>
        );
      })}
    </section>
  );
}

function AgentCard({
  agent,
  busy,
  index,
  onAction,
}: {
  agent: (typeof AGENTS)[number];
  busy: boolean;
  index: number;
  onAction: (agentId: string) => void;
}) {
  const armed = agent.status === "armed";
  const statusClass = armed
    ? "border-green/15 bg-green/10 text-green"
    : "border-amber/15 bg-amber/10 text-amber";
  const riskClass =
    agent.risk === "low"
      ? "border-green/15 bg-green/10 text-green"
      : "border-amber/15 bg-amber/10 text-amber";

  return (
    <article
      className="animate-feed-reveal rounded-[24px] border border-line bg-panel-solid-strong p-4 shadow-[0_20px_60px_rgba(0,0,0,0.2)]"
      style={{ animationDelay: `${index * 70}ms` }}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-primary/20 bg-primary/10 font-heading text-sm font-semibold uppercase tracking-[0.2em] text-primary">
            {agent.name.slice(0, 1)}
          </div>
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold text-foreground">{agent.name}</h3>
            <p className="mt-1 text-sm text-muted">{agent.strategy}</p>
          </div>
        </div>
        <span className={`shrink-0 rounded-full border px-2.5 py-1 text-xs font-medium capitalize ${statusClass}`}>
          {agent.status}
        </span>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <AgentMetric label="Capital" value={agent.capital} />
        <AgentMetric label="PnL" value={agent.pnl} />
        <AgentMetric label="Runs" value={agent.runs} />
        <AgentMetric label="Evidence" value={agent.evidence} />
      </div>

      <div className="mt-4 rounded-[18px] border border-line bg-panel px-3 py-2.5">
        <div className="flex items-center justify-between gap-3">
          <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium capitalize ${riskClass}`}>
            {agent.risk} risk
          </span>
          <span className="font-mono text-[11px] text-muted">proof-bound</span>
        </div>
        <p className="mt-2 text-sm leading-6 text-muted">{agent.note}</p>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
        <button
          type="button"
          onClick={() => onAction(agent.id)}
          className="inline-flex h-9 items-center gap-2 rounded-full border border-line bg-panel px-3 text-sm text-foreground transition-colors hover:bg-panel-strong"
        >
          {busy ? <Sparkles className="h-4 w-4 text-primary" /> : armed ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          {armed ? "Pause" : "Arm"}
        </button>
        <button
          type="button"
          className="inline-flex h-9 items-center gap-2 rounded-full border border-line bg-panel px-3 text-sm text-foreground transition-colors hover:bg-panel-strong"
        >
          Review
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </article>
  );
}

function AgentMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[16px] border border-line bg-panel-solid-strong/20 px-3 py-2">
      <p className="text-[10px] uppercase tracking-[0.22em] text-muted">{label}</p>
      <p className="mt-1 truncate font-mono text-xs font-semibold text-foreground">{value}</p>
    </div>
  );
}

function shortContextHash(value: string): string {
  if (!value.startsWith("0x") || value.length <= 14) {
    return value;
  }
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}
