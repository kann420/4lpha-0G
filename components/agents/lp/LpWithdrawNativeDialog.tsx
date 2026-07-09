"use client";

import { useEffect, useState } from "react";
import { ArrowDownToLine } from "lucide-react";
import { useAccount, useSignMessage } from "wagmi";

import { dispatchSigmaPetReaction } from "@/lib/copilot/sigma-pet";
import { buildCopilotActionConsentMessage } from "@/lib/copilot/wallet-access";
import { useOgNetwork } from "@/components/app/useOgNetwork";
import { requestActionConsentNonce } from "@/components/agents/lp/actionConsentNonce";

// Owner-only native 0G withdrawal from the V3 Policy Vault. Modal with an
// explicit confirm step (owner-only, real gas, real funds) and an amount
// input. Signs an action-specific consent (action "vault-withdraw-native" +
// vault + amount0G + server nonce) and POSTs /api/vault/withdraw-native
// with confirmedSteps:["withdraw-native"]. The route + helper re-verify the
// connected wallet is the vault owner and that DEPLOYER === vault.owner.

export function LpWithdrawNativeDialog({
  agentId,
  open,
  vault,
  vaultBalance0G,
  onClose,
  onSuccess,
}: {
  agentId?: string;
  open: boolean;
  vault: string;
  vaultBalance0G?: string;
  onClose: () => void;
  onSuccess: (result: { txHash: string; amount0G: string; balanceAfter0G: string }) => void;
}) {
  const { address, isConnected } = useAccount();
  const { networkId, network } = useOgNetwork();
  const signMessage = useSignMessage();
  const [amount, setAmount] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setAmount("");
      setConfirmed(false);
      setPending(false);
      setError(null);
    }
  }, [open]);

  if (!open) return null;

  async function submit() {
    if (pending) return;
    if (!isConnected || !address) {
      setError("Connect a wallet to withdraw.");
      return;
    }
    const trimmed = amount.trim();
    if (!/^\d+(\.\d{1,18})?$/u.test(trimmed) || Number(trimmed) <= 0) {
      setError("Enter a positive 0G amount with at most 18 decimal places.");
      return;
    }
    if (!confirmed) {
      setError("Confirm the withdrawal checkbox before continuing.");
      return;
    }
    setError(null);
    setPending(true);
    dispatchSigmaPetReaction("vault.withdraw.start", { force: true });
    try {
      const { nonce, expiresAt } = await requestActionConsentNonce("vault-withdraw-native", address);
      const message = buildCopilotActionConsentMessage({
        address,
        chainId: network.chainId,
        networkId,
        action: "vault-withdraw-native",
        vault,
        amount0G: trimmed,
        nonce,
        expiresAt,
      });
      dispatchSigmaPetReaction("wallet.signature.pending", { force: true });
      const signature = await signMessage.signMessageAsync({ message });
      const response = await fetch("/api/vault/withdraw-native", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentId,
          amount0G: trimmed,
          wallet: { address, chainId: network.chainId, message, signature },
          nonce,
          expiresAt,
          confirmedSteps: ["withdraw-native"],
        }),
      });
      const json = (await response.json()) as {
        data?: { txHash?: string; amount0G?: string; balanceAfter0G?: string };
        error?: { code?: string; message?: string };
      };
      if (!response.ok || !json.data) {
        const code = json.error?.code ?? "withdraw_failed";
        const msg = json.error?.message ?? "Withdrawal failed.";
        setError(`${code}: ${msg}`);
        dispatchSigmaPetReaction("vault.withdraw.fail", { force: true });
        return;
      }
      dispatchSigmaPetReaction("vault.withdraw.success", { force: true });
      onSuccess({
        txHash: json.data.txHash ?? "",
        amount0G: json.data.amount0G ?? trimmed,
        balanceAfter0G: json.data.balanceAfter0G ?? "",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign or request failed.");
      dispatchSigmaPetReaction("vault.withdraw.fail", { force: true });
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Withdraw 0G from Policy Vault"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-line bg-panel-solid-strong p-5 shadow-[0_24px_72px_rgba(0,0,0,0.5)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
            <ArrowDownToLine className="h-5 w-5" />
          </span>
          <div>
            <p className="text-base font-semibold text-foreground">Withdraw 0G</p>
            <p className="text-[11px] text-muted">Owner-only · real gas · real funds</p>
          </div>
        </div>

        <div className="mt-4 rounded-lg border border-line bg-panel p-3 text-[11px] text-muted">
          <p>Vault: <span className="font-mono text-foreground">{vault}</span></p>
          <p className="mt-1">Vault balance: <span className="font-mono text-foreground">{vaultBalance0G ?? "—"} 0G</span></p>
          <p className="mt-1">Withdraws native 0G to the vault owner (DEPLOYER signs on-chain).</p>
        </div>

        <label className="mt-4 block text-xs font-semibold uppercase tracking-[0.14em] text-muted">
          Amount (0G)
        </label>
        <input
          type="text"
          inputMode="decimal"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          placeholder="0.0"
          disabled={pending}
          className="mt-1 w-full rounded-lg border border-line bg-panel px-3 py-2 font-mono text-sm text-foreground outline-none focus:border-primary disabled:opacity-60"
        />

        <label className="mt-3 flex items-start gap-2 text-xs text-muted">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
            disabled={pending}
            className="mt-0.5 h-4 w-4 accent-primary"
          />
          <span>I understand this is an owner-only on-chain withdrawal that spends real gas and moves real funds.</span>
        </label>

        {error ? <p className="mt-3 text-[11px] font-semibold text-rose">{error}</p> : null}

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className="inline-flex h-9 items-center rounded-full border border-line bg-panel px-4 text-xs font-semibold text-foreground transition-colors hover:border-line-strong disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={pending || !confirmed}
            className="inline-flex h-9 items-center rounded-full bg-primary px-4 text-xs font-semibold text-on-primary transition-[filter,transform] hover:brightness-105 active:scale-[0.98] disabled:opacity-60"
          >
            {pending ? "Signing…" : "Withdraw 0G"}
          </button>
        </div>
      </div>
    </div>
  );
}
