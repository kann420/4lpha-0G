import type { OgNetworkConfig } from "@/lib/types";

export function NetworkBadge({ network }: { network: OgNetworkConfig }) {
  return (
    <div className="rounded-[18px] border border-line bg-panel px-3 py-2">
      <p className="text-[11px] uppercase tracking-[0.18em] text-muted">Network</p>
      <p className="mt-1 text-sm font-semibold text-foreground">{network.networkName}</p>
      <p className="mt-1 font-mono text-xs text-primary">chain {network.chainId}</p>
    </div>
  );
}
