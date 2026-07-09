import "server-only";

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { isAddress } from "viem";

export const ACTION_NONCE_SCOPES = [
  "lp-agent-deploy",
  "lp-mint",
  "lp-stake",
  "lp-unstake",
  "lp-zap-out",
  "lp-automation",
  "lp-policy",
  "vault-withdraw-native",
  "vault-migrate",
  "vault-migrate-v4",
] as const;

export type ActionNonceScope = (typeof ACTION_NONCE_SCOPES)[number];

export interface ActionNonceIssue {
  expiresAt: number;
  nonce: string;
  ttlSeconds: number;
}

export interface ActionNonceConsumeError {
  code: string;
  message: string;
  status: number;
}

const MAX_TTL_SECONDS = 5 * 60;
const MAX_NONCES = 500;
const NONCE_RE = /^[a-f0-9]{32}$/iu;
const NONCE_STORE_PATH = join(".data", "copilot", "action-consent-nonces.json");

interface StoredActionNonce {
  address: string;
  expiresAt: number;
  issuedAt: number;
  scope: ActionNonceScope;
}

interface ActionNonceStoreArtifact {
  nonces: Record<string, StoredActionNonce>;
  updatedAt: string;
}

export function issueActionNonce({
  address,
  scope,
  ttlSeconds = MAX_TTL_SECONDS,
}: {
  address: string;
  scope: ActionNonceScope;
  ttlSeconds?: number;
}): ActionNonceIssue {
  if (!isAddress(address)) {
    throw new Error("Cannot issue an action nonce for an invalid address.");
  }
  const store = pruneExpiredNonces(readNonceStore());
  const ttl = Math.max(1, Math.min(Math.floor(ttlSeconds), MAX_TTL_SECONDS));
  const nonce = randomBytes(16).toString("hex");
  const expiresAt = Math.floor(Date.now() / 1000) + ttl;
  store.nonces[nonceKey(scope, nonce)] = {
    address: address.toLowerCase(),
    expiresAt,
    issuedAt: Math.floor(Date.now() / 1000),
    scope,
  };
  writeNonceStore(trimNonceStore(store));
  return { expiresAt, nonce, ttlSeconds: ttl };
}

export function consumeActionNonce({
  address,
  expiresAt,
  nonce,
  scope,
}: {
  address: string;
  expiresAt: number;
  nonce: string;
  scope: ActionNonceScope;
}): ActionNonceConsumeError | undefined {
  const normalizedNonce = nonce.trim().toLowerCase();
  if (!NONCE_RE.test(normalizedNonce)) {
    return { code: "consent_invalid", message: "Action consent nonce is invalid.", status: 400 };
  }
  if (!isAddress(address)) {
    return { code: "wallet_invalid", message: "Connected wallet address is not valid.", status: 400 };
  }
  const key = nonceKey(scope, normalizedNonce);
  const store = pruneExpiredNonces(readNonceStore());
  const issued = store.nonces[key];
  if (!issued) {
    return { code: "consent_replayed", message: "Action consent nonce was not issued or was already used.", status: 401 };
  }
  delete store.nonces[key];
  writeNonceStore(store);
  const now = Math.floor(Date.now() / 1000);
  if (issued.expiresAt <= now || expiresAt <= now) {
    return { code: "consent_expired", message: "Action consent has expired; re-sign.", status: 401 };
  }
  if (issued.expiresAt !== expiresAt) {
    return { code: "consent_invalid", message: "Action consent expiry does not match the issued nonce.", status: 401 };
  }
  if (issued.address !== address.toLowerCase()) {
    return { code: "consent_invalid", message: "Action consent nonce was issued for a different wallet.", status: 401 };
  }
  return undefined;
}

export function maxActionNonceTtlSeconds() {
  return MAX_TTL_SECONDS;
}

export function isActionNonceScope(value: string): value is ActionNonceScope {
  return (ACTION_NONCE_SCOPES as readonly string[]).includes(value);
}

function nonceKey(scope: ActionNonceScope, nonce: string) {
  return `${scope}:${nonce.toLowerCase()}`;
}

function readNonceStore(): ActionNonceStoreArtifact {
  try {
    const parsed = JSON.parse(readFileSync(NONCE_STORE_PATH, "utf8").replace(/^\uFEFF/u, "")) as Partial<ActionNonceStoreArtifact>;
    const nonces = parsed.nonces && typeof parsed.nonces === "object" ? parsed.nonces : {};
    return {
      nonces: Object.fromEntries(
        Object.entries(nonces).filter((entry): entry is [string, StoredActionNonce] => {
          const [key, value] = entry;
          return (
            typeof key === "string" &&
            typeof value === "object" &&
            value !== null &&
            isActionNonceScope(value.scope) &&
            typeof value.address === "string" &&
            typeof value.expiresAt === "number" &&
            typeof value.issuedAt === "number"
          );
        }),
      ),
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
    };
  } catch {
    return { nonces: {}, updatedAt: new Date(0).toISOString() };
  }
}

function writeNonceStore(store: ActionNonceStoreArtifact) {
  mkdirSync(dirname(NONCE_STORE_PATH), { recursive: true });
  writeFileSync(
    NONCE_STORE_PATH,
    `${JSON.stringify({ nonces: store.nonces, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );
}

function pruneExpiredNonces(store: ActionNonceStoreArtifact): ActionNonceStoreArtifact {
  const now = Math.floor(Date.now() / 1000);
  let changed = false;
  for (const [key, value] of Object.entries(store.nonces)) {
    if (value.expiresAt <= now) {
      delete store.nonces[key];
      changed = true;
    }
  }
  if (changed) {
    writeNonceStore(store);
  }
  return store;
}

function trimNonceStore(store: ActionNonceStoreArtifact): ActionNonceStoreArtifact {
  const entries = Object.entries(store.nonces);
  if (entries.length <= MAX_NONCES) {
    return store;
  }
  entries.sort((left, right) => left[1].issuedAt - right[1].issuedAt);
  for (const [key] of entries.slice(0, entries.length - MAX_NONCES)) {
    delete store.nonces[key];
  }
  return store;
}
