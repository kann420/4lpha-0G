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
      ? "text-rose"
      : tone === "warning"
        ? "text-amber"
        : "text-green";

  return (
    <div className="flex items-center justify-between gap-3 border-b border-line py-2 last:border-b-0">
      <span className="text-sm text-muted">{label}</span>
      <span className={`font-mono text-sm ${toneClass}`}>{value}</span>
    </div>
  );
}
