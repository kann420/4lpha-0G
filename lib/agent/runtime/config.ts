import { getAddress, isAddress, parseEther, type Address } from "viem";
import { maxScriptTrade0G } from "@/lib/agent/curated-trade";

export interface OgAgentWorkerConfig {
  agentId?: string;
  allowConfiguredAgent: boolean;
  buyAmount0G: string;
  concurrency: number;
  dryRun: boolean;
  intervalMs: number;
  killSwitchEnabled: boolean;
  maxCycles?: number;
  maxRouteCandidates: number;
  once: boolean;
  ownerAddress?: Address;
  processAllAgents: boolean;
  selectedModel?: string;
  sellPercent: number;
  slippageBps: number;
}

export function loadOgAgentWorkerConfig(argv: string[] = process.argv.slice(2)): OgAgentWorkerConfig {
  const intervalArg = Number(readValue(argv, "--interval"));
  const concurrencyArg = Number(readValue(argv, "--concurrency"));
  const maxCyclesArg = Number(readValue(argv, "--max-cycles"));
  const routeLimitArg = Number(readValue(argv, "--route-limit"));
  const slippageArg = Number(readValue(argv, "--slippage-bps"));
  const sellPercentArg = Number(readValue(argv, "--sell-percent"));
  const execute = hasFlag(argv, "--execute") || readBoolEnv("OG_AGENT_WORKER_EXECUTE", false);
  const dryRun = hasFlag(argv, "--dry-run") || !execute;
  const buyAmount0G = readValue(argv, "--buy-amount") ?? readEnv("OG_AGENT_WORKER_BUY_0G") ?? "0.001";

  validateBuyAmount(buyAmount0G);

  return {
    agentId: readValue(argv, "--agent-id") ?? readEnv("OG_AGENT_WORKER_AGENT_ID"),
    allowConfiguredAgent:
      hasFlag(argv, "--allow-configured-agent") ||
      readBoolEnv("OG_AGENT_WORKER_ALLOW_CONFIGURED_AGENT", false),
    buyAmount0G,
    concurrency: Number.isFinite(concurrencyArg)
      ? clamp(Math.trunc(concurrencyArg), 1, 5)
      : clamp(readIntegerEnv("OG_AGENT_WORKER_CONCURRENCY", 1), 1, 5),
    dryRun,
    intervalMs: Number.isFinite(intervalArg)
      ? clamp(Math.trunc(intervalArg), 10_000, 5 * 60_000)
      : clamp(readIntegerEnv("OG_AGENT_WORKER_INTERVAL_MS", 30_000), 10_000, 5 * 60_000),
    killSwitchEnabled:
      hasFlag(argv, "--kill-switch") ||
      readBoolEnv("OG_AGENT_WORKER_KILL_SWITCH", false) ||
      readBoolEnv("AGENT_KILL_SWITCH", false),
    maxCycles: Number.isFinite(maxCyclesArg)
      ? clamp(Math.trunc(maxCyclesArg), 1, 10_000)
      : readOptionalIntegerEnv("OG_AGENT_WORKER_MAX_CYCLES"),
    maxRouteCandidates: Number.isFinite(routeLimitArg)
      ? clamp(Math.trunc(routeLimitArg), 1, 8)
      : clamp(readIntegerEnv("OG_AGENT_WORKER_ROUTE_LIMIT", 4), 1, 8),
    once: hasFlag(argv, "--once"),
    ownerAddress: readAddressValue(readValue(argv, "--owner-address") ?? readEnv("OG_AGENT_WORKER_OWNER_ADDRESS")),
    processAllAgents: hasFlag(argv, "--all-agents") || readBoolEnv("OG_AGENT_WORKER_ALL_AGENTS", false),
    selectedModel: readValue(argv, "--model") ?? readEnv("OG_AGENT_WORKER_MODEL"),
    sellPercent: Number.isFinite(sellPercentArg)
      ? clamp(Math.trunc(sellPercentArg), 1, 100)
      : clamp(readIntegerEnv("OG_AGENT_WORKER_SELL_PERCENT", 100), 1, 100),
    slippageBps: Number.isFinite(slippageArg)
      ? clamp(Math.trunc(slippageArg), 1, 1_000)
      : clamp(readIntegerEnv("OG_AGENT_WORKER_SLIPPAGE_BPS", 75), 1, 1_000),
  };
}

function validateBuyAmount(value: string) {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/u.test(value)) {
    throw new Error("OG_AGENT_WORKER_BUY_0G must be a decimal 0G amount with up to 18 decimals.");
  }
  const amount = parseEther(value);
  if (amount <= 0n || amount > maxScriptTrade0G()) {
    throw new Error(`OG_AGENT_WORKER_BUY_0G must be greater than 0 and at most ${maxScriptTrade0G()} wei.`);
  }
}

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

function readValue(argv: string[], flag: string): string | undefined {
  const prefixed = `${flag}=`;
  const eqMatch = argv.find((entry) => entry.startsWith(prefixed));
  if (eqMatch) return eqMatch.slice(prefixed.length).trim() || undefined;

  const index = argv.indexOf(flag);
  if (index !== -1 && index + 1 < argv.length && !argv[index + 1].startsWith("--")) {
    return argv[index + 1].trim() || undefined;
  }
  return undefined;
}

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function readAddressValue(value: string | undefined): Address | undefined {
  if (!value) return undefined;
  if (!isAddress(value)) {
    throw new Error("OG_AGENT_WORKER_OWNER_ADDRESS must be a valid EVM address.");
  }
  return getAddress(value);
}

function readBoolEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value);
}

function readIntegerEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readOptionalIntegerEnv(name: string): number | undefined {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
