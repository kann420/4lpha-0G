"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  CheckCircle2,
  Factory,
  Loader2,
  Pause,
  RefreshCcw,
  ShieldCheck,
  ShieldOff,
  Wallet,
} from "lucide-react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  formatEther,
  http,
  parseEther,
  type Address,
  type Chain,
  type EIP1193Provider,
  type Hex,
} from "viem";
import { useAccount, useChainId, useSwitchChain } from "wagmi";
import { policyVaultAbi } from "@/lib/contracts/policy-vault";
import { dispatchSigmaPetReaction } from "@/lib/copilot/sigma-pet";
import type { OgNetworkConfig } from "@/lib/types";

const buttonClass =
  "inline-flex h-11 items-center justify-center gap-2 rounded-full px-4 text-sm font-semibold transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-45";

// Pre-flight validation regex — mirrors parsePositiveAmount's accepted shape.
const POSITIVE_AMOUNT = /^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/;

export function VaultActionPanel({
  factoryAddress,
  isCreatingVault,
  isDiscoveringVault,
  lpEntryVaultAddress = null,
  lpExitVaultAddress = null,
  network,
  onRefreshVaultAddress,
  onVaultStateChange,
  vaultAddress,
}: {
  factoryAddress: Address | null;
  isCreatingVault: boolean;
  isDiscoveringVault: boolean;
  // V4 only: the LP Entry third. When present, the panel splits funding into a Trading pocket
  // (vaultAddress = Swap third) and an LP pocket (lpEntryVaultAddress) with a Move-between control.
  lpEntryVaultAddress?: Address | null;
  // V4 only: the LP Exit third. LP zap-out / exit proceeds land here (not in Swap or LpEntry),
  // so withdraw must be able to source from it — otherwise those funds get stuck (no UI reaches it).
  lpExitVaultAddress?: Address | null;
  network: OgNetworkConfig;
  onRefreshVaultAddress: () => Promise<void>;
  onVaultStateChange?: () => void;
  vaultAddress: Address | null;
}) {
  const isV4 = lpEntryVaultAddress !== null && vaultAddress !== null;
  const [fundTarget, setFundTarget] = useState<"trading" | "lp">("lp");
  // The pocket that deposit/withdraw currently target (V4). Pocket balances + the Move-between
  // control live in the left-column VaultPocketsPanel; this panel keeps the compact target toggle.
  const activeVaultAddress = isV4 && fundTarget === "lp" ? lpEntryVaultAddress : vaultAddress;
  // Withdraw sources across ALL thirds (Swap + LpEntry + LpExit), not just the active deposit pocket.
  // LP exit/zap-out proceeds return to LpExit, which no pocket toggle targets — draining all three on
  // withdraw guarantees no owner funds can get stranded in a third the UI would otherwise never reach.
  const withdrawTargets = useMemo<Address[]>(() => {
    if (isV4 && vaultAddress && lpEntryVaultAddress && lpExitVaultAddress) {
      return [vaultAddress, lpEntryVaultAddress, lpExitVaultAddress];
    }
    return vaultAddress ? [vaultAddress] : [];
  }, [isV4, vaultAddress, lpEntryVaultAddress, lpExitVaultAddress]);
  const [deposit, setDeposit] = useState("0.01");
  const [withdraw, setWithdraw] = useState("0.01");
  const [paused, setPaused] = useState(false);
  const [revoked, setRevoked] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [owner, setOwner] = useState<Address | null>(null);
  const [vaultBalance, setVaultBalance] = useState<string>("--");
  // Total native across all withdraw thirds (Swap + LpEntry + LpExit). Feeds withdraw "All" + validation
  // so a rescue pulls everything, including LpExit proceeds the pocket balance line does not show.
  const [withdrawableTotal, setWithdrawableTotal] = useState<string>("--");
  const [statusText, setStatusText] = useState("Configure a deployed vault address to enable live controls.");
  const [statusTxHash, setStatusTxHash] = useState<Hex | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const walletAccount = useAccount();
  const connectedChainId = useChainId();
  const switchChain = useSwitchChain();
  const chain = useMemo(() => makeViemChain(network), [network]);
  const publicClient = useMemo(
    () => createPublicClient({ chain, transport: http(network.rpcUrl) }),
    [chain, network.rpcUrl],
  );
  const panelStateLabel = vaultAddress === null ? "Pending" : "Active";
  const panelStateClass =
    vaultAddress === null
      ? "border-amber/20 bg-amber/10 text-amber"
      : "border-green/20 bg-green/10 text-green";
  const walletStatus = getWalletStatus({
    connectedAddress: walletAccount.address,
    expectedChainId: network.chainId,
    isConnected: walletAccount.isConnected,
    owner,
    walletChainId: connectedChainId,
  });
  const ownerControlDisabled =
    vaultAddress === null ||
    !walletAccount.isConnected ||
    busyAction !== null ||
    isCreatingVault ||
    isDiscoveringVault;
  const canSetWithdrawAll =
    !ownerControlDisabled && Number.isFinite(Number(withdrawableTotal)) && Number(withdrawableTotal) > 0;
  const depositValid = POSITIVE_AMOUNT.test(deposit.trim()) && Number(deposit.trim()) > 0;
  const withdrawValid = POSITIVE_AMOUNT.test(withdraw.trim()) && Number(withdraw.trim()) > 0;
  const showDepositError = !ownerControlDisabled && !depositValid;
  const showWithdrawError = !ownerControlDisabled && !withdrawValid;
  const railSetupStatus = getRailSetupStatus({
    factoryAddress,
    isCreatingVault,
    isDiscoveringVault,
    isConnected: walletAccount.isConnected,
    statusText,
    vaultAddress,
    walletTone: walletStatus.tone,
  });

  const refreshVault = useCallback(async () => {
    setRefreshing(true);
    if (vaultAddress === null) {
      setOwner(null);
      setVaultBalance("--");
      setPaused(false);
      setRevoked(false);
      setStatusText("No deployed vault address is configured for this network.");
      setRefreshing(false);
      return;
    }

    try {
      // Balance is read from the ACTIVE pocket (Swap or LpEntry) so withdraw-all + validation match
      // the selected deposit/withdraw target. paused/revoked/owner are vault-level (same across thirds).
      const [balance, pausedValue, revokedValue, ownerValue] = await Promise.all([
        publicClient.getBalance({ address: (activeVaultAddress ?? vaultAddress) as Address }),
        publicClient.readContract({ address: vaultAddress, abi: policyVaultAbi, functionName: "paused" }),
        publicClient.readContract({ address: vaultAddress, abi: policyVaultAbi, functionName: "executorRevoked" }),
        publicClient.readContract({ address: vaultAddress, abi: policyVaultAbi, functionName: "owner" }),
      ]);
      setVaultBalance(formatEther(balance));
      setPaused(pausedValue);
      setRevoked(revokedValue);
      setOwner(ownerValue);
      // Sum every withdraw third so "All" and validation cover LpExit proceeds too.
      const targetBalances = await Promise.all(
        withdrawTargets.map((address) => publicClient.getBalance({ address }).catch(() => 0n)),
      );
      setWithdrawableTotal(formatEther(targetBalances.reduce((sum, value) => sum + value, 0n)));
      setStatusText("Vault state refreshed from 0G RPC.");
    } catch {
      setStatusText("Could not read vault state from the selected 0G RPC.");
    } finally {
      setRefreshing(false);
    }
  }, [publicClient, vaultAddress, lpEntryVaultAddress, isV4, fundTarget, withdrawTargets]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refreshVault();
    }, 0);

    return () => window.clearTimeout(timer);
  }, [refreshVault]);

  async function runOwnerAction(actionName: string, action: (account: Address, walletClient: ReturnType<typeof createWalletClient>) => Promise<Hex>) {
    if (vaultAddress === null) {
      return;
    }
    setBusyAction(actionName);
    setStatusTxHash(null);
    setStatusText("Waiting for wallet confirmation.");
    dispatchVaultActionStart(actionName, paused);
    try {
      if (!walletAccount.isConnected || !walletAccount.address) {
        throw new Error("Connect the vault owner wallet first.");
      }
      if (connectedChainId !== network.chainId) {
        setStatusText(`Switching wallet to ${network.networkName}.`);
        dispatchSigmaPetReaction("wallet.switch.start", { force: true });
        await switchChain.switchChainAsync({ chainId: network.chainId });
        dispatchSigmaPetReaction("wallet.switch.success", { force: true });
      }
      const walletClient = await getWalletClient(chain);
      const [account] = await walletClient.getAddresses();
      const currentOwner = await publicClient.readContract({
        address: vaultAddress,
        abi: policyVaultAbi,
        functionName: "owner",
      });
      setOwner(currentOwner);
      if (account.toLowerCase() !== currentOwner.toLowerCase()) {
        dispatchSigmaPetReaction("wallet.owner-mismatch", { force: true });
        throw new Error("Connected wallet is not the vault owner.");
      }
      dispatchSigmaPetReaction("wallet.signature.pending", { force: true });
      const txHash = await action(account, walletClient);
      setStatusTxHash(txHash);
      setStatusText("Transaction submitted. Waiting for confirmation.");
      try {
        await publicClient.waitForTransactionReceipt({
          hash: txHash,
          pollingInterval: 3_000,
          timeout: 120_000,
        });
      } catch {
        await refreshVault();
        onVaultStateChange?.();
        setStatusText("Receipt is still indexing on this RPC. Vault state was refreshed from 0G.");
        dispatchVaultActionSuccess(actionName, paused);
        return;
      }
      await refreshVault();
      onVaultStateChange?.();
      setStatusText("Transaction confirmed on 0G.");
      dispatchVaultActionSuccess(actionName, paused);
    } catch (error) {
      setStatusTxHash(null);
      dispatchVaultActionFailure(actionName, error);
      setStatusText(error instanceof Error ? sanitizeWalletError(error.message) : "Wallet action failed.");
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <aside
      className="animate-feed-reveal rounded-hero border border-line bg-panel-solid-strong p-4 sm:p-5 lg:rounded-[30px] xl:sticky xl:top-8 xl:self-start"
      style={{ animationDelay: "240ms" }}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.24em] text-muted">Actions</p>
          <h2 className="mt-2 font-heading text-xl font-semibold tracking-tight text-foreground">Funding control</h2>
        </div>
        <span className={`shrink-0 rounded-full border px-3 py-1 text-xs font-medium ${panelStateClass}`}>
          {panelStateLabel}
        </span>
      </div>

      <div className="mt-5 grid gap-2">
        <VaultRailStatus status={railSetupStatus} />
        {statusTxHash ? (
          <p className="px-1 text-xs text-muted">
            Tx:{" "}
            <a
              href={`${network.explorerUrl}/tx/${statusTxHash}`}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-primary underline decoration-primary/40 underline-offset-4 transition-colors hover:text-primary"
            >
              View on 0G ChainScan
            </a>
          </p>
        ) : null}

        {isV4 ? (
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setFundTarget("trading")}
              className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
                fundTarget === "trading" ? "border-amber/40 bg-amber/10 text-amber" : "border-line text-muted hover:border-amber/25"
              }`}
            >
              Trading pocket
            </button>
            <button
              type="button"
              onClick={() => setFundTarget("lp")}
              className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
                fundTarget === "lp" ? "border-primary/40 bg-primary/10 text-primary" : "border-line text-muted hover:border-primary/25"
              }`}
            >
              LP pocket
            </button>
          </div>
        ) : null}

        <label className="grid gap-2">
          <span className="text-[11px] font-medium uppercase tracking-[0.22em] text-muted">
            {isV4 ? `Add 0G → ${fundTarget === "lp" ? "LP" : "Trading"} pocket` : "Add 0G"}
          </span>
          <div
            className={`flex h-11 items-center rounded-full border bg-panel px-4 transition-colors focus-within:bg-panel ${
              showDepositError
                ? "border-rose/40"
                : "border-line focus-within:border-amber/40"
            }`}
          >
            <input
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={deposit}
              disabled={ownerControlDisabled}
              onChange={(event) => setDeposit(event.target.value)}
              className="min-w-0 flex-1 bg-transparent text-sm font-semibold tabular-nums text-foreground outline-none placeholder:text-muted disabled:cursor-not-allowed"
              placeholder="0.01"
            />
            <span className="pl-3 text-xs font-semibold text-amber">0G</span>
          </div>
          {showDepositError ? (
            <span className="px-1 text-xs text-rose">Enter a positive 0G amount (up to 18 decimals).</span>
          ) : null}
        </label>

        <button
          type="button"
          disabled={ownerControlDisabled}
          onClick={() =>
            runOwnerAction("deposit", async (account, walletClient) => {
              const value = parsePositiveAmount(deposit);
              const simulation = await publicClient.simulateContract({
                account,
                address: activeVaultAddress as Address,
                abi: policyVaultAbi,
                functionName: "depositNative",
                value,
              });
              // explicit gas → wallet skips (failing) estimation on 0G
              return walletClient.writeContract({ ...simulation.request, gas: 200_000n });
            })
          }
          className={`${buttonClass} w-full bg-amber text-background hover:bg-amber`}
        >
          {busyAction === "deposit" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowDownToLine className="h-4 w-4" />}
          {busyAction === "deposit" ? "Depositing" : "Deposit"}
        </button>

        <label className="mt-2 grid gap-2">
          <span className="text-[11px] font-medium uppercase tracking-[0.22em] text-muted">Withdraw 0G</span>
          <div
            className={`flex h-11 items-center gap-2 rounded-full border bg-panel px-3 transition-colors focus-within:bg-panel ${
              showWithdrawError
                ? "border-rose/40"
                : "border-line focus-within:border-primary/40"
            }`}
          >
            <input
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={withdraw}
              disabled={ownerControlDisabled}
              onChange={(event) => setWithdraw(event.target.value)}
              className="min-w-0 flex-1 bg-transparent px-1 text-sm font-semibold tabular-nums text-foreground outline-none placeholder:text-muted disabled:cursor-not-allowed"
              placeholder="0.01"
            />
            <button
              type="button"
              disabled={!canSetWithdrawAll}
              onClick={() => {
                dispatchSigmaPetReaction("vault.withdraw.all", { force: true });
                setWithdraw(normalizeBalanceInput(withdrawableTotal));
              }}
              className="ml-auto rounded-full border border-primary/20 bg-primary/10 px-2.5 py-1 text-[11px] font-semibold text-primary transition-colors hover:border-primary/35 hover:bg-primary/18 disabled:cursor-not-allowed disabled:border-line disabled:bg-panel disabled:text-muted"
            >
              All
            </button>
            <span className="text-xs font-semibold text-primary">0G</span>
          </div>
          {showWithdrawError ? (
            <span className="px-1 text-xs text-rose">Enter a positive 0G amount (up to 18 decimals).</span>
          ) : null}
        </label>

        <button
          type="button"
          disabled={ownerControlDisabled}
          onClick={() =>
            runOwnerAction("withdraw", async (account, walletClient) => {
              const amount = parsePositiveAmount(withdraw);
              // Read every third's balance, then pull the requested amount across them (Swap → LpEntry
              // → LpExit). This reaches LpExit proceeds no single pocket exposes. Multiple thirds =
              // multiple wallet confirmations; each withdrawNative is owner-only and bounded by balance.
              const balances = await Promise.all(
                withdrawTargets.map((address) => publicClient.getBalance({ address }).catch(() => 0n)),
              );
              const total = balances.reduce((sum, value) => sum + value, 0n);
              if (amount > total) {
                throw new Error("Withdraw amount exceeds vault balance.");
              }
              setWithdrawableTotal(formatEther(total));
              let remaining = amount;
              let lastTxHash: Hex | null = null;
              for (let i = 0; i < withdrawTargets.length && remaining > 0n; i += 1) {
                const take = balances[i] < remaining ? balances[i] : remaining;
                if (take <= 0n) continue;
                const simulation = await publicClient.simulateContract({
                  account,
                  address: withdrawTargets[i],
                  abi: policyVaultAbi,
                  functionName: "withdrawNative",
                  args: [take],
                });
                // explicit gas → wallet skips (failing) estimation on 0G
                lastTxHash = await walletClient.writeContract({ ...simulation.request, gas: 200_000n });
                await publicClient.waitForTransactionReceipt({ hash: lastTxHash });
                remaining -= take;
              }
              if (!lastTxHash) {
                throw new Error("No vault third held a withdrawable balance.");
              }
              return lastTxHash;
            })
          }
          className={`${buttonClass} w-full bg-primary text-background hover:bg-primary`}
        >
          {busyAction === "withdraw" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUpFromLine className="h-4 w-4" />}
          {busyAction === "withdraw" ? "Withdrawing" : "Withdraw"}
        </button>

        <button
          type="button"
          disabled={busyAction !== null || isCreatingVault || isDiscoveringVault}
          onClick={() => {
            dispatchSigmaPetReaction("vault.refresh", { force: true });
            void Promise.all([refreshVault(), onRefreshVaultAddress()]).then(() => onVaultStateChange?.());
          }}
          className={`${buttonClass} w-full border border-line bg-panel text-foreground hover:border-primary/20 hover:bg-panel-strong`}
        >
          {isDiscoveringVault ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
          Refresh status
        </button>

        <section className="mt-3 grid gap-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[10px] font-medium uppercase tracking-[0.22em] text-muted">Owner safety</span>
            <span className="text-xs font-semibold text-muted">agent scope</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              aria-pressed={paused}
              disabled={ownerControlDisabled}
              onClick={() =>
                runOwnerAction("pause", async (account, walletClient) => {
                  const simulation = await publicClient.simulateContract({
                    account,
                    address: vaultAddress as Address,
                    abi: policyVaultAbi,
                    functionName: "setPaused",
                    args: [!paused],
                  });
                  return walletClient.writeContract(simulation.request);
                })
              }
              className={`${buttonClass} border ${
                paused
                  ? "border-amber/20 bg-amber/[0.1] text-amber hover:bg-amber/[0.16]"
                  : "border-line bg-panel text-foreground hover:border-line-strong hover:bg-panel-strong"
              }`}
            >
              {busyAction === "pause" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Pause className="h-4 w-4" />}
              {paused ? "Resume" : "Pause"}
            </button>
            <button
              type="button"
              aria-pressed={revoked}
              disabled={ownerControlDisabled || revoked}
              onClick={() =>
                runOwnerAction("revoke", async (account, walletClient) => {
                  const simulation = await publicClient.simulateContract({
                    account,
                    address: vaultAddress as Address,
                    abi: policyVaultAbi,
                    functionName: "revokeExecutor",
                  });
                  return walletClient.writeContract(simulation.request);
                })
              }
              className={`${buttonClass} border ${
                revoked
                  ? "border-rose/20 bg-rose/[0.1] text-rose hover:bg-rose/[0.16]"
                  : "border-line bg-panel text-foreground hover:border-line-strong hover:bg-panel-strong"
              }`}
            >
              {busyAction === "revoke" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldOff className="h-4 w-4" />}
              {revoked ? "Revoked" : "Revoke"}
            </button>
          </div>
        </section>
      </div>

      <div className="mt-5 space-y-2 border-t border-line pt-5">
        <RailStatus
          icon={<Wallet className="h-4 w-4" />}
          label="Wallet"
          value={walletStatus.label}
          tone={walletStatus.tone}
        />
        <RailStatus
          icon={<Wallet className="h-4 w-4" />}
          label="Network"
          value={network.networkName}
          tone="emerald"
        />
        <RailStatus
          icon={<ShieldCheck className="h-4 w-4" />}
          label="Executor"
          value={revoked ? "revoked" : paused ? "paused" : "bounded"}
          tone={revoked ? "rose" : paused ? "amber" : "emerald"}
        />
        <RailStatus
          icon={<CheckCircle2 className="h-4 w-4" />}
          label="Vault"
          value={vaultAddress === null ? "not configured" : shortAddress(vaultAddress)}
          tone="slate"
        />
        <RailStatus
          icon={<ShieldCheck className="h-4 w-4" />}
          label="Balance"
          value={
            refreshing && vaultAddress !== null ? (
              <span className="inline-block h-3 w-16 animate-pulse rounded-full bg-panel-strong" />
            ) : vaultAddress === null ? (
              "--"
            ) : (
              `${formatBalanceLabel(vaultBalance)} 0G`
            )
          }
          tone="cyan"
        />
      </div>
    </aside>
  );
}

function VaultRailStatus({
  status,
}: {
  status: {
    detail: string;
    icon: "factory" | "loader" | "pause" | "shield" | "shieldOff";
    label: string;
    tone: "amber" | "cyan" | "emerald" | "rose" | "slate";
    variant?: "card" | "session";
  };
}) {
  if (status.variant === "session") {
    return (
      <div className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-full bg-green px-4 text-sm font-semibold text-background">
        <ShieldCheck className="h-4 w-4" />
        {status.label}
      </div>
    );
  }

  const toneClass =
    status.tone === "emerald"
      ? "border-green/20 bg-green/10 text-green"
      : status.tone === "amber"
        ? "border-amber/20 bg-amber/10 text-amber"
        : status.tone === "rose"
          ? "border-rose/20 bg-rose/10 text-rose"
          : status.tone === "cyan"
            ? "border-teal/20 bg-teal/10 text-teal"
            : "border-line bg-panel text-foreground";
  const icon =
    status.icon === "loader" ? (
      <Loader2 className="h-4 w-4 animate-spin" />
    ) : status.icon === "shield" ? (
      <ShieldCheck className="h-4 w-4" />
    ) : status.icon === "shieldOff" ? (
      <ShieldOff className="h-4 w-4" />
    ) : status.icon === "pause" ? (
      <Pause className="h-4 w-4" />
    ) : (
      <Factory className="h-4 w-4" />
    );

  return (
    <div className={`rounded-card border px-4 py-3 ${toneClass}`}>
      <div className="flex items-center justify-between gap-3">
        <span className="inline-flex min-w-0 items-center gap-2 text-sm font-semibold">
          {icon}
          <span className="truncate">{status.label}</span>
        </span>
        <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.18em] opacity-70">Vault</span>
      </div>
      <p className="mt-1 truncate text-xs leading-5 text-muted" title={status.detail}>
        {status.detail}
      </p>
    </div>
  );
}

function RailStatus({
  icon,
  label,
  tone,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  tone: "amber" | "cyan" | "emerald" | "rose" | "slate";
  value: React.ReactNode;
}) {
  const toneClass =
    tone === "emerald"
      ? "text-green"
      : tone === "amber"
        ? "text-amber"
        : tone === "rose"
          ? "text-rose"
          : tone === "cyan"
            ? "text-teal"
            : "text-muted";

  return (
    <div className="flex min-h-10 items-center justify-between gap-3 rounded-tile bg-panel px-3 py-2.5">
      <span className="inline-flex min-w-0 items-center gap-2 text-xs text-muted">
        {icon}
        <span className="truncate">{label}</span>
      </span>
      <span className={`min-w-0 truncate text-right text-xs font-semibold ${toneClass}`}>{value}</span>
    </div>
  );
}

function getRailSetupStatus({
  factoryAddress,
  isCreatingVault,
  isDiscoveringVault,
  isConnected,
  statusText,
  vaultAddress,
  walletTone,
}: {
  factoryAddress: Address | null;
  isCreatingVault: boolean;
  isDiscoveringVault: boolean;
  isConnected: boolean;
  statusText: string;
  vaultAddress: Address | null;
  walletTone: "amber" | "cyan" | "emerald" | "rose" | "slate";
}): {
  detail: string;
  icon: "factory" | "loader" | "pause" | "shield" | "shieldOff";
  label: string;
  tone: "amber" | "cyan" | "emerald" | "rose" | "slate";
  variant?: "card" | "session";
} {
  if (isCreatingVault || isDiscoveringVault) {
    return { detail: statusText, icon: "loader", label: isCreatingVault ? "Creating vault" : "Refreshing vault", tone: "cyan" };
  }
  if (vaultAddress === null) {
    return {
      detail: factoryAddress === null ? "Factory is not configured for this network." : "Use the Policy Vault card to create it.",
      icon: "factory",
      label: "Vault setup required",
      tone: factoryAddress === null ? "rose" : "amber",
    };
  }
  if (!isConnected) {
    return { detail: "Connect owner wallet to manage funding.", icon: "shield", label: "Vault ready", tone: "cyan" };
  }
  if (walletTone === "amber") {
    return { detail: "Switch wallet to the selected 0G network.", icon: "shield", label: "Wrong network", tone: "amber" };
  }
  if (walletTone === "rose") {
    return { detail: "Connected wallet is not the vault owner.", icon: "shieldOff", label: "Owner mismatch", tone: "rose" };
  }
  return { detail: "Owner wallet is bound to this vault.", icon: "shield", label: "Session active", tone: "emerald", variant: "session" };
}

function makeViemChain(network: OgNetworkConfig): Chain {
  return {
    id: network.chainId,
    name: network.networkName,
    nativeCurrency: {
      decimals: 18,
      name: "0G",
      symbol: "0G",
    },
    rpcUrls: {
      default: { http: [network.rpcUrl] },
    },
    blockExplorers: {
      default: {
        name: "0G ChainScan",
        url: network.explorerUrl,
      },
    },
  };
}

async function getWalletClient(chain: Chain) {
  const ethereum = getEthereumProvider();
  await ethereum.request({ method: "eth_requestAccounts" });
  const currentChainId = await ethereum.request({ method: "eth_chainId" });
  const requiredChainId = `0x${chain.id.toString(16)}` as `0x${string}`;
  if (String(currentChainId).toLowerCase() !== requiredChainId) {
    await switchOrAddChain(ethereum, chain, requiredChainId);
  }
  return createWalletClient({ chain, transport: custom(ethereum) });
}

async function switchOrAddChain(
  ethereum: EIP1193Provider,
  chain: Chain,
  requiredChainId: `0x${string}`,
) {
  try {
    await ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: requiredChainId }],
    });
  } catch (error) {
    if (!isUnknownChainError(error)) {
      throw error;
    }

    await ethereum.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          blockExplorerUrls: chain.blockExplorers?.default?.url
            ? [chain.blockExplorers.default.url]
            : undefined,
          chainId: requiredChainId,
          chainName: chain.name,
          nativeCurrency: chain.nativeCurrency,
          rpcUrls: chain.rpcUrls.default.http,
        },
      ],
    });
  }
}

function isUnknownChainError(error: unknown) {
  const maybeError = error as { code?: unknown; message?: unknown };
  return (
    maybeError.code === 4902 ||
    (typeof maybeError.message === "string" && maybeError.message.toLowerCase().includes("unrecognized chain"))
  );
}

function getEthereumProvider(): EIP1193Provider {
  const maybeWindow = window as Window & { ethereum?: EIP1193Provider };
  if (maybeWindow.ethereum === undefined) {
    throw new Error("No injected wallet found.");
  }
  return maybeWindow.ethereum;
}

function sanitizeWalletError(message: string): string {
  if (message.length > 160) {
    return `${message.slice(0, 157)}...`;
  }
  return message;
}

function dispatchVaultActionStart(actionName: string, isPaused: boolean) {
  if (actionName === "deposit") {
    dispatchSigmaPetReaction("vault.deposit.start", { force: true });
    return;
  }
  if (actionName === "withdraw") {
    dispatchSigmaPetReaction("vault.withdraw.start", { force: true });
    return;
  }
  if (actionName === "pause") {
    dispatchSigmaPetReaction(isPaused ? "vault.resume" : "vault.pause", { force: true });
    return;
  }
  if (actionName === "revoke") {
    dispatchSigmaPetReaction("vault.revoke", { force: true });
  }
}

function dispatchVaultActionSuccess(actionName: string, wasPaused: boolean) {
  if (actionName === "deposit") {
    dispatchSigmaPetReaction("vault.deposit.success", { force: true });
    return;
  }
  if (actionName === "withdraw") {
    dispatchSigmaPetReaction("vault.withdraw.success", { force: true });
    return;
  }
  if (actionName === "pause") {
    dispatchSigmaPetReaction(wasPaused ? "vault.resume" : "vault.pause", { force: true });
    return;
  }
  if (actionName === "revoke") {
    dispatchSigmaPetReaction("vault.revoke", { force: true });
  }
}

function dispatchVaultActionFailure(actionName: string, error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("user rejected") || message.includes("rejected request")) {
    dispatchSigmaPetReaction("wallet.signature.rejected", { force: true });
    return;
  }
  if (actionName === "deposit") {
    dispatchSigmaPetReaction("vault.deposit.fail", { force: true });
    return;
  }
  if (actionName === "withdraw") {
    dispatchSigmaPetReaction("vault.withdraw.fail", { force: true });
    return;
  }
  dispatchSigmaPetReaction("wallet.connect.fail", { force: true });
}

function shortAddress(value: string) {
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function getWalletStatus({
  connectedAddress,
  expectedChainId,
  isConnected,
  owner,
  walletChainId,
}: {
  connectedAddress?: Address;
  expectedChainId: number;
  isConnected: boolean;
  owner: Address | null;
  walletChainId: number;
}): { label: string; tone: "amber" | "cyan" | "emerald" | "rose" | "slate" } {
  if (!isConnected || !connectedAddress) {
    return { label: "not connected", tone: "slate" };
  }
  if (walletChainId !== expectedChainId) {
    return { label: "wrong network", tone: "amber" };
  }
  if (owner !== null && connectedAddress.toLowerCase() !== owner.toLowerCase()) {
    return { label: "not owner", tone: "rose" };
  }
  if (owner !== null) {
    return { label: "owner connected", tone: "emerald" };
  }
  return { label: shortAddress(connectedAddress), tone: "cyan" };
}

function parsePositiveAmount(value: string): bigint {
  const trimmed = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(trimmed)) {
    throw new Error("Enter a positive 0G amount with up to 18 decimals.");
  }
  const parsed = parseEther(trimmed);
  if (parsed <= 0n) {
    throw new Error("Amount must be greater than zero.");
  }
  return parsed;
}

function formatBalanceLabel(value: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return "--";
  }
  return parsed.toFixed(4);
}

function normalizeBalanceInput(value: string) {
  const trimmed = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(trimmed)) {
    return "0";
  }

  return trimmed.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}
