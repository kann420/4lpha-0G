"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Bot, Coins, Loader2, Repeat2, ShieldCheck, Sparkles, TrendingDown, TrendingUp, Upload } from "lucide-react";
import { formatEther, parseEther } from "viem";
import { useSignMessage } from "wagmi";

import { AppShell } from "@/components/app/AppShell";
import { EMPTY_OG_MODEL_CATALOG, OgModelSelector, shortModelLabel, type OgModelCatalogState } from "@/components/app/OgModelSelector";
import { useOgNetwork } from "@/components/app/useOgNetwork";
import { WalletConnectButton } from "@/components/wallet";
import { useWalletConnection } from "@/components/wallet/useWalletConnection";
import { AutomationModuleCard } from "@/components/agents/lp/AutomationModuleCard";
import { LpRangePreview } from "@/components/agents/lp/LpRangePreview";
import { ZiaPoweredBadge } from "@/components/agents/lp/ZiaPoweredBadge";
import { MOCK_LP_POOLS } from "@/lib/agent/lp/mock-lp-data";
import { dispatchSigmaPetReaction } from "@/lib/copilot/sigma-pet";
import { buildLpDeployActionConsentMessage, type LpDeployConsentStep } from "@/lib/copilot/wallet-access";
import { getOgNetwork } from "@/lib/og/networks";
import type { OgAgentWorkspace } from "@/lib/agent/single-agent";
import type { CopilotModelsResponse } from "@/lib/types";

const MAINNET = getOgNetwork("mainnet");

const inputClassName =
  "h-12 w-full rounded-full border border-line bg-panel px-4 text-sm font-semibold text-foreground outline-none transition-colors placeholder:text-muted focus:border-primary/40 disabled:cursor-not-allowed disabled:opacity-50";

interface LpAgentDraft {
  name: string;
  minAprPct: string; // blank = no minimum APR filter (0%).
  maxAprPct: string; // empty string = no upper bound. Pool selection filter.
  maxPositions: string; // max concurrent LP positions the agent may open (agent-enforced).
  maxPerPosition0G: string; // max 0G the agent may deploy into a SINGLE LP NFT (agent-enforced).
  rangeMode: "full" | "pm5" | "pm12" | "pm20" | "custom";
  llmPicksRange: boolean; // when true, the LLM chooses the optimal band within the APR filter.
  customLowerPct: string; // negative side % (below current), e.g. "7" = -7%.
  customUpperPct: string; // positive side % (above current), e.g. "12" = +12%.
  depositNative0G: string; // initial vault deposit the agent deploys from.
  llmPrimaryModel: string; // 0G Compute Router model that powers the agent's decisions.
  llmFallbackModel: string; // Secondary Router model choice for review/runtime wiring.
  automation: { autoRebalance: boolean; autoCompound: boolean; takeProfit: boolean; stopLoss: boolean };
}

type LpDeployResponse = {
  data?: {
    deployment?: { id?: string };
    firstMint?: { lpTxHash?: string; tokenId?: string };
    firstMintError?: string;
    firstMintRun?: { status?: string; brainSummary?: string; error?: string };
    workspace?: OgAgentWorkspace;
  };
  error?: {
    code?: string;
    message?: string;
  };
};

const INITIAL_DRAFT: LpAgentDraft = {
  name: "",
  minAprPct: "",
  maxAprPct: "",
  maxPositions: "3",
  maxPerPosition0G: "0.5",
  rangeMode: "full",
  llmPicksRange: false,
  customLowerPct: "5",
  customUpperPct: "5",
  depositNative0G: "",
  llmPrimaryModel: "",
  llmFallbackModel: "",
  automation: { autoRebalance: false, autoCompound: false, takeProfit: false, stopLoss: false },
};

const RANGE_OPTIONS = [
  { key: "full", label: "Full range" },
  { key: "pm5", label: "±5%" },
  { key: "pm12", label: "±12%" },
  { key: "pm20", label: "±20%" },
  { key: "custom", label: "Custom" },
] as const;

const AUTOMATION_MODULES = [
  { key: "autoRebalance", icon: Repeat2, title: "Auto-rebalance", tone: "blue", subtitle: "Re-center the LP range as the pool price drifts.", inactiveSummary: "Keeps the position around the active tick. Backend wiring coming soon." },
  { key: "autoCompound", icon: Coins, title: "Auto-compound", tone: "blue", subtitle: "Claim earned fees and add them back into the LP position.", inactiveSummary: "Accumulate fees first, then compound manually. Backend wiring coming soon." },
  { key: "takeProfit", icon: TrendingUp, title: "Take Profit", tone: "green", subtitle: "Zap out when the position hits a target return.", inactiveSummary: "Locks in gains at a configured target. Backend wiring coming soon." },
  { key: "stopLoss", icon: TrendingDown, title: "Stop Loss", tone: "rose", subtitle: "Zap out when exposure drops below a floor.", inactiveSummary: "Caps downside on the LP position. Backend wiring coming soon." },
] as const;

export function LpAgentCreateWorkspace() {
  const { network, networkId, setNetworkId } = useOgNetwork();
  const router = useRouter();
  const wallet = useWalletConnection("mainnet");
  const signMessage = useSignMessage();
  const [draft, setDraft] = useState<LpAgentDraft>(INITIAL_DRAFT);
  const [workspace, setWorkspace] = useState<OgAgentWorkspace | null>(null);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [statusText, setStatusText] = useState("Connect the Policy Vault owner wallet to create a live LP agent.");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [modelCatalog, setModelCatalog] = useState<OgModelCatalogState>(EMPTY_OG_MODEL_CATALOG);
  const [openModelDropdown, setOpenModelDropdown] = useState<"fallback" | "primary" | null>(null);

  const minApr = draft.minAprPct.trim() === "" ? 0 : Number(draft.minAprPct);
  const maxApr = draft.maxAprPct.trim() === "" ? null : Number(draft.maxAprPct);
  const minValid = draft.minAprPct.trim() === "" || (Number.isFinite(minApr) && minApr >= 0);
  const maxValid = draft.maxAprPct.trim() === "" || (Number.isFinite(maxApr) && (maxApr as number) >= 0);
  const aprRangeValid = maxApr === null || (minValid && (maxApr as number) >= minApr);

  // Pool discovery: fetch the live Zia pool list (intersected with the vault
  // allowlist + W0G-leg verified on-chain) from /api/agents/lp/pools, filtered
  // by the user's APR band. Falls back to MOCK_LP_POOLS (labeled) on 503. Until
  // the first fetch resolves, MOCK_LP_POOLS is the optimistic seed so the form
  // renders immediately.
  const [poolDiscovery, setPoolDiscovery] = useState<{
    pools: readonly typeof MOCK_LP_POOLS[number][];
    qualifyingCount: number;
    total: number;
    source: "allowlist-fallback" | "mock-fallback" | "zia-tradegpt-partner";
    warning?: string;
  }>(() => ({
    pools: MOCK_LP_POOLS,
    qualifyingCount: MOCK_LP_POOLS.length,
    total: MOCK_LP_POOLS.length,
    source: "mock-fallback",
    warning: "loading pool discovery",
  }));

  useEffect(() => {
    if (!minValid) return;
    const controller = new AbortController();
    const qs = `minAprPct=${encodeURIComponent(String(minApr))}${
      draft.maxAprPct.trim() ? `&maxAprPct=${encodeURIComponent(draft.maxAprPct)}` : ""
    }`;
    fetch(`/api/agents/lp/pools?${qs}`, { signal: controller.signal })
      .then(async (res) => {
        const json = (await res.json()) as {
          data: { pools: readonly typeof MOCK_LP_POOLS[number][]; qualifyingCount: number; total: number };
          meta: { source: "allowlist-fallback" | "mock-fallback" | "zia-tradegpt-partner"; warning?: string };
        };
        setPoolDiscovery({
          pools: json.data.pools,
          qualifyingCount: json.data.qualifyingCount,
          total: json.data.total,
          source: json.meta.source,
          warning: json.meta.warning,
        });
      })
      .catch(() => {
        // Network/abort error — keep the existing state (MOCK seed or last good).
      });
    return () => controller.abort();
  }, [draft.maxAprPct, minApr, minValid]);

  // Count how many Zia pools satisfy the APR filter — the LLM picks among these.
  useEffect(() => {
    let cancelled = false;

    setModelCatalog((current) => ({
      defaultModel: current.defaultModel,
      models: current.models,
      status: "loading",
    }));

    fetch("/api/copilot/models?networkId=mainnet", { cache: "no-store" })
      .then(async (response) => {
        const payload = (await response.json()) as CopilotModelsResponse;
        if (!response.ok || !payload.data) {
          throw new Error(payload.error?.message ?? "Unable to read 0G Router model catalog.");
        }
        return payload.data;
      })
      .then((data) => {
        if (cancelled) {
          return;
        }
        const allowedModelIds = new Set(["0gm-1.0-35b-a3b", "deepseek-v4-flash"]);
        const filteredModels = data.models.filter((model) => allowedModelIds.has(model.id));
        setModelCatalog({
          defaultModel:
            data.defaultModel && allowedModelIds.has(data.defaultModel)
              ? data.defaultModel
              : filteredModels[0]?.id,
          models: filteredModels,
          status: "ready",
        });
        setDraft((current) => ({
          ...current,
          llmPrimaryModel:
            current.llmPrimaryModel && filteredModels.some((model) => model.id === current.llmPrimaryModel)
              ? current.llmPrimaryModel
              : "",
          llmFallbackModel:
            current.llmFallbackModel && filteredModels.some((model) => model.id === current.llmFallbackModel)
              ? current.llmFallbackModel
              : "",
        }));
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        setModelCatalog({
          error: error instanceof Error ? error.message : "Unable to read 0G Router model catalog.",
          models: [],
          status: "error",
        });
        setDraft((current) => ({ ...current, llmPrimaryModel: "", llmFallbackModel: "" }));
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!wallet.address) {
      setWorkspace(null);
      setWorkspaceLoading(false);
      setStatusText("Connect the Policy Vault owner wallet to create a live LP agent.");
      return;
    }
    const controller = new AbortController();
    setWorkspaceLoading(true);
    setStatusText("Resolving the mainnet Policy Vault and storage readiness.");
    const params = new URLSearchParams({ live: "1", ownerAddress: wallet.address });
    fetch(`/api/agents?${params.toString()}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload = (await response.json()) as { data?: OgAgentWorkspace; error?: { message?: string } };
        if (!response.ok || !payload.data) {
          throw new Error(payload.error?.message ?? "Unable to load agent workspace.");
        }
        setWorkspace(payload.data);
        const vaultLabel = payload.data.vault.vaultVersion ? `Policy Vault V${payload.data.vault.vaultVersion}` : "Policy Vault";
        setStatusText(
          payload.data.vault.ready
            ? `${vaultLabel} resolved. This deploy will mint an LP Agentic ID and enable its agent key.`
            : payload.data.vault.warnings?.join(" ") || "Policy Vault is not ready.",
        );
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setWorkspace(null);
        setStatusText(error instanceof Error ? error.message : "Unable to load agent workspace.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setWorkspaceLoading(false);
      });
    return () => controller.abort();
  }, [wallet.address]);

  const qualifyingPoolCount = minValid ? poolDiscovery.qualifyingCount : 0;

  // Derive the selected price band ({ lower, upper } percent offsets from current
  // price) for the range preview. null = full range. This is the band policy the
  // LLM targets; the vault enforces a max width on-chain.
  const rangeBand = useMemo(() => {
    if (draft.rangeMode === "full") return null;
    if (draft.rangeMode === "custom") {
      const lo = Number(draft.customLowerPct);
      const hi = Number(draft.customUpperPct);
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo <= 0 || hi <= 0) return null;
      return { lower: lo, upper: hi };
    }
    const n = Number(draft.rangeMode.replace("pm", ""));
    return Number.isFinite(n) && n > 0 ? { lower: n, upper: n } : null;
  }, [draft.rangeMode, draft.customLowerPct, draft.customUpperPct]);
  const customValid =
    draft.rangeMode !== "custom" ||
    (Number(draft.customLowerPct) > 0 && Number.isFinite(Number(draft.customLowerPct)) &&
      Number(draft.customUpperPct) > 0 && Number.isFinite(Number(draft.customUpperPct)));

  const maxPositionsN = Number(draft.maxPositions);
  // LP agents are capped at 3 concurrent positions (product limit).
  const maxPositionsValid = Number.isInteger(maxPositionsN) && maxPositionsN >= 1 && maxPositionsN <= 3;
  const maxPerPositionN = Number(draft.maxPerPosition0G);
  const maxPerPositionValid = maxPerPositionN > 0 && Number.isFinite(maxPerPositionN);

  const nameValid = draft.name.trim().length >= 3;
  const depositNative0G = normalizeOptional0GAmount(draft.depositNative0G);
  const depositValid = depositNative0G !== null;
  const depositRequested = depositNative0G !== null && !isZeroDecimal(depositNative0G);
  const fundLpEntryFromSwap0G =
    workspace && maxPerPositionValid
      ? suggestLpEntryFundFromSwap0G({
          depositRequested,
          maxPerPosition0G: draft.maxPerPosition0G,
          swapBalance0G: workspace.vault.v4SwapBalance0G ?? "0",
          warnings: workspace.vault.warnings ?? [],
        })
      : "0";
  const fundFromSwapRequested = !isZeroDecimal(fundLpEntryFromSwap0G);
  const ownerAddress = workspace?.vault.owner;
  const vaultAddress = workspace?.vault.vault;
  const vaultReadyForDeploy = workspace
    ? workspace.vault.ready === true ||
      (depositRequested && isLpFundingWarningSet(workspace.vault.warnings ?? [])) ||
      (fundFromSwapRequested && hasLpEntryFundingWarning(workspace.vault.warnings ?? []))
    : false;
  const isOwnerWallet = Boolean(wallet.address && ownerAddress && wallet.address.toLowerCase() === ownerAddress.toLowerCase());
  const validationIssues = useMemo(() => {
    const issues: string[] = [];
    if (!nameValid) issues.push("Agent name must be at least 3 characters.");
    if (!wallet.isConnected) issues.push("Connect the Policy Vault owner wallet.");
    if (wallet.isConnected && !isOwnerWallet) issues.push("Connected wallet must match the Policy Vault owner.");
    if (workspaceLoading) issues.push("Policy Vault readiness is still loading.");
    if (workspace && !vaultReadyForDeploy) {
      if (hasLpEntryFundingWarning(workspace.vault.warnings ?? [])) {
        issues.push("Fund LP Entry from V4 Swap before deploy.");
      } else if (isOnlyZeroBalanceWarning(workspace.vault.warnings ?? [])) {
        issues.push("Add a vault top-up or fund the Policy Vault before deploy.");
      } else {
        issues.push("Policy Vault must be ready.");
      }
    }
    if (!vaultAddress) issues.push("Policy Vault address must be resolved.");
    if (!depositValid) issues.push("Deposit must be blank, zero, or a decimal with <= 18 fractional digits.");
    if (qualifyingPoolCount <= 0) issues.push("At least one allowlisted Zia pool must match the APR filter.");
    return issues;
  }, [depositValid, isOwnerWallet, nameValid, qualifyingPoolCount, vaultAddress, vaultReadyForDeploy, wallet.isConnected, workspace, workspaceLoading]);
  const formValid =
    nameValid &&
    minValid &&
    maxValid &&
    aprRangeValid &&
    customValid &&
    maxPositionsValid &&
    maxPerPositionValid &&
    validationIssues.length === 0;

  function set<K extends keyof LpAgentDraft>(key: K, value: LpAgentDraft[K]) {
    if (key === "minAprPct" || key === "maxAprPct" || key === "maxPositions" || key === "maxPerPosition0G") {
      dispatchSigmaPetReaction("lp.create.form");
    }
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  async function onSubmit() {
    if (!formValid || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    setStatusText("Preparing single-use LP deploy consent.");
    dispatchSigmaPetReaction("lp.deploy.start", { force: true });
    try {
      if (!wallet.address || !vaultAddress || depositNative0G === null) {
        throw new Error("Wallet, vault, and deposit inputs must be ready before deploy.");
      }
      if (wallet.isWrongChain) {
        setStatusText(`Switching wallet to ${MAINNET.networkName}.`);
        dispatchSigmaPetReaction("wallet.switch.start", { force: true });
        await wallet.switchToOg();
        dispatchSigmaPetReaction("wallet.switch.success", { force: true });
      }
      // The create-form filter (maxPositions + maxPerPosition0G) is enforced
      // AGENT-side (brain/worker), persisted into the agent's runtime at deploy.
      // The vault is NOT tightened — the owner's on-chain caps stay as the hard
      // backstop. tightenPolicy is intentionally NOT part of the deploy consent
      // (it would clamp the vault's daily cap / exposure below prior spend and
      // lock all agents out — see lp-singleton-global-daily-cap memory).
      const confirmedSteps: LpDeployConsentStep[] = ["mint-agentic-id", "enable-agent-key"];
      if (fundFromSwapRequested) confirmedSteps.push("fund-lp-entry-from-v4-swap");
      if (depositRequested) confirmedSteps.push("deposit-native");
      confirmedSteps.push("first-mint");
      const triggerFirstMint = true;
      const nonceResponse = await fetch(`/api/agents/lp/deploy/nonce?address=${encodeURIComponent(wallet.address)}`, {
        cache: "no-store",
      });
      const nonceJson = (await nonceResponse.json()) as {
        data?: { nonce: string; expiresAt: number };
        error?: { message?: string };
      };
      if (!nonceResponse.ok || !nonceJson.data) {
        throw new Error(nonceJson.error?.message ?? "Unable to issue LP deploy nonce.");
      }
      const message = buildLpDeployActionConsentMessage({
        address: wallet.address,
        chainId: MAINNET.chainId,
        networkId: "mainnet",
        vault: vaultAddress,
        agentName: draft.name.trim(),
        maxPositions: maxPositionsN,
        maxPerPosition0G: draft.maxPerPosition0G.trim(),
        minAprPct: minApr,
        maxAprPct: maxApr,
        depositNative0G,
        fundLpEntryFromSwap0G,
        confirmedSteps,
        triggerFirstMint,
        nonce: nonceJson.data.nonce,
        expiresAt: nonceJson.data.expiresAt,
      });
      setStatusText("Waiting for owner signature.");
      dispatchSigmaPetReaction("wallet.signature.pending", { force: true });
      const signature = await signMessage.signMessageAsync({ message });
      setStatusText("Submitting LP deploy. The server will scan pools and try the first mint before returning.");
      const response = await fetch("/api/agents/lp/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: draft.name.trim(),
          lpFence: {
            maxPositions: maxPositionsN,
            maxPerPosition0G: draft.maxPerPosition0G.trim(),
            minAprPct: minApr,
            maxAprPct: maxApr,
          },
          depositNative0G,
          fundLpEntryFromSwap0G,
          llmModel: draft.llmPrimaryModel || undefined,
          confirmedSteps,
          triggerFirstMint,
          nonce: nonceJson.data.nonce,
          expiresAt: nonceJson.data.expiresAt,
          wallet: { address: wallet.address, chainId: MAINNET.chainId, message, signature },
        }),
      });
      const json = (await response.json()) as LpDeployResponse;
      if (!response.ok || !json.data) {
        throw new Error(json.error?.message ?? "Unable to deploy LP agent.");
      }
      const agentId = json.data.deployment?.id ?? json.data.workspace?.agent.id;
      if (!agentId) {
        throw new Error("LP agent deployed but response did not include an agent id.");
      }
      if (json.data.firstMint?.lpTxHash) {
        setStatusText("LP Agent created. First scan/mint cycle executed.");
        dispatchSigmaPetReaction("lp.deploy.mint", { force: true });
      } else if (json.data.firstMintError) {
        setStatusText(`LP Agent created. First scan returned: ${json.data.firstMintError}`);
        dispatchSigmaPetReaction("lp.deploy.no-mint", { force: true });
      } else {
        setStatusText("LP Agent created. First scan completed.");
        dispatchSigmaPetReaction("lp.deploy.no-mint", { force: true });
      }
      router.push(`/agents/lp/${agentId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "LP agent deploy failed.";
      setSubmitError(message);
      setStatusText(message);
      dispatchSigmaPetReaction("lp.deploy.fail", { force: true });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AppShell network={network} networkId={networkId} onNetworkChange={setNetworkId}>
      <main className="h-full min-h-0 overflow-y-auto px-4 py-5 lg:px-8 lg:py-7">
        <div className="mx-auto w-full max-w-6xl space-y-6 pb-10">
          <header className="space-y-3">
            <Link href="/agents/create" className="inline-flex items-center gap-2 text-sm font-semibold text-muted hover:text-foreground">
              <ArrowLeft className="h-4 w-4" />
              Back to Agent
            </Link>
            <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
              <div className="space-y-2">
                <h1 className="text-4xl font-semibold tracking-tight text-foreground">Create LP Agent</h1>
                <p className="max-w-3xl text-base leading-7 text-muted">
                  Configure a 0G-only LP agent, bind it to the Policy Vault, and mint an Agentic ID evidence record. Single-sided 0G → Zia Uniswap v3 LP.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <ZiaPoweredBadge size="md" />
                <WalletConnectButton compact networkId="mainnet" />
              </div>
            </div>
          </header>

          {/* Agent Identity — cloned from trading, dropped Strategy Template + Description. */}
          <FormPanel description="Name the LP agent." icon={<Bot className="h-5 w-5" />} title="Agent Identity">
            <Field label="Agent Name">
              <input
                value={draft.name}
                onChange={(e) => set("name", e.target.value)}
                className={inputClassName}
                placeholder="e.g. W0G/USDC LP guard"
              />
            </Field>

            <div className="grid gap-3">
              <p className="text-sm font-semibold text-foreground">Profile Image</p>
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex h-16 w-16 items-center justify-center rounded-full border border-line bg-panel text-xs font-semibold uppercase tracking-[0.16em] text-muted">
                  ID
                </div>
                <button
                  type="button"
                  disabled
                  className="inline-flex h-11 items-center gap-2 rounded-full border border-line bg-panel px-4 text-sm font-semibold text-muted"
                >
                  <Upload className="h-4 w-4" />
                  Upload image
                </button>
              </div>
              <p className="max-w-2xl text-sm leading-6 text-muted">
                Optional avatar metadata will stay redacted until Agentic ID media upload is enabled.
              </p>
            </div>
          </FormPanel>

          {/* Pool Selection Policy — APR filter for the LLM's autonomous pool pick. */}
          <FormPanel
            description="The agent (LLM via 0G Compute Router) auto-picks a qualifying Zia v3 W0G-leg pool at mint time. You set the fence; the vault enforces it on-chain."
            icon={<Bot className="h-5 w-5" />}
            title="Pool Selection Policy"
          >
            <div className="grid gap-3 lg:grid-cols-2">
              <Field label="Min APR">
                <div className="flex items-center gap-3">
                  <input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="0.1"
                    value={draft.minAprPct}
                    onChange={(e) => set("minAprPct", e.target.value)}
                    placeholder="blank = no minimum"
                    className={`${inputClassName} flex-1`}
                  />
                  <span className="text-sm font-semibold text-muted">%</span>
                </div>
              </Field>
              <Field label="Max APR">
                <div className="flex items-center gap-3">
                  <input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="0.1"
                    value={draft.maxAprPct}
                    onChange={(e) => set("maxAprPct", e.target.value)}
                    className={`${inputClassName} flex-1`}
                  />
                  <span className="text-sm font-semibold text-muted">%</span>
                </div>
              </Field>
            </div>
            {!minValid ? <p className="text-xs text-rose">Min APR must be a number ≥ 0.</p> : null}
            {minValid && !aprRangeValid ? <p className="text-xs text-rose">Max APR must be ≥ Min APR.</p> : null}

            <Readout
              label="LLM auto-pick"
              value={minValid && aprRangeValid ? `${qualifyingPoolCount} of ${poolDiscovery.total} Zia pools match` : "—"}
            />
            <p className="text-xs leading-5 text-muted">
              APR is the advertised staking-reward APR from the Zia vault. The LLM chooses among matching pools; the vault rejects any pool outside the allowlist.
            </p>
            {poolDiscovery.source === "mock-fallback" ? (
              <p className="text-xs leading-5 text-amber">
                {poolDiscovery.warning ?? "mock — partner URL not configured"} · showing fallback pool set.
              </p>
            ) : null}
          </FormPanel>

          {/* Risk Policy — max positions + max 0G per position (vault-enforced fence).
              Total exposure is bounded by the vault balance; per-position cap is the
              granular risk control so no single LP NFT eats too much of the deposit. */}
          <FormPanel
            description="Hard limits the Policy Vault enforces on-chain. The LLM cannot exceed these regardless of its decision."
            icon={<Bot className="h-5 w-5" />}
            title="Risk Policy"
          >
            <div className="grid gap-3 lg:grid-cols-2">
              <Field label="Max positions">
                <div className="flex items-center gap-3">
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={10}
                    step={1}
                    value={draft.maxPositions}
                    onChange={(e) => set("maxPositions", e.target.value)}
                    className={`${inputClassName} flex-1`}
                  />
                  <span className="text-sm font-semibold text-muted">pos</span>
                </div>
              </Field>
              <Field label="Max 0G per position">
                <div className="flex items-center gap-3">
                  <input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="0.01"
                    value={draft.maxPerPosition0G}
                    onChange={(e) => set("maxPerPosition0G", e.target.value)}
                    className={`${inputClassName} flex-1`}
                  />
                  <span className="text-sm font-semibold text-muted">0G</span>
                </div>
              </Field>
            </div>
            {!maxPositionsValid ? <p className="text-xs text-rose">Max positions must be an integer 1–3.</p> : null}
            {!maxPerPositionValid ? <p className="text-xs text-rose">Max 0G per position must be greater than 0.</p> : null}
            <p className="text-xs leading-5 text-muted">
              Max positions caps concurrent LP NFTs the agent may hold. Max 0G per position caps how much the agent may
              deploy into a single LP NFT — total exposure is bounded by your vault deposit.
            </p>
          </FormPanel>

          {/* LLM Model - uses the same Router catalog as Copilot/chat. */}
          <FormPanel
            description="The agent's autonomous pool and range decisions route through the 0G Compute Router. Pick the primary model and fallback model for the loop."
            icon={<Sparkles className="h-5 w-5" />}
            title="LLM Model"
          >
            <div
              className={`grid gap-3 transition-[margin-bottom] duration-200 lg:grid-cols-2 ${
                openModelDropdown ? "mb-[19.25rem]" : ""
              }`}
            >
              <Field label="Primary Model">
                <OgModelSelector
                  ariaLabel="Primary LLM model"
                  catalog={modelCatalog}
                  selectedModel={draft.llmPrimaryModel}
                  onChange={(model) => set("llmPrimaryModel", model)}
                  onOpenChange={(open) =>
                    setOpenModelDropdown((current) => (open ? "primary" : current === "primary" ? null : current))
                  }
                  className="relative flex min-w-0 w-full items-center"
                  menuClassName="absolute left-0 right-0 top-full z-[120] mt-1.5 max-h-[300px] overflow-y-auto rounded-[14px] border border-line bg-panel-solid-strong p-1 shadow-[0_18px_52px_rgba(0,0,0,0.55)] scrollbar-subtle"
                  triggerClassName="inline-flex h-12 w-full items-center gap-2 rounded-full border border-line bg-panel px-4 text-sm font-semibold text-foreground outline-none transition-[background-color,border-color,color,transform] hover:border-line-strong active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
                />
              </Field>
              <Field label="Fallback Model">
                <OgModelSelector
                  ariaLabel="Fallback LLM model"
                  catalog={modelCatalog}
                  selectedModel={draft.llmFallbackModel}
                  onChange={(model) => set("llmFallbackModel", model)}
                  onOpenChange={(open) =>
                    setOpenModelDropdown((current) => (open ? "fallback" : current === "fallback" ? null : current))
                  }
                  className="relative flex min-w-0 w-full items-center"
                  menuClassName="absolute left-0 right-0 top-full z-[120] mt-1.5 max-h-[300px] overflow-y-auto rounded-[14px] border border-line bg-panel-solid-strong p-1 shadow-[0_18px_52px_rgba(0,0,0,0.55)] scrollbar-subtle"
                  triggerClassName="inline-flex h-12 w-full items-center gap-2 rounded-full border border-line bg-panel px-4 text-sm font-semibold text-foreground outline-none transition-[background-color,border-color,color,transform] hover:border-line-strong active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
                />
              </Field>
            </div>
            <Readout
              label="Reasoning path"
              value="0G Compute Router · server-only"
            />
            <p className="text-xs leading-5 text-muted">
              The Router never handles funds — it only returns a (pool, band, amount) decision. The Policy Vault
              enforces it on-chain. Model options are fetched server-side from the same Router catalog used by Copilot/chat.
            </p>
          </FormPanel>

          {/* Price Range & Deposit — range band options (Full / ±5% / ±12% / ±20% / Custom). */}
          <FormPanel description="Single-sided zap-in: 0G → W0G → swap to pair → mint." icon={<Bot className="h-5 w-5" />} title="Price Range & Deposit">
            {/* "Let the LLM decide" — for users who don't know which band to pick. */}
            <label className="inline-flex cursor-pointer items-center gap-3 py-1">
              <input
                type="checkbox"
                checked={draft.llmPicksRange}
                onChange={(e) => set("llmPicksRange", e.target.checked)}
                className="h-5 w-5 shrink-0 cursor-pointer accent-[var(--color-primary)]"
              />
              <span className="min-w-0 text-sm font-semibold text-foreground">Let the LLM choose the optimal range</span>
              <span className="min-w-0 text-xs font-semibold text-muted">(mint-time pick, vault-capped width)</span>
            </label>
            <div className={`flex flex-wrap items-center gap-2 rounded-full border border-line bg-panel p-1 ${draft.llmPicksRange ? "pointer-events-none opacity-40" : ""}`}>
              {RANGE_OPTIONS.map((opt) => (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => set("rangeMode", opt.key)}
                  className={`h-9 flex-1 rounded-full px-3 text-sm font-semibold transition-colors ${
                    draft.rangeMode === opt.key ? "bg-primary text-on-primary" : "text-muted hover:text-foreground"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {draft.rangeMode === "custom" && !draft.llmPicksRange ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Below current (%)">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-muted">-</span>
                    <input
                      type="number"
                      inputMode="decimal"
                      min={0.1}
                      step="0.1"
                      value={draft.customLowerPct}
                      onChange={(e) => set("customLowerPct", e.target.value)}
                      className={`${inputClassName} flex-1`}
                    />
                    <span className="text-sm font-semibold text-muted">%</span>
                  </div>
                </Field>
                <Field label="Above current (%)">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-muted">+</span>
                    <input
                      type="number"
                      inputMode="decimal"
                      min={0.1}
                      step="0.1"
                      value={draft.customUpperPct}
                      onChange={(e) => set("customUpperPct", e.target.value)}
                      className={`${inputClassName} flex-1`}
                    />
                    <span className="text-sm font-semibold text-muted">%</span>
                  </div>
                </Field>
              </div>
            ) : null}
            {!customValid && !draft.llmPicksRange ? <p className="text-xs text-rose">Both sides of the custom range must be greater than 0.</p> : null}

            {!draft.llmPicksRange ? (
              <LpRangePreview
                band={rangeBand}
                onChange={
                  draft.rangeMode === "custom"
                    ? (next) => {
                        setDraft((prev) => ({
                          ...prev,
                          customLowerPct: String(next.lower),
                          customUpperPct: String(next.upper),
                        }));
                      }
                    : undefined
                }
              />
            ) : null}

            <Field label="Optional vault top-up (native 0G)">
              <div className="flex items-center gap-3">
                <input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="0.001"
                  value={draft.depositNative0G}
                  onChange={(e) => set("depositNative0G", e.target.value)}
                  placeholder="blank or 0 = use existing vault balance"
                  className={`${inputClassName} flex-1`}
                />
                <span className="shrink-0 rounded-full border border-line bg-panel px-4 py-2 text-sm font-semibold text-muted">0G</span>
              </div>
              {!depositValid && draft.depositNative0G.length > 0 ? (
                <p className="mt-1 text-xs text-rose">Use blank, zero, or a decimal with no more than 18 digits after the dot.</p>
              ) : null}
              <p className="mt-1 text-xs leading-5 text-muted">
                Default is no top-up. A deposit tx is included only when this amount is greater than zero.
              </p>
            </Field>
            <Readout label="Zap-in path" value="0G → W0G → swap to pair → mint" />
          </FormPanel>

          {/* Automation Controls — 4 cards ported from 4alpha. All coming soon. */}
          <FormPanel description="All four automations are coming soon. Toggles are preview-only." icon={<Bot className="h-5 w-5" />} title="Automation Controls">
            <div className="grid gap-3 sm:grid-cols-2">
              {AUTOMATION_MODULES.map((m) => (
                <AutomationModuleCard
                  key={m.key}
                  icon={m.icon}
                  title={m.title}
                  subtitle={m.subtitle}
                  inactiveSummary={m.inactiveSummary}
                  tone={m.tone}
                  enabled={draft.automation[m.key]}
                />
              ))}
            </div>
          </FormPanel>

          {/* Deploy Review */}
          <FormPanel description="Confirm the LP agent setup before deploying." icon={<Bot className="h-5 w-5" />} title="Deploy Review">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <ReviewMetric icon={<Bot className="h-3.5 w-3.5" />} label="Agent" value={nameValid ? draft.name : "—"} />
              <ReviewMetric
                icon={<Bot className="h-3.5 w-3.5" />}
                label="Pool selection"
                value={minValid && aprRangeValid ? `LLM auto-pick · ${qualifyingPoolCount}/${poolDiscovery.total}` : "—"}
              />
              <ReviewMetric icon={<Bot className="h-3.5 w-3.5" />} label="APR band" value={minValid ? `${minApr}% – ${maxApr === null ? "∞" : `${maxApr}%`}` : "—"} />
              <ReviewMetric
                icon={<Bot className="h-3.5 w-3.5" />}
                label="Range"
                value={
                  draft.llmPicksRange
                    ? "LLM pick"
                    : draft.rangeMode === "full"
                      ? "Full range"
                      : draft.rangeMode === "custom"
                        ? customValid
                          ? `-${draft.customLowerPct}% / +${draft.customUpperPct}%`
                          : "—"
                        : `±${draft.rangeMode.replace("pm", "")}%`
                }
              />
              <ReviewMetric icon={<Bot className="h-3.5 w-3.5" />} label="Max positions" value={maxPositionsValid ? `${draft.maxPositions}` : "—"} />
              <ReviewMetric icon={<Bot className="h-3.5 w-3.5" />} label="Max / position" value={maxPerPositionValid ? `${draft.maxPerPosition0G} 0G` : "—"} />
              <ReviewMetric icon={<Sparkles className="h-3.5 w-3.5" />} label="Primary model" value={modelSelectionLabel(modelCatalog, draft.llmPrimaryModel)} />
              <ReviewMetric icon={<Sparkles className="h-3.5 w-3.5" />} label="Fallback model" value={modelSelectionLabel(modelCatalog, draft.llmFallbackModel)} />
              <ReviewMetric icon={<Bot className="h-3.5 w-3.5" />} label="Vault" value={vaultAddress ? shortAddress(vaultAddress) : "not ready"} />
              <ReviewMetric icon={<Bot className="h-3.5 w-3.5" />} label="Deposit" value={depositRequested ? `${depositNative0G} 0G` : "No top-up"} />
              {fundFromSwapRequested ? (
                <ReviewMetric icon={<Bot className="h-3.5 w-3.5" />} label="LP Entry fund" value={`${fundLpEntryFromSwap0G} 0G from V4 Swap`} />
              ) : null}
              <ReviewMetric
                icon={<Bot className="h-3.5 w-3.5" />}
                label="First cycle"
                value="Scan + mint immediately"
              />
            </div>
            <div className="mt-4 rounded-[18px] border border-line bg-panel px-4 py-3">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 text-primary">
                  {workspaceLoading || submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-foreground">{statusText}</p>
                  <p className="mt-1 text-xs leading-5 text-muted">
                    Signed steps: mint Agentic ID + enable agent key{fundFromSwapRequested ? " + fund LP Entry from V4 Swap" : ""}{depositRequested ? " + deposit native 0G" : ""} + scan/mint now. Auto-mint stays ON for later cycles; toggle it off on the detail page.
                  </p>
                  {submitError ? <p className="mt-2 text-xs font-semibold text-rose">{submitError}</p> : null}
                </div>
              </div>
            </div>
            <div className="mt-5 flex flex-col gap-2 sm:flex-row">
              <button
                type="button"
                onClick={onSubmit}
                disabled={!formValid || submitting}
                className="inline-flex h-12 flex-1 items-center justify-center gap-2 rounded-full bg-primary px-4 text-sm font-semibold text-on-primary transition-[filter,transform] hover:brightness-105 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitting ? "Signing..." : "Sign & Create LP Agent"}
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
              </button>
              <Link
                href="/agents/create"
                className="inline-flex h-12 items-center justify-center gap-2 rounded-full border border-line bg-panel px-4 text-sm font-semibold text-foreground transition-colors hover:border-line-strong"
              >
                <ArrowLeft className="h-4 w-4" />
                Cancel
              </Link>
            </div>
            {!formValid ? (
              <div className="mt-3 space-y-1">
                {validationIssues.slice(0, 4).map((issue) => (
                  <p key={issue} className="text-xs text-rose">{issue}</p>
                ))}
              </div>
            ) : null}
          </FormPanel>
        </div>
      </main>
    </AppShell>
  );
}

// ---- inline helpers (ported from trading create, restyled to 0G tokens). ----

function FormPanel({ children, description, icon, title }: { children: ReactNode; description: string; icon: ReactNode; title: string }) {
  return (
    <section className="rounded-[28px] border border-line bg-panel-solid-strong/94 p-5 shadow-[0_18px_58px_rgba(0,0,0,0.22)] lg:p-6">
      <div className="mb-6 flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <span className="text-primary">{icon}</span>
          <h2 className="text-xl font-semibold text-foreground">{title}</h2>
        </div>
        <p className="text-sm leading-6 text-muted">{description}</p>
      </div>
      <div className="space-y-5">{children}</div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="block">
      <span className="mb-2 block text-sm font-semibold text-foreground">{label}</span>
      {children}
    </div>
  );
}

function Readout({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-full border border-line bg-panel px-4 py-2.5">
      <span className="text-xs font-semibold uppercase tracking-[0.16em] text-muted">{label}</span>
      <span className="font-mono text-xs font-semibold text-foreground">{value}</span>
    </div>
  );
}

function ReviewMetric({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-[18px] border border-line bg-panel px-4 py-3">
      <div className="flex items-center gap-2 text-muted">
        <span className="text-primary">{icon}</span>
        <span className="text-[10px] font-semibold uppercase tracking-[0.2em]">{label}</span>
      </div>
      <p className="mt-2 truncate font-mono text-sm font-semibold text-foreground" title={value}>
        {value}
      </p>
    </div>
  );
}

function modelSelectionLabel(catalog: OgModelCatalogState, selectedModel: string): string {
  if (selectedModel) {
    return catalog.models.find((model) => model.id === selectedModel)?.label ?? shortModelLabel(selectedModel);
  }
  return catalog.defaultModel ? `Auto · ${shortModelLabel(catalog.defaultModel)}` : "Auto Router";
}

function normalizeOptional0GAmount(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return "0";
  if (!/^\d+(?:\.\d{1,18})?$/u.test(trimmed)) return null;
  return trimmed;
}

function isZeroDecimal(value: string): boolean {
  return /^0+(?:\.0+)?$/u.test(value);
}

function isOnlyZeroBalanceWarning(warnings: string[]): boolean {
  return warnings.length > 0 && warnings.every((warning) => warning === "Policy Vault has no 0G balance.");
}

function hasLpEntryFundingWarning(warnings: string[]): boolean {
  return warnings.some((warning) => warning.startsWith("LP Entry has no 0G balance;"));
}

function isLpFundingWarningSet(warnings: string[]): boolean {
  return warnings.length > 0 && warnings.every((warning) => warning === "Policy Vault has no 0G balance." || warning.startsWith("LP Entry has no 0G balance;"));
}

function suggestLpEntryFundFromSwap0G({
  depositRequested,
  maxPerPosition0G,
  swapBalance0G,
  warnings,
}: {
  depositRequested: boolean;
  maxPerPosition0G: string;
  swapBalance0G: string;
  warnings: string[];
}): string {
  if (depositRequested || !hasLpEntryFundingWarning(warnings)) return "0";
  const maxWei = parse0GAmount(maxPerPosition0G);
  const swapWei = parse0GAmount(swapBalance0G);
  if (maxWei === null || swapWei === null || maxWei <= 0n || swapWei <= 0n) return "0";
  return formatEther(maxWei < swapWei ? maxWei : swapWei);
}

function parse0GAmount(value: string): bigint | null {
  try {
    return parseEther(value.trim());
  } catch {
    return null;
  }
}

function shortAddress(value: string): string {
  return value.length > 12 ? `${value.slice(0, 6)}...${value.slice(-4)}` : value;
}

export type { LpAgentDraft };
