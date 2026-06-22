import { NextResponse } from "next/server";
import { isAddress, isHex, type Address, type Hex } from "viem";
import { z } from "zod";
import { quoteCuratedTrade } from "@/lib/agent/curated-trade";

export const runtime = "nodejs";

const requestSchema = z.object({
  amount: z.string().trim().min(1).max(40),
  networkId: z.literal("mainnet"),
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
    return tradeError("invalid_request", "Trade quote request was not valid.", 400);
  }

  const routeId = parseHex32(parsed.data.routeId, "routeId");
  if (routeId instanceof Response) return routeId;
  const tokenAddress = parseAddress(parsed.data.tokenAddress, "tokenAddress");
  if (tokenAddress instanceof Response) return tokenAddress;
  const vaultAddress = parseAddress(parsed.data.vaultAddress, "vaultAddress");
  if (vaultAddress instanceof Response) return vaultAddress;

  try {
    const quote = await quoteCuratedTrade({
      amount: parsed.data.amount,
      networkId: parsed.data.networkId,
      routeId,
      side: parsed.data.side,
      slippageBps: parsed.data.slippageBps,
      tokenAddress,
      tokenSymbol: parsed.data.tokenSymbol,
      vaultAddress,
    });

    return NextResponse.json({ data: quote });
  } catch (error) {
    return tradeError("quote_failed", error instanceof Error ? error.message : "Unable to quote this route.", 400);
  }
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
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
