"use client";

import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  SIGMA_ANIMATIONS,
  SIGMA_ATLAS_COLUMNS,
  SIGMA_ATLAS_ROWS,
  SIGMA_PET_GREETING,
  SIGMA_PET_STATE_EVENT,
  SIGMA_POSITION_STORAGE_KEY,
  type SigmaPetAnimationState,
  type SigmaPetStateDetail,
} from "@/lib/copilot/sigma-pet";

export { SIGMA_PET_GREETING, SIGMA_PET_STATE_EVENT } from "@/lib/copilot/sigma-pet";

export function SigmaPet() {
  const petSize = 82;
  const dragRef = useRef<{ offsetX: number; offsetY: number; pointerId: number } | null>(null);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [ready, setReady] = useState(false);
  const [greetingDismissed, setGreetingDismissed] = useState(false);
  const [runtime, setRuntime] = useState<SigmaPetStateDetail>({
    bubbleText: SIGMA_PET_GREETING,
    state: "waving",
  });
  const bubbleOnRight = position.x < 280;
  const isGreetingBubble = runtime.bubbleText === SIGMA_PET_GREETING;
  const showBubble = Boolean(runtime.bubbleText) && !(isGreetingBubble && greetingDismissed);

  useEffect(() => {
    function syncPosition() {
      const stored = readStoredPosition();
      const fallback = {
        x: window.innerWidth - petSize - 32,
        y: Math.max(84, Math.round(window.innerHeight * 0.18)),
      };
      setPosition(clampSigmaPosition(stored ?? fallback, petSize));
      setReady(true);
    }

    const timeout = window.setTimeout(syncPosition, 0);
    window.addEventListener("resize", syncPosition);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener("resize", syncPosition);
    };
  }, []);

  useEffect(() => {
    function handleState(event: Event) {
      const detail = (event as CustomEvent<SigmaPetStateDetail>).detail;
      if (!detail?.state || !(detail.state in SIGMA_ANIMATIONS)) return;
      setRuntime({
        bubbleText: detail.bubbleText,
        state: detail.state,
      });
    }

    window.addEventListener(SIGMA_PET_STATE_EVENT, handleState);
    return () => window.removeEventListener(SIGMA_PET_STATE_EVENT, handleState);
  }, []);

  function handlePointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
    dragRef.current = {
      offsetX: event.clientX - position.x,
      offsetY: event.clientY - position.y,
      pointerId: event.pointerId,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag) return;

    setPosition(
      clampSigmaPosition(
        {
          x: event.clientX - drag.offsetX,
          y: event.clientY - drag.offsetY,
        },
        petSize,
      ),
    );
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
    storePosition(position);
  }

  return (
    <div
      className="group pointer-events-none fixed left-0 top-0 z-[80] hidden md:block"
      style={{
        opacity: ready ? 1 : 0,
        transform: `translate3d(${position.x}px, ${position.y}px, 0)`,
      }}
    >
      {showBubble ? (
        <div
          className={`pointer-events-none absolute top-1 w-[min(270px,32vw)] rounded-[18px] border border-white/12 bg-[#0d141a]/95 px-3 py-2 text-sm leading-5 text-slate-100 shadow-[0_16px_42px_rgba(0,0,0,0.42)] backdrop-blur ${
            bubbleOnRight ? "left-[76px]" : "right-[76px]"
          } ${isGreetingBubble ? "group-hover:hidden" : ""}`}
        >
          <p className="line-clamp-3">{runtime.bubbleText}</p>
        </div>
      ) : null}
      <button
        aria-label="Move SIGMA pet"
        className="pointer-events-auto touch-none cursor-grab rounded-[18px] p-1 outline-none transition-transform duration-150 active:cursor-grabbing active:scale-[0.96] focus-visible:ring-2 focus-visible:ring-cyan-300/60"
        type="button"
        onFocus={() => {
          if (isGreetingBubble) setGreetingDismissed(true);
        }}
        onMouseEnter={() => {
          if (isGreetingBubble) setGreetingDismissed(true);
        }}
        onPointerCancel={handlePointerUp}
        onPointerDown={handlePointerDown}
        onPointerEnter={() => {
          if (isGreetingBubble) setGreetingDismissed(true);
        }}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        <SigmaSprite size={petSize} state={runtime.state} />
      </button>
    </div>
  );
}

function SigmaSprite({
  className = "",
  size,
  state,
}: {
  className?: string;
  size: number;
  state: SigmaPetAnimationState;
}) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const animation = SIGMA_ANIMATIONS[state];
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (prefersReducedMotion || animation.frames <= 1) return;

    const interval = window.setInterval(() => {
      setFrame((current) => (current + 1) % animation.frames);
    }, animation.intervalMs);

    return () => window.clearInterval(interval);
  }, [animation.frames, animation.intervalMs, prefersReducedMotion]);

  const safeFrame = frame % animation.frames;
  const x = (safeFrame / (SIGMA_ATLAS_COLUMNS - 1)) * 100;
  const y = (animation.row / (SIGMA_ATLAS_ROWS - 1)) * 100;

  return (
    <span
      aria-label="SIGMA"
      className={`block bg-no-repeat ${className}`}
      role="img"
      style={{
        aspectRatio: "192 / 208",
        backgroundImage: "url('/pets/sigma/spritesheet.webp')",
        backgroundPosition: `${x}% ${y}%`,
        backgroundSize: `${SIGMA_ATLAS_COLUMNS * 100}% ${SIGMA_ATLAS_ROWS * 100}%`,
        imageRendering: "pixelated",
        width: size,
      }}
    />
  );
}

function usePrefersReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const timeout = window.setTimeout(() => {
      setPrefersReducedMotion(mediaQuery.matches);
    }, 0);

    function handleChange(event: MediaQueryListEvent) {
      setPrefersReducedMotion(event.matches);
    }

    mediaQuery.addEventListener("change", handleChange);
    return () => {
      window.clearTimeout(timeout);
      mediaQuery.removeEventListener("change", handleChange);
    };
  }, []);

  return prefersReducedMotion;
}

function clampSigmaPosition(
  position: { x: number; y: number },
  size: number,
): { x: number; y: number } {
  return {
    x: Math.min(Math.max(8, position.x), Math.max(8, window.innerWidth - size - 8)),
    y: Math.min(Math.max(8, position.y), Math.max(8, window.innerHeight - size - 8)),
  };
}

function readStoredPosition(): { x: number; y: number } | null {
  const raw = window.localStorage.getItem(SIGMA_POSITION_STORAGE_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<{ x: unknown; y: unknown }>;
    if (typeof parsed.x !== "number" || typeof parsed.y !== "number") return null;
    return { x: parsed.x, y: parsed.y };
  } catch {
    return null;
  }
}

function storePosition(position: { x: number; y: number }) {
  window.localStorage.setItem(SIGMA_POSITION_STORAGE_KEY, JSON.stringify(position));
}
