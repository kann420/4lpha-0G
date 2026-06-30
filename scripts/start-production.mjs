import { spawn } from "node:child_process";

const isWindows = process.platform === "win32";
const npmCommand = isWindows ? "npm.cmd" : "npm";
const nodeCommand = process.execPath;

const children = new Map();
let shuttingDown = false;

const workerEnabled = readBoolEnv("OG_AGENT_WORKER_ENABLED", true);
const workerExecute = readBoolEnv("OG_AGENT_WORKER_EXECUTE", false);

startProcess("web", npmCommand, ["run", "start:web"]);

if (workerEnabled && workerExecute) {
  startProcess("worker", nodeCommand, [
    "--conditions=react-server",
    "--import",
    "tsx",
    "scripts/og-agent-worker.ts",
    "--execute",
    "--all-agents",
  ]);
} else {
  console.info(
    JSON.stringify({
      type: "production-start",
      workerEnabled,
      workerExecute,
      message: "0G agent worker not started. Set OG_AGENT_WORKER_EXECUTE=true to enable auto-run.",
    }),
  );
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => shutdown(0, signal));
}

function startProcess(label, command, args) {
  const child = spawn(command, args, {
    env: process.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.set(label, child);

  console.info(
    JSON.stringify({
      type: "production-start",
      process: label,
      command,
      args,
      pid: child.pid,
    }),
  );

  child.stdout.on("data", (chunk) => forwardOutput(label, chunk, false));
  child.stderr.on("data", (chunk) => forwardOutput(label, chunk, true));
  child.on("exit", (code, signal) => {
    children.delete(label);
    if (!shuttingDown) {
      console.error(
        JSON.stringify({
          type: "production-process-exit",
          process: label,
          code,
          signal,
        }),
      );
      shutdown(code ?? 1, `${label}-exit`);
    }
  });
}

function forwardOutput(label, chunk, isError) {
  const lines = chunk.toString().split(/\r?\n/u).filter(Boolean);
  for (const line of lines) {
    const output = `[${label}] ${line}`;
    if (isError) {
      console.error(output);
    } else {
      console.info(output);
    }
  }
}

function shutdown(code, reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(JSON.stringify({ type: "production-shutdown", reason, code }));
  for (const child of children.values()) {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  }
  setTimeout(() => process.exit(code), 5_000).unref();
}

function readBoolEnv(name, fallback) {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value);
}
