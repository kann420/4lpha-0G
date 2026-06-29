"use client";

import Image from "next/image";
import { OG_NETWORKS } from "@/lib/og/networks";
import type { OgNetworkId } from "@/lib/types";

export function ZeroGNetworkSwitch({
  activeId,
  onChange,
}: {
  activeId: OgNetworkId;
  onChange: (value: OgNetworkId) => void;
}) {
  const network = OG_NETWORKS.mainnet;
  const active = activeId === "mainnet";

  return (
    <div className="animate-nav-in inline-flex shrink-0 items-center rounded-full border border-line bg-panel p-1">
      <button
        type="button"
        aria-pressed={active}
        onClick={() => onChange("mainnet")}
        className="inline-flex h-10 items-center gap-2 rounded-full bg-invert px-3 text-sm font-semibold text-invert-ink transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
      >
        <span className="relative h-5 w-5 shrink-0 overflow-hidden">
          <Image
            src="/0G-Logo-Purple_Hero.svg"
            alt={network.label}
            fill
            sizes="20px"
            className="object-contain"
          />
        </span>
        <span>{network.label}</span>
      </button>
    </div>
  );
}
