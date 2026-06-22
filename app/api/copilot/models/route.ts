import { NextResponse } from "next/server";
import {
  isConfiguredOgComputeRouterModel,
  listOgComputeRouterModels,
  OgComputeRouterError,
  resolveOgComputeRouterConfig,
  resolveOgComputeRouterDefaultModel,
} from "@/lib/copilot/router";
import { isOgNetworkId } from "@/lib/og/networks";
import type { CopilotModelsResponse, OgNetworkId } from "@/lib/types";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const requestedNetworkId = parseNetworkId(url.searchParams.get("networkId") ?? undefined);
  if (url.searchParams.has("networkId") && !requestedNetworkId) {
    return modelsError("invalid_network", "Unsupported 0G network.", 400);
  }

  const config = resolveOgComputeRouterConfig(requestedNetworkId);
  if ("error" in config) {
    return modelsError(config.error.code, config.error.message, config.error.status);
  }

  try {
    const modelIds = await listOgComputeRouterModels(config);
    const response: CopilotModelsResponse = {
      data: {
        defaultModel: resolveOgComputeRouterDefaultModel(config, modelIds),
        models: modelIds.map((modelId) => ({
          id: modelId,
          label: modelId,
          source: isConfiguredOgComputeRouterModel(config, modelId) ? "configured" : "catalog",
        })),
        network: {
          chainId: config.network.chainId,
          id: config.network.id,
          label: config.network.networkName,
        },
      },
      meta: {
        provider: "0g-compute-router",
      },
    };

    return NextResponse.json(response);
  } catch (error) {
    if (error instanceof OgComputeRouterError) {
      return modelsError(error.code, error.message, error.status);
    }

    return modelsError("model_catalog_unavailable", "0G Compute Router model catalog is unavailable.", 502);
  }
}

function parseNetworkId(value: string | undefined): OgNetworkId | undefined {
  return isOgNetworkId(value) ? value : undefined;
}

function modelsError(code: string, message: string, status: number) {
  const response: CopilotModelsResponse = {
    error: {
      code,
      message,
    },
    meta: {
      provider: "0g-compute-router",
    },
  };

  return NextResponse.json(response, { status });
}
