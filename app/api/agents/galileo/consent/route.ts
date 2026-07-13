import { NextResponse } from "next/server";
import { z } from "zod";
import type { Address } from "viem";

import { assertGalileoRequestBoundary, buildGalileoConsentMessage, issueGalileoConsent } from "@/lib/galileo/consent";
import { GalileoLedgerError } from "@/lib/galileo/ledger";

export const runtime = "nodejs";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/u);
const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/u);
const uint = z.string().regex(/^(0|[1-9][0-9]{0,77})$/u);
const trade = z.object({
  adapter: address,
  agentKey: bytes32,
  agentRef: z.string().regex(/^[A-Za-z0-9_-]{8,160}$/u),
  amountIn: uint,
  chainId: z.literal(16602),
  clientRequestId: z.string().regex(/^[A-Za-z0-9_-]{8,96}$/u),
  minOut: uint,
  networkId: z.literal("testnet"),
  payloadDigest: bytes32,
  policyHash: bytes32,
  poolId: bytes32,
  quoteBlock: uint,
  quoteExpiry: z.number().int().positive(),
  reserveNative: uint,
  reserveToken: uint,
  side: z.enum(["buy", "sell"]),
  trustedQuote: uint,
  vault: address,
});
const schema = z.object({
  action: z.enum(["deploy", "trade", "workspace-read"]),
  clientRequestId: z.string().regex(/^[A-Za-z0-9_-]{8,96}$/u).optional(),
  chainId: z.literal(16602),
  config: z.object({
    filters: z.array(z.string().trim().min(1).max(64)).min(1).max(4),
    name: z.string().trim().min(3).max(80),
    runtime: z.object({
      maxHoldingMinutes: z.number().int().min(1).max(1440).optional(),
      maxPositions: z.number().int().min(1).max(5).optional(),
      maxTrade0G: z.string().trim().min(1).max(48).optional(),
      slippageBps: z.number().int().min(1).max(1000).optional(),
    }).optional(),
    vault: address,
  }).optional(),
  networkId: z.literal("testnet"),
  owner: address,
  trade: trade.optional(),
}).superRefine((value, ctx) => {
  if (value.action === "deploy" && !value.config) ctx.addIssue({ code: "custom", message: "Deploy consent requires agent configuration.", path: ["config"] });
  if (value.action === "deploy" && !value.clientRequestId) ctx.addIssue({ code: "custom", message: "Deploy consent requires clientRequestId.", path: ["clientRequestId"] });
  if (value.action === "deploy" && value.trade) ctx.addIssue({ code: "custom", message: "Deploy consent does not accept trade data.", path: ["trade"] });
  if (value.action === "trade" && (!value.trade || value.config || value.clientRequestId)) ctx.addIssue({ code: "custom", message: "Trade consent requires only its complete normalized trade tuple.", path: ["trade"] });
  if (value.action === "workspace-read" && (value.config || value.trade || value.clientRequestId)) ctx.addIssue({ code: "custom", message: "Workspace consent does not accept deployment or trade data.", path: ["action"] });
});

export async function POST(request: Request) {
  const parsed = schema.safeParse(await readJson(request));
  if (!parsed.success) return error("invalid_request", "Galileo consent request was not valid.", 400);
  try {
    assertGalileoRequestBoundary(request, parsed.data);
    const owner = parsed.data.owner.toLowerCase() as Address;
    const config = parsed.data.config ? { ...parsed.data.config, clientRequestId: parsed.data.clientRequestId, owner, vault: parsed.data.config.vault.toLowerCase() as Address } : undefined;
    const preparedTrade = parsed.data.trade ? {
      ...parsed.data.trade,
      adapter: parsed.data.trade.adapter.toLowerCase() as Address,
      agentKey: parsed.data.trade.agentKey.toLowerCase() as `0x${string}`,
      payloadDigest: parsed.data.trade.payloadDigest.toLowerCase() as `0x${string}`,
      policyHash: parsed.data.trade.policyHash.toLowerCase() as `0x${string}`,
      poolId: parsed.data.trade.poolId.toLowerCase() as `0x${string}`,
      vault: parsed.data.trade.vault.toLowerCase() as Address,
    } : undefined;
    const issue = issueGalileoConsent({ action: parsed.data.action, config, owner, trade: preparedTrade });
    return NextResponse.json({
      data: {
        agentKey: issue.agentKey,
        agentRef: issue.agentRef,
        configDigest: issue.configDigest,
        consentMessage: buildGalileoConsentMessage({
          action: parsed.data.action,
          agentRef: issue.agentRef,
          configDigest: issue.configDigest,
          expiresAt: issue.expiresAt,
          nonce: issue.nonce,
          owner,
          trade: issue.trade,
          vault: parsed.data.config?.vault.toLowerCase() as `0x${string}` | undefined,
        }),
        expiresAt: issue.expiresAt,
        nonce: issue.nonce,
        prepareId: issue.prepareId,
      },
      meta: { chainId: 16602, networkId: "testnet" },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    return ledgerError(cause);
  }
}

async function readJson(request: Request): Promise<unknown> {
  try { return await request.json(); } catch { return undefined; }
}
function ledgerError(cause: unknown) {
  if (cause instanceof GalileoLedgerError) return error(cause.code, cause.message, cause.status);
  return error("galileo_unavailable", "Galileo consent is unavailable.", 503);
}
function error(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } });
}
