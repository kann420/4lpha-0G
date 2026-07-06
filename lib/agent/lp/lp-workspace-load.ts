import "server-only";

import { loadOgAgentWorkspace } from "@/lib/agent/single-agent-server";
import type { OgAgentDeploymentRecord, OgAgentVaultSnapshot } from "@/lib/agent/single-agent";

// Retry the LP workspace load until the V3 vault snapshot is usable.
//
// readVaultSnapshot (inside loadOgAgentWorkspace) is wrapped in withTimeout —
// on a flaky mainnet RPC (quiknode) a vault read can time out and the snapshot
// comes back ready:false (the withTimeout catch returns `{ owner, ready:false,
// warnings: ["Policy Vault state timed out after Nms."] }` with NO vault
// address), which would abort LP mint/exit even though the vault is fine
// on-chain (a fresh load usually succeeds). Retry a few times so a transient
// timeout self-heals rather than surfacing as a hard failure.
//
// Non-transient not-ready states are NOT retried — they are deterministic and
// retrying only wastes RPC calls + latency. The helper throws immediately with
// the real `vault.warnings` surfaced (e.g. "Policy Vault is paused.", "RPC
// chain mismatch: ...", "V3 vault snapshot is missing lpAdapter/lpPolicy (V2
// or swap-only vault).") so callers/users see the actual reason instead of a
// generic "requires a ready V3 vault" message.
//
// Returns the first workspace whose vault snapshot has the fields the mint/exit
// paths need (ready + vault address + lpAdapter + lpPolicy). The helper
// guarantees `vault.paused === false` and `vault.executorRevoked === false` on
// return (those are non-transient warnings it would have thrown on). Callers
// still re-check the OFF-CHAIN agent.status === "paused" flag themselves — that
// is a registry concept, not a vault-snapshot warning, and has no on-chain
// backstop.
export async function loadReadyLpWorkspace(
  deployment: Pick<OgAgentDeploymentRecord, "id" | "owner">,
  options: { attempts?: number; delayMs?: number } = {},
): ReturnType<typeof loadOgAgentWorkspace> {
  const attempts = options.attempts ?? 4;
  const delayMs = options.delayMs ?? 1_500;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const ws = await loadOgAgentWorkspace({
      agentId: deployment.id,
      live: true,
      ownerAddress: deployment.owner,
    });
    const v = ws.vault;
    if (v.ready && v.vault && v.lpAdapter && v.lpPolicy) {
      return ws;
    }
    const reason = notReadyReason(v);
    if (!isTransient(v) || attempt === attempts - 1) {
      throw new Error(reason);
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  // Unreachable — the loop either returns or throws on every path.
  throw new Error("LP action could not load a ready V3 vault snapshot after retries.");
}

function isTransient(v: OgAgentVaultSnapshot): boolean {
  // The withTimeout fallback for a timed-out readVaultSnapshot returns a
  // snapshot with NO vault address and a "timed out" / "Unable to read"
  // warning. That is the only shape a retry can fix — every other not-ready
  // state (paused, revoked, chain mismatch, owner mismatch, no vault, V2,
  // swap-only V3) is deterministic.
  if (v.vault) return false;
  return (v.warnings ?? []).some((w) => /timed out|unable to read/i.test(w));
}

function notReadyReason(v: OgAgentVaultSnapshot): string {
  const warnings = v.warnings ?? [];
  if (warnings.length > 0) return warnings.join(" ");
  // ready may be true with no warnings but lpAdapter/lpPolicy undefined — a V2
  // vault or a swap-only V3 vault. Call this out explicitly so the operator
  // sees "migrate to V3" rather than a generic ready-check message.
  return "V3 vault snapshot is missing lpAdapter/lpPolicy (V2 or swap-only vault).";
}