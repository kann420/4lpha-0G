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
  return (
    <div className="animate-nav-in inline-flex shrink-0 items-center gap-1 rounded-full border border-white/8 bg-white/[0.035] p-1">
      {(Object.keys(OG_NETWORKS) as OgNetworkId[]).map((id) => {
        const network = OG_NETWORKS[id];
        const active = id === activeId;

        return (
          <button
            key={id}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(id)}
            className={`inline-flex h-10 items-center gap-2 rounded-full px-3 text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/50 ${
              active
                ? "bg-white text-[#071015]"
                : "text-slate-300 hover:bg-white/[0.08] hover:text-white"
            }`}
          >
            <span className="relative h-5 w-5 shrink-0 overflow-hidden">
              <Image
                src={id === "testnet" ? "/0g_black_logo.svg" : "/0G-Logo-Purple_Hero.svg"}
                alt={network.label}
                fill
                sizes="20px"
                className="object-contain"
              />
            </span>
            <span>{network.label}</span>
          </button>
        );
      })}
    </div>
  );
}
