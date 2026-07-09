"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Search, X } from "lucide-react";
import type { ReactNode } from "react";
import { WalletConnectButton } from "@/components/wallet";
import type { OgNetworkConfig, OgNetworkId } from "@/lib/types";
import { ZeroGNetworkSwitch } from "./ZeroGNetworkSwitch";
import { ThemeToggle } from "./ThemeToggle";

const NAV_ITEMS = [
  { href: "/scan", label: "AI Scan" },
  { href: "/agents", label: "Agents" },
  { href: "/chat", label: "Chat" },
  { href: "/fund", label: "Fund" },
] as const;

export function AppShell({
  children,
  network,
  networkId,
  onNetworkChange,
  onQueryChange,
  query,
}: {
  children: ReactNode;
  network: OgNetworkConfig;
  networkId: OgNetworkId;
  onNetworkChange: (value: OgNetworkId) => void;
  onQueryChange?: (value: string) => void;
  query?: string;
}) {
  return (
    <div className="ambient-surface relative flex h-svh w-full max-w-full flex-col overflow-hidden bg-[var(--pulse-bg)] text-foreground">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -left-24 top-20 h-[28rem] w-[28rem] rounded-full bg-primary/15 blur-[140px] animate-drift-slow" />
        <div className="absolute right-[-8rem] top-0 h-[32rem] w-[32rem] rounded-full bg-primary/10 blur-[160px] animate-drift-delayed" />
        <div className="absolute bottom-[-10rem] left-1/3 h-[26rem] w-[26rem] rounded-full bg-primary/8 blur-[160px] animate-drift-slow" />
      </div>

      <div className="relative z-10 flex h-svh min-h-0 w-full max-w-full flex-col overflow-hidden">
        <Header
          network={network}
          networkId={networkId}
          onNetworkChange={onNetworkChange}
          onQueryChange={onQueryChange}
          query={query}
        />
        <div className="relative min-h-0 flex-1 overflow-hidden">{children}</div>
      </div>
    </div>
  );
}

function Header({
  network,
  networkId,
  onNetworkChange,
  onQueryChange,
  query,
}: {
  network: OgNetworkConfig;
  networkId: OgNetworkId;
  onNetworkChange: (value: OgNetworkId) => void;
  onQueryChange?: (value: string) => void;
  query?: string;
}) {
  const showSearch = typeof query === "string" && typeof onQueryChange === "function";

  return (
    <header className="relative z-[100] w-full max-w-full overflow-visible border-b border-line bg-panel-solid-strong/90 backdrop-blur-xl max-lg:rounded-none">
      <div className="flex flex-col gap-2 px-3 py-2.5 lg:gap-3 lg:px-8 lg:py-4">
        <div className="flex items-center justify-between gap-3 lg:grid lg:grid-cols-[auto_auto_minmax(0,1fr)_auto] lg:gap-4">
          <Link
            href="/agents"
            aria-label="Go to Agents"
            className="animate-nav-in flex min-w-0 items-center gap-2 rounded-[18px] transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 lg:min-w-[15rem] lg:gap-3"
            style={{ animationDelay: "80ms" }}
          >
            <Image
              src="/4lpha_logo_180.png"
              alt="4lpha"
              width={64}
              height={64}
              className="h-10 w-10 shrink-0 lg:h-16 lg:w-16"
            />
            <div className="min-w-0">
              <p className="font-heading text-lg font-bold leading-none text-foreground lg:text-xl">
                4lpha AI
              </p>
              <span className="mt-1 hidden rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-primary sm:inline-flex">
                Autonomous Agent
              </span>
            </div>
          </Link>

          <div
            className="flex shrink-0 items-center gap-2 lg:hidden animate-nav-in"
            style={{ animationDelay: "240ms" }}
          >
            <ThemeToggle />
            <WalletConnectButton compact networkId={networkId} />
          </div>

          <div className="hidden items-center gap-2 lg:flex">
            <HeaderNav />
          </div>

          {showSearch ? (
            <div className="hidden min-w-0 xl:flex xl:justify-center">
              <HeaderSearch query={query} onQueryChange={onQueryChange} delayMs={330} />
            </div>
          ) : (
            <div className="hidden xl:block" />
          )}

          <div
            className="hidden items-center justify-end gap-2 lg:flex animate-nav-in"
            style={{ animationDelay: "320ms" }}
          >
            <ThemeToggle />
            <ZeroGNetworkSwitch activeId={networkId} onChange={onNetworkChange} />
            <WalletConnectButton networkId={networkId} />
          </div>
        </div>

        <div className="flex flex-col gap-2 lg:hidden">
          <HeaderNav delayStartMs={220} />

          <div className="scrollbar-subtle flex overflow-x-auto">
            <ZeroGNetworkSwitch activeId={networkId} onChange={onNetworkChange} />
          </div>

          {showSearch ? (
            <HeaderSearch query={query} onQueryChange={onQueryChange} delayMs={330} />
          ) : null}
        </div>

        {showSearch ? (
          <div className="hidden xl:hidden lg:block">
            <HeaderSearch query={query} onQueryChange={onQueryChange} delayMs={330} />
          </div>
        ) : null}
      </div>
    </header>
  );
}

function HeaderNav({ delayStartMs = 150 }: { delayStartMs?: number }) {
  const pathname = usePathname();

  return (
    <nav className="flex min-w-0 items-center gap-1 max-lg:w-full max-lg:rounded-full max-lg:border max-lg:border-line max-lg:bg-panel max-lg:p-1">
      {NAV_ITEMS.map((item, index) => {
        const active =
          (item.href === "/scan" &&
            (pathname === "/scan" || pathname === "/discover")) ||
          (item.href === "/fund" && (pathname === "/fund" || pathname === "/vault")) ||
          pathname === item.href ||
          pathname.startsWith(`${item.href}/`);

        return (
          <Link
            key={item.href}
            href={item.href}
            className={`animate-nav-in min-w-0 rounded-full px-3 py-3 text-base font-semibold transition-colors max-lg:flex-1 max-lg:px-2 max-lg:py-3 max-lg:text-center max-lg:text-sm ${
              active
                ? "bg-primary/10 text-primary"
                : "text-muted hover:bg-panel hover:text-foreground"
            }`}
            style={{ animationDelay: `${delayStartMs + index * 65}ms` }}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

function HeaderSearch({
  delayMs = 220,
  query,
  onQueryChange,
}: {
  delayMs?: number;
  query: string;
  onQueryChange: (value: string) => void;
}) {
  return (
    <label
      className="relative flex h-11 min-w-0 max-w-3xl flex-1 animate-nav-in items-center overflow-hidden rounded-full border border-line bg-panel px-3 text-sm text-muted transition-colors focus-within:border-line-strong focus-within:bg-panel-strong lg:h-auto lg:w-full lg:px-4 lg:py-2.5 lg:text-base"
      style={{ animationDelay: `${delayMs}ms` }}
    >
      <Search className="mr-2 h-4 w-4 shrink-0 text-muted lg:mr-3" />
      <input
        type="search"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder="Search scans, contracts, risk signals"
        className="min-w-0 w-full bg-transparent text-sm text-foreground placeholder:text-muted focus:outline-none lg:text-base"
      />
      {query ? (
        <button
          type="button"
          onClick={() => onQueryChange("")}
          className="ml-3 flex h-7 w-7 items-center justify-center rounded-full bg-panel-strong text-muted transition-colors hover:bg-primary/15 hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : (
        <kbd className="ml-3 hidden rounded-full border border-line bg-panel-strong px-2 py-1 font-mono text-xs uppercase tracking-[0.18em] text-muted sm:inline-flex">
          /
        </kbd>
      )}
    </label>
  );
}
