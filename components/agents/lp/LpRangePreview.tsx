"use client";

import { useRef, type PointerEvent as ReactPointerEvent } from "react";

// MOCK — frontend-only price-range preview for the LP create form. Renders a
// horizontal track with the selected price band shaded around the current pool
// price, plus a current-price marker. Bands are expressed as negative/positive
// percent offsets from the current price (e.g. { lower: 5, upper: 12 } = -5% /
// +12%). When `onChange` is provided (custom mode), the band edges become
// draggable handles so the user can drag the range directly on the track. Real
// tick-boundary math arrives with backend wiring; this visual is a mock preview.

const DRAG_MAX_PCT = 100; // fixed drag view = [-100%, +100%] around current price.

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

export function LpRangePreview({
  band,
  onChange,
}: {
  band: { lower: number; upper: number } | null;
  onChange?: (band: { lower: number; upper: number }) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragWhich = useRef<"lower" | "upper" | null>(null);
  const isFull = band === null;
  const draggable = Boolean(onChange) && !isFull;

  const caption = isFull
    ? "Full range"
    : band!.lower === band!.upper
      ? `±${band!.lower}%`
      : `-${band!.lower}% / +${band!.upper}%`;

  // Geometry: drag mode uses a fixed [-maxPct, +maxPct] view; zoom mode (fixed
  // ±N% bands) uses a padded window around the band so even ±5% is visible.
  let viewLeft: number;
  let viewRight: number;
  if (draggable) {
    viewLeft = -DRAG_MAX_PCT;
    viewRight = DRAG_MAX_PCT;
  } else if (isFull) {
    viewLeft = 0;
    viewRight = 100;
  } else {
    const pad = (band!.lower + band!.upper) * 0.25;
    viewLeft = -band!.lower - pad;
    viewRight = band!.upper + pad;
  }
  const viewWidth = Math.max(1, viewRight - viewLeft);

  const bandLeftPct = isFull ? 0 : ((-band!.lower - viewLeft) / viewWidth) * 100;
  const bandRightPct = isFull ? 100 : ((band!.upper - viewLeft) / viewWidth) * 100;
  const currentPct = isFull ? 50 : ((0 - viewLeft) / viewWidth) * 100;

  function onHandleDown(which: "lower" | "upper", e: ReactPointerEvent) {
    e.preventDefault();
    dragWhich.current = which;
    trackRef.current?.setPointerCapture?.(e.pointerId);
  }
  function onPointerMove(e: ReactPointerEvent) {
    if (!dragWhich.current || !trackRef.current || !band || !onChange) return;
    const rect = trackRef.current.getBoundingClientRect();
    const x = clamp(e.clientX - rect.left, 0, rect.width);
    const ratio = x / Math.max(1, rect.width);
    if (dragWhich.current === "lower") {
      const newLower = clamp(DRAG_MAX_PCT - ratio * 2 * DRAG_MAX_PCT, 0.1, DRAG_MAX_PCT);
      onChange({ lower: round1(newLower), upper: band.upper });
    } else {
      const newUpper = clamp(ratio * 2 * DRAG_MAX_PCT - DRAG_MAX_PCT, 0.1, DRAG_MAX_PCT);
      onChange({ lower: band.lower, upper: round1(newUpper) });
    }
  }
  function onPointerUp(e: ReactPointerEvent) {
    dragWhich.current = null;
    trackRef.current?.releasePointerCapture?.(e.pointerId);
  }

  return (
    <div className="rounded-[22px] border border-line bg-panel p-4">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Price range</p>
        <span className="font-mono text-[11px] text-muted">{caption}</span>
      </div>

      <div
        ref={trackRef}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className={`relative mt-4 h-3 rounded-full bg-line ${draggable ? "touch-none select-none" : ""}`}
      >
        {isFull ? (
          <div className="absolute inset-0 rounded-full bg-primary/20" />
        ) : (
          <div
            className="absolute top-0 bottom-0 rounded-full border border-primary/40 bg-primary/30"
            style={{ left: `${bandLeftPct}%`, width: `${Math.max(0, bandRightPct - bandLeftPct)}%` }}
          />
        )}

        {/* Current-price marker. */}
        {!isFull ? (
          <div
            className="pointer-events-none absolute top-1/2 h-5 w-px -translate-y-1/2 bg-amber"
            style={{ left: `${Math.max(0, Math.min(100, currentPct))}%` }}
            title="current price"
          />
        ) : null}

        {/* Drag handles (custom mode only). */}
        {draggable ? (
          <>
            <Handle
              side="lower"
              leftPct={bandLeftPct}
              onPointerDown={(e) => onHandleDown("lower", e)}
            />
            <Handle
              side="upper"
              leftPct={bandRightPct}
              onPointerDown={(e) => onHandleDown("upper", e)}
            />
          </>
        ) : null}
      </div>

      <div className="mt-2 flex justify-between font-mono text-[10px] text-muted">
        {isFull ? (
          <>
            <span>min tick</span>
            <span>full range</span>
            <span>max tick</span>
          </>
        ) : (
          <>
            <span>-{band!.lower}%</span>
            <span>current</span>
            <span>+{band!.upper}%</span>
          </>
        )}
      </div>
      <p className="mt-2 text-xs text-muted">
        MOCK: preview only. Real tick boundaries for the selected band arrive with backend wiring.
      </p>
    </div>
  );
}

function Handle({
  side,
  leftPct,
  onPointerDown,
}: {
  side: "lower" | "upper";
  leftPct: number;
  onPointerDown: (e: ReactPointerEvent) => void;
}) {
  return (
    <button
      type="button"
      onPointerDown={onPointerDown}
      aria-label={side === "lower" ? "Drag lower bound" : "Drag upper bound"}
      className="absolute top-1/2 flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 cursor-grab items-center justify-center rounded-full border border-primary/60 bg-panel-solid-strong text-primary shadow-[0_4px_14px_rgba(0,0,0,0.35)] transition-transform active:cursor-grabbing active:scale-110"
      style={{ left: `${Math.max(0, Math.min(100, leftPct))}%` }}
    >
      <span className="h-3 w-0.5 rounded-full bg-primary/70" />
    </button>
  );
}