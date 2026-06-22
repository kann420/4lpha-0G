import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { OgAgentRuntimeRunRecord, OgAgentRuntimeStoreArtifact } from "@/lib/agent/runtime/types";

const RUNTIME_RUN_DIR = join(".data", "agents", "runtime");
const MAX_STORED_RUNS = 100;

export async function appendOgAgentRun(record: OgAgentRuntimeRunRecord): Promise<void> {
  const current = await readOgAgentRunArtifact(record.agentId);
  const runs = [record, ...(current?.runs ?? [])].slice(0, MAX_STORED_RUNS);
  await writeJsonArtifact(runtimeRunPath(record.agentId), {
    runs,
    updatedAt: new Date().toISOString(),
  } satisfies OgAgentRuntimeStoreArtifact);
}

export async function readOgAgentRuns(agentId: string, limit = 20): Promise<OgAgentRuntimeRunRecord[]> {
  const artifact = await readOgAgentRunArtifact(agentId);
  return (artifact?.runs ?? []).slice(0, Math.max(0, limit));
}

async function readOgAgentRunArtifact(agentId: string): Promise<OgAgentRuntimeStoreArtifact | null> {
  return readJsonArtifact<OgAgentRuntimeStoreArtifact>(runtimeRunPath(agentId));
}

function runtimeRunPath(agentId: string): string {
  return join(RUNTIME_RUN_DIR, `${safeArtifactName(agentId)}-runs.json`);
}

function safeArtifactName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/gu, "_").slice(0, 96);
}

async function readJsonArtifact<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw.replace(/^\uFEFF/u, "")) as T;
  } catch {
    return null;
  }
}

async function writeJsonArtifact(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
