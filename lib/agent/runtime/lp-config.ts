import { getAddress, isAddress, type Address } from "viem";

export interface OgAgentLpWorkerConfig {
  agentId?: string;
  dryRun: boolean;
  intervalMs: number;
  killSwitchEnabled: boolean;
  maxCycles?: number;
  once: boolean;
  ownerAddress?: Address;
  processAllAgents: boolean;
  selectedModel?: string;
}

// Mirror of loadOgAgentWorkerConfig (lib/agent/runtime/config.ts) for the LP
// mint loop. Dry-run defaults to true when not executing (config.ts:29-30) —
// the worker never mints on-chain unless --execute / OG_AGENT_LP_WORKER_EXECUTE
// is set. Interval default 60s, clamped 30s..10min.
export function loadOgAgentLpWorkerConfig(argv: string[] = process.argv.slice(2)): OgAgentLpWorkerConfig {
  const intervalArg = Number(readValue(argv, "--interval"));
  const maxCyclesArg = Number(readValue(argv, "--max-cycles"));
  const execute = hasFlag(argv, "--execute") || readBoolEnv("OG_AGENT_LP_WORKER_EXECUTE", false);
  const dryRun = hasFlag(argv, "--dry-run") || !execute;

  return {
    agentId: readValue(argv, "--agent-id") ?? readEnv("OG_AGENT_LP_WORKER_AGENT_ID"),
    dryRun,
    intervalMs: Number.isFinite(intervalArg)
      ? clamp(Math.trunc(intervalArg), 30_000, 10 * 60_000)
      : clamp(readIntegerEnv("OG_AGENT_LP_WORKER_INTERVAL_MS", 60_000), 30_000, 10 * 60_000),
    killSwitchEnabled:
      hasFlag(argv, "--kill-switch") ||
      readBoolEnv("OG_AGENT_LP_WORKER_KILL_SWITCH", false) ||
      readBoolEnv("AGENT_KILL_SWITCH", false),
    maxCycles: Number.isFinite(maxCyclesArg)
      ? clamp(Math.trunc(maxCyclesArg), 1, 10_000)
      : readOptionalIntegerEnv("OG_AGENT_LP_WORKER_MAX_CYCLES"),
    once: hasFlag(argv, "--once"),
    ownerAddress: readAddressValue(
      readValue(argv, "--owner-address") ?? readEnv("OG_AGENT_LP_WORKER_OWNER_ADDRESS"),
    ),
    processAllAgents: hasFlag(argv, "--all-agents") || readBoolEnv("OG_AGENT_LP_WORKER_ALL_AGENTS", false),
    selectedModel: readValue(argv, "--model") ?? readEnv("OG_AGENT_LP_WORKER_MODEL"),
  };
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
    throw new Error("OG_AGENT_LP_WORKER_OWNER_ADDRESS must be a valid EVM address.");
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