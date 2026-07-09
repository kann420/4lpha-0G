"use client";

import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { useAccount, useSignMessage } from "wagmi";
import type { Address } from "viem";

import { requestActionConsentNonce } from "@/components/agents/lp/actionConsentNonce";
import { useOgNetwork } from "@/components/app/useOgNetwork";
import { dispatchSigmaPetReaction } from "@/lib/copilot/sigma-pet";
import { buildCopilotActionConsentMessage } from "@/lib/copilot/wallet-access";

interface MintDefaults {
  currentTick: number;
  defaultAmount0G: string;
  feeTier: number;
  maxAmount0G: string;
  poolAddress: Address;
  poolLabel: string;
  tickLower: number;
  tickSpacing: number;
  tickUpper: number;
}

export interface ManualMintResult {
  amount0G: string;
  liquidity?: string;
  lpTxHash?: string;
  poolAddress?: string;
  quoteSource?: string;
  tickLower?: number;
  tickUpper?: number;
  tokenId?: string;
  staked?: boolean;
  stakeTxHash?: string;
  stakeError?: string;
}

export interface ManualMintTarget {
  poolAddress?: Address;
  poolLabel?: string;
}

export function LpManualMintDialog({
  agentId,
  onClose,
  onSuccess,
  open,
  target,
  vault,
}: {
  agentId: string;
  onClose: () => void;
  onSuccess: (result: ManualMintResult) => void;
  open: boolean;
  target?: ManualMintTarget | null;
  vault: string;
}) {
  const { address, isConnected } = useAccount();
  const { network, networkId } = useOgNetwork();
  const signMessage = useSignMessage();
  const [defaults, setDefaults] = useState<MintDefaults | null>(null);
  const [amount, setAmount] = useState("");
  const [loadingDefaults, setLoadingDefaults] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setDefaults(null);
      setAmount("");
      setLoadingDefaults(false);
      setPending(false);
      setError(null);
      return;
    }
    if (!address) {
      setDefaults(null);
      setError("Connect a wallet to prepare manual mint.");
      return;
    }
    const controller = new AbortController();
    async function loadDefaults() {
      setLoadingDefaults(true);
      setError(null);
      try {
        const params = new URLSearchParams({ wallet: address ?? "" });
        if (target?.poolAddress) params.set("poolAddress", target.poolAddress);
        const response = await fetch(`/api/agents/lp/${agentId}/mint/defaults?${params.toString()}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const json = (await response.json()) as {
          data?: MintDefaults;
          error?: { code?: string; message?: string };
        };
        if (!response.ok || !json.data) {
          const code = json.error?.code ?? "mint_defaults_failed";
          const message = json.error?.message ?? "Could not prepare manual mint.";
          throw new Error(`${code}: ${message}`);
        }
        setDefaults(json.data);
        setAmount(json.data.defaultAmount0G);
      } catch (err) {
        if (controller.signal.aborted) return;
        setDefaults(null);
        setError(err instanceof Error ? err.message : "Could not prepare manual mint.");
      } finally {
        if (!controller.signal.aborted) setLoadingDefaults(false);
      }
    }
    void loadDefaults();
    return () => controller.abort();
  }, [address, agentId, open, target?.poolAddress]);

  if (!open) return null;

  async function submit() {
    if (pending) return;
    if (!isConnected || !address) {
      setError("Connect a wallet to mint.");
      return;
    }
    if (!defaults) {
      setError("Mint defaults are not ready yet.");
      return;
    }
    const amount0G = amount.trim();
    if (!/^\d+(\.\d{1,18})?$/u.test(amount0G) || Number(amount0G) <= 0) {
      setError("Enter a positive 0G amount with at most 18 decimal places.");
      return;
    }
    setError(null);
    setPending(true);
    dispatchSigmaPetReaction("lp.mint.start", { force: true });
    try {
      const { nonce, expiresAt } = await requestActionConsentNonce("lp-mint", address);
      const message = buildCopilotActionConsentMessage({
        address,
        agentId,
        amount0G,
        chainId: network.chainId,
        networkId,
        action: "lp-mint",
        vault,
        poolAddress: defaults.poolAddress,
        tickLower: defaults.tickLower,
        tickUpper: defaults.tickUpper,
        nonce,
        expiresAt,
      });
      dispatchSigmaPetReaction("wallet.signature.pending", { force: true });
      const signature = await signMessage.signMessageAsync({ message });
      const response = await fetch(`/api/agents/lp/${agentId}/mint`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount0G,
          poolAddress: defaults.poolAddress,
          tickLower: defaults.tickLower,
          tickUpper: defaults.tickUpper,
          wallet: { address, chainId: network.chainId, message, signature },
          nonce,
          expiresAt,
        }),
      });
      const json = (await response.json()) as {
        data?: ManualMintResult;
        error?: { code?: string; message?: string };
      };
      if (!response.ok || !json.data) {
        const code = json.error?.code ?? "mint_failed";
        const message = json.error?.message ?? "Manual mint failed.";
        setError(`${code}: ${message}`);
        dispatchSigmaPetReaction("lp.mint.fail", { force: true });
        return;
      }
      onSuccess(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign or request failed.");
      dispatchSigmaPetReaction("lp.mint.fail", { force: true });
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Manual LP mint"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-2xl border border-line bg-panel-solid-strong p-5 shadow-[0_24px_72px_rgba(0,0,0,0.5)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary">
            <Plus className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <p className="text-base font-semibold text-foreground">Manual LP mint</p>
            <p className="truncate text-[11px] text-muted">
              {target?.poolLabel ? `Pool locked to ${target.poolLabel}` : "Bootstrap first position"}
            </p>
          </div>
        </div>

        <div className="mt-4 rounded-lg border border-line bg-panel p-3 text-[11px] text-muted">
          {loadingDefaults ? (
            <p>Preparing live pool range...</p>
          ) : defaults ? (
            <>
              <p>
                Pool: <span className="font-mono text-foreground">{defaults.poolLabel}</span>
              </p>
              <p className="mt-1">
                Address: <span className="font-mono text-foreground">{defaults.poolAddress}</span>
              </p>
              <p className="mt-1">
                Range:{" "}
                <span className="font-mono text-foreground">
                  [{defaults.tickLower}, {defaults.tickUpper}]
                </span>{" "}
                <span className="font-mono">current {defaults.currentTick}</span>
              </p>
              <p className="mt-1">
                Max for this mint: <span className="font-mono text-foreground">{defaults.maxAmount0G} 0G</span>
              </p>
            </>
          ) : (
            <p>Mint defaults unavailable.</p>
          )}
        </div>

        <label className="mt-4 block text-xs font-semibold uppercase tracking-[0.14em] text-muted">
          Amount (0G)
        </label>
        <input
          type="text"
          inputMode="decimal"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          placeholder="0.01"
          disabled={pending || loadingDefaults}
          className="mt-1 w-full rounded-lg border border-line bg-panel px-3 py-2 font-mono text-sm text-foreground outline-none focus:border-primary disabled:opacity-60"
        />

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
            disabled={pending || loadingDefaults || !defaults}
            className="inline-flex h-9 items-center rounded-full bg-primary px-4 text-xs font-semibold text-on-primary transition-[filter,transform] hover:brightness-105 active:scale-[0.98] disabled:opacity-60"
          >
            {pending ? "Signing..." : "Mint LP NFT"}
          </button>
        </div>
      </div>
    </div>
  );
}
