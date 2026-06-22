import { Copy } from "lucide-react";
import { shortHash } from "@/lib/format";

export function HashPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 rounded-[14px] border border-white/8 bg-white/[0.035] px-3 py-2">
      <span className="shrink-0 text-[11px] uppercase tracking-[0.18em] text-slate-500">{label}</span>
      <span className="flex min-w-0 items-center gap-2 font-mono text-xs text-slate-100">
        <span className="truncate">{shortHash(value)}</span>
        <Copy className="h-3.5 w-3.5 shrink-0 text-slate-500" />
      </span>
    </div>
  );
}
