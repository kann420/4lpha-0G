import type { AgentTradeRouteOption } from "@/lib/types";
import { GALILEO_AGENT_TRADE_ROUTE } from "@/lib/galileo/trade-route";
import { formatEther } from "viem";
import { CURATED_MAINNET_POLICY_VAULT_ROUTES } from "@/lib/contracts/curated-routes";
import { defaultMainnetPolicyVaultPolicy } from "@/lib/contracts/policy-vault";
import { SINGLE_OG_AGENT_ID, isOgMainnetAgentId } from "@/lib/agent/single-agent";

const MAINNET_ROUTE_CAP_0G = format0GAmount(defaultMainnetPolicyVaultPolicy.perTradeCap0G);

// Galileo routes are populated only after the dedicated attested sandbox stack
// is deployed and verified. The legacy mock rehearsal routes must never appear
// in the public-testnet trade UI.
// Keep this descriptor separate from the mainnet curated routes. Testnet UI
// imports the Galileo module directly, so selecting Galileo never resolves a
// mainnet route, address, or execution module.
export const TESTNET_AGENT_TRADE_ROUTES: AgentTradeRouteOption[] = [GALILEO_AGENT_TRADE_ROUTE];

const MAINNET_AGENT_TRADE_ROUTES: AgentTradeRouteOption[] = CURATED_MAINNET_POLICY_VAULT_ROUTES.map((route) => ({
  agentId: SINGLE_OG_AGENT_ID,
  auditId: `route-${route.id.slice(2, 10)}`,
  defaultAmountIn: "0.001",
  defaultSide: "buy",
  id: route.id,
  inputToken: "0G",
  label: `${route.label} curated route`,
  maxAmountIn: MAINNET_ROUTE_CAP_0G,
  minAmountOutRequired: true,
  networkId: "mainnet",
  outputToken: route.symbol.replace(/-direct|-oku/u, ""),
  readiness: "ready",
  tokenAddress: route.tokenOut,
  venue: route.venue,
}));

export const AGENT_TRADE_ROUTES: AgentTradeRouteOption[] = [
  ...TESTNET_AGENT_TRADE_ROUTES,
  ...MAINNET_AGENT_TRADE_ROUTES,
];

export function getAgentTradeRoute(routeId: string): AgentTradeRouteOption | undefined {
  return AGENT_TRADE_ROUTES.find((route) => route.id === routeId);
}

export function canAgentUseTradeRoute(route: AgentTradeRouteOption, agentId: string): boolean {
  if (route.agentId === agentId) {
    return true;
  }
  return route.networkId === "mainnet" && route.agentId === SINGLE_OG_AGENT_ID && isOgMainnetAgentId(agentId);
}

function format0GAmount(amount: bigint): string {
  return formatEther(amount)
    .replace(/(\.\d*?)0+$/u, "$1")
    .replace(/\.$/u, "");
}
