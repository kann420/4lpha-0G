"use client";

import { useMemo, useState } from "react";
import { ChevronDown, Coins, ExternalLink, RefreshCcw, Repeat2, TrendingDown, TrendingUp } from "lucide-react";

import { AutomationModuleCard } from "@/components/agents/lp/AutomationModuleCard";
import { LpAutoMintToggle } from "@/components/agents/lp/LpAutoMintToggle";
import { LpStatusPill } from "@/components/agents/lp/LpStatusPill";
import type { OgAgentLogEntry } from "@/lib/agent/single-agent";
import { dispatchSigmaPetReaction } from "@/lib/copilot/sigma-pet";

// Right column — Automation Controls (collapsible, default collapsed) + the
// Agent log (moved here from the center column so it sits below the automation
// panel where it's easier to read). All four automations are "coming soon"; the
// live EmbeddedCopilotRail would call the server chat route, out of scope here.

const TABS = [
  { key: "autoRebalance", icon: Repeat2, title: "Auto-rebalance", tone: "blue", subtitle: "Re-center the LP range as the pool price drifts.", inactiveSummary: "Keeps the position around the active tick. Backend wiring coming soon." },
  { key: "autoCompound", icon: Coins, title: "Auto-compound", tone: "blue", subtitle: "Claim earned fees and add them back into the LP position.", inactiveSummary: "Accumulate fees first, then compound manually. Backend wiring coming soon." },
  { key: "takeProfit", icon: TrendingUp, title: "Take Profit", tone: "green", subtitle: "Zap out when the position hits a target return.", inactiveSummary: "Locks in gains at a configured target. Backend wiring coming soon." },
  { key: "stopLoss", icon: TrendingDown, title: "Stop Loss", tone: "rose", subtitle: "Zap out when exposure drops below a floor.", inactiveSummary: "Caps downside on the LP position. Backend wiring coming soon." },
] as const;

const CHAINSCAN_BASE_URL = "https://chainscan.0g.ai";

type LpLogFilter = "all" | "reject" | "execute";

const LOG_FILTERS: Array<{ label: string; tone: "slate" | "amber" | "emerald"; value: LpLogFilter }> = [
  { label: "All", tone: "slate", value: "all" },
  { label: "Reject", tone: "amber", value: "reject" },
  { label: "Execute", tone: "emerald", value: "execute" },
];

export function LpPolicyControls({
  automation,
  logs,
  agentId,
  vault,
  autoMint,
  isRefreshingLogs = false,
  onAutoMintChange,
  onRefreshLogs,
}: {
  automation: Record<string, boolean>;
  logs: readonly OgAgentLogEntry[];
  // Live Auto-mint toggle (the one wired automation). The other four tabs stay
  // "coming soon". When agentId/vault are omitted the toggle is hidden.
  agentId?: string;
  vault?: string;
  autoMint?: boolean;
  isRefreshingLogs?: boolean;
  onAutoMintChange?: (next: boolean) => void;
  onRefreshLogs?: () => void;
}) {
  const [active, setActive] = useState<(typeof TABS)[number]["key"]>("autoRebalance");
  // Automation Controls default collapsed — expand to tune (preview-only) tabs.
  const [automationOpen, setAutomationOpen] = useState(false);
  const [logFilter, setLogFilter] = useState<LpLogFilter>("all");
  const activeTab = useMemo(() => TABS.find((t) => t.key === active) ?? TABS[0], [active]);
  const filteredLogs = useMemo(() => filterLogs(logs, logFilter), [logFilter, logs]);

  return (
    <div className="flex flex-col gap-4">
      {/* Live Auto-mint toggle — always visible above the coming-soon tabs. */}
      {agentId && vault ? (
        <LpAutoMintToggle
          agentId={agentId}
          vault={vault}
          autoMint={autoMint ?? false}
          onAutoMintChange={onAutoMintChange ?? (() => undefined)}
        />
      ) : null}

      {/* Automation Controls — collapsible, default collapsed. */}
      <div className="rounded-card border border-line bg-panel-solid-strong p-4">
        <button
          type="button"
          onClick={() => {
            dispatchSigmaPetReaction("lp.create.form");
            setAutomationOpen((v) => !v);
          }}
          aria-expanded={automationOpen}
          className="flex w-full items-center justify-between gap-3 text-left"
        >
          <div className="flex items-center gap-2">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Automation</p>
            <LpStatusPill value="coming-soon" />
          </div>
          <ChevronDown
            className={`h-4 w-4 shrink-0 text-muted transition-transform ${automationOpen ? "rotate-180" : ""}`}
          />
        </button>

        {automationOpen ? (
          <>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {TABS.map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => {
                    dispatchSigmaPetReaction("lp.create.form");
                    setActive(tab.key);
                  }}
                  aria-pressed={active === tab.key}
                  className={`flex min-w-0 items-center gap-2 rounded-tile border px-2.5 py-2 text-left text-xs font-semibold transition-colors ${
                    active === tab.key ? "border-primary/50 bg-primary/10 text-primary" : "border-line bg-panel text-muted hover:border-line-strong"
                  }`}
                >
                  <tab.icon className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{tab.title}</span>
                </button>
              ))}
            </div>
            <div className="mt-3">
              <AutomationModuleCard
                icon={activeTab.icon}
                title={activeTab.title}
                subtitle={activeTab.subtitle}
                inactiveSummary={activeTab.inactiveSummary}
                tone={activeTab.tone}
                enabled={automation[activeTab.key]}
              />
            </div>
          </>
        ) : (
          <p className="mt-3 text-xs leading-5 text-muted">
            Four automations (rebalance, compound, take-profit, stop-loss) are coming soon. Expand to preview.
          </p>
        )}
      </div>

      {/* Agent log — moved below the automation panel for easier reading. */}
      <div className="flex max-h-[min(32rem,calc(100vh-260px))] min-h-[14rem] flex-col rounded-card border border-line bg-panel-solid-strong p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Agent log</p>
            <p className="mt-1 flex items-center gap-2 text-[11px] text-muted">
              <span className="h-1.5 w-1.5 rounded-full bg-green" />
              Live stream active - 30s fallback refresh
            </p>
          </div>
          {onRefreshLogs ? (
            <button
              type="button"
              onClick={onRefreshLogs}
              disabled={isRefreshingLogs}
              title="Refresh agent log now"
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-tile border border-line bg-panel text-muted transition-[background-color,border-color,color,transform] hover:border-line-strong hover:text-foreground active:scale-[0.96] disabled:cursor-wait disabled:opacity-60"
            >
              <RefreshCcw className={`h-3.5 w-3.5 ${isRefreshingLogs ? "animate-spin" : ""}`} />
            </button>
          ) : null}
        </div>
        <div className="mt-3 grid grid-cols-3 gap-1 rounded-tile border border-line bg-panel p-1">
          {LOG_FILTERS.map((filter) => (
            <LogFilterButton
              active={logFilter === filter.value}
              count={countLogs(logs, filter.value)}
              key={filter.value}
              label={filter.label}
              onClick={() => setLogFilter(filter.value)}
              tone={filter.tone}
            />
          ))}
        </div>
        <div className="scrollbar-subtle mt-3 min-h-0 flex-1 divide-y divide-line overflow-y-auto pr-1">
          {filteredLogs.length === 0 ? (
            <div className="py-3 text-xs leading-5 text-muted">
              No agent history for this filter yet.
            </div>
          ) : filteredLogs.map((log) => (
            <div key={log.id} className="py-2.5">
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <LpStatusPill
                    value={log.status === "executed" ? "armed" : log.status === "ready" ? "draft" : "paused"}
                    label={log.status}
                  />
                  <span className="truncate text-sm font-semibold text-foreground">{log.summary}</span>
                </div>
                <span className="shrink-0 font-mono text-[10px] text-muted">{log.createdAt.slice(5, 16).replace("T", " ")}</span>
              </div>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted">
                <span>action: {log.action}</span>
                <span>filter: {log.filter}</span>
                {log.txHash ? <LogTxLink hash={log.txHash} label="tx" /> : null}
                {log.proofTxHash ? <LogTxLink hash={log.proofTxHash} label="proof" /> : null}
                {log.storageRoot ? <span className="font-mono">storage {shortHash(log.storageRoot)}</span> : null}
              </div>
              {log.notes.length > 0 ? <p className="mt-1 text-[11px] text-muted">{log.notes.join(" · ")}</p> : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function LogFilterButton({
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
  tone: "slate" | "amber" | "emerald";
}) {
  const activeClass =
    tone === "emerald"
      ? "border-line-strong bg-panel-strong text-foreground"
      : tone === "amber"
        ? "border-line-strong bg-panel-strong text-foreground"
        : "border-line-strong bg-panel-strong text-foreground";
  const countClass = active
    ? tone === "emerald"
      ? "bg-green/15 text-green"
      : tone === "amber"
        ? "bg-amber/15 text-amber"
        : "bg-panel text-muted"
    : "bg-panel-strong text-muted";

  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex min-w-0 items-center justify-center gap-1.5 rounded-tile border px-2 py-1.5 text-[11px] font-medium transition-[background-color,border-color,color] ${
        active ? activeClass : "border-transparent text-muted hover:text-foreground"
      }`}
    >
      <span className="truncate">{label}</span>
      <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${countClass}`}>
        {count}
      </span>
    </button>
  );
}

function LogTxLink({ hash, label }: { hash: string; label: string }) {
  return (
    <a
      className="inline-flex items-center gap-1 font-mono text-primary transition-colors hover:text-primary-strong"
      href={`${CHAINSCAN_BASE_URL}/tx/${hash}`}
      rel="noreferrer"
      target="_blank"
      title={hash}
    >
      <span>
        {label} {shortHash(hash)}
      </span>
      <ExternalLink className="h-3 w-3 shrink-0" />
    </a>
  );
}

function filterLogs(logs: readonly OgAgentLogEntry[], filter: LpLogFilter): readonly OgAgentLogEntry[] {
  if (filter === "all") {
    return logs;
  }
  if (filter === "reject") {
    return logs.filter(
      (log) => log.status === "skipped" || log.status === "blocked" || log.filter === "skipped" || log.filter === "blocked",
    );
  }
  return logs.filter((log) => log.status === "executed" || log.filter === "executed");
}

function countLogs(logs: readonly OgAgentLogEntry[], filter: LpLogFilter): number {
  return filterLogs(logs, filter).length;
}

function shortHash(value: string): string {
  if (value.length <= 12) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}
