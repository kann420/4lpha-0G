"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCcw, Wallet } from "lucide-react";
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
} from "viem";
import { useAccount, useChainId, useSwitchChain } from "wagmi";

import { policyVaultAbi } from "@/lib/contracts/policy-vault";
import type { OgNetworkConfig } from "@/lib/types";

const POSITIVE_AMOUNT = /^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/;

// Left-column V4 companion to VaultActionPanel: shows the per-pocket balances
// (Trading = Swap third, LP = LpEntry third) and a Move-between-pockets control.
// Move = owner withdraw from the source third + deposit into the destination third
// (two owner-signed txs; the agent never touches the wallet). Explicit gas is set so
// the wallet skips the failing 0G gas estimation.
export function VaultPocketsPanel({
  lpEntryVaultAddress,
  lpExitVaultAddress,
  network,
  onVaultStateChange,
  swapVaultAddress,
}: {
  lpEntryVaultAddress: Address;
  // LP exit/zap-out proceeds return here, not to LpEntry — the LP pocket balance must include it
  // or the panel understates LP funds (shows 0 while real 0G sits in LpExit).
  lpExitVaultAddress: Address | null;
  network: OgNetworkConfig;
  onVaultStateChange?: () => void;
  swapVaultAddress: Address;
}) {
  const [tradingBalance, setTradingBalance] = useState("--");
  const [lpBalance, setLpBalance] = useState("--");
  const [moveAmount, setMoveAmount] = useState("0.01");
  const [moveDir, setMoveDir] = useState<"tradingToLp" | "lpToTrading">("tradingToLp");
  const [busy, setBusy] = useState(false);
  const [statusText, setStatusText] = useState<string | null>(null);
  const walletAccount = useAccount();
  const connectedChainId = useChainId();
  const switchChain = useSwitchChain();
  const chain = useMemo(() => makeViemChain(network), [network]);
  const publicClient = useMemo(
    () => createPublicClient({ chain, transport: http(network.rpcUrl) }),
    [chain, network.rpcUrl],
  );

  const refresh = useCallback(async () => {
    try {
      const [trading, lpEntry, lpExit] = await Promise.all([
        publicClient.getBalance({ address: swapVaultAddress }),
        publicClient.getBalance({ address: lpEntryVaultAddress }),
        lpExitVaultAddress ? publicClient.getBalance({ address: lpExitVaultAddress }) : Promise.resolve(0n),
      ]);
      setTradingBalance(formatEther(trading));
      // LP pocket = LpEntry (deposits) + LpExit (zap-out / exit proceeds).
      setLpBalance(formatEther(lpEntry + lpExit));
    } catch {
      // leave last-known balances on a transient RPC failure
    }
  }, [publicClient, swapVaultAddress, lpEntryVaultAddress, lpExitVaultAddress]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const moveValid = POSITIVE_AMOUNT.test(moveAmount.trim()) && Number(moveAmount.trim()) > 0;
  const disabled = busy || !walletAccount.isConnected;

  async function runMove() {
    setBusy(true);
    setStatusText("Waiting for wallet confirmation.");
    try {
      const provider =
        typeof window === "undefined" ? undefined : (window as Window & { ethereum?: EIP1193Provider }).ethereum;
      if (!provider) {
        throw new Error("Wallet provider is required.");
      }
      if (connectedChainId !== network.chainId) {
        await switchChain.switchChainAsync({ chainId: network.chainId });
      }
      const walletClient = createWalletClient({ chain, transport: custom(provider) });
      const [account] = await walletClient.getAddresses();
      const owner = await publicClient.readContract({
        address: swapVaultAddress,
        abi: policyVaultAbi,
        functionName: "owner",
      });
      if (!account || account.toLowerCase() !== owner.toLowerCase()) {
        throw new Error("Connected wallet is not the vault owner.");
      }
      const amount = parseEther(moveAmount.trim());
      const source = moveDir === "tradingToLp" ? swapVaultAddress : lpEntryVaultAddress;
      const dest = moveDir === "tradingToLp" ? lpEntryVaultAddress : swapVaultAddress;
      const srcBalance = await publicClient.getBalance({ address: source });
      if (amount > srcBalance) {
        throw new Error("Move amount exceeds the source pocket balance.");
      }
      setStatusText("Step 1/2: withdrawing from the source pocket.");
      const withdrawSim = await publicClient.simulateContract({
        account,
        address: source,
        abi: policyVaultAbi,
        functionName: "withdrawNative",
        args: [amount],
      });
      const withdrawHash = await walletClient.writeContract({ ...withdrawSim.request, chain: null, gas: 200_000n });
      await publicClient.waitForTransactionReceipt({ hash: withdrawHash, timeout: 120_000 });
      setStatusText("Step 2/2: depositing into the destination pocket.");
      const depositSim = await publicClient.simulateContract({
        account,
        address: dest,
        abi: policyVaultAbi,
        functionName: "depositNative",
        value: amount,
      });
      const depositHash = await walletClient.writeContract({ ...depositSim.request, chain: null, gas: 200_000n });
      await publicClient.waitForTransactionReceipt({ hash: depositHash, timeout: 120_000 });
      setStatusText("Move complete.");
      await refresh();
      onVaultStateChange?.();
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : "Move failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="rounded-hero border border-line bg-panel-solid-strong p-4 sm:p-5 lg:rounded-[30px]">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.24em] text-muted">Vault pockets</p>
          <h2 className="mt-1 font-heading text-lg font-semibold tracking-tight text-foreground">Trading &amp; LP funds</h2>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          className="inline-flex h-9 items-center gap-1.5 rounded-full border border-line bg-panel px-3 text-xs font-semibold text-muted transition-colors hover:border-primary/25 hover:text-foreground"
        >
          <RefreshCcw className="h-3.5 w-3.5" /> Refresh
        </button>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <div className="rounded-2xl border border-amber/20 bg-amber/5 px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Trading</p>
          <p className="mt-1 text-lg font-semibold tabular-nums text-foreground">{tradingBalance} 0G</p>
        </div>
        <div className="rounded-2xl border border-primary/20 bg-primary/5 px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">LP</p>
          <p className="mt-1 text-lg font-semibold tabular-nums text-foreground">{lpBalance} 0G</p>
        </div>
      </div>

      <div className="mt-4 grid gap-2">
        <span className="text-[11px] font-medium uppercase tracking-[0.22em] text-muted">Move between pockets</span>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setMoveDir("tradingToLp")}
            className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
              moveDir === "tradingToLp" ? "border-primary/40 bg-primary/10 text-primary" : "border-line text-muted hover:border-primary/25"
            }`}
          >
            Trading → LP
          </button>
          <button
            type="button"
            onClick={() => setMoveDir("lpToTrading")}
            className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
              moveDir === "lpToTrading" ? "border-amber/40 bg-amber/10 text-amber" : "border-line text-muted hover:border-amber/25"
            }`}
          >
            LP → Trading
          </button>
        </div>
        <div className="flex h-11 items-center rounded-full border border-line bg-panel px-4">
          <input
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={moveAmount}
            disabled={disabled}
            onChange={(event) => setMoveAmount(event.target.value)}
            className="min-w-0 flex-1 bg-transparent text-sm font-semibold tabular-nums text-foreground outline-none placeholder:text-muted disabled:cursor-not-allowed"
            placeholder="0.01"
          />
          <span className="pl-3 text-xs font-semibold text-muted">0G</span>
        </div>
        <button
          type="button"
          disabled={disabled || !moveValid}
          onClick={() => void runMove()}
          className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-full border border-line bg-panel px-4 text-sm font-semibold text-foreground transition-colors hover:border-primary/25 disabled:cursor-not-allowed disabled:opacity-45"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
          {busy ? "Moving" : "Move"}
        </button>
        {statusText ? (
          <p className="flex items-center gap-1.5 px-1 text-xs text-muted">
            <Wallet className="h-3.5 w-3.5" /> {statusText}
          </p>
        ) : null}
      </div>
    </aside>
  );
}

function makeViemChain(network: OgNetworkConfig): Chain {
  return {
    id: network.chainId,
    name: network.networkName,
    nativeCurrency: { decimals: 18, name: "0G", symbol: "0G" },
    rpcUrls: { default: { http: [network.rpcUrl] } },
  };
}
