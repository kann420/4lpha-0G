import { NextResponse } from "next/server";
import { isAddress, type Address } from "viem";
import { listVerifiedGalileoAgents } from "@/lib/galileo/ledger";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const networkId = searchParams.get("networkId");

  // This branch precedes every mainnet resolver/import. It reads only the
  // isolated, redacted Galileo local roster and never opens a mainnet store.
  if (networkId === "testnet") {
    const ownerAddress = readGalileoOwnerAddress(searchParams.get("ownerAddress"));
    if (!ownerAddress) {
      return NextResponse.json({ error: { code: "owner_required", message: "Connect a wallet to load Galileo agents." } }, { status: 400, headers: { "Cache-Control": "no-store" } });
    }
    const agents = listVerifiedGalileoAgents(ownerAddress).map((agent) => ({
      agentKey: agent.agentKey,
      agentRef: agent.agentRef,
      chainId: agent.chainId,
      createdAt: agent.createdAt,
      storageRef: agent.storageRef,
      storageRoot: agent.storageRoot,
      storageVerified: agent.storageVerified,
      vault: agent.vault,
    }));
    return NextResponse.json({
      data: { agents, chainId: 16602, networkId: "testnet" },
      meta: { provider: "4lpha-galileo-local-roster" },
    }, { headers: { "Cache-Control": "no-store" } });
  }

  if (networkId && networkId !== "mainnet") {
    return NextResponse.json({ error: { code: "invalid_network", message: "Unsupported 0G network." } }, { status: 400 });
  }

  const [{ loadOgAgentWorkspace }, { readMainnetOwnerAddress }] = await Promise.all([
    import("@/lib/agent/single-agent-server"),
    import("@/lib/agent/mainnet-vault-resolver"),
  ]);
  const agentId = searchParams.get("agentId") ?? undefined;
  const live = isTruthy(searchParams.get("live"));
  const ownerAddress = readMainnetOwnerAddress(searchParams.get("ownerAddress"));
  // The roster is scoped by ownerAddress. Without it, readAgentDeploymentRoster's
  // filter is empty and matches every deployment across every owner (active AND
  // removed) — this endpoint must never serve that unscoped roster to a caller
  // that hasn't identified a wallet.
  if (!ownerAddress) {
    return NextResponse.json({ error: { code: "owner_required", message: "Connect a wallet to load its agent workspace." } }, { status: 400 });
  }
  const workspace = await loadOgAgentWorkspace({ agentId, live, ownerAddress });
  return NextResponse.json({
    data: workspace,
    meta: {
      provider: "4lpha-0g-agent-registry",
    },
  });
}

function readGalileoOwnerAddress(value: string | null): Address | undefined {
  return value && isAddress(value, { strict: true }) ? value.toLowerCase() as Address : undefined;
}

function isTruthy(value: string | null): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}
