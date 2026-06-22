"use client";

import { useCallback, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Database,
  FileCheck2,
  Loader2,
  Play,
  RefreshCcw,
  ShieldCheck,
} from "lucide-react";
import { AGENT_TRADE_ROUTES } from "@/lib/agent/trade-catalog";
import type {
  AgentTradePreview,
  AgentTradeResponse,
  AgentTradeRouteOption,
  AgentTradeSide,
  OgNetworkId,
} from "@/lib/types";

export function AgentRouteTradePanel({
  networkId,
  networkLabel,
  onPreviewChange,
}: {
  networkId: OgNetworkId;
  networkLabel: string;
  onPreviewChange?: (preview: AgentTradePreview | null) => void;
}) {
  return (
    <AgentRouteTradePanelBody
      key={networkId}
      networkId={networkId}
      networkLabel={networkLabel}
      onPreviewChange={onPreviewChange}
    />
  );
}

function AgentRouteTradePanelBody({
  networkId,
  networkLabel,
  onPreviewChange,
}: {
  networkId: OgNetworkId;
  networkLabel: string;
  onPreviewChange?: (preview: AgentTradePreview | null) => void;
}) {
  const networkRoutes = useMemo(
    () => AGENT_TRADE_ROUTES.filter((route) => route.networkId === networkId),
    [networkId],
  );
  const firstRoute = networkRoutes[0];
  const [selectedRouteId, setSelectedRouteId] = useState(firstRoute?.id ?? "");
  const selectedRoute = networkRoutes.find((route) => route.id === selectedRouteId) ?? networkRoutes[0];
  const [amountIn, setAmountIn] = useState(firstRoute?.defaultAmountIn ?? "0.05");
  const [side, setSide] = useState<AgentTradeSide>(firstRoute?.defaultSide ?? "buy");
  const [slippageBps, setSlippageBps] = useState(75);
  const [operatorKey, setOperatorKey] = useState("");
  const [preview, setPreview] = useState<AgentTradePreview | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isExecuting, setIsExecuting] = useState(false);
  const [statusText, setStatusText] = useState(
    firstRoute ? "Route selected. Refresh quote to preview proof bundle." : "No routes for this network.",
  );

  const clearPreview = useCallback(() => {
    setPreview(null);
    onPreviewChange?.(null);
  }, [onPreviewChange]);

  const handleRouteChange = useCallback(
    (routeId: string) => {
      const nextRoute = networkRoutes.find((route) => route.id === routeId) ?? networkRoutes[0];
      setSelectedRouteId(nextRoute?.id ?? "");
      setAmountIn(nextRoute?.defaultAmountIn ?? "0.05");
      setSide(nextRoute?.defaultSide ?? "buy");
      clearPreview();
      setStatusText(nextRoute ? "Route selected. Refresh quote to preview proof bundle." : "No routes for this network.");
    },
    [clearPreview, networkRoutes],
  );

  const requestTrade = useCallback(
    async (intent: "preview" | "execute") => {
      if (!selectedRoute) {
        return;
      }

      if (intent === "preview") {
        setIsPreviewing(true);
        setStatusText("Fetching server route quote.");
      } else {
        setIsExecuting(true);
        setStatusText("Sending trade request to server executor route.");
      }

      try {
        const response = await fetch("/api/agent/trade", {
          body: JSON.stringify({
            agentId: selectedRoute.agentId,
            amountIn,
            auditId: selectedRoute.auditId,
            intent,
            networkId,
            routeId: selectedRoute.id,
            side,
            slippageBps,
            ...(intent === "execute" && networkId === "mainnet" ? { operatorKey } : {}),
          }),
          headers: {
            "Content-Type": "application/json",
          },
          method: "POST",
        });
        const payload = (await response.json()) as AgentTradeResponse;

        if (!payload.data) {
          throw new Error(payload.error?.message ?? "Agent trade route failed.");
        }

        setPreview(payload.data.preview);
        onPreviewChange?.(payload.data.preview);

        if (intent === "execute" && payload.data.execution) {
          const execution = payload.data.execution;
          setStatusText(
            execution.status === "blocked"
              ? execution.reason ?? "Trade blocked by server policy."
              : execution.reason ?? "Trade request accepted by server route.",
          );
        } else {
          setStatusText(
            payload.data.preview.proofBundle.policyDecision === "allow"
              ? "Quote and proof bundle ready."
              : "Quote preview requires review before execution.",
          );
        }
      } catch (error) {
        setPreview(null);
        onPreviewChange?.(null);
        setStatusText(error instanceof Error ? error.message : "Agent trade route failed.");
      } finally {
        setIsPreviewing(false);
        setIsExecuting(false);
      }
    },
    [amountIn, networkId, onPreviewChange, operatorKey, selectedRoute, side, slippageBps],
  );

  const canExecute =
    preview?.proofBundle.policyDecision === "allow" &&
    !isPreviewing &&
    !isExecuting &&
    (networkId !== "mainnet" || operatorKey.trim().length > 0);

  return (
    <section className="rounded-[24px] border border-white/8 bg-[linear-gradient(180deg,rgba(12,17,24,0.96),rgba(7,10,15,0.88))] p-4 shadow-[0_22px_72px_rgba(0,0,0,0.22)] lg:rounded-[30px] lg:p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-full border border-cyan-300/16 bg-cyan-300/10 text-cyan-100">
              <Play className="h-4 w-4" />
            </span>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-slate-500">Agent executor</p>
              <h2 className="text-xl font-semibold text-white">Route trade preview</h2>
            </div>
          </div>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-400">
            Server route stages quote, policy hash, and audit proof data before any vault executor action.
          </p>
        </div>
        <span className="shrink-0 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold text-slate-300">
          {networkLabel}
        </span>
      </div>

      <div className="mt-5 grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(20rem,0.9fr)]">
        <div className="grid gap-3">
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_9rem]">
            <label className="grid gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-500">Route</span>
              <select
                value={selectedRoute?.id ?? ""}
                onChange={(event) => handleRouteChange(event.target.value)}
                className="h-11 min-w-0 rounded-full border border-white/10 bg-[#0d151c] px-4 text-sm font-semibold text-white outline-none transition-colors focus:border-cyan-200/35"
              >
                {networkRoutes.map((route) => (
                  <option key={route.id} value={route.id} className="bg-[#0d151c] text-white">
                    {route.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="grid gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-500">Amount</span>
              <input
                value={amountIn}
                onChange={(event) => {
                  setAmountIn(event.target.value);
                  clearPreview();
                }}
                inputMode="decimal"
                autoComplete="off"
                className="h-11 min-w-0 rounded-full border border-white/10 bg-white/[0.04] px-4 font-mono text-sm font-semibold text-white outline-none transition-colors placeholder:text-slate-600 focus:border-cyan-200/35"
                placeholder="0.05"
              />
            </label>
          </div>

          <div className="grid gap-3 md:grid-cols-[auto_minmax(0,1fr)_auto] md:items-end">
            <div className="grid gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-500">Side</span>
              <div className="inline-flex rounded-full border border-white/8 bg-white/[0.04] p-1">
                {(["buy", "sell"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={side === value}
                    onClick={() => {
                      setSide(value);
                      clearPreview();
                    }}
                    className={`h-9 rounded-full px-4 text-sm font-semibold capitalize transition-colors ${
                      side === value ? "bg-cyan-300/14 text-cyan-100" : "text-slate-400 hover:text-white"
                    }`}
                  >
                    {value}
                  </button>
                ))}
              </div>
            </div>

            <label className="grid gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-500">Slippage bps</span>
              <input
                value={slippageBps}
                onChange={(event) => {
                  setSlippageBps(Number.parseInt(event.target.value || "0", 10));
                  clearPreview();
                }}
                min={1}
                max={500}
                type="number"
                className="h-11 min-w-0 rounded-full border border-white/10 bg-white/[0.04] px-4 font-mono text-sm font-semibold text-white outline-none transition-colors focus:border-cyan-200/35"
              />
            </label>

            {networkId === "mainnet" ? (
              <label className="grid gap-2 md:col-span-3">
                <span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-500">
                  Operator key
                </span>
                <input
                  value={operatorKey}
                  onChange={(event) => setOperatorKey(event.target.value)}
                  type="password"
                  autoComplete="off"
                  className="h-11 min-w-0 rounded-full border border-white/10 bg-white/[0.04] px-4 font-mono text-sm font-semibold text-white outline-none transition-colors placeholder:text-slate-600 focus:border-cyan-200/35"
                  placeholder="Required only for live execute"
                />
              </label>
            ) : null}

            <div className="flex flex-wrap items-center gap-2 md:justify-end">
              <button
                type="button"
                onClick={() => void requestTrade("preview")}
                disabled={!selectedRoute || isPreviewing || isExecuting}
                className="inline-flex h-11 items-center justify-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 text-sm font-semibold text-slate-100 transition-colors hover:bg-white/[0.07] disabled:cursor-not-allowed disabled:opacity-45"
              >
                {isPreviewing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
                Quote
              </button>
              <button
                type="button"
                onClick={() => void requestTrade("execute")}
                disabled={!canExecute}
                className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-[var(--pulse-teal)] px-4 text-sm font-semibold text-[#041015] transition-[filter,transform] hover:brightness-105 active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-45"
              >
                {isExecuting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
                Trigger trade
              </button>
            </div>
          </div>

          <div className="rounded-[18px] border border-white/8 bg-black/18 px-3 py-2.5">
            <div className="flex items-center gap-2">
              {preview?.proofBundle.policyDecision === "allow" ? (
                <ShieldCheck className="h-4 w-4 text-emerald-300" />
              ) : (
                <AlertTriangle className="h-4 w-4 text-amber-200" />
              )}
              <p className="text-sm leading-6 text-slate-300">{statusText}</p>
            </div>
          </div>
        </div>

        <RouteProofPreview preview={preview} route={selectedRoute} />
      </div>
    </section>
  );
}

function RouteProofPreview({
  preview,
  route,
}: {
  preview: AgentTradePreview | null;
  route: AgentTradeRouteOption | undefined;
}) {
  const decision = preview?.proofBundle.policyDecision ?? route?.readiness ?? "review";
  const decisionClass =
    decision === "allow" || decision === "ready"
      ? "border-emerald-300/20 bg-emerald-300/10 text-emerald-100"
      : decision === "reject" || decision === "blocked"
        ? "border-rose-300/20 bg-rose-300/10 text-rose-100"
        : "border-amber-300/20 bg-amber-300/10 text-amber-100";

  return (
    <aside className="grid gap-3 rounded-[22px] border border-white/8 bg-white/[0.03] p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-500">Quote and proof</p>
          <h3 className="mt-1 text-base font-semibold text-white">{preview?.quote.routeLabel ?? route?.label ?? "No route"}</h3>
        </div>
        <span className={`shrink-0 rounded-full border px-2.5 py-1 text-xs font-semibold capitalize ${decisionClass}`}>
          {String(decision)}
        </span>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <ProofMetric
          icon={<ArrowRight className="h-3.5 w-3.5" />}
          label="Expected out"
          value={
            preview
              ? `${preview.quote.expectedAmountOut} ${preview.quote.outputToken}`
              : route
                ? `-- ${route.outputToken}`
                : "--"
          }
        />
        <ProofMetric
          icon={<ShieldCheck className="h-3.5 w-3.5" />}
          label="Min out"
          value={preview ? `${preview.quote.amountOutMin} ${preview.quote.outputToken}` : "--"}
        />
        <ProofMetric
          icon={<Database className="h-3.5 w-3.5" />}
          label="Storage root"
          value={preview?.proofBundle.storageRoot ?? "--"}
        />
        <ProofMetric
          icon={<FileCheck2 className="h-3.5 w-3.5" />}
          label="Policy hash"
          value={preview?.proofBundle.policyDecisionHash ?? "--"}
        />
      </div>

      <div className="grid gap-2 border-t border-white/8 pt-3">
        <HashLine label="Route hash" value={preview?.quote.routeHash ?? "--"} />
        <HashLine label="Quote hash" value={preview?.quote.quoteHash ?? "--"} />
        <HashLine label="Proof tx" value={preview?.proofBundle.proofTxHash ?? "pending"} />
      </div>
    </aside>
  );
}

function ProofMetric({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-[16px] border border-white/8 bg-black/20 px-3 py-2">
      <div className="flex items-center gap-1.5 text-slate-500">
        {icon}
        <span className="text-[10px] uppercase tracking-[0.18em]">{label}</span>
      </div>
      <p className="mt-1 truncate font-mono text-xs font-semibold text-slate-100" title={value}>
        {shortHash(value)}
      </p>
    </div>
  );
}

function HashLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 rounded-[14px] bg-black/18 px-3 py-2">
      <span className="text-xs text-slate-500">{label}</span>
      <span className="min-w-0 truncate text-right font-mono text-xs font-semibold text-slate-200" title={value}>
        {shortHash(value)}
      </span>
    </div>
  );
}

function shortHash(value: string): string {
  if (!value.startsWith("0x") || value.length <= 14) {
    return value;
  }
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}
