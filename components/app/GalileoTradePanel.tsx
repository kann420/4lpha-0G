"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowRight, CheckCircle2, Database, FileCheck2, Loader2, RefreshCcw, ShieldCheck, Wallet } from "lucide-react";
import { useAccount, useSignMessage } from "wagmi";

import { GALILEO_CHAIN_ID } from "@/lib/galileo/constants";
import { GALILEO_AGENT_TRADE_ROUTE } from "@/lib/galileo/trade-route";
import { dispatchSigmaPetReaction } from "@/lib/copilot/sigma-pet";
import type {
  AgentTradeExecution,
  AgentTradePreview,
  AgentTradeResponse,
  AgentTradeSide,
  GalileoAgentRosterResponse,
  GalileoPublicAgentRecord,
  GalileoTradeConsentIssue,
  GalileoTradeConsentSubmission,
} from "@/lib/types";

const GALILEO_EXPLORER_ORIGIN = "https://chainscan-galileo.0g.ai";
const ALLOWED_STORAGE_ORIGINS = new Set([
  "https://indexer-storage-turbo.0g.ai",
  "https://indexer-storage-testnet-turbo.0g.ai",
]);

export function GalileoTradePanel({
  networkLabel,
  onPreviewChange,
}: {
  networkLabel: string;
  onPreviewChange?: (preview: AgentTradePreview | null) => void;
}) {
  const account = useAccount();
  const signMessage = useSignMessage();
  const [agents, setAgents] = useState<GalileoPublicAgentRecord[]>([]);
  const [selectedAgentRef, setSelectedAgentRef] = useState("");
  const [amountIn, setAmountIn] = useState(GALILEO_AGENT_TRADE_ROUTE.defaultAmountIn);
  const [side, setSide] = useState<AgentTradeSide>(GALILEO_AGENT_TRADE_ROUTE.defaultSide);
  const [slippageBps, setSlippageBps] = useState(75);
  const [preview, setPreview] = useState<AgentTradePreview | null>(null);
  const [execution, setExecution] = useState<AgentTradeExecution | null>(null);
  const [consent, setConsent] = useState<GalileoTradeConsentSubmission | null>(null);
  const [clientRequestId, setClientRequestId] = useState(newClientRequestId);
  const [isLoadingAgents, setIsLoadingAgents] = useState(false);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isPreparingConsent, setIsPreparingConsent] = useState(false);
  const [isExecuting, setIsExecuting] = useState(false);
  const [status, setStatus] = useState("Connect the Galileo owner wallet to load its verified local agents.");

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.agentRef === selectedAgentRef) ?? agents[0],
    [agents, selectedAgentRef],
  );
  const slippageError = !Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > 100
    ? "Enter slippage between 1 and 100 bps."
    : null;

  const clearDerivedState = useCallback(() => {
    setPreview(null);
    setExecution(null);
    setConsent(null);
    setClientRequestId(newClientRequestId());
    onPreviewChange?.(null);
  }, [onPreviewChange]);

  const loadAgents = useCallback(async () => {
    if (!account.address) {
      setAgents([]);
      setSelectedAgentRef("");
      return;
    }
    setIsLoadingAgents(true);
    try {
      const query = new URLSearchParams({ networkId: "testnet", ownerAddress: account.address });
      const response = await fetch(`/api/agents?${query.toString()}`, { cache: "no-store" });
      const payload = await response.json() as GalileoAgentRosterResponse;
      if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? "Galileo agent roster is unavailable.");
      setAgents(payload.data.agents);
      setSelectedAgentRef((current) => payload.data?.agents.some((agent) => agent.agentRef === current) ? current : (payload.data?.agents[0]?.agentRef ?? ""));
      setStatus(payload.data.agents.length ? "Select an armed Galileo agent, then request a live sandbox quote." : "No Storage-verified Galileo agent is available for this wallet.");
    } catch (error) {
      setAgents([]);
      setSelectedAgentRef("");
      setStatus(error instanceof Error ? error.message : "Galileo agent roster is unavailable.");
    } finally {
      setIsLoadingAgents(false);
    }
  }, [account.address]);

  useEffect(() => { void loadAgents(); }, [loadAgents]);

  const requestTrade = useCallback(async (intent: "preview" | "execute", signedConsent?: GalileoTradeConsentSubmission) => {
    if (!account.address || !selectedAgent) {
      setStatus("Connect the Galileo owner wallet and select a verified local agent first.");
      return;
    }
    if (slippageError) {
      setStatus(slippageError);
      return;
    }
    if (intent === "preview") {
      setIsPreviewing(true);
      setStatus("Reading the live Galileo sandbox quote and V4 policy state.");
      dispatchSigmaPetReaction("trade.quote.start", { force: true });
    } else {
      setIsExecuting(true);
      setStatus("Submitting the exactly-consented Galileo sandbox trade.");
      dispatchSigmaPetReaction("trade.execute.start", { force: true });
    }
    try {
      const response = await fetch("/api/agent/trade", {
        body: JSON.stringify({
          agentId: selectedAgent.agentRef,
          amountIn,
          auditId: GALILEO_AGENT_TRADE_ROUTE.auditId,
          chainId: GALILEO_CHAIN_ID,
          clientRequestId,
          ...(signedConsent ? { galileoConsent: signedConsent } : {}),
          intent,
          networkId: "testnet",
          ownerAddress: account.address,
          routeId: GALILEO_AGENT_TRADE_ROUTE.id,
          side,
          slippageBps,
          vaultAddress: selectedAgent.vault,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json() as AgentTradeResponse;
      if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? "Galileo trade request failed.");
      setPreview(payload.data.preview);
      onPreviewChange?.(payload.data.preview);
      if (intent === "execute" && payload.data.execution) {
        setExecution(payload.data.execution);
        setConsent(null);
        setStatus(payload.data.execution.reason ?? "Galileo trade submitted; evidence will be confirmed by the executor.");
        dispatchSigmaPetReaction(payload.data.execution.status === "blocked" ? "chat.trade-blocked" : "chat.trade-submitted", { force: true });
      } else {
        setStatus(payload.data.preview.galileo?.decisionReason ?? "Live quote and policy preview ready. Review the exact floor before signing.");
        dispatchSigmaPetReaction("trade.quote.ready", { force: true });
      }
    } catch (error) {
      setConsent(null);
      setStatus(error instanceof Error ? error.message : "Galileo trade request failed.");
      dispatchSigmaPetReaction("chat.trade-failed", { force: true });
    } finally {
      setIsPreviewing(false);
      setIsExecuting(false);
    }
  }, [account.address, amountIn, clientRequestId, onPreviewChange, selectedAgent, side, slippageBps, slippageError]);

  const prepareAndSignConsent = useCallback(async () => {
    if (!account.address || !selectedAgent || !preview?.galileo?.consentRequest) {
      setStatus("A server-issued, preview-bound Galileo consent is required before the wallet can sign.");
      return;
    }
    setIsPreparingConsent(true);
    try {
      const response = await fetch("/api/agents/galileo/consent", {
        body: JSON.stringify(preview.galileo.consentRequest),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json() as { data?: GalileoTradeConsentIssue; error?: { message: string } };
      if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? "Galileo action consent could not be prepared.");
      const signature = await signMessage.signMessageAsync({ message: payload.data.consentMessage });
      const nextConsent: GalileoTradeConsentSubmission = {
        ...payload.data,
        wallet: {
          address: account.address,
          chainId: GALILEO_CHAIN_ID,
          message: payload.data.consentMessage,
          signature,
        },
      };
      setConsent(nextConsent);
      setStatus(`Owner consent signed. It expires at ${new Date(payload.data.expiresAt * 1_000).toLocaleTimeString()}.`);
    } catch (error) {
      setConsent(null);
      setStatus(error instanceof Error ? error.message : "Galileo action consent could not be signed.");
    } finally {
      setIsPreparingConsent(false);
    }
  }, [account.address, preview?.galileo?.consentRequest, selectedAgent, signMessage]);

  const galileo = preview?.galileo;
  const previewAllowsExecution = preview?.proofBundle.policyDecision === "allow" && Boolean(galileo);
  const blockedByState = !galileo || !galileo.agentKeyEnabled || galileo.vaultPaused || galileo.executorRevoked || !galileo.storageAvailable || !galileo.cooldownReady;
  const canPrepareConsent = previewAllowsExecution && !blockedByState && !isPreviewing && !isPreparingConsent && !isExecuting;
  const canExecute = canPrepareConsent && Boolean(consent) && (consent?.expiresAt ?? 0) > Math.floor(Date.now() / 1_000);

  return (
    <section className="rounded-[24px] border border-primary/25 bg-panel-solid-strong p-4 shadow-[0_22px_72px_rgba(0,0,0,0.22)] lg:rounded-[30px] lg:p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-full border border-primary/30 bg-primary/10 text-primary"><ShieldCheck className="h-4 w-4" /></span>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-primary">Galileo swap executor</p>
              <h2 className="text-xl font-semibold text-foreground">Signed sandbox trade</h2>
            </div>
          </div>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-muted">Preview the attested V4 sandbox pool, sign one exact owner consent, then execute a real Galileo testnet transaction.</p>
        </div>
        <span title={networkLabel} className="shrink-0 rounded-full border border-primary/30 bg-primary/10 px-3 py-1.5 text-[10px] font-bold tracking-[0.16em] text-primary">GALILEO TESTNET · REAL TX · SANDBOX LIQUIDITY</span>
      </div>

      <div className="mt-5 grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(20rem,0.9fr)]">
        <div className="grid gap-3">
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_9rem]">
            <label className="grid gap-2"><span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted">Verified local agent</span>
              <select value={selectedAgent?.agentRef ?? ""} onChange={(event) => { setSelectedAgentRef(event.target.value); clearDerivedState(); }} disabled={!agents.length || isLoadingAgents} className="h-11 min-w-0 rounded-full border border-line bg-panel px-4 text-sm font-semibold text-foreground outline-none focus:border-primary/40 disabled:opacity-50">
                {!agents.length ? <option value="">No verified Galileo agent</option> : agents.map((agent) => <option key={agent.agentRef} value={agent.agentRef}>{agent.agentRef}</option>)}
              </select>
            </label>
            <label className="grid gap-2"><span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted">{side === "buy" ? "Amount 0G" : "Amount mUSDC"}</span>
              <input value={amountIn} onChange={(event) => { setAmountIn(event.target.value); clearDerivedState(); }} inputMode="decimal" autoComplete="off" className="h-11 min-w-0 rounded-full border border-line bg-panel px-4 font-mono text-sm font-semibold text-foreground outline-none focus:border-primary/40" />
            </label>
          </div>

          <div className="grid gap-3 md:grid-cols-[auto_minmax(0,1fr)] md:items-end">
            <div className="grid gap-2"><span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted">Side</span>
              <div className="inline-flex rounded-full border border-line bg-panel p-1">{(["buy", "sell"] as const).map((value) => <button key={value} type="button" aria-pressed={side === value} onClick={() => { setSide(value); clearDerivedState(); }} className={`h-9 rounded-full px-4 text-sm font-semibold capitalize ${side === value ? "bg-primary/15 text-primary" : "text-muted hover:text-foreground"}`}>{value}</button>)}</div>
            </div>
            <label className="grid gap-2"><span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted">Slippage</span>
              <input value={slippageBps} onChange={(event) => { setSlippageBps(Number(event.target.value)); clearDerivedState(); }} type="number" min={1} max={100} aria-invalid={Boolean(slippageError)} aria-describedby={slippageError ? "galileo-slippage-error" : undefined} className="h-11 min-w-0 rounded-full border border-line bg-panel px-4 font-mono text-sm font-semibold text-foreground outline-none focus:border-primary/40" />
              {slippageError ? <span id="galileo-slippage-error" className="text-xs text-red-400">{slippageError}</span> : null}
            </label>
          </div>

          <div className="flex flex-wrap gap-2 pt-1">
            <button type="button" onClick={() => void requestTrade("preview")} disabled={!account.address || !selectedAgent || Boolean(slippageError) || isPreviewing || isPreparingConsent || isExecuting} className="inline-flex h-11 items-center justify-center gap-2 rounded-full border border-line bg-panel px-4 text-sm font-semibold text-foreground transition-colors hover:bg-panel-strong disabled:cursor-not-allowed disabled:opacity-45">
              {isPreviewing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />} Refresh quote
            </button>
            <button type="button" onClick={() => void prepareAndSignConsent()} disabled={!canPrepareConsent} className="inline-flex h-11 items-center justify-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-4 text-sm font-semibold text-primary transition-colors hover:bg-primary/15 disabled:cursor-not-allowed disabled:opacity-45">
              {isPreparingConsent ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wallet className="h-4 w-4" />} Sign exact consent
            </button>
            <button type="button" onClick={() => void requestTrade("execute", consent ?? undefined)} disabled={!canExecute} className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-primary px-4 text-sm font-semibold text-on-primary transition-[filter,transform] hover:brightness-105 active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-45">
              {isExecuting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />} Execute signed trade
            </button>
            <button type="button" onClick={() => void loadAgents()} disabled={isLoadingAgents} className="inline-flex h-11 items-center justify-center rounded-full border border-line px-3 text-muted hover:text-foreground disabled:opacity-45" aria-label="Refresh Galileo agents"><RefreshCcw className={`h-4 w-4 ${isLoadingAgents ? "animate-spin" : ""}`} /></button>
          </div>

          <div className="rounded-[18px] border border-line bg-panel-solid-strong/20 px-3 py-2.5"><div className="flex items-start gap-2">{previewAllowsExecution && !blockedByState ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber" />}<p className="text-sm leading-6 text-muted">{status}</p></div></div>
        </div>

        <GalileoPreviewEvidence preview={preview} execution={execution} consent={consent} />
      </div>
    </section>
  );
}

function GalileoPreviewEvidence({ preview, execution, consent }: { preview: AgentTradePreview | null; execution: AgentTradeExecution | null; consent: GalileoTradeConsentSubmission | null }) {
  const galileo = preview?.galileo;
  const evidence = execution?.galileo;
  return <aside className="grid gap-3 rounded-[22px] border border-line bg-panel p-3">
    <div className="flex items-start justify-between gap-3"><div><p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted">Live quote and evidence</p><h3 className="mt-1 text-base font-semibold text-foreground">0G ⇄ mUSDC sandbox pool</h3></div><span className={`shrink-0 rounded-full border px-2.5 py-1 text-xs font-semibold ${preview?.proofBundle.policyDecision === "allow" ? "border-green/20 bg-green/10 text-green" : "border-amber/20 bg-amber/10 text-amber"}`}>{preview?.proofBundle.policyDecision ?? "review"}</span></div>
    <div className="grid gap-2 sm:grid-cols-2"><Metric label="Trusted quote" value={galileo?.trustedQuote ?? "--"} /><Metric label="Final min out" value={galileo?.amountOutMin ?? "--"} /><Metric label="Vault floor" value={galileo?.vaultMinOut ?? "--"} /><Metric label="User floor" value={galileo?.userMinOut ?? "--"} /><Metric label="Price impact" value={galileo ? `${galileo.priceImpactBps} bps` : "--"} /><Metric label="Pool native reserve" value={galileo?.poolNativeReserve ?? "--"} /><Metric label="Sellable inventory" value={galileo?.sellableInventory ?? "--"} /></div>
    <div className="grid gap-2 border-t border-line pt-3"><HashLine label="Agent key" value={galileo?.agentKey ?? "--"} /><HashLine label="Policy hash" value={galileo?.policyHash ?? "--"} /><HashLine label="Quote block" value={galileo?.quoteBlock ?? "--"} />{consent ? <HashLine label="Consent expiry" value={new Date(consent.expiresAt * 1_000).toLocaleTimeString()} /> : null}</div>
    <div className="grid gap-2 border-t border-line pt-3"><EvidenceLink icon={<Database className="h-3.5 w-3.5" />} label="Storage upload" href={storageEvidenceHref(evidence?.storageRef)} /><EvidenceLink icon={<FileCheck2 className="h-3.5 w-3.5" />} label="Proof acceptance" href={transactionHref(evidence?.proofTxHash)} /><EvidenceLink icon={<ArrowRight className="h-3.5 w-3.5" />} label="Trade transaction" href={transactionHref(evidence?.tradeTxHash)} /></div>
  </aside>;
}

function Metric({ label, value }: { label: string; value: string }) { return <div className="min-w-0 rounded-[16px] border border-line bg-panel-solid-strong/20 px-3 py-2"><p className="text-[10px] uppercase tracking-[0.18em] text-muted">{label}</p><p className="mt-1 truncate font-mono text-xs font-semibold text-foreground" title={value}>{shortValue(value)}</p></div>; }
function HashLine({ label, value }: { label: string; value: string }) { return <div className="flex min-w-0 items-center justify-between gap-3 rounded-[14px] bg-panel-solid-strong/20 px-3 py-2"><span className="text-xs text-muted">{label}</span><span className="min-w-0 truncate text-right font-mono text-xs font-semibold text-foreground" title={value}>{shortValue(value)}</span></div>; }
function EvidenceLink({ icon, label, href }: { icon: React.ReactNode; label: string; href?: string }) { return href ? <a href={href} target="_blank" rel="noreferrer" className="flex items-center justify-between gap-3 rounded-[14px] bg-panel-solid-strong/20 px-3 py-2 text-xs text-primary hover:underline"><span className="flex items-center gap-1.5">{icon}{label}</span><span>Open</span></a> : <div className="flex items-center justify-between gap-3 rounded-[14px] bg-panel-solid-strong/20 px-3 py-2 text-xs text-muted"><span className="flex items-center gap-1.5">{icon}{label}</span><span>Pending</span></div>; }

function transactionHref(hash: string | undefined): string | undefined { return hash && /^0x[a-fA-F0-9]{64}$/.test(hash) ? `${GALILEO_EXPLORER_ORIGIN}/tx/${encodeURIComponent(hash)}` : undefined; }
function storageEvidenceHref(storageRef: string | undefined): string | undefined { if (!storageRef) return undefined; const configured = process.env.NEXT_PUBLIC_GALILEO_STORAGE_INDEXER_URL; if (!configured) return undefined; try { const origin = new URL(configured).origin; if (!ALLOWED_STORAGE_ORIGINS.has(origin)) return undefined; return `${origin}/?root=${encodeURIComponent(storageRef)}`; } catch { return undefined; } }
function shortValue(value: string): string { return value.startsWith("0x") && value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value; }
function newClientRequestId(): string { return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().replaceAll("-", "") : `galileo${Date.now().toString(36)}`; }
