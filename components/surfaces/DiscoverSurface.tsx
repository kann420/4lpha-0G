"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  Archive,
  Bot,
  CheckCircle2,
  CircleAlert,
  Coins,
  Database,
  FileScan,
  Fingerprint,
  Link2,
  Loader2,
  Radar,
  Search,
  ShieldCheck,
  Sparkles,
  WalletCards,
  XCircle,
} from "lucide-react";
import { AppShell } from "@/components/app/AppShell";
import { useOgNetwork } from "@/components/app/useOgNetwork";
import type {
  AiScanAgentLogEntry,
  AiScanMode,
  AiScanModelCatalogResponse,
  AiScanReport,
  AiScanReportItem,
  AiScanReportSection,
  AiScanReportTone,
  AiScanResponse,
  AiScanState,
  AiScanTargetType,
} from "@/lib/types/ai-scan";

type ScanMode = AiScanMode;
type ScanState = AiScanState;
type ScanTargetType = AiScanTargetType;
type ReportTone = AiScanReportTone;
type ReportItem = AiScanReportItem;
type ReportSection = AiScanReportSection;
type EvidenceRow = AiScanReport["evidence"][number];
type AgentLogEntry = AiScanAgentLogEntry;
type ScanResult = AiScanReport;

interface ArchitectureStep {
  detail: string;
  icon: typeof Fingerprint;
  label: string;
}

const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const SAMPLE_TARGETS: Record<ScanTargetType, string> = {
  token: "0x1f3AA82227281cA364bFb3d253B0f1af1Da6473E",
  wallet: "0x92c0c02e30d1f5a8c5f434db9b1d4f8b20f6e7a1",
};

const TARGET_COPY: Record<
  ScanTargetType,
  {
    helper: string;
    label: string;
    placeholder: string;
    sampleLabel: string;
  }
> = {
  token: {
    helper: "Contract risk, honeypot path, holders, liquidity, and audit evidence.",
    label: "Token",
    placeholder: "0x token contract address",
    sampleLabel: "Sample token",
  },
  wallet: {
    helper: "Portfolio holdings, recent activity, smart-money signals, and vault readiness.",
    label: "Wallet",
    placeholder: "0x wallet address",
    sampleLabel: "Sample wallet",
  },
};

const ARCHITECTURE_STEPS: ArchitectureStep[] = [
  {
    detail: "User pastes a token contract or wallet address. The frontend normalizes the target.",
    icon: Fingerprint,
    label: "Target input",
  },
  {
    detail: "The backend reads contract metadata, wallet activity, approvals, and holder context.",
    icon: Search,
    label: "On-chain scan",
  },
  {
    detail: "Risk checks come from deterministic simulation, portfolio deltas, and wallet/contract behavior rules.",
    icon: Radar,
    label: "Risk engine",
  },
  {
    detail: "AI turns the scan packet into a readable report and reasoning log.",
    icon: ShieldCheck,
    label: "AI research",
  },
  {
    detail: "A redacted audit bundle is stored on 0G, then hashes and references are anchored.",
    icon: Database,
    label: "Evidence layer",
  },
  {
    detail: "The vault and agent reuse scan context before allowing executor actions.",
    icon: WalletCards,
    label: "Vault gate",
  },
];

const MODE_TO_STEP: Record<ScanMode, number> = {
  approvals: 2,
  behavior: 3,
  honeypot: 2,
  research: 3,
  risk: 2,
  "wallet-risk": 2,
};

const TONE_CLASS: Record<ReportTone, string> = {
  clean: "border-emerald-300/20 bg-emerald-300/[0.07] text-emerald-100",
  danger: "border-rose-300/22 bg-rose-300/[0.08] text-rose-100",
  info: "border-cyan-300/20 bg-cyan-300/[0.07] text-cyan-100",
  warning: "border-amber-300/22 bg-amber-300/[0.08] text-amber-100",
};

function getDefaultMode(targetType: ScanTargetType): ScanMode {
  return targetType === "token" ? "honeypot" : "wallet-risk";
}

export function DiscoverSurface() {
  const { network, networkId, setNetworkId } = useOgNetwork();
  const [targetType, setTargetType] = useState<ScanTargetType>("token");
  const [activeMode, setActiveMode] = useState<ScanMode>(getDefaultMode("token"));
  const [activeStepIndex, setActiveStepIndex] = useState(0);
  const [targetAddress, setTargetAddress] = useState("");
  const [draftError, setDraftError] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [modelStatus, setModelStatus] = useState<"error" | "loading" | "ready">("loading");
  const [selectedModel, setSelectedModel] = useState("");
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [scanState, setScanState] = useState<ScanState>("idle");

  useEffect(() => {
    if (scanState !== "running") {
      return;
    }

    const timers = ARCHITECTURE_STEPS.map((_, index) =>
      window.setTimeout(() => setActiveStepIndex(index), index * 560),
    );

    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [scanState]);

  useEffect(() => {
    let cancelled = false;

    async function loadModels() {
      setModelStatus("loading");
      setModelError(null);
      try {
        const response = await fetch(`/api/ai-scan?networkId=${networkId}`);
        const payload = (await response.json()) as AiScanModelCatalogResponse;
        if (!response.ok || !payload.data) {
          throw new Error(payload.error?.message ?? "Unable to load AI Scan models.");
        }
        if (cancelled) {
          return;
        }
        setModelOptions(payload.data.models);
        setSelectedModel((current) => {
          if (current && payload.data?.models.includes(current)) {
            return current;
          }
          return payload.data?.defaultModel ?? payload.data?.models[0] ?? "";
        });
        setModelStatus("ready");
      } catch (error) {
        if (cancelled) {
          return;
        }
        setModelOptions([]);
        setSelectedModel("");
        setModelStatus("error");
        setModelError(error instanceof Error ? error.message : "Unable to load AI Scan models.");
      }
    }

    void loadModels();

    return () => {
      cancelled = true;
    };
  }, [networkId]);

  function resetPreview(stepIndex = 0) {
    if (scanState !== "running") {
      setActiveStepIndex(stepIndex);
      setScanResult(null);
      setScanState("idle");
    }
  }

  function handleTargetAddressChange(value: string) {
    setTargetAddress(value);
    setDraftError(null);
    resetPreview();
  }

  function handleTargetTypeChange(value: ScanTargetType) {
    const nextMode = getDefaultMode(value);
    setTargetType(value);
    setActiveMode(nextMode);
    setTargetAddress("");
    setDraftError(null);
    resetPreview(MODE_TO_STEP[nextMode]);
  }

  function loadSampleAddress() {
    setTargetAddress(SAMPLE_TARGETS[targetType]);
    setDraftError(null);
    resetPreview();
  }

  async function runScan() {
    const normalized = targetAddress.trim();
    if (!ADDRESS_PATTERN.test(normalized)) {
      setDraftError(`Paste a full 0x ${targetType} address to run AI Scan.`);
      return;
    }
    if (!selectedModel) {
      setDraftError("Select an AI model before scanning.");
      return;
    }

    setDraftError(null);
    setActiveStepIndex(0);
    setScanResult(null);
    setScanState("running");

    try {
      const response = await fetch("/api/ai-scan", {
        body: JSON.stringify({
          address: normalized,
          model: selectedModel,
          mode: activeMode,
          networkId,
          targetType,
        }),
        headers: {
          "content-type": "application/json",
        },
        method: "POST",
      });
      const payload = (await response.json()) as AiScanResponse;
      if (!response.ok || !payload.data?.report) {
        throw new Error(payload.error?.message ?? "AI Scan backend is unavailable.");
      }

      setActiveStepIndex(ARCHITECTURE_STEPS.length - 1);
      setScanResult(payload.data.report);
      setScanState("complete");
    } catch (error) {
      setScanState("idle");
      setScanResult(null);
      setDraftError(error instanceof Error ? error.message : "AI Scan backend is unavailable.");
    }
  }

  return (
    <AppShell network={network} networkId={networkId} onNetworkChange={setNetworkId}>
      <main className="h-full min-h-0 w-full max-w-full overflow-hidden px-3 py-3 lg:px-6 lg:py-4">
        <div className="scrollbar-subtle mx-auto h-full min-h-0 w-full max-w-full overflow-y-auto overflow-x-hidden lg:max-w-[100rem]">
          <div className="grid min-w-0 max-w-full gap-4 pb-6">
            <ScanHero
              activeStepIndex={activeStepIndex}
              draftError={draftError}
              modelError={modelError}
              modelOptions={modelOptions}
              modelStatus={modelStatus}
              networkLabel={network.networkName}
              onModelChange={setSelectedModel}
              onRunScan={runScan}
              onTargetAddressChange={handleTargetAddressChange}
              onTargetTypeChange={handleTargetTypeChange}
              onLoadSample={loadSampleAddress}
              scanResult={scanResult}
              scanState={scanState}
              selectedModel={selectedModel}
              targetAddress={targetAddress}
              targetType={targetType}
            />

            {scanState !== "complete" ? (
              <ArchitectureVisual
                activeMode={activeMode}
                activeStepIndex={activeStepIndex}
                scanState={scanState}
              />
            ) : null}
          </div>
        </div>
      </main>
    </AppShell>
  );
}

function ScanHero({
  activeStepIndex,
  draftError,
  modelError,
  modelOptions,
  modelStatus,
  networkLabel,
  onLoadSample,
  onModelChange,
  onRunScan,
  onTargetAddressChange,
  onTargetTypeChange,
  scanResult,
  scanState,
  selectedModel,
  targetAddress,
  targetType,
}: {
  activeStepIndex: number;
  draftError: string | null;
  modelError: string | null;
  modelOptions: string[];
  modelStatus: "error" | "loading" | "ready";
  networkLabel: string;
  onLoadSample: () => void;
  onModelChange: (value: string) => void;
  onRunScan: () => void;
  onTargetAddressChange: (value: string) => void;
  onTargetTypeChange: (value: ScanTargetType) => void;
  scanResult: ScanResult | null;
  scanState: ScanState;
  selectedModel: string;
  targetAddress: string;
  targetType: ScanTargetType;
}) {
  const isRunning = scanState === "running";
  const runLabel = isRunning ? "Scanning" : scanState === "complete" ? "Scan again" : "Scan";

  return (
    <section className="min-w-0 max-w-full overflow-hidden rounded-[24px] border border-white/8 bg-[linear-gradient(135deg,rgba(8,12,18,0.98),rgba(5,8,12,0.96)_54%,rgba(30,232,197,0.1))] p-3 shadow-[0_28px_100px_rgba(0,0,0,0.26)] sm:p-5 lg:rounded-[30px] lg:p-7">
      <div className="grid min-w-0 max-w-full gap-6">
        <div className="min-w-0 space-y-6">
          <div className="min-w-0 max-w-full">
            <h1 className="max-w-4xl text-[2rem] font-semibold leading-[1.08] tracking-tight text-white sm:text-5xl lg:text-[4rem]">
              4lpha AI Smart Scan
            </h1>
            <p className="mt-4 max-w-3xl text-sm leading-6 text-slate-400 sm:text-base lg:text-lg">
              Scan tokens for honeypot and liquidity risk, or scan wallets for portfolio, recent activity,
              smart-money signals, and agent-ready evidence stored on 0G.
            </p>
          </div>

          <div className="grid gap-3 lg:grid-cols-[minmax(18rem,30rem)_minmax(12rem,18rem)] lg:items-start">
            <TargetTypeSwitch activeType={targetType} onChange={onTargetTypeChange} />
            <ModelSelector
              modelError={modelError}
              modelOptions={modelOptions}
              modelStatus={modelStatus}
              networkLabel={networkLabel}
              onModelChange={onModelChange}
              selectedModel={selectedModel}
            />
          </div>

          <div className="grid gap-3">
            <div className="flex min-w-0 max-w-full flex-col gap-2 rounded-[22px] border border-white/10 bg-black/20 p-2 lg:flex-row lg:items-center">
              <label className="flex min-h-14 min-w-0 flex-1 items-center gap-3 rounded-[16px] bg-white/[0.035] px-3 lg:px-4">
                <Fingerprint className="h-4 w-4 shrink-0 text-cyan-100" />
                <input
                  value={targetAddress}
                  onChange={(event) => {
                    onTargetAddressChange(event.target.value);
                  }}
                  placeholder={TARGET_COPY[targetType].placeholder}
                  spellCheck={false}
                  className="min-w-0 flex-1 bg-transparent font-mono text-sm text-white outline-none placeholder:text-slate-600 lg:text-base"
                />
              </label>
              <div className="grid grid-cols-[minmax(0,0.85fr)_minmax(0,1fr)] gap-2 sm:flex">
                <button
                  type="button"
                  onClick={onLoadSample}
                  className="inline-flex h-12 min-w-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] px-4 text-sm font-semibold text-slate-200 transition-[background-color,transform] hover:bg-white/[0.07] active:scale-[0.96] lg:h-14 lg:px-5 lg:text-base"
                >
                  Sample
                </button>
                <button
                  type="button"
                  onClick={onRunScan}
                  disabled={isRunning}
                  className="inline-flex h-12 min-w-0 items-center justify-center gap-2 rounded-full bg-[var(--pulse-teal)] px-4 text-sm font-semibold text-[#041015] transition-[filter,transform,opacity] hover:brightness-105 active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-70 sm:min-w-[8.5rem] lg:h-14 lg:px-6 lg:text-base"
                >
                  {isRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileScan className="h-4 w-4" />}
                  {runLabel}
                </button>
              </div>
            </div>

            {draftError ? (
              <p className="rounded-full border border-amber-300/18 bg-amber-300/[0.08] px-3 py-2 text-sm text-amber-100">
                {draftError}
              </p>
            ) : null}
          </div>
        </div>

        <div className="min-w-0">
          <SecurityReport activeStepIndex={activeStepIndex} result={scanResult} scanState={scanState} />
        </div>
      </div>
    </section>
  );
}

function TargetTypeSwitch({
  activeType,
  onChange,
}: {
  activeType: ScanTargetType;
  onChange: (value: ScanTargetType) => void;
}) {
  return (
    <div className="grid w-full grid-cols-2 gap-1 rounded-full border border-white/8 bg-white/[0.035] p-1">
      {(["token", "wallet"] as const).map((type) => {
        const active = activeType === type;
        const Icon = type === "token" ? Coins : WalletCards;
        return (
          <button
            key={type}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(type)}
            className={`inline-flex h-11 items-center justify-center gap-2 rounded-full text-sm font-semibold transition-[background-color,color,transform] active:scale-[0.96] ${
              active ? "bg-white/[0.1] text-white" : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <Icon className="h-4 w-4" />
            {TARGET_COPY[type].label}
          </button>
        );
      })}
    </div>
  );
}

function ModelSelector({
  modelError,
  modelOptions,
  modelStatus,
  networkLabel,
  onModelChange,
  selectedModel,
}: {
  modelError: string | null;
  modelOptions: string[];
  modelStatus: "error" | "loading" | "ready";
  networkLabel: string;
  onModelChange: (value: string) => void;
  selectedModel: string;
}) {
  const disabled = modelStatus !== "ready" || modelOptions.length === 0;

  return (
    <div className="grid min-w-0 gap-2">
      <label className="flex min-h-12 min-w-0 items-center gap-2 rounded-full border border-white/10 bg-white/[0.035] px-3">
        <Bot className="h-4 w-4 shrink-0 text-cyan-100" />
        <span className="shrink-0 text-sm font-semibold text-slate-300">Model</span>
        <select
          value={selectedModel}
          onChange={(event) => onModelChange(event.target.value)}
          disabled={disabled}
          className="min-w-0 flex-1 appearance-none bg-transparent text-sm font-semibold text-white outline-none disabled:text-slate-500"
        >
          {modelStatus === "loading" ? <option value="">Loading models...</option> : null}
          {modelStatus === "error" ? <option value="">Model catalog unavailable</option> : null}
          {modelStatus === "ready" && modelOptions.length === 0 ? <option value="">No models available</option> : null}
          {modelOptions.map((model) => (
            <option key={model} value={model} className="bg-[#0b1117] text-white">
              {model}
            </option>
          ))}
        </select>
        <span className="hidden rounded-full border border-white/8 bg-black/20 px-2 py-1 text-[10px] font-semibold text-slate-400 xl:inline-flex">
          {networkLabel}
        </span>
      </label>
      {modelError ? (
        <p className="rounded-full border border-amber-300/18 bg-amber-300/[0.08] px-3 py-2 text-sm text-amber-100">
          {modelError}
        </p>
      ) : null}
    </div>
  );
}

function ScopeRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 overflow-hidden rounded-[14px] border border-white/8 bg-white/[0.035] px-3 py-2">
      <span className="shrink-0 text-xs font-semibold text-slate-500">{label}</span>
      <span className="min-w-0 truncate text-right text-sm font-semibold text-slate-200" title={value}>
        {value}
      </span>
    </div>
  );
}

function SecurityReport({
  activeStepIndex,
  result,
  scanState,
}: {
  activeStepIndex: number;
  result: ScanResult | null;
  scanState: ScanState;
}) {
  if (scanState === "idle" && !result) {
    return null;
  }

  if (scanState === "running") {
    const activeStep = ARCHITECTURE_STEPS[activeStepIndex] ?? ARCHITECTURE_STEPS[0];
    const progress = Math.round(((activeStepIndex + 1) / ARCHITECTURE_STEPS.length) * 100);

    return (
      <div className="overflow-hidden rounded-[22px] border border-cyan-300/20 bg-cyan-300/[0.055] p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-cyan-100/70">
              AI Scan running
            </p>
            <h2 className="mt-1 text-xl font-semibold text-white">{activeStep.label}</h2>
            <p className="mt-1 text-sm leading-5 text-slate-400">{activeStep.detail}</p>
          </div>
          <span className="inline-flex w-fit items-center gap-2 rounded-full border border-cyan-300/20 bg-black/20 px-3 py-1.5 text-sm font-semibold text-cyan-100">
            <Loader2 className="h-4 w-4 animate-spin" />
            {progress}%
          </span>
        </div>
        <div className="mt-4 h-2 overflow-hidden rounded-full bg-black/24">
          <div
            className="h-full rounded-full bg-[linear-gradient(90deg,var(--pulse-teal),rgba(255,209,102,0.9))] transition-[width] duration-500"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>
    );
  }

  if (!result) {
    return null;
  }

  const isVerified = result.verdict === "Verified" || Boolean(result.verifiedToken);
  const reportTone = result.verdict === "High risk" ? "warning" : result.verdict === "Watch" ? "info" : "clean";

  return (
    <div className="grid gap-4 rounded-[24px] border border-white/8 bg-[linear-gradient(135deg,rgba(7,11,15,0.96),rgba(10,16,20,0.9))] p-4 lg:grid-cols-[17rem_minmax(0,1fr)] lg:p-5">
      <aside className="min-w-0 overflow-hidden rounded-[20px] border border-white/8 bg-black/22 p-4">
        <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500">
          Security report
        </p>
        <div className="mt-4 flex items-end gap-3">
          <span className="text-5xl font-semibold tabular-nums text-white">{result.score}</span>
          <span className="pb-2 font-mono text-sm text-slate-500">/100</span>
        </div>
        <span className={`mt-4 inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-semibold ${TONE_CLASS[reportTone]}`}>
          {isVerified ? <ShieldCheck className="h-3.5 w-3.5" /> : null}
          {result.verdict}
        </span>
        {isVerified && result.verifiedToken ? (
          <p className="mt-2 text-xs leading-5 text-emerald-100/80">
            {result.verifiedToken.verificationSource}
          </p>
        ) : null}
        <p className="mt-5 text-sm font-semibold text-white">{result.targetLabel}</p>
        <p className="mt-1 truncate font-mono text-xs text-slate-500" title={result.address}>
          {result.address}
        </p>
        <div className="mt-5 grid gap-2">
          <ScopeRow label="Type" value={TARGET_COPY[result.targetType].label} />
          <ScopeRow label="Scan" value={result.scanId} />
        </div>
      </aside>

      <div className="min-w-0 space-y-4">
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_21rem]">
          <div className="min-w-0">
            <p className="text-sm leading-6 text-slate-300">{result.summary}</p>
            <p className="mt-3 rounded-[18px] border border-cyan-300/18 bg-cyan-300/[0.06] px-3 py-3 text-sm leading-6 text-cyan-50">
              {result.recommendation}
            </p>
          </div>
          <EvidencePanel evidence={result.evidence} />
        </div>

        <div className="grid gap-3 xl:grid-cols-2">
          {result.sections.map((section) => (
            <ReportSectionCard key={section.title} section={section} />
          ))}
        </div>

        <AgentReasoningLog logs={result.agentLogs} />
      </div>
    </div>
  );
}

function EvidencePanel({ evidence }: { evidence: EvidenceRow[] }) {
  return (
    <div className="min-w-0 rounded-[18px] border border-white/8 bg-white/[0.035] p-3">
      <div className="flex items-center gap-2 text-cyan-100">
        <Archive className="h-4 w-4" />
        <h3 className="text-sm font-semibold text-white">0G evidence</h3>
      </div>
      <div className="mt-3 space-y-2">
        {evidence.map((row) => (
          <div key={row.label} className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">{row.label}</p>
            <p className="mt-0.5 truncate font-mono text-xs font-semibold text-slate-200" title={row.value}>
              {row.value}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

function ReportSectionCard({ section }: { section: ReportSection }) {
  return (
    <section className="min-w-0 rounded-[20px] border border-white/8 bg-white/[0.028] p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-base font-semibold text-white">{section.title}</h3>
        {section.action ? <span className="text-xs font-semibold text-cyan-100/70">{section.action}</span> : null}
      </div>
      <div className="mt-4 space-y-3">
        {section.items.map((item, index) => (
          <ReportItemRow key={reportItemKey(section, item, index)} item={item} />
        ))}
      </div>
    </section>
  );
}

function reportItemKey(section: ReportSection, item: ReportItem, index: number): string {
  return [section.title, item.title, item.detail ?? item.metrics?.join("|") ?? "", index].join("-");
}

function ReportItemRow({ item }: { item: ReportItem }) {
  const Icon = item.status === "danger" ? XCircle : item.status === "warning" ? CircleAlert : CheckCircle2;

  return (
    <div className="grid gap-2 rounded-[16px] border border-white/8 bg-black/18 p-3">
      <div className="flex items-start gap-2">
        <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${TONE_CLASS[item.status]}`}>
          <Icon className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-white">{item.title}</p>
          {item.detail ? <p className="mt-1 text-sm leading-5 text-slate-400">{item.detail}</p> : null}
        </div>
      </div>
      {item.metrics ? (
        <div className="ml-7 grid gap-1">
          {item.metrics.map((metric) => (
            <p key={metric} className="min-w-0 break-words font-mono text-xs text-slate-400 [overflow-wrap:anywhere]">
              {metric}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function AgentReasoningLog({ logs }: { logs: AgentLogEntry[] }) {
  return (
    <section className="min-w-0 rounded-[20px] border border-white/8 bg-black/20 p-4">
      <div className="flex items-center gap-2 text-cyan-100">
        <Bot className="h-4 w-4" />
        <h3 className="text-base font-semibold text-white">Agent reasoning log</h3>
      </div>
      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        {logs.map((log) => (
          <div key={`${log.time}-${log.label}`} className="min-w-0 rounded-[16px] border border-white/8 bg-white/[0.03] p-3">
            <div className="flex items-center justify-between gap-3">
              <span className={`rounded-full border px-2 py-1 text-xs font-semibold ${TONE_CLASS[log.tone]}`}>
                {log.label}
              </span>
              <span className="font-mono text-xs text-slate-500">{log.time}</span>
            </div>
            <p className="mt-2 text-sm leading-5 text-slate-400">{log.detail}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function ArchitectureVisual({
  activeMode,
  activeStepIndex,
  scanState,
}: {
  activeMode: ScanMode;
  activeStepIndex: number;
  scanState: ScanState;
}) {
  const modeStep = MODE_TO_STEP[activeMode];
  const statusLabel =
    scanState === "running" ? "AI Scan running" : scanState === "complete" ? "Evidence packet ready" : "Architecture";

  return (
    <section className="min-w-0 max-w-full overflow-hidden rounded-[24px] border border-white/8 bg-[linear-gradient(180deg,rgba(8,12,18,0.96),rgba(5,8,12,0.92))] p-4 shadow-[0_28px_100px_rgba(0,0,0,0.24)] lg:rounded-[30px] lg:p-6">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-cyan-100/60">
            AI Scan architecture
          </p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-white lg:text-3xl">
            From target to transparent evidence.
          </h2>
        </div>
        <span className="inline-flex w-fit items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold text-slate-300">
          {scanState === "running" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-cyan-100" />
          ) : scanState === "complete" ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-100" />
          ) : (
            <Archive className="h-3.5 w-3.5 text-slate-400" />
          )}
          {statusLabel}
        </span>
      </div>

      <div className="relative mt-5 overflow-hidden rounded-[24px] border border-white/8 bg-black/20 p-3 lg:p-5">
        <div className="pointer-events-none absolute inset-0 opacity-60 [background-image:linear-gradient(rgba(255,255,255,0.045)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.035)_1px,transparent_1px)] [background-size:32px_32px]" />
        <div className="relative grid gap-3 xl:grid-cols-[minmax(0,1fr)_auto_minmax(0,1.05fr)_auto_minmax(0,1.05fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)] xl:items-stretch">
          {ARCHITECTURE_STEPS.map((step, index) => {
            const active = scanState === "running" && activeStepIndex === index;
            const done = scanState === "complete" || (scanState === "running" && index < activeStepIndex);
            const modeRelated = scanState === "idle" && index === modeStep;

            return (
              <ArchitectureNode
                key={step.label}
                active={active}
                done={done}
                index={index}
                modeRelated={modeRelated}
                showConnector={index < ARCHITECTURE_STEPS.length - 1}
                step={step}
              />
            );
          })}
        </div>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-3">
        <ArchitecturePrinciple
          icon={<ShieldCheck className="h-4 w-4" />}
          label="Rules decide"
          text="Honeypot, approvals, and sell-lock verdicts come from deterministic checks first."
        />
        <ArchitecturePrinciple
          icon={<Sparkles className="h-4 w-4" />}
          label="AI explains"
          text="0G Compute summarizes the packet, writes the reasoning log, and cites which signals mattered."
        />
        <ArchitecturePrinciple
          icon={<Link2 className="h-4 w-4" />}
          label="0G remembers"
          text="Storage roots and proof references keep scan context reusable for agents and vault policies."
        />
      </div>
    </section>
  );
}

function ArchitectureNode({
  active,
  done,
  index,
  modeRelated,
  showConnector,
  step,
}: {
  active: boolean;
  done: boolean;
  index: number;
  modeRelated: boolean;
  showConnector: boolean;
  step: ArchitectureStep;
}) {
  const Icon = step.icon;
  const stateClass = active
    ? "border-cyan-200/40 bg-cyan-300/[0.1] shadow-[0_0_42px_rgba(30,232,197,0.12)]"
    : done
      ? "border-emerald-300/22 bg-emerald-300/[0.06]"
      : modeRelated
        ? "border-cyan-200/30 bg-cyan-200/[0.075]"
        : "border-white/8 bg-[#0b1117]/85";

  return (
    <>
      <div
        className={`min-w-0 rounded-[20px] border p-4 transition-[background-color,border-color,box-shadow,transform] duration-300 ${stateClass}`}
      >
        <div className="flex items-start justify-between gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[14px] border border-white/10 bg-black/25 text-cyan-100">
            <Icon className="h-4 w-4" />
          </span>
          <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-1 font-mono text-[11px] text-slate-400">
            0{index + 1}
          </span>
        </div>
        <h3 className="mt-4 text-base font-semibold text-white">{step.label}</h3>
        <p className="mt-2 text-sm leading-5 text-slate-400">{step.detail}</p>
      </div>

      {showConnector ? (
        <div className="flex min-h-8 items-center justify-center xl:min-h-0 xl:w-7">
          <span className="h-8 w-px bg-[linear-gradient(180deg,transparent,rgba(30,232,197,0.55),transparent)] xl:h-px xl:w-full xl:bg-[linear-gradient(90deg,transparent,rgba(30,232,197,0.55),transparent)]" />
        </div>
      ) : null}
    </>
  );
}

function ArchitecturePrinciple({
  icon,
  label,
  text,
}: {
  icon: ReactNode;
  label: string;
  text: string;
}) {
  return (
    <div className="min-w-0 rounded-[18px] border border-white/8 bg-white/[0.035] p-3">
      <div className="flex items-center gap-2 text-cyan-100">
        {icon}
        <h3 className="text-sm font-semibold text-white">{label}</h3>
      </div>
      <p className="mt-2 text-sm leading-5 text-slate-400">{text}</p>
    </div>
  );
}
