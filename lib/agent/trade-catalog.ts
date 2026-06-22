import type { AgentTradeRouteOption } from "@/lib/types";
import { formatEther } from "viem";
import { CURATED_MAINNET_POLICY_VAULT_ROUTES } from "@/lib/contracts/curated-routes";
import { defaultMainnetPolicyVaultPolicy } from "@/lib/contracts/policy-vault";
import { SINGLE_OG_AGENT_ID, isOgMainnetAgentId } from "@/lib/agent/single-agent";

const MAINNET_ROUTE_CAP_0G = format0GAmount(defaultMainnetPolicyVaultPolicy.perTradeCap0G);

const TESTNET_AGENT_TRADE_ROUTES: AgentTradeRouteOption[] = [
  {
    agentId: "agent-aura",
    auditId: "audit-042",
    defaultAmountIn: "0.05",
    defaultSide: "buy",
    id: "galileo-mock-w0g-musd",
    inputToken: "0G",
    label: "W0G / mUSD mock route",
    maxAmountIn: "0.32",
    minAmountOutRequired: true,
    networkId: "testnet",
    outputToken: "mUSD",
    readiness: "ready",
    venue: "Mock adapter",
  },
  {
    agentId: "agent-kepler",
    auditId: "audit-041",
    defaultAmountIn: "0.03",
    defaultSide: "sell",
    id: "galileo-mock-inventory-trim",
    inputToken: "mUSD",
    label: "mUSD / W0G inventory trim",
    maxAmountIn: "0.18",
    minAmountOutRequired: true,
    networkId: "testnet",
    outputToken: "0G",
    readiness: "review",
    venue: "Mock adapter",
  },
  {
    agentId: "agent-aura",
    auditId: "audit-040",
    defaultAmountIn: "0.04",
    defaultSide: "buy",
    id: "galileo-unprotected-demo-route",
    inputToken: "0G",
    label: "Unprotected demo route",
    maxAmountIn: "0.04",
    minAmountOutRequired: false,
    networkId: "testnet",
    outputToken: "mRISK",
    readiness: "blocked",
    venue: "Rejected adapter",
  },
];

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
