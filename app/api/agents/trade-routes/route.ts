import { NextResponse } from "next/server";
import { OG_NETWORKS } from "@/lib/og/networks";
import { listCuratedMainnetRouteDescriptors } from "@/lib/trading/curated-route-quotes";
import type { AgentTradeRouteCatalogResponse } from "@/lib/types";

export const runtime = "nodejs";

export async function GET() {
  const routes = listCuratedMainnetRouteDescriptors();
  const response: AgentTradeRouteCatalogResponse = {
    data: {
      execution: {
        submitsTransaction: false,
        type: "catalog-only",
      },
      network: {
        chainId: 16661,
        id: "mainnet",
        label: OG_NETWORKS.mainnet.networkName,
      },
      routes,
    },
    meta: {
      provider: "0g-mainnet-curated-routes",
      routeCount: routes.length,
    },
  };

  return NextResponse.json(response);
}
