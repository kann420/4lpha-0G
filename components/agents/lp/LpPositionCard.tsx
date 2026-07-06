"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";

import { LpStatusPill } from "@/components/agents/lp/LpStatusPill";
import { findMockPoolByAddress } from "@/lib/agent/lp/mock-lp-data";
import type { MockLpAccounting } from "@/lib/agent/lp/mock-lp-data";
import type { OgAgentVaultLpPosition } from "@/lib/agent/single-agent";

// One LP position card for the detail page center column. Shows the position
// header (status + tokenId + pool + a user-facing USD price range, with raw
// ticks moved into the debug expand) and a 5-cell accounting strip
// (Balance / Assets / Unclaimed fee / Unrealized PnL / APR).
//
// Real agents use per-position accounting populated by readSellableLpPositions
// (NFPM tokensOwed + pool slot0 + Zia pool prices/APR). The mock agent keeps
// mockAccountingFor. When a real field is missing (Zia API down) the cell shows
// "—" rather than a fake number. The card expands to reveal a price-range chart
// that plots the position's tick range within the pool's full tick bounds with a
// current-tick marker.

type CellTone = "success" | "warning" | "danger";

interface Cell {
  label: string;
  value: string;
  subValue?: string;
  tone?: CellTone;
  compact?: boolean;
}

const STABLE_SYMBOLS = new Set(["USDC", "USDT", "DAI", "USDCE", "USDC.E"]);

function formatUSD(value: number): string {
  const abs = Math.abs(value);
  if (abs === 0) return "$0";
  if (abs < 0.01) return `$${value.toFixed(6)}`;
  if (abs < 1) return `$${value.toFixed(4)}`;
  if (abs < 1000) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(0)}`;
}

function formatPct(value: number): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

/// Build the 5-cell accounting strip from the position's real fields when
/// present. Mock accounting is used ONLY for the explicit mock agent
/// (isMockAgent=true); a real agent with missing real fields (Zia API down)
/// renders "—" cells rather than fabricated numbers, so the UI never lies.
function buildCells(position: OgAgentVaultLpPosition, mock: MockLpAccounting, isMockAgent: boolean): Cell[] {
  const hasReal =
    position.valueUSD !== undefined ||
    position.aprStatus !== undefined ||
    position.amount0 !== undefined;
  if (!hasReal) {
    if (!isMockAgent) {
      // Real agent, real data unavailable — show honest placeholders, never
      // mock numbers (a real mainnet tokenId must never render fabricated
      // balance/PnL/APR from the mock table).
      return [
        { label: "Balance", value: "—" },
        { label: "Assets", value: "—" },
        { label: "Unclaimed fee", value: "—" },
        { label: "Unrealized PnL", value: "—" },
        { label: "APR", value: "—" },
      ];
    }
    return [
      { label: "Balance", value: mock.balance.value, subValue: mock.balance.subValue },
      { label: "Assets", value: mock.assets.value, subValue: mock.assets.subValue, compact: true },
      { label: "Unclaimed fee", value: mock.unclaimedFee.value, subValue: mock.unclaimedFee.subValue, tone: "success" },
      {
        label: "Unrealized PnL",
        value: mock.unrealizedPnl.value,
        subValue: mock.unrealizedPnl.subValue,
        tone: mock.unrealizedPnl.tone === "success" ? "success" : mock.unrealizedPnl.tone === "danger" ? "danger" : undefined,
      },
      // Mock APR tone mirrors the real-path rule: success only for staking APR,
      // neutral for trading APR (so the mock render matches real semantics).
      {
        label: "APR",
        value: mock.apr.value,
        subValue: mock.apr.subValue,
        tone: mock.apr.subValue === "staking APR" ? "success" : undefined,
      },
    ];
  }

  const sym0 = position.token0Symbol ?? "";
  const sym1 = position.token1Symbol ?? "";
  const legs = position.amount0 !== undefined && position.amount1 !== undefined
    ? `${position.amount0} ${sym0} · ${position.amount1} ${sym1}`
    : "—";

  // Balance — total USD value, sub the leg breakdown.
  const balanceValue = position.valueUSD !== undefined && position.valueUSD !== null ? formatUSD(position.valueUSD) : "—";

  // Assets — leg amounts + USD-weighted % split.
  let assetsSub = "—";
  const leg0 = position.leg0USD ?? null;
  const leg1 = position.leg1USD ?? null;
  const total = position.valueUSD ?? null;
  if (leg0 !== null && leg1 !== null && total !== null && total > 0) {
    const pct0 = (leg0 / total) * 100;
    const pct1 = (leg1 / total) * 100;
    assetsSub = `${pct0.toFixed(1)}% / ${pct1.toFixed(1)}%`;
  }

  // Unclaimed fee — honest on-chain tokensOwed (may be 0; shown as the real number).
  const feeValue = position.unclaimedFee0 !== undefined && position.unclaimedFee1 !== undefined
    ? `${position.unclaimedFee0} ${sym0} · ${position.unclaimedFee1} ${sym1}`
    : "—";

  // Unrealized PnL — USD, sub ±%.
  const pnlUSD = position.unrealizedPnlUSD ?? null;
  const pnlPct = position.unrealizedPnlPct ?? null;
  const pnlValue = pnlUSD !== null ? `${pnlUSD >= 0 ? "+" : "-"}${formatUSD(Math.abs(pnlUSD))}` : "—";
  const pnlSub = pnlPct !== null ? formatPct(pnlPct) : "—";
  const pnlTone: CellTone | undefined = position.unrealizedPnlTone === "success"
    ? "success"
    : position.unrealizedPnlTone === "danger"
      ? "danger"
      : undefined;

  // APR — staked → staking APR (success tone); !staked → trading APR (muted); unknown → "—".
  const aprPct = position.aprPct ?? null;
  const aprValue = aprPct !== null ? `${aprPct.toFixed(2)}%` : "—";
  const aprSub = position.aprStatus === "staked-earning"
    ? "staking APR"
    : position.aprStatus === "unstaked-trading-only"
      ? "trading APR"
      : "—";
  const aprTone: CellTone | undefined = position.aprStatus === "staked-earning" ? "success" : undefined;

  return [
    { label: "Balance", value: balanceValue, subValue: legs },
    { label: "Assets", value: legs, subValue: assetsSub, compact: true },
    { label: "Unclaimed fee", value: feeValue, subValue: "on-chain", tone: "success" },
    { label: "Unrealized PnL", value: pnlValue, subValue: pnlSub, tone: pnlTone },
    { label: "APR", value: aprValue, subValue: aprSub, tone: aprTone },
  ];
}

export function LpPositionCard({
  position,
  accounting,
  allowStaking,
  isMockAgent,
  pendingAction,
  onStake,
  onUnstake,
  onZapOut,
}: {
  position: OgAgentVaultLpPosition;
  accounting: MockLpAccounting;
  // Vault lpPolicy.allowStaking — gates whether the Stake button renders.
  allowStaking: boolean;
  // Only the explicit mock agent id may render mock accounting numbers; real
  // agents render "—" when real fields are missing.
  isMockAgent: boolean;
  // Which action is currently in-flight for this card ("stake" | "unstake" |
  // "zap-out" | null). Buttons disable + show "…" while pending.
  pendingAction?: "stake" | "unstake" | "zap-out" | null;
  onStake: () => void;
  onUnstake: () => void;
  onZapOut: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const busy = (action: "stake" | "unstake" | "zap-out") => pendingAction === action;
  const cells = buildCells(position, accounting, isMockAgent);

  // User-facing price range (USD) for the non-stable leg; ticks move to debug expand.
  const hasPriceRange = position.priceLowerUSD !== undefined
    && position.priceUpperUSD !== undefined
    && position.priceLowerUSD !== null
    && position.priceUpperUSD !== null;
  const priceRangeLabel = hasPriceRange
    ? `Price range ${formatUSD(position.priceLowerUSD!)} - ${formatUSD(position.priceUpperUSD!)} ${position.priceLabelSymbol ?? ""}`.trim()
    : `ticks [${position.tickLower}, ${position.tickUpper}]`;

  return (
    <section className="rounded-card border border-line bg-panel-solid-strong p-4">
      {/* Position header — 4alpha WorkspaceHeader style. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <LpStatusPill value="armed" label={position.staked ? "Staked · In range" : "In range"} />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground">Position #{position.tokenId}</p>
            <p className="font-mono text-xs text-muted">{position.poolLabel} · {priceRangeLabel}</p>
          </div>
        </div>
        <div className="text-right">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">Deployed</p>
          <p className="font-mono text-sm font-semibold text-foreground">{position.deployedNative0G} 0G</p>
        </div>
      </div>

      {/* 5-cell accounting strip. */}
      <div className="mt-3 grid overflow-hidden rounded-tile border border-line bg-panel md:grid-cols-2 xl:grid-cols-5">
        {cells.map((cell) => (
          <InfoCell key={cell.label} label={cell.label} value={cell.value} subValue={cell.subValue} tone={cell.tone} compact={cell.compact} />
        ))}
      </div>

      {/* Per-position actions. State-disambiguated (B4):
          - staked → Unstake (back to vault-held)
          - !staked && allowStaking → Stake (into the Zia stake vault)
          - !staked → Zap out to 0G (burn + swap + unwrap + native out)
          The per-position "Mint new NFT in this pool" button was removed — mint a
          fresh NFT via the empty-state bootstrap or the worker instead. Pending
          state disables the clicked button to prevent dup clicks. */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {position.staked ? (
          <button
            type="button"
            onClick={onUnstake}
            disabled={busy("unstake")}
            className="inline-flex h-9 items-center gap-2 rounded-full border border-line bg-panel px-4 text-xs font-semibold text-foreground transition-colors hover:border-line-strong disabled:opacity-60"
          >
            {busy("unstake") ? "Unstaking…" : "Unstake"}
          </button>
        ) : (
          <>
            {allowStaking ? (
              <button
                type="button"
                onClick={onStake}
                disabled={busy("stake")}
                className="inline-flex h-9 items-center gap-2 rounded-full border border-line bg-panel px-4 text-xs font-semibold text-foreground transition-colors hover:border-line-strong disabled:opacity-60"
              >
                {busy("stake") ? "Staking…" : "Stake"}
              </button>
            ) : null}
            <button
              type="button"
              onClick={onZapOut}
              disabled={busy("zap-out")}
              className="inline-flex h-9 items-center gap-2 rounded-full border border-line bg-panel px-4 text-xs font-semibold text-foreground transition-colors hover:border-line-strong disabled:opacity-60"
            >
              {busy("zap-out") ? "Zapping out…" : "Zap out to 0G"}
            </button>
          </>
        )}
        {/* Expand toggle for the price-range chart. */}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-full border border-line bg-panel px-3 text-xs font-semibold text-muted transition-colors hover:border-line-strong hover:text-foreground"
        >
          Range
          <ChevronDown className={`h-3.5 w-3.5 transition-transform ${expanded ? "rotate-180" : ""}`} />
        </button>
      </div>

      {/* Expandable price-range chart. Plots the position's [tickLower,
          tickUpper] inside the pool's full tick bounds with a current-tick
          marker. USD bounds are shown when the Zia pool price is available;
          raw ticks are surfaced as a debug line under the chart. */}
      {expanded ? <PositionRangeChart position={position} /> : null}
    </section>
  );
}

function PositionRangeChart({ position }: { position: OgAgentVaultLpPosition }) {
  const pool = findMockPoolByAddress(position.poolAddress);
  // Fall back to a tight window around the position's ticks if the pool isn't found.
  const minTick = pool?.tickBounds.minTick ?? position.tickLower - 10_000;
  const maxTick = pool?.tickBounds.maxTick ?? position.tickUpper + 10_000;
  const currentTick = pool?.tickBounds.currentTick ?? Math.round((position.tickLower + position.tickUpper) / 2);
  const span = Math.max(1, maxTick - minTick);

  const posLeftPct = ((position.tickLower - minTick) / span) * 100;
  const posRightPct = ((position.tickUpper - minTick) / span) * 100;
  const currentPct = ((currentTick - minTick) / span) * 100;

  const hasPriceRange = position.priceLowerUSD !== undefined
    && position.priceUpperUSD !== undefined
    && position.priceLowerUSD !== null
    && position.priceUpperUSD !== null;
  const leftLabel = hasPriceRange ? formatUSD(position.priceLowerUSD!) : "min tick";
  const rightLabel = hasPriceRange ? formatUSD(position.priceUpperUSD!) : "max tick";

  return (
    <div className="mt-3 rounded-tile border border-line bg-panel p-4">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Price range</p>
        <span className="font-mono text-[11px] text-muted">
          ticks [{position.tickLower}, {position.tickUpper}]
        </span>
      </div>
      <div className="relative mt-4 h-3 rounded-full bg-line">
        {/* Position tick range. */}
        <div
          className="absolute top-0 bottom-0 rounded-full border border-primary/40 bg-primary/30"
          style={{ left: `${Math.max(0, posLeftPct)}%`, width: `${Math.max(0, posRightPct - posLeftPct)}%` }}
        />
        {/* Current-tick marker. */}
        <div
          className="pointer-events-none absolute top-1/2 h-5 w-px -translate-y-1/2 bg-amber"
          style={{ left: `${Math.max(0, Math.min(100, currentPct))}%` }}
          title="current tick"
        />
      </div>
      <div className="mt-2 flex justify-between font-mono text-[10px] text-muted">
        <span>{leftLabel}</span>
        <span className="text-amber">current</span>
        <span>{rightLabel}</span>
      </div>
      <p className="mt-2 text-[11px] text-muted">
        {hasPriceRange
          ? `USD range for the ${position.priceLabelSymbol ?? "non-stable"} leg (ticks shown for debugging).`
          : "Position tick range vs the pool's full bounds. USD bounds arrive when the Zia pool price is available."}
      </p>
    </div>
  );
}

// Ported from 4alpha LpPositionInfoStrip InfoCell, restyled to 0G tokens.
function InfoCell({
  label,
  value,
  subValue,
  tone,
  compact,
}: {
  label: string;
  value: string;
  subValue?: string;
  tone?: CellTone;
  compact?: boolean;
}) {
  const valueTone =
    tone === "success"
      ? "text-green"
      : tone === "warning"
        ? "text-amber"
        : tone === "danger"
          ? "text-rose"
          : "text-foreground";
  return (
    <div className="min-h-[4.75rem] min-w-0 border-b border-r border-line bg-panel-solid-strong px-3 py-2 last:border-r-0 xl:border-b-0">
      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">{label}</p>
      <p
        className={`mt-1 truncate font-mono text-sm font-semibold ${valueTone} ${compact ? "text-[12.5px] leading-4" : ""}`}
        title={value}
      >
        {value}
      </p>
      {subValue ? (
        <p className="mt-0.5 truncate font-mono text-xs font-semibold text-muted" title={subValue}>
          {subValue}
        </p>
      ) : null}
    </div>
  );
}
