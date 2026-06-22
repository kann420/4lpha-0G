import { createHash, randomUUID } from "node:crypto";
import type { CopilotAuditBundle, OgNetworkConfig } from "@/lib/types";

export interface CopilotPolicyContext {
  chainId: 16602 | 16661;
  controls: string[];
  networkId: string;
  surface: "copilot";
  vaultMode: "0g-policy-vault";
}

export function buildCopilotPolicyContext(network: OgNetworkConfig): CopilotPolicyContext {
  return {
    chainId: network.chainId,
    controls: [
      "deny-by-default vault policy",
      "server-only 0G Compute Router calls",
      "redacted audit evidence only",
      "no private keys, API keys, cookies, JWTs, or wallet material",
      "no trade execution without on-chain policy checks",
    ],
    networkId: network.id,
    surface: "copilot",
    vaultMode: "0g-policy-vault",
  };
}

export function createCopilotAuditBundle({
  model,
  network,
  operatorContext,
  policyContext,
  prompt,
  response,
  routerBaseUrl,
  trace,
}: {
  model: string;
  network: OgNetworkConfig;
  operatorContext?: unknown;
  policyContext: CopilotPolicyContext;
  prompt: string;
  response: string;
  routerBaseUrl: string;
  trace?: CopilotAuditBundle["trace"];
}): CopilotAuditBundle {
  const timestamp = new Date().toISOString();

  return {
    id: randomUUID(),
    model,
    network: {
      chainId: network.chainId,
      id: network.id,
      label: network.networkName,
    },
    operatorContextHash: operatorContext === undefined ? undefined : hashJson(operatorContext),
    policyContextHash: hashJson(policyContext),
    promptHash: hashText(prompt),
    responseHash: hashText(response),
    routerBaseUrl,
    timestamp,
    trace,
  };
}

export function hashText(value: string): string {
  return `0x${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function hashJson(value: unknown): string {
  return hashText(stableJson(value));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}
