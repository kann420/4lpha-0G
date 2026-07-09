"use client";

import { useState } from "react";

// Shared token avatar for position lists (Trading Agent detail + LP Agent
// detail). Renders a Zia-hosted logo when available; falls back to the
// bundled 0G mark for native/wrapped 0G (Zia's /token logoUrl for those comes
// back as an unresolvable relative path — see getZiaTokenLogoUrl), or an
// initials badge for any other token, when logoUrl is null or the image
// fails to load.

const NATIVE_ZERO_G_SYMBOLS = new Set(["0G", "W0G", "ZG", "ZEROG"]);

// Deterministic background color per symbol so a given token always renders
// the same tint across cards/reloads.
const AVATAR_TONES = ["bg-primary/25 text-primary", "bg-amber/20 text-amber", "bg-green/20 text-green", "bg-rose/20 text-rose"];
function avatarTone(symbol: string): string {
  let hash = 0;
  for (let i = 0; i < symbol.length; i++) hash = (hash * 31 + symbol.charCodeAt(i)) >>> 0;
  return AVATAR_TONES[hash % AVATAR_TONES.length];
}

export function TokenAvatar({
  symbol,
  logoUrl,
  className,
  initials,
}: {
  symbol: string;
  logoUrl?: string | null;
  className?: string;
  // Override the fallback badge text (e.g. a caller-computed 2-letter combo
  // for a "TOKEN0 / TOKEN1" label). Defaults to the first letter of `symbol`
  // (stripping a leading "W" so wrapped tokens like WETH/WBTC read as E/B).
  initials?: string;
}) {
  const [broken, setBroken] = useState(false);
  const size = className ?? "h-6 w-6";
  if (logoUrl && !broken) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- external partner-hosted logo, not a local/optimizable asset
      <img
        src={logoUrl}
        alt={symbol}
        onError={() => setBroken(true)}
        className={`${size} rounded-full border border-line bg-panel-solid-strong object-cover`}
      />
    );
  }
  if (NATIVE_ZERO_G_SYMBOLS.has(symbol.toUpperCase())) {
    return (
      // Plain <img>, not next/image: Next's image optimizer 400s on local SVGs unless
      // images.dangerouslyAllowSVG is set in next.config.ts, which would silently break
      // this icon (empty circle) rather than throw.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src="/0G 500x500.svg"
        alt={symbol}
        className={`${size} rounded-full border border-line bg-panel-solid-strong object-cover`}
      />
    );
  }
  const label = initials || symbol.replace(/^W/, "").slice(0, 1).toUpperCase() || "?";
  return (
    <span className={`flex ${size} items-center justify-center rounded-full border border-line text-[10px] font-semibold ${avatarTone(symbol)}`}>
      {label}
    </span>
  );
}

// Overlapping pair icon (token0 in front, token1 behind), matching the
// Uniswap-style pair badge used for LP positions.
export function TokenPairIcon({
  symbol0,
  logoUrl0,
  symbol1,
  logoUrl1,
}: {
  symbol0: string;
  logoUrl0?: string | null;
  symbol1: string;
  logoUrl1?: string | null;
}) {
  return (
    <div className="relative flex h-6 w-9 shrink-0 items-center" title={`${symbol0}/${symbol1}`}>
      <div className="absolute left-3 z-0">
        <TokenAvatar symbol={symbol1} logoUrl={logoUrl1} />
      </div>
      <div className="absolute left-0 z-10">
        <TokenAvatar symbol={symbol0} logoUrl={logoUrl0} />
      </div>
    </div>
  );
}
