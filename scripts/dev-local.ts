import dotenv from "dotenv";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";

dotenv.config({ path: ".env.local", quiet: true });

const argv = process.argv.slice(2);
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const hostname = readValue(argv, "--hostname") ?? "127.0.0.1";
const port = readValue(argv, "--port") ?? "3000";
const workerDisabled = hasFlag(argv, "--no-worker");
const workerAgentId = readValue(argv, "--agent-id") ?? process.env.OG_AGENT_WORKER_AGENT_ID?.trim();
const workerExecute = shouldExecuteWorker(argv);
const lpWorkerDisabled = workerDisabled || hasFlag(argv, "--no-lp-worker");
const lpWorkerAgentId =
  readValue(argv, "--lp-agent-id") ??
  process.env.OG_AGENT_LP_WORKER_AGENT_ID?.trim() ??
  workerAgentId;
const lpWorkerExecute = shouldExecuteLpWorker(argv);
const strictWorker = readBoolEnv("DEV_LOCAL_STRICT_WORKER", false);
const workerArgs = workerDisabled ? [] : [
  "run",
  "agent:worker",
  "--",
  ...(workerExecute ? ["--execute"] : []),
  ...(workerAgentId ? ["--agent-id", workerAgentId] : []),
  ...forwardWorkerArgs(argv),
];
const lpWorkerArgs = lpWorkerDisabled ? [] : [
  "run",
  "agent:lp:worker",
  "--",
  ...(lpWorkerExecute ? ["--execute"] : []),
  ...(lpWorkerAgentId ? ["--agent-id", lpWorkerAgentId] : []),
  ...forwardLpWorkerArgs(argv),
];

let shuttingDown = false;
const children: ChildProcessWithoutNullStreams[] = [];

const nextProcess = startProcess("app", npmCommand, ["run", "dev:app", "--", "--hostname", hostname, "--port", port]);
const workerProcess = workerDisabled ? null : startProcess("worker", npmCommand, workerArgs);
const lpWorkerProcess = lpWorkerDisabled ? null : startProcess("lp-worker", npmCommand, lpWorkerArgs);

console.info(
  JSON.stringify({
    app: `http://${hostname}:${port}`,
    lpWorker: lpWorkerDisabled ? "disabled" : lpWorkerExecute ? "execute" : "dry-run",
    lpWorkerAgentId: lpWorkerAgentId ?? "latest-auto-mint",
    timestamp: new Date().toISOString(),
    type: "dev-local-started",
    worker: workerDisabled ? "disabled" : workerExecute ? "execute" : "dry-run",
    workerAgentId: workerAgentId ?? "latest",
    strictWorker,
  }),
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdown(0, signal);
  });
}

nextProcess.on("exit", (code, signal) => {
  if (!shuttingDown) {
    console.info(`[dev:app] exited with ${signal ?? code ?? 0}`);
    void shutdown(code ?? 0, "app-exit");
  }
});

if (workerProcess) {
  workerProcess.on("exit", (code, signal) => {
    if (!shuttingDown) {
      console.info(`[agent:worker] exited with ${signal ?? code ?? 0}`);
      if (strictWorker) {
        void shutdown(code ?? 0, "worker-exit");
        return;
      }
      console.info("[dev-local] app remains online after worker exit; set DEV_LOCAL_STRICT_WORKER=true to fail closed.");
    }
  });
}

if (lpWorkerProcess) {
  lpWorkerProcess.on("exit", (code, signal) => {
    if (!shuttingDown) {
      console.info(`[agent:lp:worker] exited with ${signal ?? code ?? 0}`);
      if (strictWorker) {
        void shutdown(code ?? 0, "lp-worker-exit");
        return;
      }
      console.info("[dev-local] app remains online after LP worker exit; set DEV_LOCAL_STRICT_WORKER=true to fail closed.");
    }
  });
}

function startProcess(label: string, command: string, args: string[]): ChildProcessWithoutNullStreams {
  const child =
    process.platform === "win32"
      ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", quoteWindowsCommand([command, ...args])], {
          cwd: process.cwd(),
          env: process.env,
          windowsHide: false,
        })
      : spawn(command, args, {
    cwd: process.cwd(),
    env: process.env,
    windowsHide: false,
        });
  children.push(child);
  prefixStream(child.stdout, label);
  prefixStream(child.stderr, label);
  return child;
}

function quoteWindowsCommand(parts: string[]): string {
  return parts.map(quoteWindowsArg).join(" ");
}

function quoteWindowsArg(value: string): string {
  if (/^[a-zA-Z0-9._:/=+-]+$/u.test(value)) {
    return value;
  }
  return `"${value.replace(/"/gu, '\\"')}"`;
}

function prefixStream(stream: NodeJS.ReadableStream, label: string): void {
  const reader = readline.createInterface({ input: stream });
  reader.on("line", (line) => {
    console.info(`[${label}] ${line}`);
  });
}

async function shutdown(code: number, reason: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.info(`[dev-local] shutdown requested: ${reason}`);

  for (const child of children) {
    await terminateChild(child, "soft");
  }

  await new Promise((resolve) => setTimeout(resolve, 1500));
  for (const child of children) {
    await terminateChild(child, "force");
  }
  process.exit(code);
}

async function terminateChild(child: ChildProcessWithoutNullStreams, mode: "force" | "soft"): Promise<void> {
  if (child.killed || child.exitCode !== null || !child.pid) {
    return;
  }
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      execFile("taskkill.exe", ["/PID", String(child.pid), "/T", mode === "force" ? "/F" : ""].filter(Boolean), () =>
        resolve(),
      );
    });
    return;
  }
  child.kill(mode === "force" ? "SIGKILL" : "SIGTERM");
}

function shouldExecuteWorker(args: string[]): boolean {
  if (hasFlag(args, "--dry-run")) {
    return false;
  }
  if (hasFlag(args, "--execute")) {
    return true;
  }
  if (readBoolEnv("OG_AGENT_WORKER_EXECUTE", false)) {
    return true;
  }
  return readBoolEnv("AGENT_TRADE_LIVE_ENABLED", false);
}

function shouldExecuteLpWorker(args: string[]): boolean {
  if (hasFlag(args, "--dry-run")) {
    return false;
  }
  if (hasFlag(args, "--execute")) {
    return true;
  }
  return readBoolEnv("OG_AGENT_LP_WORKER_EXECUTE", false);
}

function forwardWorkerArgs(args: string[]): string[] {
  const forwarded: string[] = [];
  for (const flag of [
    "--buy-amount",
    "--interval",
    "--max-cycles",
    "--model",
    "--route-limit",
    "--sell-percent",
    "--slippage-bps",
  ]) {
    const value = readValue(args, flag);
    if (value) {
      forwarded.push(flag, value);
    }
  }
  if (hasFlag(args, "--all-agents")) {
    forwarded.push("--all-agents");
  }
  if (hasFlag(args, "--kill-switch")) {
    forwarded.push("--kill-switch");
  }
  return forwarded;
}

function forwardLpWorkerArgs(args: string[]): string[] {
  const forwarded: string[] = [];
  for (const flag of [
    "--interval",
    "--max-cycles",
    "--model",
    "--owner-address",
  ]) {
    const value = readValue(args, flag);
    if (value) {
      forwarded.push(flag, value);
    }
  }
  if (hasFlag(args, "--all-agents")) {
    forwarded.push("--all-agents");
  }
  if (hasFlag(args, "--kill-switch")) {
    forwarded.push("--kill-switch");
  }
  return forwarded;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function readValue(args: string[], flag: string): string | undefined {
  const prefixed = `${flag}=`;
  const eqMatch = args.find((entry) => entry.startsWith(prefixed));
  if (eqMatch) return eqMatch.slice(prefixed.length).trim() || undefined;

  const index = args.indexOf(flag);
  if (index !== -1 && index + 1 < args.length && !args[index + 1].startsWith("--")) {
    return args[index + 1].trim() || undefined;
  }
  return undefined;
}

function readBoolEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value);
}
