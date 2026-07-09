import { NextResponse } from "next/server";
import { isAddress, getAddress } from "viem";

import { resolveMainnetV4VaultForOwner } from "@/lib/agent/mainnet-vault-resolver";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const ownerAddress = url.searchParams.get("ownerAddress");
  const agentKey = url.searchParams.get("agentKey") as `0x${string}` | null;
  if (!ownerAddress || !isAddress(ownerAddress)) {
    return NextResponse.json({ data: null, error: { code: "owner_invalid", message: "ownerAddress is required." } }, { status: 400 });
  }

  try {
    const resolved = await resolveMainnetV4VaultForOwner(getAddress(ownerAddress), agentKey ?? undefined);
    return NextResponse.json({
      data: {
        v4SwapAddress: resolved?.swapVault ?? null,
        v4LpEntryAddress: resolved?.lpEntryVault ?? null,
        v4LpExitAddress: resolved?.lpExitVault ?? null,
        swapActive: resolved?.swapActive ?? false,
        lpActive: resolved?.lpActive ?? false,
        active: resolved?.active ?? false,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { data: null, error: { code: "v4_status_failed", message: error instanceof Error ? error.message : "Unable to resolve V4 vaults." } },
      { status: 500 },
    );
  }
}
