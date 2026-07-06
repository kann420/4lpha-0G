import { NextResponse } from "next/server";
import { isAddress, type Address } from "viem";
import { resolveMainnetV3VaultForOwner } from "@/lib/agent/mainnet-vault-resolver";
import { getOgNetwork } from "@/lib/og/networks";

export const runtime = "nodejs";

// Resolves the owner's V3 Policy Vault from the off-chain registry.
// The V3 singleton is deployed offline via `npm run vault:mainnet:create:v3`
// (no on-chain V3 factory on mainnet), so the /fund surface must ask the server
// whether a V3 exists for the connected wallet before offering a v2 -> v3 migrate.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const ownerParam = url.searchParams.get("ownerAddress")?.trim();
  if (!ownerParam || !isAddress(ownerParam)) {
    return NextResponse.json(
      { error: { code: "invalid_request", message: "ownerAddress query param is required and must be a valid address." } },
      { status: 400 },
    );
  }

  const network = getOgNetwork("mainnet");
  try {
    const v3VaultAddress = await resolveMainnetV3VaultForOwner(ownerParam as Address);
    return NextResponse.json({
      data: { v3VaultAddress, network: { id: "mainnet", chainId: network.chainId } },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: {
          code: "registry_unavailable",
          message: error instanceof Error ? error.message : "Unable to read the V3 vault registry.",
        },
      },
      { status: 500 },
    );
  }
}