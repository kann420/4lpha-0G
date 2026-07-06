"use client";

import Image from "next/image";
import { OG_NETWORKS } from "@/lib/og/networks";
import type { OgNetworkId } from "@/lib/types";

type NetworkOption = {
  id: OgNetworkId;
  label: string;
  logo: string;
};

const NETWORK_OPTIONS: NetworkOption[] = [
  { id: "mainnet", label: OG_NETWORKS.mainnet.label, logo: "/0G-Logo-Purple_Hero.svg" },
  { id: "testnet", label: OG_NETWORKS.testnet.label, logo: "/0G-Logo-Purple_Hero.svg" },
];

export function ZeroGNetworkSwitch({
  activeId,
  onChange,
}: {
  activeId: OgNetworkId;
  onChange: (value: OgNetworkId) => void;
}) {
  return (
    <div className="animate-nav-in inline-flex shrink-0 items-center rounded-full border border-line bg-panel p-1">
      {NETWORK_OPTIONS.map((option) => {
        const active = activeId === option.id;
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.id)}
            className={`inline-flex h-10 items-center gap-2 rounded-full px-3 text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 ${
              active
                ? "bg-invert text-invert-ink"
                : "text-muted hover:text-foreground"
            }`}
          >
            <span className="relative h-5 w-5 shrink-0 overflow-hidden">
              <Image
                src={option.logo}
                alt={option.label}
                fill
                sizes="20px"
                className="object-contain"
              />
            </span>
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}