"use client";

export type LpActionConsentScope =
  | "lp-mint"
  | "lp-stake"
  | "lp-unstake"
  | "lp-zap-out"
  | "lp-automation"
  | "vault-withdraw-native";

export interface ActionConsentNonce {
  expiresAt: number;
  nonce: string;
  ttlSeconds: number;
}

export async function requestActionConsentNonce(
  action: LpActionConsentScope,
  address: string,
): Promise<ActionConsentNonce> {
  const params = new URLSearchParams({ action, address });
  const response = await fetch(`/api/copilot/action-consent/nonce?${params.toString()}`, {
    cache: "no-store",
  });
  const json = (await response.json()) as {
    data?: ActionConsentNonce;
    error?: { code?: string; message?: string };
  };
  if (!response.ok || !json.data) {
    const code = json.error?.code ?? "nonce_failed";
    const message = json.error?.message ?? "Could not issue action nonce.";
    throw new Error(`${code}: ${message}`);
  }
  return json.data;
}
