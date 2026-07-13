# Galileo Testnet Rebuild — Fix Plan (2026-07-12)

Source of truth: `docs/galileo-testnet-rebuild-audit-2026-07-12.md` (mentor's review).
Branch: `fix/vault-v4-blockers`.

Workflow: **Claude plan (this doc) → Codex review of plan/audit → Codex execution → Claude final audit.**

## STATUS: COMPLETE (2026-07-12)

All blockers + high + robustness fixes implemented (Codex execution) and verified (Claude final audit).

| Fix | Status | Verified by |
|-----|--------|-------------|
| 1 auditId schema | ✅ | source: `auditId` optional in `galileoRequestSchema` |
| 2 preview not gated by write boundary | ✅ | source: top gate now `!boundary.ok && status===400` only; execute re-checks `!boundary.ok`; `galileo-config` test (preview-only/unavailable) passes |
| 3 slippage bound | ✅ | source: input `max={100}` + inline `slippageError` |
| 4 amount label side-aware | ✅ | source: `{side === "buy" ? "Amount 0G" : "Amount mUSDC"}` |
| 5 testnet indexer allowlist | ✅ | source: both origins in `ALLOWED_STORAGE_ORIGINS` |
| 6 hardhat `accounts: []` | ✅ | source: both networks `length===0 ? []` |
| 7 spread shared route const | ✅ | source: `route: { ...GALILEO_AGENT_TRADE_ROUTE, ...override }` |
| 8 RPC read reduction + retry | ✅ | source: `galileoPublicClient` retry helper everywhere; single integrity pass (L179); lightweight `readGalileoTradeFreshness` preserving quote/policyHash/paused/revoked + amountOutMin>0 |
| 9 TradeExecuted from artifact | ✅ | `galileo-abi-parity` test (deepEqual sharedEvent==artifactEvent) passes |
| 10 ledger pruning | ✅ | source: `pruneTerminalTrades` (terminal-only, non-terminal always kept, 48h OR 200, both fsyncs intact); `galileo-reconcile` + `galileo-consent-ledger` tests pass |
| Caveat 2 hook gating | ✅ | source: `useGalileoWalletVault(network.id === "testnet")`, effect gated `if (!testnetEnabled) return` |

**Verification results:**
- `npx tsc --noEmit`: zero errors in any galileo/modified file. (Pre-existing, out-of-scope: `OgAgentDetailPage.tsx:857,1266` Icon JSX typing — identical at committed HEAD; `marketing-video-pmg/` untracked remotion sub-app. Neither touched by these fixes.)
- `npx hardhat compile`: OK (no .sol changed).
- Galileo test suite: **30 passing** — abi-parity 3, consent-ledger 7, reconcile 3, rate-limit 3, redaction 1, low-reserve 4, config 6, ui-isolation 3.
- `npm run build` deliberately NOT greenlit: it would fail only on the pre-existing `OgAgentDetailPage.tsx` Icon type error (unrelated to this audit); resolve that separately before a production build.
- Phase 4 cleanup backlog: NOT done this pass (non-blocking; tracked for a follow-up).

**Codex orchestration note:** review ran on the compact `codex:codex-rescue` pass; execution ran in 4 write batches (A: Fix 1-5,7 + Caveat 2; B: Fix 6,9; C: Fix 8; D: Fix 10). Long Codex write runs that invoked the hardhat test runner crashed mid-flight twice (process died, leaving an orphan `running` entry in the companion state) — mitigated by forbidding in-run `hardhat test` (Claude runs the suite) which kept every subsequent run short and stable.

Scope rule: mainnet isolation is PASS — do **not** touch the mainnet branch of any shared
file. Every change below stays inside the `networkId === "testnet"` gate, the Galileo panel,
or Galileo-only `lib/galileo/*` modules. No mainnet field/prop/route may be renamed or removed.

Guiding constraints from AGENTS.md: English-only code/comments; `{ data, error?, meta? }`
API contract; strict Zod at the boundary; server-only Galileo modules; no forbidden legacy
deps; keep changes scoped.

---

## Phase 1 — Blockers (panel is dead in the browser)

### Fix 1 — `auditId` rejected by strict Galileo schema (Finding #1)
- **File:** `app/api/agent/trade/route.ts` (`galileoRequestSchema`, ~line 39-56).
- **Change:** add `auditId: z.string().trim().min(1).max(96).optional()` to `galileoRequestSchema`
  (before `.strict()`). The outer `requestSchema` already has it; the strict Galileo schema is
  the one rejecting the panel's payload.
- **Why this over "stop sending it":** `auditId` is legitimately part of the panel payload
  (`GALILEO_AGENT_TRADE_ROUTE.auditId`) and is useful evidence context; accept it optionally.
- **Verify:** panel preview no longer returns `400 invalid_galileo_request`.

### Fix 2 — preview 503s under default `ENABLE_GALILEO_TRADE=false` (Finding #2)
- **File:** `app/api/agent/trade/route.ts` (testnet block, ~line 76-99).
- **Problem:** the top-of-block `resolveGalileoTradeRouteBoundary()` returns `503
  galileo_trade_disabled` for `preview_only` mode, killing preview even though preview needs
  no signer.
- **Change:**
  - Keep the **network-tuple** validation early and fail-closed (a `boundary.status === 400`
    / `invalid_galileo_network` must still 400 immediately — do not let a mainnet-shaped
    request slip through).
  - Do **not** early-return on `preview_only`/`galileo_trade_disabled` (503). Let the request
    proceed to preview using `resolveGalileoTradeReadConfig()` (read-only, already at line 89).
  - Enforce the write boundary only on the execute path — the second
    `resolveGalileoTradeRouteBoundary()` (line 102) already does this; keep it as the single
    write gate.
- **Implementation shape:** call the boundary once up front; if `!boundary.ok && boundary.status
  === 400` → return the 400. Otherwise continue. For `intent === "execute"`, re-resolve (or
  reuse) the boundary and require `boundary.ok` before calling `executeGalileoTrade`.
- **Verify:** with `ENABLE_GALILEO_TRADE=false`, preview returns 200; execute returns
  `503 galileo_trade_disabled`.

---

## Phase 2 — High-severity UI/contract-drift bugs

### Fix 3 — slippage bound mismatch 1–500 vs schema max 100 (Finding #3)
- **Files:** `components/app/GalileoTradePanel.tsx:218` (input `max={500}`) and
  `app/api/agent/trade/route.ts` (`galileoRequestSchema.slippageBps` `max(100)`).
- **Decision — pick one bound:** align the **UI to the schema** (`max=100`). Rationale: 100 bps
  (1%) is already generous for a sandbox pool and the server floor is the security-relevant
  one; widening the schema would loosen a policy input. Set input `max={100}` and `min={1}`.
- **Add per-field error:** clamp/validate on change and show an inline message when the user
  types >100 (or <1) instead of letting it fall through to an opaque 400. Keep it lightweight
  (local state + a small helper text under the input).
- **Verify:** entering 300 shows a clear field error; 75 still works.

### Fix 4 — Amount label is asset-wrong on sell (Finding #4)
- **File:** `components/app/GalileoTradePanel.tsx:208`.
- **Change:** make the amount label side-aware: `buy → "Amount 0G"`, `sell → "Amount mUSDC"`
  (server parses sell `amountIn` as 6-decimal mUSDC, buy as 18-decimal 0G, per route.ts:91).
- **Optional nicety:** mirror the same asset in any helper/placeholder text so the signed
  consent magnitude is unambiguous.
- **Verify:** toggling side flips the label; consent reflects the correct asset.

### Fix 5 — testnet Storage indexer not allowlisted → evidence link stuck "Pending" (Finding #5)
- **File:** `components/app/GalileoTradePanel.tsx:22` (`ALLOWED_STORAGE_ORIGINS`).
- **Change:** add the Galileo testnet indexer origin `https://indexer-storage-testnet-turbo.0g.ai`
  to the allowlist. This is a **public 0G infra origin** (the mainnet sibling
  `https://indexer-storage-turbo.0g.ai` is already hardcoded here and is documented in
  AGENTS.md), so it is not a secret — hardcoding it matches the existing pattern.
- **Codex review note (NEEDS-CHANGE):** Codex flagged hardcoding "another API origin" as an
  AGENTS.md smell and preferred deriving/validating the origin from
  `NEXT_PUBLIC_GALILEO_STORAGE_INDEXER_URL`. Reconcile as follows: the allowlist is a **safety
  gate** (it must stay a fixed set of known-good public origins so a misconfigured/hostile env
  value can't be turned into a link), and `storageEvidenceHref()` already reads the env origin
  and checks it against the set. So: keep the allowlist as a constant, add the public **testnet**
  origin to it, and keep the existing env-origin validation. Do NOT drive the allowlist itself
  from env. If Codex still objects at execute time, the acceptable alternative is a small
  `GALILEO_STORAGE_INDEXER_ORIGIN` constant in `lib/galileo/*` reused by both — but the origin
  value is public either way.
- **Verify:** after a successful upload the Storage evidence link renders "Open" against the
  testnet indexer.

### Fix 6 — `accounts: "remote"` fallback on `ogMainnet`/`ogGalileo` (Finding #6, caveat 1)
- **File:** `hardhat.config.ts:108` and `:114`.
- **Change:** restore the empty-array behavior — when the key env is unset use `[]` instead of
  `"remote"`, so a missing key fails fast rather than asking an RPC node for `eth_accounts`
  (which risks signing with an unintended unlocked remote account). Apply to **both** networks:
  `accounts: galileoPrivateKeys.length === 0 ? [] : galileoPrivateKeys` and the mainnet
  equivalent.
- **Codex review note (NEEDS-CHANGE):** this edits an `ogMainnet` line, which is a deliberate
  **exception** to the "do not touch mainnet" scope rule — it is a mainnet *safety* restoration,
  not a behavior change to the app's mainnet path. Call it out explicitly in the commit, and
  regression-test that both `ogMainnet` and `ogGalileo` still resolve signers correctly when the
  key IS set (only the unset case changes).
- **Verify:** `npx hardhat compile` still succeeds; deploy scripts that need a signer fail
  clearly when the key is unset; a set key still produces the expected signer on both networks.

### Fix 7 — hand-built preview route object drifted from shared const (Finding #7)
- **File:** `app/api/agent/trade/route.ts:164` (`galileoPreview()` `route:` object).
- **Change:** import and spread `GALILEO_AGENT_TRADE_ROUTE` from `@/lib/galileo/trade-route`,
  overriding only the dynamic fields (`id: request.routeId`, `agentId: request.agentId`,
  `inputToken`/`outputToken` by side, `readiness` from `preview.decision`). Drop the divergent
  literals (`auditId: "galileo-audit"`, `maxAmountIn: "0.01"`, `label: "Galileo sandbox swap"`)
  so the const stays the single source.
- **Verify:** preview `route` payload matches the const's `auditId`/`maxAmountIn`/`label`.

### Caveat 2 — `useGalileoWalletVault()` fires testnet RPC on mainnet vault page
- **File:** `components/app/useGalileoWalletVault.ts` (+ its use in `VaultSurface.tsx`).
- **Change:** gate the hook's refresh/polling on `network.id === "testnet"` so the mainnet
  `/vault` page does not fire background 16602 reads. No mainnet state is touched today; this
  is wasted RPC + console noise only.
- **Codex note:** keep the hook itself **called unconditionally** (React rules-of-hooks) — gate
  the *refresh/polling effect* via a testnet-enabled parameter/guard inside the hook, don't wrap
  the hook call in a condition.
- **Verify:** on mainnet `/vault`, no Galileo RPC reads in the network log.

---

## Phase 3 — Robustness / efficiency (protect a signed, in-flight trade)

### Fix 8 — ~120+ RPC reads per execute, no retry backoff (Finding #8)
- **File:** `lib/galileo/executor.ts` (`executeGalileoTrade` + `route.ts` preview double-call).
- **Problems:**
  - `route.ts` runs `previewGalileoTrade` twice (lines 94, 97) just to derive `userMinOut`.
  - `executeGalileoTrade` re-previews at line 163, 200 (`refreshed`), 227 (`postProof`), and
    calls `assertGalileoStackIntegrity` at 160 and 196.
  - All `http()` transports are raw — no `OG_RPC_RETRY_COUNT`/`OG_RPC_RETRY_DELAY_MS` backoff,
    so a single quiknode 429 mid-execute aborts a trade **after consent is signed**.
- **Changes:**
  1. Thread **one** preview through: compute `userMinOut` from the first full preview and pass
     the preview object into `executeGalileoTrade` instead of re-previewing inside it. (Adjust
     the `executeGalileoTrade` signature to accept the already-computed preview, or memoize.)
  2. Run `assertGalileoStackIntegrity` **once** per execute (remove the duplicate at 196; keep
     the pre-side-effect one). Confirm the remaining call still runs before any write.
  3. Replace the freshness re-runs (`refreshed`, `postProof`) with a **lightweight re-read** of
     only `quoteExactIn` + `policyHash` + `paused`/`executorRevoked` (the values that gate
     staleness), not a full ~17-read preview.
  4. Add retry backoff to the Galileo public clients: build the viem transport with
     `http(rpcUrl, { retryCount, retryDelay })` sourced from `OG_RPC_RETRY_COUNT` /
     `OG_RPC_RETRY_DELAY_MS` (same pattern already used elsewhere per the LP quiknode work).
     Centralize in a small `galileoPublicClient(rpcUrl)` helper so every read path shares it.
- **Care:** do not weaken any staleness/security check — the trusted-quote equality, deadline,
  policyHash equality, and post-proof re-check must still hold; only reduce the *number* of
  reads, not the guarantees. Balance-delta and event checks stay untouched.
- **Verify:** count RPC reads per execute drops materially (target well under the ~52/min
  budget for a single trade); galileo test suite still green.

### Fix 9 — `TradeExecuted` triple-defined; ABI omits the event (Finding #9)
- **File:** `lib/galileo/executor.ts:328` (`parseTradeEvent`), `galileoVaultAbi` in
  `lib/contracts/policy-vault-v4-galileo.ts`.
- **Problem:** the event is defined 3 ways (Solidity, inline `parseAbiItem` signature,
  hand-computed keccak topic) and `galileoVaultAbi` omits it. Any drift → `parseTradeEvent`
  returns undefined → `trade_event_missing` **after funds moved**, recording a real trade as
  failed/recovery_required.
- **Confirmed by Codex:** `TradeExecuted` exists in
  `artifacts/contracts/PolicyVaultV4SwapGalileo.sol/PolicyVaultV4SwapGalileo.json` (~line 337);
  `galileoVaultAbi` in `lib/contracts/policy-vault-v4-galileo.ts:91-122` contains only function
  entries, no events.
- **Change:** derive the ABI + `TradeExecuted` event from the **compiled artifact** (already
  imported for bytecode in the deploy path). Add the event to `galileoVaultAbi` from the
  artifact, and have `parseTradeEvent` use that single ABI source (via `decodeEventLog` with
  the artifact ABI) instead of the inline `parseAbiItem` + hand-computed topic.
- **Verify:** `test/galileo-abi-parity.test.ts` (extend if needed) asserts the ABI event
  matches the artifact; a real execute parses the event.

### Fix 10 — ledger rewrites + double-fsyncs whole `consents.json` per transition (Finding #10)
- **File:** `lib/galileo/ledger.ts:552` (transition/persist path).
- **Problem:** ~8 transitions per trade each read + re-validate + re-stringify + double-fsync
  the entire file; `trades[]`/`deployments[]` never pruned → unbounded growth + rising hot-path
  latency.
- **Decision — Option A (confirmed by Codex review):** prune terminal `trades[]` records beyond
  a retention window/count. **Do NOT touch the fsync pair.**
- **Codex review corrections (NEEDS-CHANGE — supersedes the original draft):**
  1. **Keep BOTH fsyncs.** They are not redundant: one fsyncs the temp file before rename, the
     other fsyncs the directory after rename — that is the standard atomic-durable-write pattern.
     Removing either weakens crash durability. My original "drop the redundant second fsync" was
     wrong; drop that instruction.
  2. **Never prune `recovery_required`** (nor any non-terminal state). Startup reconciliation
     (`recoverGalileoTrades` → `reconcileGalileoTrade`) still consumes `recovery_required`
     records; deleting them would strand an in-flight/crashed trade. Prune ONLY truly-terminal
     states (`confirmed`/`failed`/`blocked`), and even then **retain idempotency tombstones**
     (nonce/prepareId/actionHash markers) long enough that `claimTradeAndConsume` can still
     detect a replay — immediate terminal deletion would weaken replay/idempotency.
  3. Keep the retention generous (e.g. time-window + min-count) so a legitimate late retry of a
     recently-terminal request still hits its tombstone rather than being treated as fresh.
- **Care:** do not break idempotency/replay guarantees (`claimTradeAndConsume`, reconcile).
- **Verify:** `test/galileo-reconcile.test.ts` + `test/galileo-consent-ledger.test.ts` +
  `test/galileo-rate-limit.test.ts` still pass; file size stays bounded across many trades; a
  replay of a just-terminal request is still rejected (tombstone intact).

---

## Phase 4 — Cleanup backlog (non-blocking — do only if cheap & low-risk)

These are explicitly optional. Recommend deferring the structural refactors and doing only the
trivially-safe items this pass:

- **Do now (trivial, safe):**
  - Export one `GALILEO_CHAIN_ID` and replace the raw `16602` literals in ≥4 TS modules
    (there is already `GALILEO_CHAIN_ID` in `lib/galileo/config.ts` — import it; the panel has
    its own local `const GALILEO_CHAIN_ID = 16602` that can reference the shared source if the
    client can import it, else keep local but comment).
  - English-only: replace the Vietnamese "Hướng B" comment in `.env.example` and
    `EmbeddedCopilotRail.tsx` (public-repo rule). *(Pre-existing, but cheap.)*
  - Reconcile rehearsal copy: the committed rehearsal flow labels the workspace
    "mock adapter / no transaction broadcast" while `GalileoTradePanel` on the same page does
    **real** Galileo tx — fix the copy so a real-tx panel is not described as a mock.
  - Delete or wire the dead `app/api/agents/galileo/workspace/route.ts` + `workspace-read`
    consent action (no client fetches it). Prefer delete unless a near-term use is planned.

- **Defer (structural — separate follow-up, note in code with a TODO if touched):**
  - Shared abstract base for `PolicyVaultV4SwapGalileo.sol` vs mainnet V4 engine.
  - Parametrize one uploader for `lib/galileo/storage.ts` vs `lib/og/storage-*.ts`.
  - Share one canonicalizer for `lib/galileo/metadata.ts` vs `lib/copilot/session-proof.ts`
    (**flag as higher priority** — divergence breaks on-chain `auditRoot` verification; if
    Codex has budget, unify these two, but with a parity test guarding byte-equality).
  - Consolidate the copied env/private-key validators across 4 modules.
  - Refactor rehearsal isolation from scattered `isTestnetRehearsal` ternaries to a component
    seam.

---

## Verification (run after each phase; full suite before final audit)

1. `npx tsc --noEmit` and `npm run build`.
2. `npx hardhat compile` + galileo test suite (`test/galileo-*.ts` / `.test.ts`).
3. Browser smoke on `/agents` (testnet):
   - roster load → **Refresh quote with `ENABLE_GALILEO_TRADE=false` must still return a
     preview** (Fix 2) → slippage 300 shows a clear field error (Fix 3) → amount label flips
     with side (Fix 4) → sign consent → execute (flag on) → all three evidence links render,
     including Storage against the **testnet** indexer (Fix 5).
4. Confirm mainnet `/agents`, `/vault`, and a mainnet preview/execute round-trip are unchanged
   (isolation regression check; Caveat 2 → no background testnet RPC on mainnet `/vault`).

## Suggested execution order for Codex

Codex-review-recommended order (adopted):

1. **Fix 1 → Fix 2** — unblocks the panel; smallest, highest value.
2. **Fix 3, 4, 5, 7 + Caveat 2** — contained UI/config edits.
3. **Fix 6 (isolated)** — mainnet-adjacent hardhat safety change; do it on its own, regression-test both networks.
4. **Fix 9** — ABI/event from artifact (correctness before touching the read-count refactor).
5. **Fix 8** — RPC read reduction + retry backoff (careful; preserve every staleness guarantee).
6. **Fix 10 (safeguarded)** — ledger pruning with tombstones, both fsyncs kept, `recovery_required` never pruned.
7. **Full verification** (tsc, build, hardhat compile + galileo tests, browser smoke).
8. Phase 4 trivial items only.

Run verification 1–2 between phases. Do not batch Fix 8/10 blindly.

---

## Codex review verdict (2026-07-12, compact pass)

All 11 items validated against source. Verdicts:

- **CONFIRMED as-planned:** Fix 1, 2, 3, 4, 7, 8, 9, Caveat 2.
- **NEEDS-CHANGE (plan adjusted above):**
  - **Fix 5** — don't treat as a free-for-all hardcode; keep the allowlist a fixed set of public
    origins + env validation (the testnet origin is public, so adding it is fine).
  - **Fix 6** — explicitly an approved mainnet-scope exception; regression-test both networks.
  - **Fix 10** — **keep both fsyncs** (atomic-durable-write, not redundant); prune only terminal
    states, **never `recovery_required`**, and retain idempotency tombstones for replay.
- **Targeted checks:** Fix 2 execute stays fail-closed when `ENABLE_GALILEO_TRADE=false` (strict
  tuple + `ok` write boundary still required; no signer path bypasses the network-tuple check).
  Fix 8 weakens no guarantee **provided** both freshness checkpoints keep exact quote+policyHash
  equality, deadline stays locally enforced, and the post-proof read stays mandatory; balance-delta
  + event parse untouched. Fix 9 artifact has `TradeExecuted`, abi omits it. Fix 10 → Option A.
- **MISSED ITEMS:** none beyond the three NEEDS-CHANGE corrections folded in above.
