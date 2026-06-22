import { Copy, ShieldCheck } from "lucide-react";
import { auditEvidence } from "@/lib/mock-data";
import type { AuditEvidence } from "@/lib/types";
import { shortHash } from "@/lib/format";
import { StatusBadge } from "./StatusBadge";

export function EvidencePanel({ evidence = auditEvidence }: { evidence?: AuditEvidence[] }) {
  return (
    <aside className="relative isolate flex min-h-0 flex-col overflow-hidden rounded-[24px] border border-white/8 bg-[linear-gradient(180deg,rgba(12,17,24,0.97),rgba(7,10,15,0.92))] shadow-[0_24px_80px_rgba(0,0,0,0.24)] backdrop-blur-xl">
      <div className="pointer-events-none absolute inset-x-4 top-0 h-px bg-[linear-gradient(90deg,transparent,rgba(30,232,197,0.58),rgba(255,209,102,0.28),transparent)]" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-14 bg-[linear-gradient(180deg,rgba(30,232,197,0.07),transparent)]" />

      <header className="relative border-b border-white/8 px-3 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] font-medium uppercase tracking-[0.22em] text-slate-500">Audit</p>
            <h2 className="mt-1 text-sm font-semibold tracking-tight text-white">Evidence</h2>
            <p className="mt-1 text-xs leading-5 text-slate-500">Redacted roots and proof references.</p>
          </div>
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[14px] border border-cyan-300/15 bg-cyan-300/10 text-cyan-100">
            <ShieldCheck className="h-3.5 w-3.5" />
          </span>
        </div>
      </header>
      <div className="scrollbar-subtle relative min-h-0 flex-1 space-y-2 overflow-y-auto p-2.5">
        {evidence.map((item) => (
          <article key={item.id} className="rounded-[16px] border border-white/8 bg-white/[0.025] p-2.5 transition-[border-color,background-color] duration-200 ease-out hover:border-white/14 hover:bg-white/[0.04]">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-[13px] font-semibold text-white">{item.label}</p>
                <p className="mt-0.5 font-mono text-[11px] tabular-nums text-slate-500">{item.updatedAt}</p>
              </div>
              <div className="shrink-0 [&>span]:px-2 [&>span]:py-0.5 [&>span]:text-[11px]">
                <StatusBadge status={item.status} />
              </div>
            </div>
            <div className="mt-2 grid gap-1.5">
              <EvidenceHashRow label="Prompt" value={item.promptHash} />
              <EvidenceHashRow label="Response" value={item.responseHash} />
              <EvidenceHashRow label="Storage" value={item.storageRoot} />
              <EvidenceHashRow label="Proof tx" value={item.proofTxHash} />
            </div>
          </article>
        ))}
      </div>
    </aside>
  );
}

function EvidenceHashRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 rounded-[12px] border border-white/8 bg-black/20 px-2.5 py-1.5">
      <span className="shrink-0 text-[10px] font-medium uppercase tracking-[0.18em] text-slate-500">{label}</span>
      <span className="flex min-w-0 items-center gap-1.5 font-mono text-[11px] tabular-nums text-slate-100">
        <span className="truncate">{shortHash(value)}</span>
        <Copy className="h-3 w-3 shrink-0 text-slate-500" />
      </span>
    </div>
  );
}
