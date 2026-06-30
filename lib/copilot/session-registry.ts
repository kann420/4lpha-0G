import "server-only";

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { CopilotSessionRegistryRecord } from "@/lib/types";

/**
 * Per-wallet registry of saved Copilot sessions.
 *
 * Each wallet's saved sessions are indexed in `.data/copilot-sessions/<wallet>.json`
 * so the user can look up past sessions and retrieve them. The registry stores
 * the 0G Storage rootHash/storageRef + the on-chain proofTxHash; the ciphertext
 * itself lives on 0G Storage (immutable) and is fetched on demand at load time.
 *
 * The server only ever handles ciphertext + references - never plaintext.
 */

const REGISTRY_DIR = ".data/copilot-sessions";
const MAX_SESSIONS_PER_WALLET = 200;

interface RegistryFile {
  schemaVersion: 1;
  wallet: string;
  sessions: CopilotSessionRegistryRecord[];
  updatedAt: string;
}

function getRegistryPath(wallet: string): string {
  const safe = wallet.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!safe) {
    throw new Error("Invalid wallet for session registry path.");
  }
  return join(REGISTRY_DIR, `${safe}.json`);
}

async function readRegistry(wallet: string): Promise<RegistryFile> {
  const path = getRegistryPath(wallet);
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as RegistryFile;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.sessions)) {
      throw new Error("Corrupt Copilot session registry file.");
    }
    return parsed;
  } catch (error) {
    if (error instanceof Error && error.message.includes("Corrupt")) {
      throw error;
    }
    return { schemaVersion: 1, wallet: wallet.toLowerCase(), sessions: [], updatedAt: new Date().toISOString() };
  }
}

async function writeRegistry(registry: RegistryFile): Promise<void> {
  const path = getRegistryPath(registry.wallet);
  const tmp = `${path}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmp, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

/** List a wallet's saved sessions, newest first by createdAt. */
export async function listSessions(wallet: string): Promise<CopilotSessionRegistryRecord[]> {
  const registry = await readRegistry(wallet);
  return [...registry.sessions].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Find one session record by sessionId. */
export async function findSession(
  wallet: string,
  sessionId: string,
): Promise<CopilotSessionRegistryRecord | undefined> {
  const registry = await readRegistry(wallet);
  return registry.sessions.find((session) => session.sessionId === sessionId);
}

/**
 * Record a saved session. Throws a `session_already_exists` error (with a
 * `code` property) if a record with the same sessionId already exists, so the
 * save route can return a 409 before any 0G Storage upload or on-chain proof.
 */
export async function recordSession(record: CopilotSessionRegistryRecord): Promise<void> {
  const registry = await readRegistry(record.wallet);
  if (registry.sessions.some((session) => session.sessionId === record.sessionId)) {
    const error = new Error("A Copilot session with this sessionId is already saved.");
    (error as Error & { code?: string }).code = "session_already_exists";
    throw error;
  }
  registry.sessions.unshift(record);
  // Cap the registry size; drop the oldest entries beyond the cap.
  if (registry.sessions.length > MAX_SESSIONS_PER_WALLET) {
    registry.sessions.length = MAX_SESSIONS_PER_WALLET;
  }
  registry.updatedAt = new Date().toISOString();
  await writeRegistry(registry);
}

/**
 * Remove a session from the local registry. The 0G Storage upload itself is
 * immutable and cannot be deleted; this only unlists it from this browser's
 * per-wallet index so the user no longer sees it in Past Sessions.
 */
export async function deleteSession(wallet: string, sessionId: string): Promise<boolean> {
  const registry = await readRegistry(wallet);
  const next = registry.sessions.filter((session) => session.sessionId !== sessionId);
  if (next.length === registry.sessions.length) {
    return false;
  }
  registry.sessions = next;
  registry.updatedAt = new Date().toISOString();
  await writeRegistry(registry);
  return true;
}
