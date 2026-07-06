"use client";

import { useEffect, useRef, useState } from "react";
import { BrainCircuit, Check, ChevronDown } from "lucide-react";

import type { CopilotModelOption } from "@/lib/types";

export type OgModelCatalogState = {
  defaultModel?: string;
  error?: string;
  models: CopilotModelOption[];
  status: "idle" | "loading" | "ready" | "error";
};

export const EMPTY_OG_MODEL_CATALOG: OgModelCatalogState = {
  models: [],
  status: "idle",
};

export function shortModelLabel(modelId: string): string {
  if (modelId.length <= 34) {
    return modelId;
  }

  return `${modelId.slice(0, 16)}...${modelId.slice(-14)}`;
}

export function OgModelSelector({
  ariaLabel = "LLM model",
  catalog,
  className = "relative flex min-w-0 max-w-[220px] flex-1 items-center",
  menuClassName = "absolute right-0 top-full z-50 mt-1.5 max-h-[300px] w-64 overflow-y-auto rounded-[14px] border border-line bg-panel-solid-strong p-1 shadow-[0_18px_52px_rgba(0,0,0,0.55)] scrollbar-subtle",
  onChange,
  onOpenChange,
  selectedModel,
  triggerClassName,
}: {
  ariaLabel?: string;
  catalog: OgModelCatalogState;
  className?: string;
  menuClassName?: string;
  onChange: (model: string) => void;
  onOpenChange?: (open: boolean) => void;
  selectedModel: string;
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const disabled = catalog.status === "loading";

  const selectedOption = catalog.models.find((model) => model.id === selectedModel);
  const triggerLabel = selectedModel
    ? (selectedOption?.label ?? shortModelLabel(selectedModel))
    : catalog.defaultModel
      ? `Auto · ${shortModelLabel(catalog.defaultModel)}`
      : catalog.status === "error"
        ? "Models unavailable"
        : "Auto Router";
  const hasError = catalog.status === "error";

  function setSelectorOpen(nextOpen: boolean) {
    setOpen(nextOpen);
    onOpenChange?.(nextOpen);
  }

  useEffect(() => {
    if (!open) {
      return;
    }
    function handleClick(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setSelectorOpen(false);
      }
    }
    function handleKey(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        setSelectorOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  return (
    <div ref={ref} className={className}>
      <button
        type="button"
        onClick={() => setSelectorOpen(!open)}
        disabled={disabled}
        title={hasError ? catalog.error ?? "Model catalog unavailable" : ariaLabel}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={
          triggerClassName ??
          `inline-flex h-8 w-full items-center gap-1.5 rounded-[10px] border px-2.5 text-xs font-semibold transition-[background-color,border-color,color,transform] active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50 ${
            hasError
              ? "border-amber/30 bg-amber/10 text-amber hover:bg-amber/20"
              : "border-line bg-panel-solid-strong text-foreground hover:border-line-strong"
          }`
        }
      >
        <BrainCircuit className={`h-3.5 w-3.5 shrink-0 ${hasError ? "text-amber" : "text-primary"}`} />
        <span className="min-w-0 flex-1 truncate">{triggerLabel}</span>
        <ChevronDown
          className={`h-3 w-3 shrink-0 opacity-60 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open ? (
        <div role="listbox" className={menuClassName}>
          <button
            type="button"
            role="option"
            aria-selected={!selectedModel}
            onClick={() => {
              onChange("");
              setSelectorOpen(false);
            }}
            className={`flex w-full items-center gap-2 rounded-[10px] px-2.5 py-2 text-left text-xs transition-colors hover:bg-panel ${
              !selectedModel ? "bg-panel/60 text-foreground" : "text-muted"
            }`}
          >
            <BrainCircuit className="h-3.5 w-3.5 shrink-0 text-primary" />
            <span className="min-w-0 flex-1 truncate">
              {catalog.defaultModel ? `Auto · ${shortModelLabel(catalog.defaultModel)}` : "Auto Router model"}
            </span>
            {!selectedModel ? <Check className="h-3 w-3 shrink-0 text-primary" /> : null}
          </button>
          {catalog.models.length > 0 ? <div className="mx-2 my-1 border-t border-line" /> : null}
          {catalog.models.map((model) => {
            const active = model.id === selectedModel;
            return (
              <button
                key={model.id}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => {
                  onChange(model.id);
                  setSelectorOpen(false);
                }}
                className={`flex w-full items-center gap-2 rounded-[10px] px-2.5 py-2 text-left text-xs transition-colors hover:bg-panel ${
                  active ? "bg-panel/60 text-foreground" : "text-muted"
                }`}
              >
                <span className="min-w-0 flex-1 truncate" title={model.label}>
                  {model.label}
                </span>
                {active ? <Check className="h-3 w-3 shrink-0 text-primary" /> : null}
              </button>
            );
          })}
          {catalog.models.length === 0 && hasError ? (
            <p className="px-2.5 py-2 text-[11px] leading-4 text-rose">{catalog.error ?? "Model catalog unavailable."}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
