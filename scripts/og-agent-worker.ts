import dotenv from "dotenv";
import { mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadOgAgentWorkerConfig, runOgAgentWorkerOnce } from "../lib/agent/runtime";

dotenv.config({ path: ".env.local", quiet: true });

const LOCAL_WORKER_LOCK_PATH = join(process.cwd(), ".data", "runtime", "og-agent-worker.lock");
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
      console.info(`[og-agent-worker] shutdown requested via ${signal}`);
    }
  });
}

process.on("uncaughtException", (error) => {
  console.error(`[og-agent-worker] uncaughtException: ${sanitizeError(error)}`);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error(`[og-agent-worker] unhandledRejection: ${sanitizeError(reason)}`);
  process.exit(1);
});

async function main(): Promise<void> {
  const config = loadOgAgentWorkerConfig();
  await acquireLocalWorkerLockIfNeeded(config.once);
  logWorkerEvent("started", {
    agentId: config.agentId,
    allowConfiguredAgent: config.allowConfiguredAgent,
    buyAmount0G: config.buyAmount0G,
    dryRun: config.dryRun,
    intervalMs: config.intervalMs,
    killSwitchEnabled: config.killSwitchEnabled,
    maxCycles: config.maxCycles,
    once: config.once,
    processAllAgents: config.processAllAgents,
    sellPercent: config.sellPercent,
    slippageBps: config.slippageBps,
    workspaceUrlConfigured: Boolean(config.workspaceUrl),
  });

  if (config.once) {
    const summary = await runCycle(config);
    logWorkerEvent("cycle", summary);
    await releaseLocalWorkerLock();
    return;
  }

  try {
    while (!stopRequested) {
      const startedAt = Date.now();
      try {
        const summary = await runCycle(config);
        logWorkerEvent("cycle", summary);
      } catch (error) {
        console.error(`[og-agent-worker] ${sanitizeError(error)}`);
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

async function runCycle(config: ReturnType<typeof loadOgAgentWorkerConfig>) {
  return Promise.race([
    runOgAgentWorkerOnce(config),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`runOgAgentWorkerOnce timed out after ${CYCLE_TIMEOUT_MS}ms`)), CYCLE_TIMEOUT_MS),
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
        throw new Error("Another local 0G agent worker is already running. Stop it before starting a new worker.");
      }
      await unlink(LOCAL_WORKER_LOCK_PATH).catch(() => undefined);
    }

    if (retry < MAX_LOCK_RETRY - 1) {
      await sleep(200);
    }
  }

  throw new Error(`Failed to acquire local worker lock after ${MAX_LOCK_RETRY} attempts.`);
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
    console.error(`[og-agent-worker] ${sanitizeError(error)}`);
    process.exit(1);
  });
