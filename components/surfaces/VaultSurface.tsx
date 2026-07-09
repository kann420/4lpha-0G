"use client";

import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CircleDollarSign,
  Copy,
  Loader2,
  Network,
  RefreshCcw,
  ShieldCheck,
  WalletCards,
} from "lucide-react";
import { AppShell } from "@/components/app/AppShell";
import { VaultActionPanel } from "@/components/app/VaultActionPanel";
import { VaultPocketsPanel } from "@/components/app/VaultPocketsPanel";
import { useOgNetwork } from "@/components/app/useOgNetwork";
import { useWalletPolicyVault, type V4MigrationResult } from "@/components/app/useWalletPolicyVault";
import {
  getPolicyVaultReadiness,
  UNBOUNDED_POLICY_LIMIT,
  type PolicyVaultPolicy,
} from "@/lib/contracts/policy-vault";
import { CURATED_MAINNET_POLICY_VAULT_ROUTES } from "@/lib/contracts/curated-routes";
import { dispatchSigmaPetReaction } from "@/lib/copilot/sigma-pet";
import type { OgNetworkConfig } from "@/lib/types";
import { formatUnits, parseEther, type Address } from "viem";
import { useAccount, useBalance } from "wagmi";

type VaultPolicyMode = "unlimited" | "active" | "custom";

interface CustomPolicyForm {
  cooldownSeconds: string;
  dailyCap0G: string;
  defaultMinOutBps: string;
  maxDeadlineWindowSeconds: string;
  maxExposure0G: string;
  perTradeCap0G: string;
}

const ACTIVE_POLICY: PolicyVaultPolicy = {
  cooldownSeconds: 0n,
  dailyCap0G: parseEther("25"),
  defaultMinOutBps: 9_950,
  maxDeadlineWindowSeconds: 900n,
  maxExposure0G: parseEther("25"),
  perTradeCap0G: parseEther("5"),
};

const UNLIMITED_POLICY: PolicyVaultPolicy = {
  cooldownSeconds: 0n,
  dailyCap0G: UNBOUNDED_POLICY_LIMIT,
  defaultMinOutBps: 9_950,
  maxDeadlineWindowSeconds: 900n,
  maxExposure0G: UNBOUNDED_POLICY_LIMIT,
  perTradeCap0G: UNBOUNDED_POLICY_LIMIT,
};

const INITIAL_CUSTOM_POLICY_FORM: CustomPolicyForm = {
  cooldownSeconds: "0",
  dailyCap0G: "25",
  defaultMinOutBps: "9950",
  maxDeadlineWindowSeconds: "900",
  maxExposure0G: "25",
  perTradeCap0G: "5",
};

export function VaultSurface() {
  const { network, networkId, setNetworkId } = useOgNetwork();
  const walletVault = useWalletPolicyVault(network);
  const vaultReadiness = getPolicyVaultReadiness(network.id);
  const walletAccount = useAccount();
  const ownerBalance = useBalance({
    address: walletAccount.address,
    chainId: network.chainId,
    query: {
      enabled: walletAccount.isConnected && walletAccount.address !== undefined,
    },
  });
  const vaultBalance = useBalance({
    address: walletVault.vaultAddress ?? undefined,
    chainId: network.chainId,
    query: {
      enabled: walletVault.vaultAddress !== null,
    },
  });
  const lpEntryBalance = useBalance({
    address: walletVault.v4LpEntryAddress ?? undefined,
    chainId: network.chainId,
    query: { enabled: walletVault.v4LpEntryAddress !== null },
  });
  const lpExitBalance = useBalance({
    address: walletVault.v4LpExitAddress ?? undefined,
    chainId: network.chainId,
    query: { enabled: walletVault.v4LpExitAddress !== null },
  });
  const isV4Vault =
    walletVault.v4SwapAddress !== null &&
    walletVault.v4LpEntryAddress !== null &&
    walletVault.v4LpExitAddress !== null;
  // M7 FIX: for V4 the "Vault 0G" tile must show the TOTAL across all three thirds
  // (Swap/Trading + LP Entry + LP Exit), not just the Swap third.
  const vaultBalanceData =
    isV4Vault && vaultBalance.data
      ? {
          decimals: vaultBalance.data.decimals,
          symbol: vaultBalance.data.symbol,
          value:
            vaultBalance.data.value +
            (lpEntryBalance.data?.value ?? 0n) +
            (lpExitBalance.data?.value ?? 0n),
        }
      : vaultBalance.data;

  function refreshBalances() {
    if (walletAccount.address !== undefined) {
      void ownerBalance.refetch();
    }
    if (walletVault.vaultAddress !== null) {
      void vaultBalance.refetch();
    }
    if (walletVault.v4LpEntryAddress !== null) {
      void lpEntryBalance.refetch();
    }
    if (walletVault.v4LpExitAddress !== null) {
      void lpExitBalance.refetch();
    }
  }

  const hasRegisteredV4 =
    walletVault.v4SwapAddress !== null &&
    walletVault.v4LpEntryAddress !== null &&
    walletVault.v4LpExitAddress !== null;
  const showV4SetupPanel =
    walletAccount.isConnected &&
    network.id === "mainnet" &&
    !hasRegisteredV4 &&
    !walletVault.v4MigrationAvailable;
  const showV4MigrationPanel = walletAccount.isConnected && network.id === "mainnet" && walletVault.v4MigrationAvailable;

  return (
    <AppShell network={network} networkId={networkId} onNetworkChange={setNetworkId}>
      <main className="scrollbar-subtle h-full overflow-y-auto px-4 py-5 lg:px-8 lg:py-8">
        <div className="mx-auto grid w-full max-w-7xl gap-5 xl:grid-cols-[minmax(0,1fr)_24rem]">
          <div className="flex min-w-0 flex-col gap-5">
            <FundRouteHeader network={network} />
            <div className="animate-feed-reveal min-w-0" style={{ animationDelay: "60ms" }}>
              <FundBalanceGrid
                ownerBalanceLabel={readOwnerBalanceLabel({
                  balance: ownerBalance.data,
                  connected: walletAccount.isConnected,
                  error: ownerBalance.isError,
                  loading: ownerBalance.isLoading,
                })}
                vaultBalanceLabel={readVaultBalanceLabel({
                  balance: vaultBalanceData,
                  error: vaultBalance.isError,
                  loading: vaultBalance.isLoading,
                  vaultAddress: walletVault.vaultAddress,
                })}
              />
            </div>
            <div className="animate-feed-reveal min-w-0" style={{ animationDelay: "120ms" }}>
              <FundManualDepositPanel
                factoryAddress={walletVault.factoryAddress}
                creationReady={vaultReadiness.isReady}
                creationStatus={vaultReadiness.reason}
                isCreatingVault={walletVault.isCreating}
                isDiscoveringVault={walletVault.isDiscovering}
                network={network}
                onCreateVault={walletVault.createVault}
                onRefreshVaultAddress={walletVault.refreshVaultAddress}
                legacyCreateAvailable={network.id !== "mainnet"}
                vaultAddress={walletVault.vaultAddress}
                walletConnected={walletAccount.isConnected}
              />
            </div>
            {isV4Vault && walletVault.v4SwapAddress && walletVault.v4LpEntryAddress ? (
              <div className="animate-feed-reveal min-w-0" style={{ animationDelay: "150ms" }}>
                <VaultPocketsPanel
                  lpEntryVaultAddress={walletVault.v4LpEntryAddress}
                  lpExitVaultAddress={walletVault.v4LpExitAddress}
                  network={network}
                  onVaultStateChange={refreshBalances}
                  swapVaultAddress={walletVault.v4SwapAddress}
                />
              </div>
            ) : null}
            {showV4SetupPanel ? (
              <div className="animate-feed-reveal min-w-0" style={{ animationDelay: "160ms" }}>
                <VaultV4Panel
                  disabled={walletVault.isCreating || walletVault.isDiscovering}
                  network={network}
                  onCreate={walletVault.createVaultV4}
                  status={walletVault.statusText}
                  v4LpEntryAddress={walletVault.v4LpEntryAddress}
                  v4LpExitAddress={walletVault.v4LpExitAddress}
                  v4MigrationAvailable={walletVault.v4MigrationAvailable}
                  v4SwapAddress={walletVault.v4SwapAddress}
                  walletConnected={walletAccount.isConnected}
                />
              </div>
            ) : null}
            {showV4MigrationPanel ? (
              <div className="animate-feed-reveal min-w-0" style={{ animationDelay: "170ms" }}>
                <VaultV4OneButtonMigrationPanel
                  disabled={
                    walletVault.isMigratingToV4 ||
                    walletVault.isCreating ||
                    walletVault.isDiscovering
                  }
                  error={walletVault.v4MigrateError}
                  migrate={walletVault.migrateToV4}
                  network={network}
                  result={walletVault.v4MigrateResult}
                  status={walletVault.statusText}
                />
              </div>
            ) : null}
            {walletVault.migrationRequired ? (
              <div className="animate-feed-reveal min-w-0" style={{ animationDelay: "180ms" }}>
                <VaultMigrationPanel
                  disabled={walletVault.isCreating || walletVault.isDiscovering}
                  legacyCount={walletVault.legacyVaults.length}
                  onMigrate={walletVault.migrateVault}
                  status={walletVault.statusText}
                />
              </div>
            ) : null}
            {walletVault.v3MigrationAvailable && walletVault.v3VaultAddress ? (
              <div className="animate-feed-reveal min-w-0" style={{ animationDelay: "200ms" }}>
                <VaultV3MigrationPanel
                  disabled={
                    walletVault.isMigratingToV3 ||
                    walletVault.isCreating ||
                    walletVault.isDiscovering
                  }
                  onMigrate={walletVault.migrateVaultToV3}
                  status={walletVault.statusText}
                  v3VaultAddress={walletVault.v3VaultAddress}
                />
              </div>
            ) : null}
          </div>

          <VaultActionPanel
            factoryAddress={walletVault.factoryAddress}
            isCreatingVault={walletVault.isCreating}
            isDiscoveringVault={walletVault.isDiscovering}
            lpEntryVaultAddress={walletVault.v4LpEntryAddress}
            lpExitVaultAddress={walletVault.v4LpExitAddress}
            network={network}
            onRefreshVaultAddress={walletVault.refreshVaultAddress}
            onVaultStateChange={refreshBalances}
            vaultAddress={walletVault.vaultAddress}
          />
        </div>
      </main>
    </AppShell>
  );
}

function FundRouteHeader({ network }: { network: OgNetworkConfig }) {
  return (
    <section
      className="animate-feed-reveal overflow-hidden rounded-hero border border-line bg-panel-solid-strong px-4 py-5 sm:px-6 lg:rounded-[30px] lg:px-8"
      style={{ animationDelay: "0ms", boxShadow: "var(--shadow-hero)" }}
    >
      <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
        <div className="max-w-3xl space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full border border-amber/20 bg-amber/[0.06] px-3 py-1 text-[11px] font-medium uppercase tracking-[0.24em] text-amber/80">
              {network.networkName}
            </span>
            <span className="rounded-full border border-green/20 bg-green/10 px-3 py-1 text-xs font-medium text-green">
              Real-gated
            </span>
          </div>
          <div>
            <h1 className="font-heading text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
              Fund
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted sm:text-base">
              Manage 0G funding for the Policy Vault on {network.networkName}. Deposits, withdrawals, pause, and revoke stay owner-bound.
            </p>
          </div>
        </div>

        <div className="grid gap-2 text-sm sm:grid-cols-3 lg:min-w-[28rem]">
          <StatTile icon={<Network className="h-4 w-4" />} label="Network" value={network.networkName} />
          <StatTile icon={<CircleDollarSign className="h-4 w-4" />} label="Asset" tone="amber" value="0G native" />
          <StatTile
            icon={<ShieldCheck className="h-4 w-4" />}
            label="Routes"
            value={`${CURATED_MAINNET_POLICY_VAULT_ROUTES.length} curated`}
          />
        </div>
      </div>
    </section>
  );
}

function StatTile({
  detail,
  icon,
  label,
  tone = "white",
  value,
}: {
  detail?: string;
  icon: React.ReactNode;
  label: string;
  tone?: "amber" | "emerald" | "teal" | "white";
  value: string;
}) {
  const valueTone =
    tone === "amber"
      ? "text-amber"
      : tone === "emerald"
        ? "text-green"
        : tone === "teal"
          ? "text-primary"
          : "text-foreground";
  return (
    <article className="min-w-0 rounded-card border border-line bg-panel px-4 py-3 transition-colors hover:border-line-strong hover:bg-panel-strong">
      <div className="flex items-center gap-2 text-muted">
        {icon}
        <span className="text-[10px] font-medium uppercase tracking-[0.22em]">{label}</span>
      </div>
      <p
        className={`mt-2 truncate font-mono text-lg font-semibold tracking-tight tabular-nums ${valueTone}`}
        title={value}
      >
        {value}
      </p>
      {detail ? <p className="mt-1.5 text-sm leading-5 text-muted">{detail}</p> : null}
    </article>
  );
}

function FundBalanceGrid({
  ownerBalanceLabel,
  vaultBalanceLabel,
}: {
  ownerBalanceLabel: string;
  vaultBalanceLabel: string;
}) {
  return (
    <section className="grid gap-3 sm:grid-cols-2">
      <StatTile
        detail="Native balance in the connected wallet"
        icon={<CircleDollarSign className="h-4 w-4" />}
        label="Owner 0G"
        tone="amber"
        value={ownerBalanceLabel}
      />
      <StatTile
        detail="0G currently deposited in the Policy Vault"
        icon={<WalletCards className="h-4 w-4" />}
        label="Vault 0G"
        tone="emerald"
        value={vaultBalanceLabel}
      />
    </section>
  );
}

function FundManualDepositPanel({
  creationReady,
  creationStatus,
  factoryAddress,
  isCreatingVault,
  isDiscoveringVault,
  legacyCreateAvailable,
  network,
  onCreateVault,
  onRefreshVaultAddress,
  vaultAddress,
  walletConnected,
}: {
  creationReady: boolean;
  creationStatus: string;
  factoryAddress: Address | null;
  isCreatingVault: boolean;
  isDiscoveringVault: boolean;
  legacyCreateAvailable: boolean;
  network: OgNetworkConfig;
  onCreateVault: (policy?: PolicyVaultPolicy) => Promise<void>;
  onRefreshVaultAddress: () => Promise<void>;
  vaultAddress: Address | null;
  walletConnected: boolean;
}) {
  const [policyMode, setPolicyMode] = useState<VaultPolicyMode>("active");
  const [customPolicyForm, setCustomPolicyForm] = useState<CustomPolicyForm>(INITIAL_CUSTOM_POLICY_FORM);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const policyDraft = buildPolicyFromSelection(policyMode, customPolicyForm);
  const displayedPolicyError = policyDraft.ok ? policyError : policyDraft.error;
  const createVaultDisabled =
    !legacyCreateAvailable ||
    !creationReady ||
    factoryAddress === null ||
    !walletConnected ||
    isCreatingVault ||
    isDiscoveringVault ||
    !policyDraft.ok;

  async function copyVaultAddress() {
    if (vaultAddress !== null) {
      await navigator.clipboard.writeText(vaultAddress);
      dispatchSigmaPetReaction("vault.refresh");
    }
  }

  async function createVaultWithPolicy() {
    if (!policyDraft.ok) {
      setPolicyError(policyDraft.error);
      return;
    }

    setPolicyError(null);
    dispatchSigmaPetReaction("vault.create.start", { force: true });
    await onCreateVault(policyDraft.policy);
    dispatchSigmaPetReaction("vault.create.success", { force: true });
  }

  return (
    <section
      className="rounded-hero border border-line bg-panel-solid-strong p-4 sm:p-6 lg:rounded-[30px]"
      style={{ boxShadow: "var(--shadow-hero)" }}
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-2">
          <h2 className="font-heading text-xl font-semibold tracking-tight text-foreground">
            Manual deposit
          </h2>
          <p className="max-w-2xl text-sm leading-6 text-muted">
            Send 0G only after this page shows your Policy Vault address. Keep the transfer on {network.networkName}.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            dispatchSigmaPetReaction("vault.refresh", { force: true });
            void onRefreshVaultAddress();
          }}
          className="inline-flex h-11 items-center gap-2 rounded-full border border-line bg-panel px-3 text-sm text-foreground transition-colors hover:bg-panel-strong"
        >
          <RefreshCcw className="h-4 w-4" />
          Refresh
        </button>
      </div>

      <div className="mt-5 grid gap-3 lg:grid-cols-3">
        <ManualDepositStep
          icon={<Network className="h-4 w-4" />}
          label="Network"
          value={`Use ${network.networkName} from the sending wallet.`}
        />
        <ManualDepositStep
          icon={<CheckCircle2 className="h-4 w-4" />}
          label="Asset"
          value="Send native 0G only, not wrapped or bridged tokens."
        />
        <ManualDepositStep
          icon={<RefreshCcw className="h-4 w-4" />}
          label="Confirm"
          value="Refresh after the transaction is confirmed."
        />
      </div>

      {vaultAddress === null ? (
        <div className="mt-5 rounded-card border border-amber/20 bg-amber/[0.06] p-4 text-sm leading-6 text-amber">
          <div className="flex flex-col gap-4">
            <div className="flex min-w-0 items-start gap-3">
              <AlertTriangle className="mt-1 h-4 w-4 shrink-0" />
              <div className="min-w-0">
                <p>
                  {legacyCreateAvailable
                    ? "Create a wallet vault from the factory before funding controls are enabled."
                    : "Create a V4 Policy Vault before funding controls are enabled."}
                </p>
                <p className="mt-1 text-xs text-amber/70">
                  {legacyCreateAvailable
                    ? (creationReady ? "No deployed vault address is configured." : creationStatus)
                    : "No V4 vault is registered for this wallet yet."}
                </p>
              </div>
            </div>
            {legacyCreateAvailable ? (
              <>
            <div className="rounded-card border border-line bg-background/20 p-3">
              <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-amber/70">
                    Vault policy
                  </p>
                  <p className="mt-1 text-xs leading-5 text-amber/70">
                    Limits are enforced by the vault at creation time.
                  </p>
                </div>
                <p className="font-mono text-xs tabular-nums text-amber/80">
                  {readPolicySummary(policyMode, customPolicyForm)}
                </p>
              </div>

              <div className="mt-3 grid gap-2 md:grid-cols-3">
                <PolicyModeButton
                  active={policyMode === "unlimited"}
                  detail="No spend caps, no cooldown"
                  label="Unlimited"
                  onClick={() => {
                    setPolicyMode("unlimited");
                    setPolicyError(null);
                  }}
                />
                <PolicyModeButton
                  active={policyMode === "active"}
                  detail="5 per trade, 25 daily"
                  label="Active"
                  onClick={() => {
                    setPolicyMode("active");
                    setPolicyError(null);
                  }}
                />
                <PolicyModeButton
                  active={policyMode === "custom"}
                  detail="Choose every limit"
                  label="Custom"
                  onClick={() => {
                    setPolicyMode("custom");
                    setPolicyError(null);
                  }}
                />
              </div>

              {policyMode === "custom" ? (
                <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                  <PolicyInput
                    label="Per trade cap"
                    placeholder="blank = unbounded"
                    suffix="0G"
                    value={customPolicyForm.perTradeCap0G}
                    onChange={(value) => setCustomPolicyForm((current) => ({ ...current, perTradeCap0G: value }))}
                  />
                  <PolicyInput
                    label="Daily cap"
                    placeholder="blank = unbounded"
                    suffix="0G"
                    value={customPolicyForm.dailyCap0G}
                    onChange={(value) => setCustomPolicyForm((current) => ({ ...current, dailyCap0G: value }))}
                  />
                  <PolicyInput
                    label="Max exposure"
                    placeholder="blank = unbounded"
                    suffix="0G"
                    value={customPolicyForm.maxExposure0G}
                    onChange={(value) => setCustomPolicyForm((current) => ({ ...current, maxExposure0G: value }))}
                  />
                  <PolicyInput
                    label="Cooldown"
                    placeholder="0"
                    suffix="sec"
                    value={customPolicyForm.cooldownSeconds}
                    onChange={(value) => setCustomPolicyForm((current) => ({ ...current, cooldownSeconds: value }))}
                  />
                  <PolicyInput
                    label="Deadline window"
                    placeholder="900"
                    suffix="sec"
                    value={customPolicyForm.maxDeadlineWindowSeconds}
                    onChange={(value) => setCustomPolicyForm((current) => ({ ...current, maxDeadlineWindowSeconds: value }))}
                  />
                  <PolicyInput
                    label="Min-out floor"
                    placeholder="9950"
                    suffix="bps"
                    value={customPolicyForm.defaultMinOutBps}
                    onChange={(value) => setCustomPolicyForm((current) => ({ ...current, defaultMinOutBps: value }))}
                  />
                </div>
              ) : null}

              {policyDraft.ok ? <PolicyPreview policy={policyDraft.policy} /> : null}

              {displayedPolicyError !== null ? (
                <p className="mt-3 rounded-full border border-rose/20 bg-rose/[0.1] px-3 py-2 text-xs font-medium text-rose">
                  {displayedPolicyError}
                </p>
              ) : null}
            </div>

            <div className="flex justify-end">
              <button
                type="button"
                disabled={createVaultDisabled}
                onClick={() => void createVaultWithPolicy()}
                className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-full border border-amber/20 bg-amber/[0.1] px-4 text-sm font-semibold text-amber transition-[background-color,transform,opacity] hover:bg-amber/[0.16] active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-45"
              >
                {isCreatingVault ? <Loader2 className="h-4 w-4 animate-spin" /> : <WalletCards className="h-4 w-4" />}
                {isCreatingVault ? "Creating Vault" : "Create Wallet Vault"}
              </button>
            </div>
              </>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="mt-5 rounded-card border border-amber/20 bg-amber/[0.06] p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0">
              <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-amber/70">
                Policy Vault address
              </p>
              <p
                className="mt-2 break-all font-mono text-sm font-semibold text-amber"
                title={vaultAddress}
              >
                {vaultAddress}
              </p>
            </div>
            <button
              type="button"
              onClick={copyVaultAddress}
              className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-full bg-amber px-4 text-sm font-semibold text-background transition-[background-color,transform] hover:bg-amber/90 active:scale-[0.96]"
            >
              <Copy className="h-4 w-4" />
              Copy
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function PolicyModeButton({
  active,
  detail,
  label,
  onClick,
}: {
  active: boolean;
  detail: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`min-h-16 rounded-card border px-3 py-2.5 text-left transition-[background-color,border-color,transform] active:scale-[0.96] ${
        active
          ? "border-amber/20 bg-amber/[0.1] text-amber"
          : "border-line bg-panel text-muted hover:border-line-strong hover:bg-panel"
      }`}
    >
      <span className="block text-sm font-semibold">{label}</span>
      <span className="mt-1 block text-xs leading-4 text-muted">{detail}</span>
    </button>
  );
}

function PolicyInput({
  label,
  onChange,
  placeholder,
  suffix,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  placeholder: string;
  suffix: string;
  value: string;
}) {
  return (
    <label className="block rounded-tile border border-line bg-panel px-3 py-2">
      <span className="block text-[10px] font-medium uppercase tracking-[0.18em] text-amber/60">
        {label}
      </span>
      <span className="mt-1 flex items-center gap-2">
        <input
          inputMode="decimal"
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          className="h-8 min-w-0 flex-1 bg-transparent font-mono text-sm tabular-nums text-amber outline-none placeholder:text-muted"
        />
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted">{suffix}</span>
      </span>
    </label>
  );
}

function VaultMigrationPanel({
  disabled,
  legacyCount,
  onMigrate,
  status,
}: {
  disabled: boolean;
  legacyCount: number;
  onMigrate: () => Promise<void>;
  status: string;
}) {
  return (
    <section className="rounded-card border border-amber/20 bg-amber/[0.06] p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-amber">
            <AlertTriangle className="h-4 w-4" />
            Vault migration available
          </div>
          <p className="mt-2 text-sm leading-6 text-muted">
            {legacyCount} legacy vault detected. Move native 0G into the latest PolicyVault version before enabling multi-agent auto-run.
          </p>
          <p className="mt-2 text-xs leading-5 text-muted">{status}</p>
        </div>
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            dispatchSigmaPetReaction("vault.migrate.start", { force: true });
            void onMigrate()
              .then(() => dispatchSigmaPetReaction("vault.migrate.success", { force: true }))
              .catch(() => undefined);
          }}
          className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-full border border-amber/20 bg-amber/[0.1] px-4 text-sm font-semibold text-amber transition hover:bg-amber/[0.16] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {disabled ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
          Migrate vault
        </button>
      </div>
    </section>
  );
}

function VaultV4Panel({
  disabled,
  network,
  onCreate,
  status,
  v4LpEntryAddress,
  v4LpExitAddress,
  v4MigrationAvailable,
  v4SwapAddress,
  walletConnected,
}: {
  disabled: boolean;
  network: OgNetworkConfig;
  onCreate: () => Promise<void>;
  status: string;
  v4LpEntryAddress: Address | null;
  v4LpExitAddress: Address | null;
  v4MigrationAvailable: boolean;
  v4SwapAddress: Address | null;
  walletConnected: boolean;
}) {
  const hasV4 = v4SwapAddress !== null && v4LpEntryAddress !== null && v4LpExitAddress !== null;
  const createDisabled = disabled || !walletConnected || network.id !== "mainnet" || hasV4;

  return (
    <section className="rounded-card border border-line bg-panel-solid-strong p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <ShieldCheck className="h-4 w-4 text-green" />
            V4 Policy Vault
          </div>
          <p className="mt-2 text-sm leading-6 text-muted">
            Three owner-deployed vault thirds are resolved through VaultRegistryV4: Swap, LP Entry, and LP Exit.
          </p>
          <div className="mt-3 grid gap-2 text-xs sm:grid-cols-3">
            <V4AddressTile label="Swap" value={v4SwapAddress} />
            <V4AddressTile label="LP Entry" value={v4LpEntryAddress} />
            <V4AddressTile label="LP Exit" value={v4LpExitAddress} />
          </div>
          {v4MigrationAvailable ? (
            <p className="mt-3 text-xs leading-5 text-amber">
              Legacy vault state detected. Create the V4 trio before migrating funds or LP custody.
            </p>
          ) : null}
          <p className="mt-3 text-xs leading-5 text-muted">{status}</p>
        </div>
        <button
          type="button"
          disabled={createDisabled}
          onClick={() => {
            dispatchSigmaPetReaction("vault.create.start", { force: true });
            void onCreate()
              .then(() => dispatchSigmaPetReaction("vault.create.success", { force: true }))
              .catch(() => undefined);
          }}
          className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-full border border-green/20 bg-green/[0.1] px-4 text-sm font-semibold text-green transition hover:bg-green/[0.16] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {disabled ? <Loader2 className="h-4 w-4 animate-spin" /> : <WalletCards className="h-4 w-4" />}
          {hasV4 ? "V4 registered" : "Create V4 Vault"}
        </button>
      </div>
    </section>
  );
}

function V4AddressTile({ label, value }: { label: string; value: Address | null }) {
  return (
    <div className="min-w-0 rounded-tile border border-line bg-panel px-3 py-2">
      <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted">{label}</p>
      <p className="mt-1 truncate font-mono text-[11px] text-foreground" title={value ?? "Not registered"}>
        {value ?? "Not registered"}
      </p>
    </div>
  );
}

function VaultV4OneButtonMigrationPanel({
  disabled,
  error,
  migrate,
  network,
  result,
  status,
}: {
  disabled: boolean;
  error: string | null;
  migrate: () => Promise<void>;
  network: OgNetworkConfig;
  result: V4MigrationResult | null;
  status: string;
}) {
  const busy = disabled;
  return (
    <section className="rounded-card border border-amber/20 bg-amber/[0.06] p-5">
      <div className="flex items-center gap-2 text-sm font-semibold text-amber">
        <ShieldCheck className="h-4 w-4" />
        Migrate to V4
      </div>
      <p className="mt-2 text-sm leading-6 text-muted">
        Create or reuse your wallet-owned V4 trio, preserve V3 LP NFTs when present, move native 0G into V4 Swap, and
        activate V4 through VaultRegistryV4.
      </p>

      {result ? (
        <p className="mt-3 break-words rounded-card border border-green/20 bg-green/[0.06] p-3 text-xs leading-5 text-green">
          V4 migration complete for {result.oldVault}. Re-pointed agents: {result.repointedAgents?.length ?? 0}.
          Source retired: {result.retired ? "yes" : "no"}.
        </p>
      ) : null}

      {error ? (
        <p className="mt-3 break-words rounded-card border border-red/20 bg-red/[0.06] p-3 text-xs leading-5 text-red">
          {error}
        </p>
      ) : null}

      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs leading-5 text-muted">{status}</p>
        <button
          type="button"
          disabled={busy || network.id !== "mainnet"}
          onClick={() => {
            dispatchSigmaPetReaction("vault.migrate.start", { force: true });
            void migrate()
              .then(() => dispatchSigmaPetReaction("vault.migrate.success", { force: true }))
              .catch(() => undefined);
          }}
          className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-full border border-green/20 bg-green/[0.1] px-4 text-sm font-semibold text-green transition hover:bg-green/[0.16] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <WalletCards className="h-4 w-4" />}
          Migrate to V4
        </button>
      </div>
    </section>
  );
}

function VaultV3MigrationPanel({
  disabled,
  onMigrate,
  status,
  v3VaultAddress,
}: {
  disabled: boolean;
  onMigrate: () => Promise<void>;
  status: string;
  v3VaultAddress: Address;
}) {
  return (
    <section className="rounded-card border border-amber/20 bg-amber/[0.06] p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-amber">
            <ShieldCheck className="h-4 w-4" />
            V3 Policy Vault migration available
          </div>
          <p className="mt-2 text-sm leading-6 text-muted">
            Move native 0G from your legacy V2 vault into the V3 singleton, pause and revoke the V2 executor, and re-point your agent records to V3. The V3 vault is deployer-owned and was created via the offline deploy script.
          </p>
          <p className="mt-2 break-all font-mono text-[11px] leading-5 text-muted">
            V3: {v3VaultAddress}
          </p>
          <p className="mt-2 text-xs leading-5 text-muted">{status}</p>
        </div>
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            dispatchSigmaPetReaction("vault.migrate.start", { force: true });
            void onMigrate()
              .then(() => dispatchSigmaPetReaction("vault.migrate.success", { force: true }))
              .catch(() => undefined);
          }}
          className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-full border border-amber/20 bg-amber/[0.1] px-4 text-sm font-semibold text-amber transition hover:bg-amber/[0.16] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {disabled ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
          Migrate to V3
        </button>
      </div>
    </section>
  );
}

/*
function VaultV3UnlimitedPanel({
  currentVaultAddress,
  disabled,
  error,
  onMigrate,
  result,
  status,
}: {
  currentVaultAddress: Address;
  disabled: boolean;
  error: string | null;
  onMigrate: () => Promise<void>;
  result: {
    newVault: Address;
    withdrawnAmount0G: string;
    depositAmount0G: string;
    migratedAgents: string[];
    restartRequired: boolean;
    envLocalUpdated: boolean;
  } | null;
  status: string;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const busy = disabled;
  return (
    <section className="rounded-card border border-amber/20 bg-amber/[0.06] p-5">
      <div className="flex items-center gap-2 text-sm font-semibold text-amber">
        <AlertTriangle className="h-4 w-4" />
        Redeploy Policy Vault (unlimited caps)
      </div>
      <p className="mt-2 text-sm leading-6 text-muted">
        Deploys a <span className="text-foreground">new</span> Policy Vault with effectively-unlimited caps (1M 0G per-action +
        daily, unbounded LP exposure), moves <span className="text-foreground">all</span> native 0G from the current vault,
        re-points <span className="text-foreground">all</span> your agents at it, and updates <code className="font-mono text-[11px]">.env.local</code>.
        Real gas — the deployer pays. Use this to abandon a vault that was tightened on-chain (tighten is irreversible).
      </p>
      <p className="mt-2 break-all font-mono text-[11px] leading-5 text-muted">
        Current vault: {currentVaultAddress}
      </p>
      <label className="mt-3 flex cursor-pointer items-start gap-2 text-xs leading-5 text-muted">
        <input
          type="checkbox"
          checked={confirmed}
          disabled={busy}
          onChange={(event) => setConfirmed(event.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0 accent-amber"
        />
        <span>
          I understand this deploys a new on-chain vault, moves real funds from the current vault, re-points all agents,
          and that I must <span className="text-foreground">restart the dev server</span> afterward so the autonomous worker
          uses the new vault.
        </span>
      </label>
      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs leading-5 text-muted">{status}</p>
        <button
          type="button"
          disabled={busy || !confirmed}
          onClick={() => void onMigrate()}
          className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-full border border-amber/20 bg-amber/[0.1] px-4 text-sm font-semibold text-amber transition hover:bg-amber/[0.16] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
          Migrate to new vault
        </button>
      </div>
      {error ? (
        <p className="mt-3 break-words rounded-card border border-red/20 bg-red/[0.06] p-3 text-xs leading-5 text-red">
          {error}
        </p>
      ) : null}
      {result ? (
        <div className="mt-3 rounded-card border border-green/20 bg-green/[0.06] p-3 text-xs leading-5 text-muted">
          <div className="flex items-center gap-2 font-semibold text-green">
            <CheckCircle2 className="h-4 w-4" />
            Migration complete
          </div>
          <p className="mt-2 break-all font-mono text-[11px] leading-5">New vault: {result.newVault}</p>
          <p className="mt-1">
            Moved {result.withdrawnAmount0G} 0G (deposited {result.depositAmount0G} 0G after gas reserve). Re-pointed{" "}
            {result.migratedAgents.length} agent{result.migratedAgents.length === 1 ? "" : "s"}.
          </p>
          {result.envLocalUpdated ? (
            <p className="mt-1">.env.local updated (backup at .env.local.bak).</p>
          ) : null}
          <p className="mt-2 font-semibold text-amber">
            Restart the dev server so the autonomous worker reads the new vault&apos;s policy.
          </p>
        </div>
      ) : null}
    </section>
  );
}

*/
function PolicyPreview({ policy }: { policy: PolicyVaultPolicy }) {
  const rows = [
    { label: "Per trade", value: formatPolicyLimit(policy.perTradeCap0G) },
    { label: "Daily cap", value: formatPolicyLimit(policy.dailyCap0G) },
    { label: "Exposure", value: formatPolicyLimit(policy.maxExposure0G) },
    { label: "Cooldown", value: formatPolicySeconds(policy.cooldownSeconds) },
    { label: "Deadline", value: formatPolicySeconds(policy.maxDeadlineWindowSeconds) },
    { label: "Min out", value: formatMinOutBps(policy.defaultMinOutBps) },
  ];

  return (
    <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {rows.map((row) => (
        <div
          key={row.label}
          className="min-h-14 rounded-tile border border-line bg-panel px-3 py-2"
        >
          <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted">
            {row.label}
          </p>
          <p className="mt-1 truncate font-mono text-sm tabular-nums text-amber" title={row.value}>
            {row.value}
          </p>
        </div>
      ))}
    </div>
  );
}

function ManualDepositStep({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-card border border-line bg-panel p-4">
      <div className="flex items-center gap-2 text-muted">
        {icon}
        <span className="text-[11px] font-medium uppercase tracking-[0.22em]">{label}</span>
      </div>
      <p className="mt-3 text-sm leading-6 text-muted">
        {value}
      </p>
    </div>
  );
}

function buildPolicyFromSelection(
  mode: VaultPolicyMode,
  form: CustomPolicyForm,
): { ok: true; policy: PolicyVaultPolicy } | { ok: false; error: string } {
  if (mode === "unlimited") {
    return { ok: true, policy: UNLIMITED_POLICY };
  }

  if (mode === "active") {
    return { ok: true, policy: ACTIVE_POLICY };
  }

  const perTradeCap0G = parse0GLimit(form.perTradeCap0G, "Per trade cap");
  if (!perTradeCap0G.ok) {
    return perTradeCap0G;
  }

  const dailyCap0G = parse0GLimit(form.dailyCap0G, "Daily cap");
  if (!dailyCap0G.ok) {
    return dailyCap0G;
  }

  const maxExposure0G = parse0GLimit(form.maxExposure0G, "Max exposure");
  if (!maxExposure0G.ok) {
    return maxExposure0G;
  }

  const cooldownSeconds = parseWholeSeconds(form.cooldownSeconds, "Cooldown");
  if (!cooldownSeconds.ok) {
    return cooldownSeconds;
  }

  const maxDeadlineWindowSeconds = parseWholeSeconds(form.maxDeadlineWindowSeconds, "Deadline window");
  if (!maxDeadlineWindowSeconds.ok) {
    return maxDeadlineWindowSeconds;
  }
  if (maxDeadlineWindowSeconds.value === 0n || maxDeadlineWindowSeconds.value > 86_400n) {
    return { ok: false, error: "Deadline window must be between 1 and 86400 seconds." };
  }

  const defaultMinOutBps = parseBps(form.defaultMinOutBps);
  if (!defaultMinOutBps.ok) {
    return defaultMinOutBps;
  }

  return {
    ok: true,
    policy: {
      cooldownSeconds: cooldownSeconds.value,
      dailyCap0G: dailyCap0G.value,
      defaultMinOutBps: defaultMinOutBps.value,
      maxDeadlineWindowSeconds: maxDeadlineWindowSeconds.value,
      maxExposure0G: maxExposure0G.value,
      perTradeCap0G: perTradeCap0G.value,
    },
  };
}

function parse0GLimit(value: string, label: string): { ok: true; value: bigint } | { ok: false; error: string } {
  const trimmed = value.trim();
  if (trimmed === "") {
    return { ok: true, value: UNBOUNDED_POLICY_LIMIT };
  }

  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    return { ok: false, error: `${label} must be a positive 0G amount or blank.` };
  }

  try {
    const parsed = parseEther(trimmed);
    if (parsed === 0n) {
      return { ok: false, error: `${label} must be greater than 0 or blank for unbounded.` };
    }
    return { ok: true, value: parsed };
  } catch {
    return { ok: false, error: `${label} must use 18 decimals or fewer.` };
  }
}

function parseWholeSeconds(value: string, label: string): { ok: true; value: bigint } | { ok: false; error: string } {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, error: `${label} must be a whole number of seconds.` };
  }

  return { ok: true, value: BigInt(trimmed) };
}

function parseBps(value: string): { ok: true; value: number } | { ok: false; error: string } {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, error: "Min-out floor must be a whole bps value." };
  }

  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 10_000) {
    return { ok: false, error: "Min-out floor must be between 1 and 10000 bps." };
  }

  return { ok: true, value: parsed };
}

function readPolicySummary(mode: VaultPolicyMode, form: CustomPolicyForm) {
  if (mode === "unlimited") {
    return "caps unbounded";
  }

  if (mode === "active") {
    return "5 0G / trade";
  }

  const parsedPerTradeCap = parse0GLimit(form.perTradeCap0G, "Per trade cap");
  if (!parsedPerTradeCap.ok) {
    return "check inputs";
  }

  const perTradeCap = form.perTradeCap0G.trim() === "" ? "unbounded" : `${form.perTradeCap0G} 0G`;
  return `${perTradeCap} / trade`;
}

function formatPolicyLimit(value: bigint) {
  if (value === UNBOUNDED_POLICY_LIMIT) {
    return "Unlimited";
  }

  const formatted = formatUnits(value, 18);
  const parsed = Number(formatted);
  if (!Number.isFinite(parsed)) {
    return `${formatted} 0G`;
  }

  return `${parsed.toLocaleString("en-US", {
    maximumFractionDigits: 4,
    minimumFractionDigits: 0,
  })} 0G`;
}

function formatPolicySeconds(value: bigint) {
  if (value === 0n) {
    return "0 sec";
  }

  if (value % 3_600n === 0n) {
    return `${value / 3_600n} hr`;
  }

  if (value % 60n === 0n) {
    return `${value / 60n} min`;
  }

  return `${value} sec`;
}

function formatMinOutBps(value: number) {
  const percent = value / 100;
  return `${percent.toLocaleString("en-US", {
    maximumFractionDigits: 2,
    minimumFractionDigits: percent % 1 === 0 ? 0 : undefined,
  })}%`;
}

function readOwnerBalanceLabel({
  balance,
  connected,
  error,
  loading,
}: {
  balance?: { decimals: number; symbol: string; value: bigint };
  connected: boolean;
  error: boolean;
  loading: boolean;
}) {
  if (!connected) {
    return "Connect wallet";
  }
  return readBalanceLabel({ balance, error, loading, missingLabel: "0 0G" });
}

function readVaultBalanceLabel({
  balance,
  error,
  loading,
  vaultAddress,
}: {
  balance?: { decimals: number; symbol: string; value: bigint };
  error: boolean;
  loading: boolean;
  vaultAddress: Address | null;
}) {
  if (vaultAddress === null) {
    return "Create vault";
  }
  return readBalanceLabel({ balance, error, loading, missingLabel: "0 0G" });
}

function readBalanceLabel({
  balance,
  error,
  loading,
  missingLabel,
}: {
  balance?: { decimals: number; symbol: string; value: bigint };
  error: boolean;
  loading: boolean;
  missingLabel: string;
}) {
  if (loading) {
    return "Loading";
  }
  if (error) {
    return "Unavailable";
  }
  if (balance === undefined) {
    return missingLabel;
  }

  const formatted = formatUnits(balance.value, balance.decimals);
  const parsed = Number(formatted);
  const symbol = balance.symbol || "0G";
  if (!Number.isFinite(parsed)) {
    return `${formatted} ${symbol}`;
  }
  if (parsed > 0 && parsed < 0.0001) {
    return `<0.0001 ${symbol}`;
  }

  return `${parsed.toLocaleString("en-US", {
    maximumFractionDigits: 4,
    minimumFractionDigits: parsed === 0 ? 0 : undefined,
  })} ${symbol}`;
}
