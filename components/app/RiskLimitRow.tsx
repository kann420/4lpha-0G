export function RiskLimitRow({
  label,
  tone = "ok",
  value,
}: {
  label: string;
  tone?: "ok" | "warning" | "blocked";
  value: string;
}) {
  const toneClass =
    tone === "blocked"
      ? "text-rose-200"
      : tone === "warning"
        ? "text-amber-100"
        : "text-emerald-100";

  return (
    <div className="flex items-center justify-between gap-3 border-b border-white/8 py-2 last:border-b-0">
      <span className="text-sm text-slate-400">{label}</span>
      <span className={`font-mono text-sm ${toneClass}`}>{value}</span>
    </div>
  );
}
