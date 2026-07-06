"use client";

import { useCallback } from "react";
import { useAccount, useSignMessage } from "wagmi";

import { buildCopilotActionConsentMessage } from "@/lib/copilot/wallet-access";
import { useOgNetwork } from "@/components/app/useOgNetwork";
import { requestActionConsentNonce } from "@/components/agents/lp/actionConsentNonce";

// Signs an action-specific LP consent (action + vault + agentId + tokenId +
// server nonce + expiry) and POSTs to a per-action route. Used by the LP detail
// page for stake / unstake / zap-out. The signed message binds the signature to
// one action + target so it cannot be replayed for a different action or token.

export interface LpActionRequestResult {
  ok: boolean;
  data?: { lpTxHash?: string; proofTxHash?: string; tokenId?: string; amountOutMin?: string };
  error?: string;
}

export function useLpActionRequest(agentId: string, vault: string) {
  const { address, isConnected } = useAccount();
  const { networkId, network } = useOgNetwork();
  const signMessage = useSignMessage();

  return useCallback(
    async (
      action: "lp-stake" | "lp-unstake" | "lp-zap-out",
      path: string,
      body: { poolAddress: string; tokenId: string },
    ): Promise<LpActionRequestResult> => {
      if (!isConnected || !address) {
        return { ok: false, error: "Connect a wallet to sign this action." };
      }
      try {
        const { nonce, expiresAt } = await requestActionConsentNonce(action, address);
        const message = buildCopilotActionConsentMessage({
          address,
          chainId: network.chainId,
          networkId,
          action,
          vault,
          agentId,
          poolAddress: body.poolAddress,
          tokenId: body.tokenId,
          nonce,
          expiresAt,
        });
        const signature = await signMessage.signMessageAsync({ message });
        const response = await fetch(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...body,
            wallet: { address, chainId: network.chainId, message, signature },
            nonce,
            expiresAt,
          }),
        });
        const json = (await response.json()) as { data?: LpActionRequestResult["data"]; error?: { code?: string; message?: string } };
        if (!response.ok || !json.data) {
          const code = json.error?.code ?? "action_failed";
          const msg = json.error?.message ?? "Action failed.";
          return { ok: false, error: `${code}: ${msg}` };
        }
        return { ok: true, data: json.data };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Sign or request failed.";
        return { ok: false, error: message };
      }
    },
    [address, agentId, isConnected, network.chainId, networkId, signMessage, vault],
  );
}
