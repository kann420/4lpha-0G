# Galileo Testnet Trade Agent Rebuild — Review Audit (2026-07-12)

Scope: branch `fix/vault-v4-blockers` — committed testnet-rehearsal UI commits plus the
uncommitted/untracked Galileo real-transaction stack (contracts, `lib/galileo/*`,
`app/api/agents/galileo/*`, `GalileoTradePanel`, deploy/verify scripts, tests) and every
modified shared file. Review method: 8 independent finder passes (line-by-line,
removed-behavior, cross-file tracing, reuse, simplification, efficiency, altitude,
AGENTS.md conventions) followed by direct source verification of each candidate.

## Verdict

- **Mainnet isolation: PASS.** No mainnet functionality is broken by this rebuild
  (two operational caveats below).
- **Contract security: PASS.** `PolicyVaultV4SwapGalileo` + sandbox stack satisfy the
  AGENTS.md deny-by-default checklist.
- **Testnet UI wiring: FAIL as shipped.** Two confirmed bugs make the Galileo trade
  panel non-functional through the browser (the live-acceptance script passed because
  it bypasses the UI/API path).

## Mainnet isolation analysis (the user's core question)

Confirmed safe by cross-file tracing:

- `lib/types/index.ts` — purely additive: new Galileo interfaces, new **optional**
  fields on `AgentTradeRequest`/`AgentTradePreview`/`AgentTradeExecution`, widened
  `AgentTradeBackendMode` union. No mainnet field removed or renamed.
- `app/api/agent/trade/route.ts` — the Galileo logic is fully enclosed in
  `if (networkId === "testnet")` and returns before the mainnet path. The mainnet
  branch is byte-for-byte identical; `meta.backend` stays `"wired"` for mainnet.
- `app/api/agents/route.ts` — mainnet callers omit `networkId`, so they fall through
  the new testnet gate into the (now dynamically imported) mainnet resolver unchanged.
- `lib/agent/trade-catalog.ts` — `MAINNET_AGENT_TRADE_ROUTES` untouched; the worker
  filters `networkId === "mainnet"`, so the Galileo route never enters mainnet
  buy/sell candidates. No route-id collision.
- `components/surfaces/VaultSurface.tsx` / `AgentRouteTradePanel.tsx` — Galileo panels
  render only for `networkId === "testnet"`; mainnet props/hooks unchanged.
- `hardhat.config.ts` — Solidity profile unchanged (0.8.24 / cancun / viaIR); `ogMainnet`
  RPC and key env names unchanged.
- `.gitignore` / `package.json` — additive only (remotion dirs / new scripts + devDeps).
- Env separation is real: `OG_GALILEO_*` / `GALILEO_*_PRIVATE_KEY` never fall back to
  `OG_RPC_URL` / `DEPLOYER_PRIVATE_KEY`.

Two mainnet-adjacent caveats (not breakage of app functionality):

1. **`hardhat.config.ts` `accounts: "remote"` fallback (finding F6).** When
   `DEPLOYER_PRIVATE_KEY` is unset, `ogMainnet` previously had zero signers and failed
   fast; now it asks the RPC node for `eth_accounts`. Against a public RPC this just
   fails more confusingly, but against any endpoint exposing unlocked accounts a
   mainnet tx could be signed by an unintended remote account. Recommend restoring the
   empty-array behavior (same for `ogGalileo`).
2. **`useGalileoWalletVault()` runs unconditionally in `VaultSurface`,** so the mainnet
   vault page fires Galileo (16602) RPC reads in the background when the
   `NEXT_PUBLIC_GALILEO_*` env is configured. No mainnet state is touched and no
   chain-switch prompt fires (writes are only reachable from the testnet-only panel);
   it is wasted RPC + console noise. Gate the hook's refresh on
   `network.id === "testnet"`.

Also intentional-but-breaking for existing ops: `ogGalileo` dropped its
`OG_RPC_URL`/`DEPLOYER_PRIVATE_KEY` fallbacks (deliberate isolation, per in-code
comment), so the pre-existing `smoke:preflight` / `smoke:vault` scripts fail until
`OG_GALILEO_RPC_URL` + `GALILEO_DEPLOYER_PRIVATE_KEY` are populated. Expected, but
worth noting in ops docs.

## Confirmed bugs (must fix)

| # | Severity | File | Bug |
|---|----------|------|-----|
| 1 | **Blocker** | `components/app/GalileoTradePanel.tsx:106` + `app/api/agent/trade/route.ts` | Panel sends `auditId`, but `galileoRequestSchema` is `.strict()` without an `auditId` field → **every** preview/execute from the panel gets 400 `invalid_galileo_request`. The whole testnet trade panel is dead in the browser. Fix: add `auditId: z.string().trim().min(1).max(96).optional()` to the schema (or stop sending it). |
| 2 | **Blocker** (default config) | `app/api/agent/trade/route.ts:81` | Preview is gated behind `resolveGalileoTradeRouteBoundary()`, which requires all 4 signer keys **and** `ENABLE_GALILEO_TRADE=true`. With the `.env.example` default (`false`) every preview 503s, even though preview needs no signer and the boundary itself models a `preview_only` mode. Fix: for `intent === "preview"`, only require the read config; enforce the write boundary at execute (the second `resolveGalileoTradeRouteBoundary` call is already there). |
| 3 | High | `components/app/GalileoTradePanel.tsx:218` | Slippage input allows 1–500 bps; schema caps at `max(100)`. Values 101–500 → opaque 400. Align the two (pick one bound) and surface a per-field error. |
| 4 | High | `components/app/GalileoTradePanel.tsx:208` | Amount field is hard-labeled "Amount 0G", but on **sell** the server parses it as 6-decimal mUSDC. A user sizing a sell "in 0G" signs consent for a different asset/magnitude. Fix: label switches with side (`Amount 0G` / `Amount mUSDC`). |
| 5 | High | `components/app/GalileoTradePanel.tsx:22` | `ALLOWED_STORAGE_ORIGINS` only contains the **mainnet** indexer `https://indexer-storage-turbo.0g.ai`. The Galileo indexer `https://indexer-storage-testnet-turbo.0g.ai` is not allowlisted, so the Storage-upload evidence link renders "Pending" forever even after a successful upload. Add the testnet origin. |
| 6 | Medium | `hardhat.config.ts:114` | `accounts: "remote"` fallback on `ogMainnet`/`ogGalileo` when the key env is unset (see caveat 1 above). Restore `[]`. |
| 7 | Medium | `app/api/agent/trade/route.ts:164` | `galileoPreview()` hand-builds the route object and has already drifted from `GALILEO_AGENT_TRADE_ROUTE`: `maxAmountIn` "0.01" vs "0.25", `auditId` "galileo-audit" vs "galileo-v4-sandbox-swap". Spread the shared const and override only dynamic fields. |

## High-value robustness/efficiency issues

| # | File | Issue |
|---|------|-------|
| 8 | `lib/galileo/executor.ts` (execute path) | One execute triggers ~5 full previews (~17 RPC reads each — 2 in the route, 3 freshness re-runs in `executeGalileoTrade`) plus `assertGalileoStackIntegrity` twice (~29 reads each, with internal `getChainId`/`getCode` double-reads) → **120+ RPC reads per trade** against the ~52 reads/min quiknode budget, and these raw `http()` transports carry no `OG_RPC_RETRY` backoff. A 429 mid-execute aborts a trade after consent was signed. Fix: one preview threaded through, one integrity pass, lightweight freshness re-read (quote + policyHash + paused/revoked only). |
| 9 | `lib/galileo/executor.ts:328` | `TradeExecuted` is triple-defined (Solidity, inline parse signature, hand-computed keccak topic) and `galileoVaultAbi` omits the event. Any drift → `parseTradeEvent` returns undefined → `trade_event_missing` **after funds moved on-chain**, recording a real trade as failed/recovery_required. Derive ABI + event from the compiled artifact (already imported for bytecode). |
| 10 | `lib/galileo/ledger.ts:552` | Every ledger transition (≈8 per trade) reads, re-validates, re-stringifies, and double-fsyncs the whole `consents.json`; `trades[]`/`deployments[]` are never pruned → unbounded growth and rising latency on the hot path. Prune terminal records or move to an append-only event log. |

## Cleanup backlog (non-blocking)

- `contracts/PolicyVaultV4SwapGalileo.sol` re-implements the mainnet V4 trade engine
  as a compacted fork (already diverged: event shape, per-pair minOut, position
  count). Security fixes will not propagate. Consider a shared abstract base.
- `lib/galileo/storage.ts` is a near-verbatim copy of `lib/og/storage-upload.ts` /
  `storage-download.ts`; parametrize one uploader by chain/env/signer instead.
- `lib/galileo/metadata.ts` `canonicalJson`+`sha256Hex` duplicate
  `lib/copilot/session-proof.ts` `stableJson`/`hashJson` — these produce on-chain
  `auditRoot`s, so a byte-level divergence breaks verification; share one canonicalizer.
- `waitGalileoReceipt` duplicates the copilot `waitForReceipt` RPC-lag tolerance loop
  with different constants and broader error-swallowing.
- Env/private-key validators are copied across 4 modules (`lib/galileo/config.ts`,
  `lib/og/storage-*.ts`, `session-proof.ts`).
- `app/api/agents/galileo/workspace/route.ts` + the `workspace-read` consent action
  are dead code — no client fetches the route (the panel uses
  `/api/agents?networkId=testnet`). Delete or wire up.
- `resolveGalileoTradeRouteBoundary` and `resolveGalileoWriteConfig` are each resolved
  twice per request; `assertGalileoStackIntegrity` re-checks what preflight checked.
- `16602` is a raw literal in ≥4 TS modules; export one `GALILEO_CHAIN_ID`.
- Rehearsal-mode isolation in `OgAgentCreateWorkspace`/`LpAgentCreateWorkspace` rests
  on early-return guards + ~65 scattered `isTestnetRehearsal` ternaries rather than a
  separate component seam (the pattern `AgentRouteTradePanel` → `GalileoTradePanel`
  already demonstrates). One dropped guard would send a rehearsal into the real
  mainnet deploy path.
- Pre-existing (not from this change): Vietnamese comment "Hướng B" in `.env.example`
  and `EmbeddedCopilotRail.tsx` violates the English-only rule for a public repo.
- UX consistency: the committed rehearsal flow still labels the testnet workspace
  "mock adapter / no transaction broadcast" while the newer `GalileoTradePanel` on the
  same page performs **real** Galileo transactions. Reconcile the copy so users are
  not told a real-tx panel is a mock.

## What was checked and passed

- **Chain IDs:** all constants are 16602/16661; no stale 16601 anywhere.
- **Vault deny-by-default:** only narrow `buy`/`sell`; no arbitrary call, delegatecall,
  multicall, raw calldata, arbitrary target/recipient, or generic execute.
- **On-chain policy:** per-trade cap, daily cap, max exposure, cooldown, deadline
  window, replay guard (`usedActionHashes`), `amountOutMin == 0` reverts, min-out bps
  floor vs trusted quote, pause, revoke executor, owner-only withdraw, balance-delta
  checks on both legs, `tightenPolicy` can only tighten.
- **Approvals:** sell approves only the allowlisted adapter and resets to 0; executor
  is never approved.
- **Mock-adapter production guard:** vault constructor reverts on
  `adapterKind() == keccak256("4LPHA_0G_MOCK_ADAPTER")`; `mockAdapterAllowed = false`
  and re-checked by the registry attestation.
- **Registry attestation:** codehash pin + config cross-check (executor, adapter,
  proof registry, token, pool, mock flag) before a vault becomes adapter-authorized;
  adapter rejects non-attested vaults and pins chain id.
- **Secrets:** all Galileo keys are server-only env (`GALILEO_*_PRIVATE_KEY`);
  `NEXT_PUBLIC_*` Galileo vars are addresses/URLs only; `.env.example` placeholders
  only; route errors sanitized (no env/secret leakage in messages).
- **API contract:** `{ data, error?, meta? }`, strict Zod at the boundary,
  `import "server-only"` on Galileo server modules, shared shapes in `lib/types/`.
- **No forbidden legacy deps** (ZeroDev/BNB/Mantle/Four.Meme/legacy key names) in the
  Galileo scope.

## Suggested verification after fixes

1. `npx tsc --noEmit` and `npm run build`.
2. `npx hardhat compile` + the galileo test suite (`test/galileo-*.ts`).
3. Browser smoke on `/agents` (testnet): roster load → Refresh quote (with
   `ENABLE_GALILEO_TRADE=false` → preview must still work) → slippage 300 → clear
   error or accepted → sign consent → execute (flag on) → all three evidence links
   render, including the Storage link against the testnet indexer.
4. Confirm mainnet `/agents`, `/vault`, and a mainnet preview/execute round-trip are
   unchanged.
