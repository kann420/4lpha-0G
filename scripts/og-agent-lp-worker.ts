import dotenv from "dotenv";
import { mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { OgAgentLpWorkerConfig } from "../lib/agent/runtime/lp-config";
import type { OgAgentLpWorkerRunSummary } from "../lib/agent/runtime/lp-worker";

type RunLpAgentWorkerOnce = (config: OgAgentLpWorkerConfig) => Promise<OgAgentLpWorkerRunSummary>;

// Autonomous LP mint loop worker — close copy of scripts/og-agent-worker.ts.
// Mint-only: mints LP positions within the vault's on-chain fence for agents
// the owner has opted in via runtime.automation.autoMint. Exits are user-manual.
// Off by default; OG_AGENT_LP_WORKER_EXECUTE must be set to mint on-chain.

const LOCAL_WORKER_LOCK_PATH = join(process.cwd(), ".data", "runtime", "og-agent-lp-worker.lock");
const LOCAL_WORKER_LOCK_STALE_MS = 5 * 60_000;
const MAX_LOCK_RETRY = 10;
const CYCLE_TIMEOUT_MS = 5 * 60_000;

let stopRequested = false;
let lockHandle: FileHandle | null = null;
let completedCycles = 0;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (!stopRequested) {
      stopRequested = true;
      console.info(`[og-agent-lp-worker] shutdown requested via ${signal}`);
    }
  });
}

process.on("uncaughtException", (error) => {
  console.error(`[og-agent-lp-worker] uncaughtException: ${sanitizeError(error)}`);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error(`[og-agent-lp-worker] unhandledRejection: ${sanitizeError(reason)}`);
  process.exit(1);
});

async function main(): Promise<void> {
  dotenv.config({ path: ".env.local", quiet: true });
  const [{ loadOgAgentLpWorkerConfig }, { runLpAgentWorkerOnce }] = await Promise.all([
    import("../lib/agent/runtime/lp-config"),
    import("../lib/agent/runtime/lp-worker"),
  ]);

  const config = loadOgAgentLpWorkerConfig();
  await acquireLocalWorkerLockIfNeeded(config.once);
  logWorkerEvent("started", {
    agentId: config.agentId,
    dryRun: config.dryRun,
    intervalMs: config.intervalMs,
    killSwitchEnabled: config.killSwitchEnabled,
    maxCycles: config.maxCycles,
    once: config.once,
    ownerAddress: config.ownerAddress,
    processAllAgents: config.processAllAgents,
    selectedModel: config.selectedModel,
  });

  if (config.once) {
    const summary = await runCycle(config, runLpAgentWorkerOnce);
    logWorkerEvent("cycle", summary);
    await releaseLocalWorkerLock();
    return;
  }

  try {
    while (!stopRequested) {
      const startedAt = Date.now();
      try {
        const summary = await runCycle(config, runLpAgentWorkerOnce);
        logWorkerEvent("cycle", summary);
      } catch (error) {
        console.error(`[og-agent-lp-worker] ${sanitizeError(error)}`);
      }

      await refreshLocalWorkerLock();
      completedCycles += 1;
      if (config.maxCycles !== undefined && completedCycles >= config.maxCycles) {
        stopRequested = true;
        break;
      }

      const elapsedMs = Date.now() - startedAt;
      const sleepMs = Math.max(0, config.intervalMs - elapsedMs);
      if (sleepMs > 0 && !stopRequested) {
        await sleep(sleepMs);
      }
    }
  } finally {
    await releaseLocalWorkerLock();
  }

  logWorkerEvent("stopped", { completedCycles });
}

async function runCycle(config: OgAgentLpWorkerConfig, runLpAgentWorkerOnce: RunLpAgentWorkerOnce) {
  return Promise.race([
    runLpAgentWorkerOnce(config),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`runLpAgentWorkerOnce timed out after ${CYCLE_TIMEOUT_MS}ms`)),
        CYCLE_TIMEOUT_MS,
      ),
    ),
  ]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logWorkerEvent(type: string, payload: unknown): void {
  console.info(
    JSON.stringify({
      payload,
      timestamp: new Date().toISOString(),
      type,
    }),
  );
}

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/(?:sk|mk)-[a-zA-Z0-9._-]+/gu, "[redacted-key]").slice(0, 500);
}

async function acquireLocalWorkerLockIfNeeded(once: boolean): Promise<void> {
  if (once) {
    return;
  }

  await mkdir(dirname(LOCAL_WORKER_LOCK_PATH), { recursive: true });

  for (let retry = 0; retry < MAX_LOCK_RETRY; retry += 1) {
    try {
      lockHandle = await open(LOCAL_WORKER_LOCK_PATH, "wx");
      await refreshLocalWorkerLock();
      return;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code !== "EEXIST") {
        throw error;
      }
      const stale = await isLocalWorkerLockStale();
      if (!stale) {
        throw new Error("Another local 0G LP agent worker is already running. Stop it before starting a new worker.");
      }
      await unlink(LOCAL_WORKER_LOCK_PATH).catch(() => undefined);
    }

    if (retry < MAX_LOCK_RETRY - 1) {
      await sleep(200);
    }
  }

  throw new Error(`Failed to acquire local LP worker lock after ${MAX_LOCK_RETRY} attempts.`);
}

async function refreshLocalWorkerLock(): Promise<void> {
  if (!lockHandle) {
    return;
  }
  await writeFile(
    LOCAL_WORKER_LOCK_PATH,
    JSON.stringify({
      heartbeatAt: Date.now(),
      pid: process.pid,
    }),
    "utf8",
  );
}

async function releaseLocalWorkerLock(): Promise<void> {
  if (!lockHandle) {
    return;
  }
  await lockHandle.close().catch(() => undefined);
  lockHandle = null;
  await unlink(LOCAL_WORKER_LOCK_PATH).catch(() => undefined);
}

async function isLocalWorkerLockStale(): Promise<boolean> {
  try {
    const raw = await readFile(LOCAL_WORKER_LOCK_PATH, "utf8");
    if (!raw.trim()) {
      return true;
    }
    let payload: { heartbeatAt?: number; pid?: number } = {};
    try {
      payload = JSON.parse(raw) as { heartbeatAt?: number; pid?: number };
    } catch {
      return true;
    }

    if (typeof payload.pid === "number" && !isPidAlive(payload.pid)) {
      return true;
    }
    if (typeof payload.heartbeatAt === "number") {
      return Date.now() - payload.heartbeatAt > LOCAL_WORKER_LOCK_STALE_MS;
    }

    return true;
  } catch {
    return false;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(`[og-agent-lp-worker] ${sanitizeError(error)}`);
    process.exit(1);
  });
