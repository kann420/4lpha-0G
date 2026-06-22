import { NextResponse } from "next/server";
import { isAddress, isHex, type Address, type Hex } from "viem";
import { z } from "zod";
import { executeCuratedTrade } from "@/lib/agent/curated-trade";

export const runtime = "nodejs";

const requestSchema = z.object({
  amount: z.string().trim().min(1).max(40),
  copilotAudit: z
    .object({
      model: z.string().trim().max(120).optional(),
      policyContextHash: z.string().trim().max(80).optional(),
      promptHash: z.string().trim().max(80).optional(),
      responseHash: z.string().trim().max(80).optional(),
    })
    .optional(),
  networkId: z.literal("mainnet"),
  operatorKey: z.string().trim().min(1).max(256),
  routeId: z.string().optional(),
  side: z.enum(["buy", "sell"]),
  slippageBps: z.number().int().min(1).max(1_000).optional(),
  tokenAddress: z.string().optional(),
  tokenSymbol: z.string().trim().min(1).max(32).optional(),
  vaultAddress: z.string().optional(),
});

export async function POST(request: Request) {
  const parsed = requestSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return tradeError("invalid_request", "Trade execution request was not valid.", 400);
  }
  if (!isAuthorizedOperator(parsed.data.operatorKey)) {
    return tradeError("unauthorized", "Operator trade key is required for live execution.", 401);
  }

  const routeId = parseHex32(parsed.data.routeId, "routeId");
  if (routeId instanceof Response) return routeId;
  const tokenAddress = parseAddress(parsed.data.tokenAddress, "tokenAddress");
  if (tokenAddress instanceof Response) return tokenAddress;
  const vaultAddress = parseAddress(parsed.data.vaultAddress, "vaultAddress");
  if (vaultAddress instanceof Response) return vaultAddress;

  try {
    const execution = await executeCuratedTrade({
      amount: parsed.data.amount,
      copilotAudit: parsed.data.copilotAudit,
      networkId: parsed.data.networkId,
      routeId,
      side: parsed.data.side,
      slippageBps: parsed.data.slippageBps,
      tokenAddress,
      tokenSymbol: parsed.data.tokenSymbol,
      vaultAddress,
    });

    return NextResponse.json({ data: execution });
  } catch (error) {
    return tradeError("execution_failed", error instanceof Error ? error.message : "Unable to execute this trade.", 400);
  }
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

function isAuthorizedOperator(value: string): boolean {
  const expected = process.env.AGENT_TRADE_OPERATOR_KEY?.trim();
  return Boolean(expected && value === expected);
}

function parseAddress(value: string | undefined, label: string): Address | undefined | Response {
  if (value === undefined || value.trim() === "") return undefined;
  if (!isAddress(value)) {
    return tradeError("invalid_address", `${label} must be a valid EVM address.`, 400);
  }
  return value as Address;
}

function parseHex32(value: string | undefined, label: string): Hex | undefined | Response {
  if (value === undefined || value.trim() === "") return undefined;
  if (!isHex(value, { strict: true }) || value.length !== 66) {
    return tradeError("invalid_hex", `${label} must be a bytes32 hex value.`, 400);
  }
  return value as Hex;
}

function tradeError(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message } }, { status });
}
