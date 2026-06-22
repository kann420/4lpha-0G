import type { OgNetworkConfig } from "@/lib/types";

export function NetworkBadge({ network }: { network: OgNetworkConfig }) {
  return (
    <div className="rounded-[18px] border border-white/8 bg-white/[0.035] px-3 py-2">
      <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">Network</p>
      <p className="mt-1 text-sm font-semibold text-white">{network.networkName}</p>
      <p className="mt-1 font-mono text-xs text-cyan-100">chain {network.chainId}</p>
    </div>
  );
}
