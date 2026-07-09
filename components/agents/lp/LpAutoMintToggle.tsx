"use client";

import { useState } from "react";
import { useAccount, useSignMessage } from "wagmi";

import { dispatchSigmaPetReaction } from "@/lib/copilot/sigma-pet";
import { buildCopilotActionConsentMessage } from "@/lib/copilot/wallet-access";
import { useOgNetwork } from "@/components/app/useOgNetwork";
import { requestActionConsentNonce } from "@/components/agents/lp/actionConsentNonce";
import { LpStatusPill } from "@/components/agents/lp/LpStatusPill";

// Live Auto-mint toggle — the one automation that IS wired (the other four in
// LpPolicyControls are "coming soon"). Opts the agent into the autonomous LP
// mint loop (scripts/og-agent-lp-worker.ts), which mints positions within the
// vault's on-chain fence when the agent has idle balance and is off cooldown.
//
// Funds-moving consent: the wallet signs an action-specific message (action
// "lp-automation" + vault + agentId + desired state + server nonce) so a
// captured signature cannot be replayed for a different action, target, or
// toggle direction. The server validates via validateCopilotActionConsent.

export function LpAutoMintToggle({
  agentId,
  vault,
  autoMint,
  onAutoMintChange,
  disabled,
}: {
  agentId: string;
  vault: string;
  autoMint: boolean;
  onAutoMintChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  const { address, isConnected } = useAccount();
  const { networkId, network } = useOgNetwork();
  const signMessage = useSignMessage();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function toggle(next: boolean) {
    if (pending || disabled) return;
    if (!isConnected || !address) {
      setError("Connect a wallet to toggle Auto-mint.");
      setNote(null);
      return;
    }
    setError(null);
    setNote(null);
    setPending(true);
    dispatchSigmaPetReaction(next ? "lp.auto-mint.on" : "lp.auto-mint.off", { force: true });
    try {
      const { nonce, expiresAt } = await requestActionConsentNonce("lp-automation", address);
      const message = buildCopilotActionConsentMessage({
        address,
        chainId: network.chainId,
        networkId,
        action: "lp-automation",
        vault,
        agentId,
        automationEnabled: next,
        nonce,
        expiresAt,
      });
      dispatchSigmaPetReaction("wallet.signature.pending", { force: true });
      const signature = await signMessage.signMessageAsync({ message });
      const response = await fetch(`/api/agents/lp/${agentId}/automation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          autoMint: next,
          wallet: { address, chainId: network.chainId, message, signature },
          nonce,
          expiresAt,
        }),
      });
      const json = (await response.json()) as { data?: { autoMint?: boolean }; error?: { code?: string; message?: string } };
      if (!response.ok || !json.data) {
        const code = json.error?.code ?? "automation_update_failed";
        const msg = json.error?.message ?? "Could not update Auto-mint.";
        setError(`${code}: ${msg}`);
        return;
      }
      const resolvedAutoMint = json.data.autoMint ?? next;
      onAutoMintChange(resolvedAutoMint);
      dispatchSigmaPetReaction(resolvedAutoMint ? "lp.auto-mint.on" : "lp.auto-mint.off", { force: true });
      setNote(json.data.autoMint ? "Auto-mint ON — worker will mint within the fence." : "Auto-mint OFF.");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Sign or request failed.";
      setError(message);
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="rounded-tile border border-line bg-panel-solid-strong p-3">
      <div className="flex items-center justify-between gap-2">
        <LpStatusPill value={autoMint ? "armed" : "paused"} label={autoMint ? "Auto-mint on" : "Auto-mint off"} />
        <button
          type="button"
          onClick={() => toggle(!autoMint)}
          disabled={pending || disabled}
          className={`inline-flex h-9 items-center gap-2 rounded-full border px-3 text-xs font-semibold transition-colors ${
            autoMint
              ? "border-rose/20 bg-rose/[0.1] text-rose hover:bg-rose/[0.16]"
              : "border-primary/20 bg-primary/[0.1] text-primary hover:bg-primary/[0.16]"
          } ${pending || disabled ? "opacity-60" : ""}`}
        >
          {pending ? "Signing…" : autoMint ? "Turn off" : "Turn on"}
        </button>
      </div>
      {note ? <p className="mt-2 text-[11px] font-semibold text-primary">{note}</p> : null}
      {error ? <p className="mt-2 text-[11px] font-semibold text-rose">{error}</p> : null}
    </section>
  );
}
