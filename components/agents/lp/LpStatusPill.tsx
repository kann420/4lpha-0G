// LP-specific status pill. Fresh small component — do NOT import the local
// StatusPill from OgAgentDetailPage.tsx (it is not exported). Uses the semantic
// status RGB triples from globals.css.
const TONES: Record<string, { rgb: string; label: string }> = {
  armed: { rgb: "var(--status-armed)", label: "Armed" },
  draft: { rgb: "var(--status-info)", label: "Draft" },
  paused: { rgb: "var(--status-paused)", label: "Paused" },
  "coming-soon": { rgb: "var(--status-neutral)", label: "Coming soon" },
};

export function LpStatusPill({
  value,
  label,
  className = "",
}: {
  value: "draft" | "armed" | "paused" | "coming-soon";
  label?: string;
  className?: string;
}) {
  const tone = TONES[value];
  const text = label ?? tone.label;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${className}`}
      style={{
        color: `rgb(${tone.rgb})`,
        borderColor: `rgb(${tone.rgb} / 0.35)`,
        backgroundColor: `rgb(${tone.rgb} / 0.12)`,
      }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: `rgb(${tone.rgb})` }} />
      {text}
    </span>
  );
}