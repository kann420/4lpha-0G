import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { OgAgentLpRunRecord, OgAgentLpStoreArtifact } from "@/lib/agent/runtime/types";

// Advisory LP run store — mirrors lib/agent/runtime/store.ts EXACTLY: plain
// read + overwrite JSON via writeFile (no atomic temp+rename). The single-writer
// guarantee is the worker's file lock (scripts/og-agent-lp-worker.ts), not the
// store. The records here drive cooldown/lastRunAt lookups for the autonomous
// mint loop; they are NOT authoritative — the vault's on-chain cooldown is the
// backstop. Path: .data/agents/runtime/<agentId>-lp-runs.json, max 100,
// append-newest-first.

const LP_RUN_DIR = join(".data", "agents", "runtime");
const MAX_STORED_RUNS = 100;

export async function appendOgAgentLpRun(record: OgAgentLpRunRecord): Promise<void> {
  const current = await readOgAgentLpRunArtifact(record.agentId);
  const runs = [record, ...(current?.runs ?? [])].slice(0, MAX_STORED_RUNS);
  await writeJsonArtifact(lpRunPath(record.agentId), {
    runs,
    updatedAt: new Date().toISOString(),
  } satisfies OgAgentLpStoreArtifact);
}

export async function readOgAgentLpRuns(agentId: string, limit = 20): Promise<OgAgentLpRunRecord[]> {
  const artifact = await readOgAgentLpRunArtifact(agentId);
  return (artifact?.runs ?? []).slice(0, Math.max(0, limit));
}

async function readOgAgentLpRunArtifact(agentId: string): Promise<OgAgentLpStoreArtifact | null> {
  return readJsonArtifact<OgAgentLpStoreArtifact>(lpRunPath(agentId));
}

function lpRunPath(agentId: string): string {
  return join(LP_RUN_DIR, `${safeArtifactName(agentId)}-lp-runs.json`);
}

function safeArtifactName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/gu, "_").slice(0, 96);
}

async function readJsonArtifact<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw.replace(/^﻿/u, "")) as T;
  } catch {
    return null;
  }
}

async function writeJsonArtifact(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}