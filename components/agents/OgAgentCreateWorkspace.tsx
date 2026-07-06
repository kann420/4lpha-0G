"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Bot,
  Brain,
  ChevronDown,
  Database,
  FileCheck2,
  Loader2,
  RefreshCcw,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Upload,
  Zap,
} from "lucide-react";
import { useSignMessage } from "wagmi";
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  type Chain,
  type EIP1193Provider,
  type Hex,
} from "viem";
import { AppShell } from "@/components/app/AppShell";
import { useOgNetwork } from "@/components/app/useOgNetwork";
import { shortHash } from "@/components/agents/OgAgentWorkspace";
import { WalletConnectButton } from "@/components/wallet";
import { useWalletConnection } from "@/components/wallet/useWalletConnection";
import { buildCopilotWalletAccessMessage } from "@/lib/copilot/wallet-access";
import { policyVaultAgentKeyAbi } from "@/lib/contracts/policy-vault";
import { getOgNetwork } from "@/lib/og/networks";
import { type OgAgentFilterId, type OgAgentWorkspace } from "@/lib/agent/single-agent";

type DeployResponse = {
  data?: {
    workspace: OgAgentWorkspace;
  };
  error?: {
    code: string;
    message: string;
  };
};

type TakeProfitTarget = {
  id: string;
  profitPercent: string;
  sellPercent: string;
};

type StrategyTemplateId = "policy-guarded" | "proof-strict" | "stable-route" | "blue-chip-rotation" | "mixed";
type MoneyUnit = "0G" | "USD";
type AgentWalletProof = {
  address: string;
  chainId: number;
  message: string;
  signature: string;
};

const MAINNET = getOgNetwork("mainnet");

const STRATEGY_TEMPLATES: Array<{
  description: string;
  filterIds: OgAgentFilterId[];
  label: string;
  recommended?: boolean;
  value: StrategyTemplateId;
}> = [
  {
    description: "Capital guard plus proof strict checks for the default 0G mainnet agent.",
    filterIds: ["capital-guard", "proof-strict"],
    label: "Policy Guarded",
    recommended: true,
    value: "policy-guarded",
  },
  {
    description: "Requires storage evidence, policy hash, vault action hash, and Agentic ID reference.",
    filterIds: ["proof-strict"],
    label: "Proof Strict",
    value: "proof-strict",
  },
  {
    description: "USDC.e-focused stable route for proof and storage smoke loops.",
    filterIds: ["stable-route"],
    label: "Stable Route",
    value: "stable-route",
  },
  {
    description: "High-confidence ZIA blue-chip route family.",
    filterIds: ["blue-chip-rotation"],
    label: "Blue-chip Rotation",
    value: "blue-chip-rotation",
  },
  {
    description: "Combines every available 0G route filter into one strategy preset.",
    filterIds: ["capital-guard", "blue-chip-rotation", "stable-route", "proof-strict"],
    label: "Mixed",
    value: "mixed",
  },
];

const MONEY_UNIT_OPTIONS: Array<{ label: string; value: MoneyUnit }> = [
  { label: "0G", value: "0G" },
  { label: "USD", value: "USD" },
];

function getStrategyTemplate(value: StrategyTemplateId) {
  return STRATEGY_TEMPLATES.find((template) => template.value === value) ?? STRATEGY_TEMPLATES[0]!;
}

const PRIMARY_MODELS = [
  "Auto: OGM-1.0-35B-A3B",
  "Llama 3.3 70B",
  "DeepSeek R1",
  "Qwen 2.5 72B",
];

const FALLBACK_MODELS = [
  "Router fallback pool",
  "Llama 3.1 8B",
  "Qwen 2.5 7B",
];

export function OgAgentCreateWorkspace() {
  const router = useRouter();
  const { network, networkId, setNetworkId } = useOgNetwork();
  const wallet = useWalletConnection(networkId);
  const signMessage = useSignMessage();
  const [workspace, setWorkspace] = useState<OgAgentWorkspace | null>(null);
  const [name, setName] = useState("");
  const [strategyTemplate, setStrategyTemplate] = useState<StrategyTemplateId>("policy-guarded");
  const [signalConfidence, setSignalConfidence] = useState("75");
  const [maxPositions, setMaxPositions] = useState("2");
  const [takeProfits, setTakeProfits] = useState<TakeProfitTarget[]>([
    { id: "tp1", profitPercent: "15", sellPercent: "50" },
    { id: "tp2", profitPercent: "25", sellPercent: "50" },
  ]);
  const [moonbagStop, setMoonbagStop] = useState(true);
  const [stopLoss, setStopLoss] = useState("50");
  const [trailingStop, setTrailingStop] = useState(true);
  const [maxHoldingTime, setMaxHoldingTime] = useState("30");
  const [maxCapitalPerTrade, setMaxCapitalPerTrade] = useState("0.001");
  const [maxCapitalPerTradeUnit, setMaxCapitalPerTradeUnit] = useState<MoneyUnit>("0G");
  const [dailyLossLimit, setDailyLossLimit] = useState("0.005");
  const [dailyLossLimitUnit, setDailyLossLimitUnit] = useState<MoneyUnit>("0G");
  const [slippageTolerance, setSlippageTolerance] = useState("0.75");
  const [cooldownAfterLoss, setCooldownAfterLoss] = useState(false);
  const [rugProtection, setRugProtection] = useState(true);
  const [gasPriority, setGasPriority] = useState("Standard");
  const [executionTarget, setExecutionTarget] = useState("Policy Vault");
  const [executionMode, setExecutionMode] = useState("Live 0G Policy Vault or proof preview");
  const [advancedOpen, setAdvancedOpen] = useState(true);
  const [globalLearning, setGlobalLearning] = useState(true);
  const [primaryModel, setPrimaryModel] = useState(PRIMARY_MODELS[0]);
  const [fallbackModel, setFallbackModel] = useState(FALLBACK_MODELS[0]);
  const [instructions, setInstructions] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isDeploying, setIsDeploying] = useState(false);
  const [isMigrating, setIsMigrating] = useState(false);
  const [statusText, setStatusText] = useState("Loading vault and identity state.");
  const [walletAccessByKey, setWalletAccessByKey] = useState<Record<string, string>>({});

  async function loadWorkspace() {
    if (!wallet.address) {
      setWorkspace(null);
      setIsLoading(false);
      setStatusText("Connect a wallet to resolve its Policy Vault and Agentic IDs.");
      return;
    }

    setIsLoading(true);
    try {
      const params = new URLSearchParams({
        live: "1",
        ownerAddress: wallet.address,
      });
      const response = await fetch(`/api/agents?${params.toString()}`, { cache: "no-store" });
      const payload = (await response.json()) as { data?: OgAgentWorkspace; error?: { message: string } };
      if (!response.ok || !payload.data) {
        throw new Error(payload.error?.message ?? "Unable to load agent workspace.");
      }
      setWorkspace(payload.data);
      if (payload.data.vault.policy) {
        setDailyLossLimit(trimDecimal(payload.data.vault.policy.dailyCap0G));
        setSlippageTolerance(String((10000 - payload.data.vault.policy.defaultMinOutBps) / 100));
      }
      if (payload.data.vault.vault) {
        setExecutionTarget(`Policy Vault - ${shortHash(payload.data.vault.vault)}`);
      }
      setStatusText(
        payload.data.agents.length
          ? "Existing Agentic IDs are preserved. This form mints a new agent record."
          : "Choose a strategy, sign with the Policy Vault owner wallet, then mint the Agentic ID.",
      );
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : "Unable to load agent workspace.");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadWorkspace();
  }, [wallet.address]);

  const activeStrategy = useMemo(() => getStrategyTemplate(strategyTemplate), [strategyTemplate]);
  const selectedFilterIds = activeStrategy.filterIds;
  const selectedFilterDetails = useMemo(
    () => {
      const filterIdSet = new Set(activeStrategy.filterIds);
      return workspace?.filters.filter((filter) => filterIdSet.has(filter.id)) ?? [];
    },
    [activeStrategy, workspace?.filters],
  );
  const ownerAddress = workspace?.vault.owner;
  const isOwnerWallet = Boolean(wallet.address && ownerAddress && wallet.address.toLowerCase() === ownerAddress.toLowerCase());
  const walletAccessKey = wallet.address ? `${networkId}:${network.chainId}:${wallet.address.toLowerCase()}` : undefined;
  const walletActionMessage = getOwnerWalletMessage({
    isConnected: wallet.isConnected,
    isOwnerWallet,
    isWrongChain: wallet.isWrongChain,
    ownerAddress,
    walletAddress: wallet.address,
  });

  const latestDeployment = workspace?.agents.at(-1);
  const hasExistingAgents = Boolean(latestDeployment);
  const validationIssues = useMemo(() => {
    const issues: string[] = [];
    if (name.trim().length < 3) issues.push("Agent name must be at least 3 characters.");
    if (!selectedFilterIds.length) issues.push("Select a strategy template.");
    if (!wallet.isConnected || !isOwnerWallet) issues.push("Policy Vault owner wallet must sign this Agentic ID update.");
    if (workspace && workspace.vault.ready !== true) issues.push("Policy Vault must be ready.");
    if (workspace && workspace.storage.uploadReady !== true) issues.push("0G Storage upload must be ready.");
    return issues;
  }, [isOwnerWallet, name, selectedFilterIds.length, wallet.isConnected, workspace]);

  const canDeploy = validationIssues.length === 0 && !isDeploying && !isLoading;
  const selectedRouteLabel = selectedFilterDetails.length
    ? selectedFilterDetails.map((filter) => filter.label).join(" + ")
    : activeStrategy.label;

  function updateTakeProfit(id: string, patch: Partial<TakeProfitTarget>) {
    setTakeProfits((current) =>
      current.map((target) => (target.id === id ? { ...target, ...patch } : target)),
    );
  }

  function addTakeProfit() {
    setTakeProfits((current) =>
      current.length >= 4
        ? current
        : [
            ...current,
            {
              id: `tp${current.length + 1}`,
              profitPercent: String(25 + current.length * 10),
              sellPercent: "25",
            },
          ],
    );
  }

  function removeTakeProfit(id: string) {
    setTakeProfits((current) => (current.length <= 1 ? current : current.filter((target) => target.id !== id)));
  }

  async function ensureOwnerWalletProof(): Promise<AgentWalletProof> {
    if (!wallet.address) {
      throw new Error("Connect the Policy Vault owner wallet first.");
    }
    if (!ownerAddress || wallet.address.toLowerCase() !== ownerAddress.toLowerCase()) {
      throw new Error("Connected wallet is not the Policy Vault owner.");
    }
    if (wallet.isWrongChain) {
      setStatusText(`Switching wallet to ${network.networkName}.`);
      await wallet.switchToOg();
    }
    const message = buildCopilotWalletAccessMessage({
      address: wallet.address,
      chainId: network.chainId,
      networkId,
    });
    const cached = walletAccessKey ? walletAccessByKey[walletAccessKey] : undefined;
    const signature = cached ?? await signMessage.signMessageAsync({ message });
    if (walletAccessKey && !cached) {
      setWalletAccessByKey((current) => ({ ...current, [walletAccessKey]: signature }));
    }
    return {
      address: wallet.address,
      chainId: network.chainId,
      message,
      signature,
    };
  }

  async function deployAgent() {
    if (!canDeploy) {
      return;
    }
    setIsDeploying(true);
    setStatusText("Uploading redacted metadata to 0G Storage and minting Agentic ID.");
    try {
      const walletProof = await ensureOwnerWalletProof();
      const response = await fetch("/api/agents/deploy", {
        body: JSON.stringify({
          filterIds: selectedFilterIds,
          name,
          runtime: {
            maxCapitalPerTrade0G: maxCapitalPerTradeUnit === "0G" ? maxCapitalPerTrade : undefined,
            maxHoldingMinutes: Number.parseInt(maxHoldingTime, 10),
            maxPositions: Number.parseInt(maxPositions, 10),
            signalConfidence: Number.parseInt(signalConfidence, 10),
            slippageBps: Math.round(Number.parseFloat(slippageTolerance) * 100),
          },
          wallet: walletProof,
        }),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      });
      const payload = (await response.json()) as DeployResponse;
      if (!response.ok || !payload.data) {
        throw new Error(payload.error?.message ?? "Unable to deploy agent.");
      }
      await enableAgentKeyOnActiveVault(payload.data.workspace);
      setWorkspace(payload.data.workspace);
      setStatusText("Agentic ID minted and bound to the Policy Vault.");
      router.push(`/agents/${payload.data.workspace.agent.id}`);
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : "Unable to deploy agent.");
    } finally {
      setIsDeploying(false);
    }
  }

  async function enableAgentKeyOnActiveVault(nextWorkspace: OgAgentWorkspace) {
    const deployment = nextWorkspace.agent.deployment;
    const vault = nextWorkspace.vault.vault;
    if (!deployment?.agentKey || !vault || (nextWorkspace.vault.vaultVersion ?? 1) < 2) {
      return;
    }
    const provider = typeof window === "undefined"
      ? undefined
      : (window as Window & { ethereum?: EIP1193Provider }).ethereum;
    if (!provider) {
      throw new Error("Wallet provider is required to enable the V2 agent key.");
    }
    setStatusText("Waiting for wallet confirmation to enable this agent on PolicyVaultV2.");
    const chain = make0GMainnetChain(network.rpcUrl);
    const publicClient = createPublicClient({ chain, transport: http(network.rpcUrl) });
    const walletClient = createWalletClient({ chain, transport: custom(provider) });
    const [account] = await walletClient.getAddresses();
    if (!account || !ownerAddress || account.toLowerCase() !== ownerAddress.toLowerCase()) {
      throw new Error("Connected wallet is not the Policy Vault owner.");
    }
    const txHash = await walletClient.writeContract({
      account,
      address: vault,
      abi: policyVaultAgentKeyAbi,
      functionName: "setAgentKeyEnabled",
      args: [deployment.agentKey as Hex, true],
    });
    setStatusText("Agent key enable submitted. Waiting for confirmation.");
    await waitForReceipt(publicClient, txHash);
  }

  // v2 -> v3 migration: the V3 singleton is deployed offline via `npm run vault:mainnet:create:v3`
  // (no on-chain V3 factory on mainnet). This button re-points the owner's agent records to the
  // V3 vault and re-enables each agent key on V3 (server-side, DEPLOYER pays gas). Funds movement
  // (V2 withdraw / V3 deposit) stays on the manual controls. Only shown when a V3 vault exists for
  // the owner but the agent records still point at a V2 vault.
  const v3VaultAddress = workspace?.vault.vault;
  const v3MigrationAvailable = Boolean(
    workspace &&
      (workspace.vault.vaultVersion ?? 1) >= 3 &&
      v3VaultAddress &&
      workspace.agents.some((agent) => agent.vault.toLowerCase() !== v3VaultAddress.toLowerCase()),
  );

  async function migrateToV3() {
    if (!v3MigrationAvailable) {
      return;
    }
    setIsMigrating(true);
    setStatusText("Waiting for wallet signature to authorize V3 vault migration.");
    try {
      const walletProof = await ensureOwnerWalletProof();
      const response = await fetch("/api/agents/migrate-vault", {
        body: JSON.stringify({ wallet: walletProof }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json()) as { data?: { workspace: OgAgentWorkspace }; error?: { message: string } };
      if (!response.ok || !payload.data) {
        throw new Error(payload.error?.message ?? "V3 vault migration failed.");
      }
      setWorkspace(payload.data.workspace);
      setStatusText("Agent records migrated to the V3 Policy Vault; agent keys re-enabled on V3.");
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : "V3 vault migration failed.");
    } finally {
      setIsMigrating(false);
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
                <h1 className="text-4xl font-semibold tracking-tight text-foreground">Create Agent</h1>
                <p className="max-w-3xl text-base leading-7 text-muted">
                  Configure a 0G-only trading agent, bind it to the Policy Vault, and mint an Agentic ID evidence record.
                </p>
              </div>
              <button
                type="button"
                onClick={() => void loadWorkspace()}
                disabled={isLoading || isDeploying}
                className="inline-flex h-11 w-fit items-center justify-center gap-2 rounded-full border border-line bg-panel px-4 text-sm font-semibold text-foreground transition-colors hover:bg-panel-strong disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RefreshCcw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
                Refresh
              </button>
            </div>
          </header>

          {v3MigrationAvailable ? (
            <section className="animate-feed-reveal rounded-card border border-amber/20 bg-amber/[0.06] p-5">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-semibold text-amber">
                    <AlertTriangle className="h-4 w-4" />
                    V3 Policy Vault migration available
                  </div>
                  <p className="mt-2 text-sm leading-6 text-muted">
                    A V3 Policy Vault with Zia LP support exists for this wallet. Re-point your agent records to V3 and re-enable each agent key on the V3 vault. The deployer key pays the on-chain enable gas; move native 0G from V2 to V3 via the manual controls.
                  </p>
                  <p className="mt-2 text-xs leading-5 text-muted">{statusText}</p>
                </div>
                <button
                  type="button"
                  disabled={isMigrating || isDeploying}
                  onClick={() => void migrateToV3()}
                  className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-full border border-amber/20 bg-amber/[0.1] px-4 text-sm font-semibold text-amber transition hover:bg-amber/[0.16] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isMigrating ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                  Migrate to V3
                </button>
              </div>
            </section>
          ) : null}

          <section className="rounded-[22px] border border-line bg-panel-solid-strong px-5 py-4">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3">
                <span className="flex h-11 w-11 items-center justify-center rounded-full border border-primary/20 bg-primary/10 text-primary">
                  <Shield className="h-5 w-5" />
                </span>
                <div>
                  <p className="text-sm font-semibold text-foreground">0G Mainnet</p>
                  <p className="text-sm text-muted">Policy Vault / Agentic ID / 0G Storage</p>
                </div>
              </div>
              <span className="w-fit rounded-full border border-line bg-panel px-4 py-2 text-sm font-semibold text-foreground">
                Native unit: 0G
              </span>
            </div>
          </section>

          <FormPanel
            description="Name the agent and choose the operating template."
            icon={<Bot className="h-5 w-5" />}
            title="Agent Identity"
          >
            <div className="grid gap-5 lg:grid-cols-2">
              <Field label="Agent Name">
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  disabled={isDeploying}
                  className={inputClassName}
                  placeholder="e.g. Alpha 0G Scout"
                />
              </Field>

              <Field label="Strategy Template">
                <SelectShell>
                  <select
                    value={strategyTemplate}
                    onChange={(event) => setStrategyTemplate(event.target.value as StrategyTemplateId)}
                    disabled={isDeploying}
                    className={selectClassName}
                  >
                    {STRATEGY_TEMPLATES.map((template) => (
                      <option key={template.value} value={template.value} className="bg-panel-solid-strong text-foreground">
                        {template.label}
                        {template.recommended ? " (Recommended)" : ""}
                      </option>
                    ))}
                  </select>
                </SelectShell>
                <div className="mt-2 space-y-1 text-sm leading-6 text-muted">
                  <p>{activeStrategy.description}</p>
                  <p>Route filters: {selectedRouteLabel}</p>
                </div>
              </Field>
            </div>

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

          <FormPanel
            description="Set the filters that decide when the agent can route a buy or sell."
            icon={<Zap className="h-5 w-5" />}
            title="Entry & Exit Logic"
          >
            <div className="grid gap-6 xl:grid-cols-2">
              <div className="space-y-5">
                <SectionEyebrow>Entry</SectionEyebrow>
                <div className="grid gap-5 sm:grid-cols-[9rem_minmax(0,1fr)]">
                  <Field label="AI Signal Confident">
                    <NumberWithSuffix value={signalConfidence} onChange={setSignalConfidence} suffix="%" />
                  </Field>
                  <div className="rounded-full border border-primary/20 bg-primary/10 px-4 py-3 text-sm font-semibold text-primary">
                    Agent will decide market scan timing, but vault policy controls spend and slippage.
                  </div>
                </div>
                <Field label="Max Positions">
                  <input
                    value={maxPositions}
                    onChange={(event) => setMaxPositions(event.target.value)}
                    className={inputClassName}
                    inputMode="numeric"
                  />
                </Field>
              </div>

              <div className="space-y-5">
                <SectionEyebrow>Exit</SectionEyebrow>
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-semibold text-foreground">Take Profit</p>
                    <button
                      type="button"
                      onClick={addTakeProfit}
                      className="rounded-full border border-line bg-panel px-3 py-1.5 text-sm font-semibold text-foreground hover:bg-panel-strong"
                    >
                      Add TP Level
                    </button>
                  </div>
                  {takeProfits.map((target, index) => (
                    <div key={target.id} className="rounded-[18px] border border-line bg-panel p-4">
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <p className="text-sm font-semibold text-foreground">TP{index + 1}</p>
                        {takeProfits.length > 1 ? (
                          <button
                            type="button"
                            onClick={() => removeTakeProfit(target.id)}
                            className="text-xs font-semibold text-muted hover:text-foreground"
                          >
                            Remove
                          </button>
                        ) : null}
                      </div>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <Field label="Profit Target">
                          <NumberWithSuffix
                            value={target.profitPercent}
                            onChange={(value) => updateTakeProfit(target.id, { profitPercent: value })}
                            suffix="%"
                          />
                        </Field>
                        <Field label="Sell Remaining Supply">
                          <NumberWithSuffix
                            value={target.sellPercent}
                            onChange={(value) => updateTakeProfit(target.id, { sellPercent: value })}
                            suffix="%"
                          />
                        </Field>
                      </div>
                    </div>
                  ))}
                </div>

                <ToggleRow
                  checked={moonbagStop}
                  description="After the last TP, sell the rest if price returns to entry."
                  label="Moonbag Stop @ Entry"
                  onChange={setMoonbagStop}
                />
                <Field label="Stop Loss">
                  <NumberWithSuffix value={stopLoss} onChange={setStopLoss} suffix="%" />
                </Field>
                <ToggleRow
                  checked={trailingStop}
                  description="Lock in profits as price rises."
                  label="Trailing Stop"
                  onChange={setTrailingStop}
                />
                <Field label="Max Holding Time">
                  <NumberWithSuffix value={maxHoldingTime} onChange={setMaxHoldingTime} suffix="minutes" wide />
                </Field>
              </div>
            </div>
          </FormPanel>

          <FormPanel
            description="Protect the vault with capital caps, loss controls, and route gating."
            icon={<Shield className="h-5 w-5" />}
            title="Risk Management"
          >
            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_14rem]">
              <MoneyField
                amount={maxCapitalPerTrade}
                label="Max Capital Per Trade"
                onAmountChange={setMaxCapitalPerTrade}
                onUnitChange={setMaxCapitalPerTradeUnit}
                unit={maxCapitalPerTradeUnit}
              />
              <MoneyField
                amount={dailyLossLimit}
                label="Daily Loss Limit"
                onAmountChange={setDailyLossLimit}
                onUnitChange={setDailyLossLimitUnit}
                unit={dailyLossLimitUnit}
              />
              <Field label="Slippage Tolerance">
                <NumberWithSuffix value={slippageTolerance} onChange={setSlippageTolerance} suffix="%" />
              </Field>
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
              <ToggleRow
                checked={cooldownAfterLoss}
                description="Wait before re-entry after a losing trade."
                label="Cooldown After Loss"
                onChange={setCooldownAfterLoss}
              />
              <ToggleRow
                checked={rugProtection}
                description="Require proof, min-out, and balance-delta checks before execution."
                label="Proof Guard Protection"
                onChange={setRugProtection}
              />
            </div>
          </FormPanel>

          <FormPanel
            description="Choose the Policy Vault execution target for live deploy."
            icon={<Database className="h-5 w-5" />}
            title="Execution Settings"
          >
            <div className="grid gap-5 lg:grid-cols-3">
              <Field label="Gas Priority">
                <SelectShell>
                  <select value={gasPriority} onChange={(event) => setGasPriority(event.target.value)} className={selectClassName}>
                    <option className="bg-panel-solid-strong text-foreground">Standard</option>
                    <option className="bg-panel-solid-strong text-foreground">Fast</option>
                    <option className="bg-panel-solid-strong text-foreground">Proof safe</option>
                  </select>
                </SelectShell>
              </Field>
              <Field label="Execution Target">
                <SelectShell>
                  <select
                    value={executionTarget}
                    onChange={(event) => setExecutionTarget(event.target.value)}
                    className={selectClassName}
                  >
                    <option className="bg-panel-solid-strong text-foreground">
                      {workspace?.vault.vault ? `Policy Vault - ${shortHash(workspace.vault.vault)}` : "Policy Vault"}
                    </option>
                  </select>
                </SelectShell>
              </Field>
              <Field label="Execution Mode">
                <input
                  value={executionMode}
                  onChange={(event) => setExecutionMode(event.target.value)}
                  className={inputClassName}
                />
              </Field>
            </div>

            <div className="rounded-[18px] border border-line bg-panel px-4 py-3">
              <p className="text-sm font-semibold text-foreground">
                {workspace?.vault.vault ? `Policy Vault - ${shortHash(workspace.vault.vault)}` : "Policy Vault not loaded"}
              </p>
              <p className="mt-1 text-sm leading-6 text-muted">
                Live trades use narrow vault methods only. The executor cannot withdraw or arbitrary-call from this screen.
              </p>
            </div>
          </FormPanel>

          <section className="rounded-[28px] border border-line bg-panel-solid-strong/94 p-5 shadow-[0_18px_58px_rgba(0,0,0,0.22)] lg:p-6">
            <button
              type="button"
              onClick={() => setAdvancedOpen((current) => !current)}
              className="flex w-full items-center justify-between gap-3 text-left"
            >
              <span className="flex items-center gap-3">
                <SlidersHorizontal className="h-5 w-5 text-primary" />
                <span className="text-xl font-semibold text-foreground">Advanced Settings</span>
              </span>
              <ChevronDown className={`h-5 w-5 text-muted transition-transform ${advancedOpen ? "rotate-180" : ""}`} />
            </button>

            {advancedOpen ? (
              <div className="mt-5 space-y-5">
                <ToggleRow
                  checked={globalLearning}
                  description="The agent can learn from its own redacted trade outcomes."
                  label="Global Learning"
                  onChange={setGlobalLearning}
                />
                <ToggleRow
                  checked={false}
                  description="Single agent only for now. Specialized reviewer agents are coming soon."
                  disabled
                  label="Multi-Agent Mode"
                  onChange={() => undefined}
                  badge="Coming soon"
                />

                <div className="grid gap-5 lg:grid-cols-2">
                  <Field label="Primary Model">
                    <SelectShell>
                      <select value={primaryModel} onChange={(event) => setPrimaryModel(event.target.value)} className={selectClassName}>
                        {PRIMARY_MODELS.map((model) => (
                          <option key={model} className="bg-panel-solid-strong text-foreground">
                            {model}
                          </option>
                        ))}
                      </select>
                    </SelectShell>
                  </Field>
                  <Field label="Fallback Model">
                    <SelectShell>
                      <select value={fallbackModel} onChange={(event) => setFallbackModel(event.target.value)} className={selectClassName}>
                        {FALLBACK_MODELS.map((model) => (
                          <option key={model} className="bg-panel-solid-strong text-foreground">
                            {model}
                          </option>
                        ))}
                      </select>
                    </SelectShell>
                  </Field>
                </div>

                <Field label="Trading Guidance">
                  <textarea
                    value={instructions}
                    onChange={(event) => setInstructions(event.target.value.slice(0, 2000))}
                    className="min-h-[9rem] w-full resize-y rounded-[22px] border border-line bg-panel px-4 py-4 text-sm font-medium leading-6 text-foreground outline-none transition-colors placeholder:text-muted focus:border-primary/40"
                    placeholder="Example: Prefer clean momentum reclaims with confirmed volume. Avoid chasing vertical candles after the first impulse."
                  />
                  <div className="mt-2 flex items-center justify-between gap-3 text-sm text-muted">
                    <span>Advisory only. Vault policy still decides what can execute.</span>
                    <span>{instructions.length}/2,000</span>
                  </div>
                </Field>

                <Field label="Add Skill">
                  <div className="flex flex-col gap-3 rounded-[18px] border border-line bg-panel px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-sm font-semibold text-foreground">No skill file attached</p>
                      <p className="mt-1 text-sm text-muted">Markdown doctrine upload is reserved for the single-agent guidance layer.</p>
                    </div>
                    <button
                      type="button"
                      disabled
                      className="inline-flex h-11 items-center justify-center gap-2 rounded-full border border-line bg-panel px-4 text-sm font-semibold text-muted"
                    >
                      <Upload className="h-4 w-4" />
                      Upload .md
                    </button>
                  </div>
                </Field>
              </div>
            ) : null}
          </section>

          {walletActionMessage ? (
            <section className="flex flex-col gap-3 rounded-[22px] border border-amber/20 bg-amber/10 px-5 py-4 text-sm text-amber sm:flex-row sm:items-center sm:justify-between">
              <span>{walletActionMessage}</span>
              <WalletConnectButton compact networkId={networkId} />
            </section>
          ) : null}

          {validationIssues.length ? (
            <section className="rounded-[22px] border border-amber/20 bg-amber/10 px-5 py-4">
              <div className="flex gap-3">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber" />
                <div>
                  <p className="text-sm font-semibold text-amber">Validation issues</p>
                  <ul className="mt-2 space-y-1 text-sm text-amber/90">
                    {validationIssues.map((issue) => (
                      <li key={issue}>- {issue}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </section>
          ) : null}

          <section className="rounded-[28px] border border-line bg-panel-solid-strong/94 p-5 lg:p-6">
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
              <div className="grid gap-3 sm:grid-cols-3">
                <ReviewMetric icon={<FileCheck2 className="h-4 w-4" />} label="Agentic ID" value={workspace?.identity.address ? shortHash(workspace.identity.address) : "Not configured"} />
                <ReviewMetric icon={<Shield className="h-4 w-4" />} label="Vault" value={workspace?.vault.vault ? shortHash(workspace.vault.vault) : "Not loaded"} />
                <ReviewMetric icon={<Brain className="h-4 w-4" />} label="Strategy" value={activeStrategy.label} />
              </div>

              <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
                {hasExistingAgents && latestDeployment ? (
                  <Link
                    href={`/agents/${latestDeployment.id}`}
                    className="inline-flex h-12 items-center justify-center gap-2 rounded-full border border-line bg-panel px-5 text-sm font-semibold text-foreground transition-colors hover:bg-panel-strong"
                  >
                    Review latest
                    <ArrowRight className="h-4 w-4" />
                  </Link>
                ) : null}
                <button
                  type="button"
                  onClick={() => void deployAgent()}
                  disabled={!canDeploy}
                  className="inline-flex h-12 items-center justify-center gap-2 rounded-full bg-primary px-5 text-sm font-semibold text-on-primary transition-[filter,transform] hover:brightness-105 active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {isDeploying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                  Deploy Agent
                </button>
              </div>
            </div>
            <p className="mt-4 text-sm leading-6 text-muted">{statusText}</p>
          </section>
        </div>
      </main>
    </AppShell>
  );
}

const inputClassName =
  "h-12 w-full rounded-full border border-line bg-panel px-4 text-sm font-semibold text-foreground outline-none transition-colors placeholder:text-muted focus:border-primary/40 disabled:cursor-not-allowed disabled:opacity-50";

const selectClassName =
  "og-dark-select h-12 w-full appearance-none rounded-full border border-line bg-panel px-4 pr-11 text-sm font-semibold text-foreground outline-none transition-colors focus:border-primary/40";

function FormPanel({
  children,
  description,
  icon,
  title,
}: {
  children: ReactNode;
  description: string;
  icon: ReactNode;
  title: string;
}) {
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

function Field({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="block">
      <span className="mb-2 block text-sm font-semibold text-foreground">{label}</span>
      {children}
    </div>
  );
}

function SectionEyebrow({ children }: { children: ReactNode }) {
  return <p className="text-xs font-semibold uppercase tracking-[0.28em] text-muted">{children}</p>;
}

function SelectShell({ children, compact }: { children: ReactNode; compact?: boolean }) {
  return (
    <div className="relative">
      {children}
      <ChevronDown
        className={`pointer-events-none absolute top-1/2 h-4 w-4 -translate-y-1/2 text-muted ${
          compact ? "right-3" : "right-4"
        }`}
      />
    </div>
  );
}

function NumberWithSuffix({
  onChange,
  suffix,
  value,
  wide,
}: {
  onChange: (value: string) => void;
  suffix: string;
  value: string;
  wide?: boolean;
}) {
  return (
    <div className={`flex items-center gap-3 ${wide ? "w-full" : "w-fit"}`}>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={`${inputClassName} ${wide ? "" : "w-32"}`}
        inputMode="decimal"
      />
      <span className="text-sm font-semibold text-muted">{suffix}</span>
    </div>
  );
}

function MoneyField({
  amount,
  label,
  onAmountChange,
  onUnitChange,
  unit,
}: {
  amount: string;
  label: string;
  onAmountChange: (value: string) => void;
  onUnitChange: (value: MoneyUnit) => void;
  unit: MoneyUnit;
}) {
  return (
    <Field label={label}>
      <div className="flex gap-2">
        <input
          value={amount}
          onChange={(event) => onAmountChange(event.target.value)}
          className={`${inputClassName} min-w-0 flex-1`}
          inputMode="decimal"
        />
        <SelectShell compact>
          <select
            value={unit}
            onChange={(event) => onUnitChange(event.target.value as MoneyUnit)}
            className={`${selectClassName} w-24 shrink-0 px-3 pr-9`}
          >
            {MONEY_UNIT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value} className="bg-panel-solid-strong text-foreground">
                {option.label}
              </option>
            ))}
          </select>
        </SelectShell>
      </div>
    </Field>
  );
}

function ToggleRow({
  badge,
  checked,
  description,
  disabled,
  label,
  onChange,
}: {
  badge?: string;
  checked: boolean;
  description: string;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      className="flex w-full items-center justify-between gap-4 rounded-full border border-line bg-panel px-4 py-3 text-left transition-colors hover:border-line-strong disabled:cursor-not-allowed disabled:opacity-65"
    >
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
          {label}
          {badge ? (
            <span className="rounded-full border border-line bg-panel px-2 py-0.5 text-[11px] text-muted">
              {badge}
            </span>
          ) : null}
        </span>
        <span className="mt-1 block text-sm leading-5 text-muted">{description}</span>
      </span>
      <span
        className={`relative h-9 w-16 shrink-0 rounded-full border p-1 transition-colors ${
          checked ? "border-primary/20 bg-primary/20" : "border-line bg-panel"
        }`}
      >
        <span
          className={`block h-7 w-7 rounded-full transition-transform ${
            checked ? "translate-x-7 bg-primary" : "translate-x-0 bg-muted"
          }`}
        />
      </span>
    </button>
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

function trimDecimal(value: string): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return value;
  return numeric.toString();
}

function getOwnerWalletMessage({
  isConnected,
  isOwnerWallet,
  isWrongChain,
  ownerAddress,
  walletAddress,
}: {
  isConnected: boolean;
  isOwnerWallet: boolean;
  isWrongChain: boolean;
  ownerAddress?: string;
  walletAddress?: string;
}): string | undefined {
  if (!ownerAddress) return "Policy Vault owner is not available yet; Agentic ID minting is locked.";
  if (!isConnected || !walletAddress) return "Connect the Policy Vault owner wallet to mint or edit this Agentic ID.";
  if (!isOwnerWallet) return `Connected wallet ${shortHash(walletAddress)} is not the vault owner ${shortHash(ownerAddress)}.`;
  if (isWrongChain) return "Owner wallet is connected; minting will switch to 0G Mainnet before signing.";
  return undefined;
}

function make0GMainnetChain(rpcUrl: string): Chain {
  return {
    id: MAINNET.chainId,
    name: MAINNET.networkName,
    nativeCurrency: {
      decimals: 18,
      name: "0G",
      symbol: "0G",
    },
    rpcUrls: {
      default: { http: [rpcUrl] },
    },
    blockExplorers: {
      default: {
        name: "0G ChainScan",
        url: MAINNET.explorerUrl,
      },
    },
  };
}

async function waitForReceipt(
  publicClient: ReturnType<typeof createPublicClient>,
  hash: Hex,
) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      return await publicClient.getTransactionReceipt({ hash });
    } catch {
      await new Promise((resolve) => window.setTimeout(resolve, 1_000));
    }
  }
  throw new Error("Timed out waiting for the V2 agent key transaction.");
}
