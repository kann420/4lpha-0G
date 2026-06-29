import { ShieldAlert, ShieldCheck, TimerReset } from "lucide-react";
import type { AgentRunPreview } from "@/lib/types";
import { HashPill } from "./HashPill";
import { StatusBadge } from "./StatusBadge";

const ACTION_LABELS: Record<AgentRunPreview["action"], string> = {
  blocked: "Blocked",
  "buy-review": "Buy review",
  observe: "Observe",
  "sell-review": "Sell review",
};

export function RunLogItem({ run }: { run: AgentRunPreview }) {
  const Icon = run.action === "blocked" ? ShieldAlert : run.action === "observe" ? TimerReset : ShieldCheck;

  return (
    <article className="rounded-[18px] border border-line bg-panel p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-primary/20 bg-primary/10 text-primary">
            <Icon className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground">{ACTION_LABELS[run.action]}</p>
            <p className="mt-1 text-sm leading-6 text-muted">{run.summary}</p>
          </div>
        </div>
        <div className="shrink-0 text-right">
          <StatusBadge status={run.status} />
          <p className="mt-2 font-mono text-xs text-muted">{run.timestamp}</p>
        </div>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <HashPill label="Decision" value={run.policyDecision} />
        <HashPill label="Evidence" value={run.evidenceId} />
      </div>
    </article>
  );
}
