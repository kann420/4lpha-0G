// Shared Zia / TradeGPT badge. Appears on the LP Agents choice card, the LP
// create header, and the LP detail header.
export function ZiaPoweredBadge({ size = "sm", className = "" }: { size?: "sm" | "md"; className?: string }) {
  const sizeClass = size === "md" ? "px-3 py-1.5 text-xs" : "px-2.5 py-1 text-[11px]";
  const logoBoxClass = size === "md" ? "h-5 w-5" : "h-4 w-4";

  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full border border-line-strong bg-panel-strong font-semibold text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] ${sizeClass} ${className}`}
    >
      <span className={`inline-flex ${logoBoxClass} shrink-0 items-center justify-center rounded-full bg-white p-0.5 shadow-[0_0_0_1px_rgba(255,255,255,0.18)]`}>
        <img alt="Zia TradeGPT" className="h-full w-full object-contain" src="/zia.avif" />
      </span>
      <span className="text-muted">powered by</span>
      <span>Zia (TradeGPT)</span>
    </span>
  );
}
