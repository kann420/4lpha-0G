import type { AgentTradeRouteOption } from "@/lib/types";

/**
 * The Galileo route is intentionally self-contained. It represents only the
 * attested V4 sandbox pool and never imports a mainnet route, router, or ABI.
 */
export const GALILEO_AGENT_TRADE_ROUTE: AgentTradeRouteOption = {
  agentId: "galileo-local-agent",
  auditId: "galileo-v4-sandbox-swap",
  defaultAmountIn: "0.001",
  defaultSide: "buy",
  id: "galileo-v4-sandbox-0g-musdc",
  inputToken: "0G",
  label: "Galileo V4 sandbox pool",
  maxAmountIn: "0.25",
  minAmountOutRequired: true,
  networkId: "testnet",
  outputToken: "mUSDC",
  readiness: "review",
  venue: "Galileo sandbox AMM",
};
