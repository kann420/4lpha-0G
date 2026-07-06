import { Check, X, type LucideIcon } from "lucide-react";

import { LpStatusPill } from "@/components/agents/lp/LpStatusPill";

// Ported from 4alpha LpPolicyControls AutomationCard + ModuleStatusIcon, restyled
// to 0G semantic tokens. A "Coming soon" pill sits next to the title so the
// not-yet-wired state is explicit; the check/cross tile reflects the UX-only
// parent automation flag (no backend effect).

const TONE_ICON: Record<string, string> = {
  blue: "border-primary/20 bg-primary/[0.06] text-primary",
  green: "border-green/20 bg-green/[0.06] text-green",
  rose: "border-rose/20 bg-rose/[0.06] text-rose",
};

export function AutomationModuleCard({
  icon: Icon,
  title,
  subtitle,
  inactiveSummary,
  tone,
  enabled,
}: {
  icon: LucideIcon;
  title: string;
  subtitle: string;
  inactiveSummary: string;
  tone: "blue" | "green" | "rose";
  enabled?: boolean;
}) {
  return (
    <section className="rounded-tile border border-line bg-panel-solid-strong p-3">
      <div className="flex items-start gap-3">
        <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-tile border ${TONE_ICON[tone]}`}>
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
            <span className="inline-flex items-center gap-2">
              <ModuleStatusIcon enabled={Boolean(enabled)} />
              <span>{title}</span>
            </span>
            <LpStatusPill value="coming-soon" />
          </div>
          <p className="mt-1 text-xs leading-5 text-muted">{subtitle}</p>
        </div>
      </div>
      <div className="mt-4">
        <p className="text-xs leading-5 text-muted">{inactiveSummary}</p>
      </div>
    </section>
  );
}

function ModuleStatusIcon({ enabled }: { enabled: boolean }) {
  return (
    <span
      className={`ml-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] ${
        enabled ? "bg-primary text-on-primary" : "bg-panel-strong text-muted"
      }`}
      aria-label={enabled ? "Enabled" : "Disabled"}
    >
      {enabled ? <Check className="h-3 w-3 stroke-[3]" /> : <X className="h-3 w-3 stroke-[3]" />}
    </span>
  );
}
