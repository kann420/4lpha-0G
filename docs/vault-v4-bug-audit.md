# PolicyVault V4 — Read-Only Audit Report

> Date: 2026-07-08. Scope: the V4 upgrade (per-user 3-contract split) for BOTH the trading agent (swap) and the LP agent.
> Method: read-only review (no code changes), 5 parallel passes — contracts / server wiring / API+migration / UI / trading-swap path — plus manual `file:line` verification of the most severe findings.
> Build status: `hardhat test` 52 pass (mostly V1/V2/V3), `tsc` OK, `next build` OK, size-gate OK. **This means the bugs are runtime/logic, not compile-time.** That is exactly why it looks green yet breaks in production.

> **Audience: fixing agents.** Every finding carries a concrete `file:line`, a runtime failure scenario, and a fix direction. Blockers B1–B4 were verified against the source. High/Medium/Low findings are agent-reported with high confidence — re-verify each against the cited `file:line` before editing. Section 6 lists what is CORRECT (do not touch). Section 8 lists principles to avoid introducing new bugs.

---

## 0. TL;DR for the deadline

The V4 contract architecture (Swap / LpEntry / LpExit split + VaultRegistry) is **sound and correctly deny-by-default** — there is no unconditional loss-of-funds path for an attacker (recipient pinned to `msg.sender`, owner-only withdrawal, mock adapter rejected on chainid 16661, struct order matches). The failures are at the **operational layer**, and the root cause repeats across almost every subsystem:

> **The single vault was split into three contracts, but most TS/server/UI code still behaves as if there is one vault address, and it targets the WRONG "third."**

Verified blockers (checked against source):

| # | Bug | Impact | File |
|---|-----|--------|------|
| **B1** | LP exit actions (`unstakeLp`/`zapOut`) are sent to **LpEntry** instead of **LpExit** | Users can enter positions but **cannot exit through the app** — every exit reverts | `lib/executor/policy-vault-lp.ts`, `lib/agent/lp/lp-exec.ts` |
| **B2** | Migration writes the roster with the **wrong vault address + wrong V4 field names** | After migration every LP op targets Swap → reverts; fund-from-swap always 400s | `lib/agent/vault-migrate-v4.ts:774-778` |
| **B3** | `zapOut`/`burnLp` call `liquidityOf(tokenId)` **after the NFT is burned** | On **real mainnet** (canonical NFPM reverts on a burned token) → zapOut/burnLp **always revert**. Tests pass only because the mock returns 0 | `PolicyVaultV4LpExit.sol:342`, `ZiaLpAdapterV4.sol:379` |
| **B4** | The 6 LpExit exit functions use the `executorActive` modifier (checks `paused`) | `setPaused(true)` **also locks the exit path** — violates spec (pause must block entries only) | `PolicyVaultV4LpExit.sol:262/310/365/430/484/534` |
| **B5** | The **entire swap path** targets `vault.vault` = **LpEntry** for V4; `v4SwapVault` is stored but never selected | V4 trading agents are **non-functional end-to-end** — preview 502s, execute reverts, sells unsupported, history empty (see §2a, fully traced) | `single-agent-server.ts:1087`, `trade-service.ts:344`, `curated-trade.ts:665-682` |

If only a few fixes land before the deadline, do them in this order: **B4 (contract, one modifier × 6) → B3 (contract, try/catch in `liquidityOf`) → B1 + B5 (server routing to the correct third) → B2 (migration roster)**. B3+B4 require a contract redeploy, so do them first if you intend to demo on mainnet.

---

## 1. Why it is "green" yet still broken

- **The V4 test suite is very thin.** `test/policy-vault-v4.ts` exists (~11 tests) but omits almost all of the adversarial tests AGENTS.md mandates: reentrancy, malicious adapter/ERC20, cap/cooldown bypass, **pause-blocks-entries-but-exits-still-run** (exactly B4), mock-rejected-on-mainnet-chainid. `MaliciousZiaLpAdapterV4`, `DrainingAdapter`, `MaliciousERC20` **exist as files but are never deployed in any V4 test.** The fixture policy is left **unbounded**, so caps/cooldown are never exercised.
- **Mocks hide mainnet behavior.** `MockZiaLpAdapter.liquidityOf` reads its own mapping and returns 0 after burn → B3 never surfaces in tests. A **revert-on-burned** mock NFPM is required to catch real mainnet behavior.
- **`.r3-gaps.json`**: the plan's own round-3 verify found 58 gaps (9 blockers) **at the document level** — the V4 code was implemented while the spec was still being edited, precisely the conditions that produce spec-vs-code drift (location of `sweepToken`, `finalizeExit`→`reduceLpDeployment`/`purgeLpNft`, location of `rescueNft`). Several findings below are direct consequences.

---

## 2. Blockers — verified against source

### B1 — LP exit actions target the wrong third (LpEntry instead of LpExit)
**Severity: CRITICAL (functional). Files:** `lib/executor/policy-vault-lp.ts:113,334-341,517-536`; `lib/agent/lp/lp-exec.ts:84,149-168`

- For a V4 deployment, `deployment.vault` = **LpEntry** (`single-agent-server.ts:773,1087`).
- The executor uses **one shared `vaultAddress`** for every action. `unstakeLp`/`zapOut` only exist on `PolicyVaultV4LpExit` (`LpExit.sol:258,306`); LpEntry only has `zapInMintLp`/`zapInIncreaseLiquidity`/`stakeLp`.
- Grep proves it: **nothing in the repo ever passes `v4LpExitVault` to the executor** — `deployment.v4LpExitVault` is only used for snapshot plumbing.
- The preflight at `:135-139` also reads with `policyVaultV3Abi` for V4.

**Runtime failure:** every V4 unstake/zap-out (routes `[id]/unstake`, `[id]/zap-out`, worker exits, cleanup/smoke scripts) dies at `simulateContract` with an undecodable revert. Mint + auto-stake succeed → the user's capital is stuck in a position.

**Fix direction:** teach `executeMainnetPolicyVaultLpAction` about the trio. For **exit** actions: use `deployment.v4LpExitVault` + `policyVaultV4LpExitAbi`; read `policySnapshotHash` from **LpEntry** (`LpExit._validate` checks `policySnapshotHash == lpEntry.policyHash()`, `LpExit.sol:653`) but read `vaultActionHashForLp`/`actionHashFor` from **LpExit** (the hash binds `address(this)`); check `agentKeyEnabled`/`paused`/`executorRevoked` **on LpExit**. Note `policy()`/`lpDailySpent0G`/`allowedLpPools` **do not exist on LpExit** → the preflight must be per-third.

### B2 — Migration roster writes the wrong vault + wrong field names
**Severity: CRITICAL (functional + funds-visibility). File:** `lib/agent/vault-migrate-v4.ts:770-778` (`repointRoster`)

- The fresh-deploy path sets `record.vault = lpEntryVault` and fields `v4SwapVault/v4LpEntryVault/v4LpExitVault` (`single-agent.ts:60-62`, `single-agent-server.ts:635-640,773`).
- But `repointRoster` (the migration path) writes `record.vault = v4Trio.swapVault` (**wrong — must be lpEntryVault**) and fields `v4SwapAddress/v4LpEntryAddress/v4LpExitAddress` (**wrong names — nothing reads them**). The type-checker is blind because the record is cast to `Record<string, unknown>`.

**Runtime failure:** every LP path that uses `deployment.vault` (`lp-exec.ts:84/152/168`, `lp-mint.ts:175/198`, `mint/defaults/route.ts:55`) after migration targets **Swap** → reverts / "position not found" / 500. The NFTs the migration just preserved into LpEntry become unmanageable. `fund-lp-entry-from-v4-swap` reads `deployment.v4SwapVault` (undefined) → **always 400s** (`lp-deploy.ts:218`).

**Fix direction:** in `repointRoster` set `record.vault = v4Trio.lpEntryVault` and use the correct `*Vault` field names; add a typed helper instead of the untyped cast so the type-checker catches this next time.

### B3 — `liquidityOf` called after the NFT is burned → bricks on mainnet
**Severity: HIGH (bricks the exit path on mainnet, masked by mocks). Files:** `PolicyVaultV4LpExit.sol:342,345,514`; `PolicyVaultV4LpEntry.sol:692`; `ZiaLpAdapterV4.sol:343-345,378-381`

- `LpExit.zapOut` enforces full liquidity → `ZiaLpAdapterV4.zapOut` **always burns the NFT** (`:344`). Immediately after, `LpExit.sol:342` calls `lpAdapter.liquidityOf(tokenId)` (post-check `!= 0`), and `purgeLpNft` calls `liquidityOf` again (`LpEntry.sol:692`).
- `ZiaLpAdapterV4.liquidityOf` (`:379`) calls `NFPM.positions(tokenId)` directly with **no try/catch**. Canonical UniV3 periphery **reverts `'Invalid token ID'`** on a burned token (the spec's own E.4.13b acknowledges these semantics).
- Tests pass **only because** `MockZiaLpAdapter.liquidityOf` reads a separate mapping and returns 0 after burn.

**Runtime failure:** on real mainnet, **every `zapOut` and `burnLp` reverts after the burn step**. No funds lost (owner-only rescue still exists), but the exit lifecycle + accounting cleanup are bricked, and the contracts are non-upgradeable.

**Fix direction:** wrap `positions()` in a try/catch inside `ZiaLpAdapterV4.liquidityOf` and **return 0 for a burned token**; or capture liquidity before the burn and drop the post-burn read. **Mandatory: add a revert-on-burned mock NFPM** and re-run the zapOut/burnLp tests before mainnet.

### B4 — Pause locks the exit path (spec violation)
**Severity: HIGH (spec violation — availability). File:** `PolicyVaultV4LpExit.sol:107-115` + the 6 exit fns `:262/310/365/430/484/534`

- All six exit functions (`unstakeLp`,`zapOut`,`decreaseLiquidity`,`collectFees`,`burnLp`,`sweepToken`) use `executorActive` (modifier checks `!paused && !executorRevoked`).
- The spec is explicit and repeated (`vault-v4-plan.md:214,257,260`, A.4.4, F.8): exits must use `onlyExecutorNotRevoked` — "pause does NOT block exits; only `revokeExecutor` is the hard kill switch." The "exit still runs while paused" test was **never written**.

**Runtime failure:** a user panic-pauses all three thirds (the UI pauses them together) during a market event → the agent **cannot exit / de-risk** until unpause. This is exactly the exit-lockup the spec set out to avoid.

**Fix direction:** replace `executorActive` with a revoke-only gate on the six exit functions; add the A.4.4/F.8 test.

### B5 — Trading (swap) buy/sell executed against the wrong third
**Severity: CRITICAL (functional). Files:** `lib/agent/single-agent-server.ts:312,347`; `lib/agent/trade-service.ts:74,243`; swap executor `lib/executor/policy-vault-trade.ts`

- The swap executor takes `input.vault` and reads `executor`/`proofRegistry`/`adapter`/`policy`/`allowedTokens`/`allowedPools` and calls `buy`/`sell` on that address (`policy-vault-trade.ts:307-315,430,498`).
- Callers pass `vaultAddress: vault.vault` (`single-agent-server.ts:312,347`) and `workspace.vault.vault ?? workspace.agent.deployment.vault` (`trade-service.ts:74,243`). For a V4 agent, `vault.vault` = **LpEntry** (§B1/B2). LpEntry has **none** of the swap functions/state (`buy`, `sell`, `allowedTokens`, `positionUnits`, swap `policy`).
- The Swap contract is at `deployment.v4SwapVault`, which the trade path **never** resolves.

**Runtime failure:** V4 trading agents cannot buy or sell — the executor either reverts on the missing selector or reads garbage. Confirmed by grep; the detailed end-to-end trace (which routes/reads are affected, resolver fallback, ABI/error decode) is in **§2a** below.

**Fix direction:** the trade path must resolve `v4SwapVault` (not `vault.vault`) for V4 agents and use `policyVaultV4SwapAbi`; apply the same per-third rule as B1. See §2a for the full route/read list.

---

## 2a. Trading agent (swap) path on V4 — detailed

**Net conclusion: the V4 swap path is non-functional end-to-end.** For a V4 owner the workspace's canonical `vault.vault` is the **LpEntry** address (`single-agent-server.ts:1087`), and the entire swap surface (preview, quote, execute, position reads, log reads) consumes `vault.vault`/`deployment.vault` as the swap target. `v4SwapVault` is computed and stored in the snapshot/record (`:1088`) but **no swap code path ever selects it**. Every V4 buy/sell targets a contract that has none of the swap functions. This is a single architectural miss (thread `v4SwapVault` through the swap consumers), not many independent patches — but it manifests as ~8 distinct failures:

**T1. CRITICAL — canonical `vault.vault` = LpEntry for V4.** `single-agent-server.ts:1087` (and the chain-mismatch branch `:773`). The swap executor's single source of truth for the swap contract is LpEntry. **Fix:** swap consumers must read `v4SwapVault`, or the workspace must expose the Swap third to swap consumers.

**T2. CRITICAL — preview throws for every V4 agent → route returns 502.** `trade-service.ts:344` (`buildMainnetTradePreview` sets `vaultAddress = workspace.vault.vault` = LpEntry) → `quoteCuratedTrade` → `readVaultState` (`curated-trade.ts:665-682`) reads swap-only selectors (`adapter`, `allowedTokens`, `policy`, `minOutBpsFor`, `dailySpent0G`, `lastTradeAt`, `openExposure0G`) on LpEntry → those selectors don't exist → `Promise.all` rejects → the copilot/agent trade routes return 502 "trade route is unavailable." (Verified.) **Fix:** resolve `v4SwapVault` for V4 and pass it as the quote/exec vault.

**T3. CRITICAL — execute reverts on the wrong third.** `trade-service.ts:115-124` passes `preview.vaultAddress` (LpEntry) to `executeCuratedTrade`, which reads `vaultActionHashFor(bool,TradeRequest)` and calls `buy`/`sell` on LpEntry (`curated-trade.ts:332-376`) — none of those selectors exist there. **Fix:** target the Swap third.

**T4. CRITICAL — swap sells entirely unsupported for V4.** `app/api/copilot/trade/route.ts:205-217` reads `agentPositionUnits`/`positionUnits` against `workspace.vault.vault` (LpEntry) → revert → caught as non-`AgentTradeError` → 502. Combined with T8 (`sellablePositions` hardcoded `[]`), V4 agents cannot sell at all. **Fix:** read position units from `v4SwapVault`.

**T5. HIGH — the swap-op activation/fallback rule is not wired (same dead code as H1).** `resolveActiveVaultForOwner` (`mainnet-vault-resolver.ts:236-256`) computes `swapActive`/`lpActive` and the V3/V2 fallback set but is imported only by `v4-status`/`migrate-v4/plan`/docs — **never by `trade-service.ts`, `curated-trade.ts`, `worker.ts`, or any trade route.** The trade path has no V4 awareness at all. **Fix:** have the swap resolver consume `resolveActiveVaultForOwner` and pick `swapVault` when `swapActive`, else fall back to V3/V2.

**T6. HIGH — version-detection heuristic misfires on LpEntry.** `curated-trade.ts:285-292,332-337`: `vaultSupportsAgentKeys` probes `agentOpenPositionCount` (absent on LpEntry → `false`), while `isAgentKeyEnabled` probes `agentKeyEnabled` (present on LpEntry, and the deploy loop enables the key there → `true`) → yields `supportsAgentKeys=false` but `isV2=true`, then `vaultActionHashFor` reverts. **Fix:** resolve the Swap third up front; do not infer version by probing an arbitrary vault.

**T7. HIGH — trade audit log reads the wrong third.** `single-agent-server.ts:2115-2128` reads `TradeExecutedV2`/`TradeExecuted` from `deployment.vault` (= LpEntry, set at `:635`). LpEntry never emits swap trade events → V4 agents show an empty swap trade history even after successful swaps. **Fix:** read swap logs from `deployment.v4SwapVault` when `vaultVersion === 4`.

**T8. MEDIUM — `sellablePositions: []` hardcoded for V4 + `hasAgentOpenPositions` misreads.** `single-agent-server.ts:1086`. The trading worker's `buildSellCandidates` (`worker.ts:328`) needs `vault.sellablePositions` to ever sell; with `[]` it never sells for V4. `hasAgentOpenPositions` (`:2596`) runs against LpEntry (`agentOpenPositionCount` missing → falls back to `readSellablePositions` on LpEntry → `agentPositionUnits` missing → revert → `false`), so the pause/remove "still has open positions" guard misreads V4. **Fix:** populate `sellablePositions` from `v4SwapVault` via `readSellablePositions(client, swapVault, { agentKey })`.

**T9. MEDIUM — trade routes leak raw viem errors (RPC/quiknode URL).** `app/api/agent/trade/quote/route.ts:46` and `app/api/agent/trade/execute/route.ts:59` return raw `error.message` from `curated-trade` (embeds the RPC endpoint + revert internals). Contrast `copilot/trade/route.ts:106`, which collapses non-`AgentTradeError` to a generic message (correct). Note `worker.ts:495` `sanitizeError` strips only `sk-`/`mk-` keys, not RPC URLs. **Fix:** map to a generic client message; log detail server-side only. (Same class as H10.)

**T10. LOW — dead `lib/executor/policy-vault-trade.ts` uses the V1 TradeRequest layout (12 fields, no `agentKey`).** `:96-109`. Not on the live path (curated-trade.ts is the real executor), but if ever wired for V4 it would mis-encode the TradeRequest and hit the wrong third. **Fix:** delete or rewrite against `policyVaultV4SwapAbi` + Swap-third resolution before any use.

**T11. LOW — `policyVaultV4SwapAbi` has no `error` entries** (`lib/contracts/policy-vault-v4.ts:107-171`). Works today only because decoding reuses the byte-identical V2 error ABI — a hidden dependency. **Fix:** add the V4 error entries (same as H5).

**Verified-correct on the swap path (do not touch):**
- TradeRequest struct order matches: `PolicyVaultV4Swap.sol:27-41` == `policyVaultTradeRequestComponents` (`vault-policy-shapes.ts:32-46`) == V2 request ABI, all 13 fields with `agentKey` at index 7. V4 is byte-identical to V2, so the executor would encode correctly **if it targeted the Swap third**.
- Deploy-time key enable turns the agentKey on for all three thirds including Swap (`single-agent-server.ts:597-601`) → `swapActive` would be true; the bug is address selection, not authorization.
- Copilot trade route auth is sound: `validateCopilotWalletGate` + `validateVaultOwnerAccess` (`copilot/trade/route.ts:72-88`) require a signed gate and enforce vault-owner == connected wallet; `wallet-gate.ts` signature verification is correct (expiry, nonce, message-match, `verifyMessage`).
- V4 snapshot **display** fields (`readV4LpVaultSnapshot:1050-1094`) correctly read `dailySpent0G`/`policy`/`openExposure0G`/`adapter`/balance from the **Swap** third — only the canonical `vault` pointer and downstream execution consumers are wrong.

**Swap-path watch-list:**
- `readVaultSnapshot` calls `resolveMainnetV4VaultForOwner` with `agentKey=undefined` (`:765`) so `swapActive`/`active` are always false there — confirm nothing gates swap readiness on that always-false flag once T5 is wired.
- `curated-trade.ts:260` falls back to `vaultOf(runtime, proofAccount.address)` (the deployer's **V2 factory** vault) when no `vaultAddress` is supplied — a V4 user with no resolved swap vault could silently execute against the deployer's V2 vault. Ensure `vaultAddress` is always supplied.
- `mintAgent` binds the identity to `readyVault.vault` (= LpEntry for V4, `:566`) — proof/identity binding points at LpEntry, not the Swap third; verify this is intended for proof acceptance on swap trades.

---

## 3. High — address before public (agent-reported, high confidence)

### H1 — The V4 activation rule ("all three thirds enabled") is not wired; `resolveActiveVaultForOwner` is dead code
`lib/agent/mainnet-vault-resolver.ts:236-256` (no callers), `single-agent-server.ts:764-782`.
`readVaultSnapshot` switches the whole workspace to V4 **the moment the registry `vaultOf` returns a trio** — it never reads `agentKeyEnabled` on any third, and there is no per-operation fallback to V3/V2. An owner mid-migration (trio registered, keys not yet enabled on one or more thirds) sees the UI/worker pivot to V4: V3 balances/positions vanish, execution runs against a vault whose agent key is disabled → `InvalidAgentKey` reverts.
**Fix:** have `readVaultSnapshot` pass the agent key and honor `swapActive`/`lpActive` per-op as the spec requires; delete or actually use `resolveActiveVaultForOwner`.

### H2 — Swap-position reads target LpEntry → V4 swap positions invisible + wasted RPC
`single-agent-server.ts:377-384,917,2567-2621`. `agentPositionUnits`/`positionUnits`/`agentOpenPositionCount` only exist on `PolicyVaultV4Swap` but the code reads them on `vault.vault` (=LpEntry). The whole `Promise.all` rejects, `.catch(() => [])` hides it → sell flow blind, ~6 doomed reads per poll against the 52/min budget. (Overlaps B5.)
**Fix:** route these reads to `vault.v4SwapVault` when `vaultVersion === 4`.

### H3 — V4 triples the read burst; the quiknode client fast-fails → chronic `ready:false` flapping
`single-agent-server.ts:956-1012` (27 reads in one `Promise.all`), `:2386-2401` (`retryCount:0`, 4s timeout), `lp-workspace-load.ts:34-51` (up to 4 reloads), `lp-worker.ts:95,188` (workspace loaded 2-3× per cycle). One mint cycle ≈ 100-200 reads, far over ~52/min. A 429 → one read fails → the whole `Promise.all` rejects → "Unable to read Policy Vault state" → worker blocked, exit routes 409.
**Fix:** cache the trio + snapshot per tick, batch via multicall or stagger chunks, default the quiknode client to `retryCount>0`. (Related memory: `[[lp-quiknode-429-rate-limit]]`.)

### H4 — `resolveMainnetV4VaultForOwner(...).catch(() => null)` turns transient RPC errors into "no V4 vault" → version flapping
`single-agent-server.ts:764-766`; same `.catch(() => false)` for `agentKeyEnabled` at `mainnet-vault-resolver.ts:210-229`. A 429 on the registry read drops a V4 owner back to V3 for that cycle → the worker computes dedup/balance/exposure against the **wrong vault** → can mint a duplicate-pool position.
**Fix:** distinguish "registry returned zero" from "read failed" — propagate the failure as `ready:false` instead of falling through to V3.

### H5 — No `error` entries in any policy-vault ABI → V4/V3 custom errors never decode; the retry classifier is dead
`lib/contracts/policy-vault-v4.ts` (0 error entries; V3 and base too), `lp-fallback.ts:29-50`. Reverts surface as raw selector hex → `isRetryableLpMintError` matches nothing → the multi-pool fallback never triggers on `LpInvalidMinOut`/`LpBadDelta`; users see opaque errors instead of "LP daily cap exceeded".
**Fix:** append the error fragments from `LpEntry.sol` / `LpExit.sol` / `Swap.sol` to the respective ABIs (viem then decodes `errorName`), and key the classifier on those names. **This is also why many bugs above surface as "execution reverted" and are hard to diagnose — fix this first.**

### H6 (UI) — A partial V4 deploy is a permanent, gas-burning dead end
`useWalletPolicyVault.ts:423-565,1181-1312`; `VaultRegistryV4.sol:22-50` reverts `AlreadyRegistered` on the second registration. The 7-tx flow (3 deploys → 3 registers → setLpExitVault) has **no resume path**. If the user rejects/loses tx 5 of 7 → a retry **redeploys all three contracts**, then `registerLpEntry` reverts `AlreadyRegistered` → every retry burns 3 deployments and fails; the trio can never complete. `readRegistryV4Trio:1322` treats partial registration as "no trio."
**Fix:** read `swapVaultOf/lpEntryVaultOf/lpExitVaultOf` individually before deploying; reuse already-registered thirds; skip completed steps; persist deployed-but-unregistered addresses (localStorage) to resume.

### H7 (UI) — No `receipt.status` check anywhere → reverted txs count as success
`useWalletPolicyVault.ts:1515-1541,1613-1630`. `writeAndWait` sends without simulation (`chain:null`) and only waits for a receipt; a mined-but-reverted `registerLpEntry`/`setLpExitVault`/`importLpNft`/`depositNative` is treated as success ("V4 trio created" on a broken trio). `waitForReceipt` returns `null` after ~90s and that is also treated as success. Geth-style receipts populate `contractAddress` even for reverted creations → a code-less address feeds the next constructor.
**Fix:** everywhere assert `receipt.status === "success"`, throw on timeout instead of returning null, simulate before owner txs. (Same class at `useAgentOwnerControls.ts:253-265`.)

### H8 (UI) — Pause/Remove for a V4 agent toggles the key on only 1 of 3 vaults
`LpAgentDetailPage.tsx:135-150` never passes the trio to `useAgentOwnerControls` (though the V4 branch exists at `:117-126`). For V4, Pause/Remove call `setAgentKeyEnabled(false)` on `deployment.vault` only. After Remove, the key stays enabled on the other two thirds **permanently** (executor-compromise blast radius). In the multi-user case (deployer ≠ owner), the owner can **never enable all three thirds** from the UI → the resolver (needs all three) never activates the agent.
**Fix:** pass `v4SwapVault/v4LpEntryVault/v4LpExitVault` into the hook; guard so `vaultVersion >= 4` with a missing trio throws instead of silently writing one vault.

### H9 (UI) — Owner safety controls only reach the Swap third
`VaultSurface.tsx:201-209` + `VaultActionPanel.tsx`. For V4, `walletVault.vaultAddress = swapVault`; the panel is single-address → Pause pauses only Swap, Revoke revokes only Swap's executor, Withdraw/deposit/balance are Swap-only. There is **no control** to pause/revoke/withdraw/rescue LpEntry/LpExit — which hold the NFTs + native. Violates the "pause both LP thirds together" invariant. A user who hits Pause believes the whole vault is stopped while the LP executor path stays live.
**Fix:** make `VaultActionPanel` V4-aware: accept the trio, fan pause/revoke out to all three (sequential txs, honest per-third status), add LpEntry/LpExit withdraw+rescue controls, sum/itemize balances across thirds.

### H10 (API) — Raw viem errors leak the RPC URL (quiknode key) to clients
`v4-status/route.ts:28`, `v3-status:33`, `migrate-v4:117`, `migrate-v4/plan:115`, `migrate-v3:122`, `withdraw-native:146`, the LP mint/stake/unstake/zap-out catch-alls, `lp/pools:64-68` — all pass `error.message`. viem `HttpRequestError` **embeds the full transport URL**; `OG_RPC_URL` (quiknode) carries its API key in the path.
**Fix:** map unknown errors to generic messages server-side; log details, return code-only errors; scrub URLs from any surfaced provider message. (Violates AGENTS.md "sanitize upstream errors.")

### H11 (API/migration) — Single-slot migration state file destroys crash-recovery data when a second vault migration starts
`vault-migrate-v4.ts:53,1189-1197`. One global `vault-migrate-v4-state.json`; a run for a different `oldVault` **overwrites** the prior vault's state. `LEGACY_V3_VAULTS` has 4 vaults → sequential migration is the expected use. Vault A crashes after `withdrawNative` (recovery depends on the persisted `intendedWithdrawWei`), the operator migrates B → resuming A re-inits fresh state → `withdrawnAmount0G="0"` → deposit skipped → retire's aggregate check passes (`expectedDeposit=0`) → reports "executed" while A's withdrawn native **sits unnoticed on the DEPLOYER EOA**.
**Fix:** key the state file per oldVault (`vault-migrate-v4.<vault>.json`), or refuse to init a new vault while another has an unfinished native hop.

### H12 (API/migration) — `finalizeWalletOwnedV4Migration` trusts client-supplied `sourceVersion`, skipping NFT-import verification
`vault-migrate-v4.ts:1109-1129` runs inventory + `assertImported` only when `input.sourceVersion === 3`; the route (`migrate-v4/route.ts:38`) takes `sourceVersion` from the body and never verifies it against the source contract. A client passing `sourceVersion:2` for a V3 source gets the roster repointed + migration marked retired with LP NFTs never imported (stranded in the paused V3). `inventoryHash`/`planHash` in the consent are never recomputed server-side.
**Fix:** derive `sourceVersion` server-side (probe V3-only selectors / the registry), compare the client hash to the live inventory hash, 409 on mismatch.

---

## 4. Medium — should fix, not demo-blocking

- **M1 (contract F4) — Ghost notional from `decreaseLiquidity` rounding.** `LpExit.sol:408-409` frees native pro-rata `deployed*liq/totalLiq`, flooring down on each partial decrease → `openLpExposure0G`/notional retains a residual forever (only cleared by `purgeLpNft`, which B3 blocks on mainnet) → new entries hit `LpExposureExceeded` prematurely. **Fix:** on full decrease (`liquidity==totalLiq`) free the entire recorded amount instead of the pro-rata floor.
- **M2 (contract F3/F7) — Compromised executor can burn value via uncapped exits.** `zapOut`/`sweepToken` accept `quotedAmountOut==0` → effective min-out is 1 wei; the adapter's internal swaps run `amountOutMinimum:0` (`ZiaLpAdapterV4:346,173,222`). No direct theft (recipient=vault) but MEV/sandwich extracts nearly all value. **Fix:** forbid `quotedAmountOut==0` on zapOut/sweep; pass a non-zero min-out into the adapter's terminal swap.
- **M3 (server) — LP deploy on a genuinely user-owned trio always fails AFTER the irreversible AgenticID mint.** `single-agent-server.ts:593-618` only enables the key when `deployerIsVaultOwner`; `lp-deploy.ts:178-187` throws `agent_key_not_enabled` 409 otherwise. Multi-user: the mint tx lands, deploy 409s → **orphaned identity + wasted gas.** **Fix:** return a "keys pending owner enable" record, let the UI drive the three wallet signatures, then re-verify all three thirds.
- **M4 (server) — Env-override owner pinning persists (the documented V3 defect V4 was meant to close).** `lp-worker.ts:141,191` `config.ownerAddress ?? deployment.owner`; with the env set + `--all-agents`, the gating snapshot resolves for the env owner while execution targets `deployment.vault` → gating and execution disagree. **Fix:** prefer `deployment.owner` for per-agent loads; use `config.ownerAddress` only for the initial roster query.
- **M5 (server) — Server withdraw path is V3-only.** `mainnet-vault-withdraw.ts:63` only calls `resolveMainnetV3VaultForOwner`; a V4 owner gets `v3_vault_not_found` or withdraws from a stale V3. `withdraw-native/route.ts` inherits this. **Fix:** resolve the trio and withdraw per third, or explicitly reject with "use the wallet withdraw."
- **M6 (API) — Action-nonce store is racy (TOCTOU) and evictable by an attacker.** `action-nonce-store.ts:98-104` consume is a non-atomic read→delete→write → two concurrent requests with the same signed consent can both pass → a funds-moving action runs twice. Issuance is unauthenticated (`action-consent/nonce/route.ts`) + evicts oldest above 500 → spam 500 issuances to evict a victim's nonce. **Fix:** serialize consume (mutex + atomic rename), rate-limit issuance, evict by expiry.
- **M7 (API) — `agents/status|remove|migrate-vault` accept the replayable Copilot-access signature.** They use `validateCopilotWalletGate` (no nonce, no expiry). Anyone who captures one chat request can replay it to pause/arm/remove agents. **Fix:** move to the action-consent pattern (scoped nonce + expiry) like the LP routes.
- **M8 (API) — Unauthenticated snapshot route exposes any agent's workspace.** `[id]/snapshot/route.ts:26-45`: `wallet` is optional; without it the roster is unfiltered and falls back to `deployment.owner`, returning balances/positions/policy for guessable sequential ids. **Fix:** require the wallet param (or a signed gate), 404 on owner mismatch.
- **M9 (UI) — Migrate-to-V4 is not resumable after registration; the panel disappears mid-failure.** `useWalletPolicyVault.ts:1017,884-886`. `migrateToV4` sets `v4SwapAddress` as soon as the trio registers (before NFT preservation / native move / finalize) → `v4MigrationAvailable=false` reactively → the panel unmounts **while it is still failing.** Any failure after registration strands the user (V3 still holds funds, agents still point at V3, no migrate button on reload). **Fix:** gate `v4MigrationAvailable` on "legacy still has funds/NFTs or agents point at it"; keep the panel mounted while migrating/errored.
- **M10 (UI) — No V4 risk-limit controls or policy visibility.** `VaultSurface.tsx:139,436-551`. The policy picker only renders when non-mainnet; on mainnet V4 is always created with hard-coded defaults, the caps the user agrees to are never shown, and there is no post-create policy display or tighten control. Violates AGENTS.md. **Fix:** reuse the policy form for V4 create + a read-only policy panel for the trio.
- **M11 (UI) — Real positions render a mock-derived "current tick."** `LpPositionCard.tsx:263-273` calls `findMockPoolByAddress` for **real** agents; if the pool address matches the mock table, the tick bounds + current-tick marker come from mock data presented as live. Violates "the UI never lies." The status pill always says "In range." **Fix:** use the mock table only when `isMockAgent`; otherwise read on-chain slot0 or hide the marker.

---

## 5. Low / cleanup

- **L1 (contract F5)** — `setLpExitVault` (one-shot) can be permanently bricked if the registry/candidate owner drifts; no reset. Document + test the clean-revert path; consider allowing owner re-set while LpExit holds no NFTs.
- **L2 (server)** — `runTightenPolicy` calls V3 `tightenPolicy(Policy)` — a selector that exists on no V4 third (V4 uses `tightenLpPolicy`, also missing from the ABI). Fenced by `deprecated_step` today, but the export is still live for the policy route.
- **L3 (server)** — `scripts/lp-mainnet-v4-smoke.ts` is a **stub** that only prints "registered" and exercises nothing. Do not treat it as a smoke gate.
- **L4 (server/API)** — `.env.example` drift: the code reads `OG_RPC_RETRY_COUNT`, `OG_RPC_RETRY_DELAY_MS`, `OG_PUBLIC_RPC_URL`, `OG_PUBLIC_RPC_RETRY_*`, `OG_AGENT_WORKSPACE_DEBUG`, `OG_AGENT_LP_WORKER_DEBUG`, `OG_LOG_CHUNK_BLOCKS` — **none are in `.env.example`.** Operators cannot discover the 429-mitigation knobs. (Env-name drift is a recurring bug class in this repo — see memory `[[cmc-mcp-wiring]]`.)
- **L5 (API)** — `migrate-v3/route.ts:80-95` consumes the single-use nonce before validating `confirmedSteps`. `v4-status/route.ts:9` casts `agentKey` with no hex/length validation. `agents/remove/route.ts:63` checks `agentKeyEnabled` on one vault only for V4.
- **L6 (UI)** — `LpAgentSidebar.tsx:93` hard-labels "Policy Vault V3" even for V4 agents. `LpPositionsWorkspace.tsx:44-60` leaves other cards clickable while one action is pending → collides with executor nonces + the 429 budget. `useLpActionRequest.ts:37-48` uses the app-selected chainId (possibly testnet 16602) for the consent → the mainnet-only server rejects it. `LpAgentCreateWorkspace.tsx:396` collects a fallback LLM model but never sends it.

---

## 6. What is CORRECT (do not touch while fixing)

- Struct order matches: `TradeRequest`(13), `LpActionRequest`(24), Swap `Policy`(6, `uint16 defaultMinOutBps`), `LpPolicy`(7, `uint16 lpMinOutBps`) — verified field-by-field TS↔Solidity, **no mismatch.** UI deploy sites match constructor arg order + `allowMock=false` + registry.
- Recipient pinned to `msg.sender` on every adapter path (`ZiaLpAdapterV4:190,267,284,338,363`), rejects `vaultAddress != msg.sender`. No arbitrary calldata pass-through.
- Mock adapter rejected on chainid 16661 (all three vault constructors + the adapter).
- Swap error ABI is **byte-identical to V2** (`PolicyVaultV2:42-63 == Swap:43-64`); V4 `sell` correctly drops the agentKey gate per the documented intentional divergence.
- `collectFees` requires both mins >= 1; entries (`zapInMintLp`/`zapInIncreaseLiquidity`/`stakeLp`) enforce cooldown; sweepToken on LpExit has no cooldown — **matches spec.**
- Registry `vaultOf` re-verifies `owner()` on read (anti-spoof); one-shot register prevents overwrite.
- Consent nonce (`actionConsentNonce.ts` + `action-nonce-store.ts`): single-use, scope+address-bound, 5-min TTL — logic is sound (race caveat = M6).
- `deploySingleOgAgent` **does** enable the key on all three thirds when deployer==owner → the old root cause `[[agent-key-enable-on-deploy]]` is handled for the demo path.

---

## 7. Suggested action plan (by deadline)

**Must do first if demoing on mainnet (requires a contract redeploy):**
1. **B4** — change the 6 LpExit exit modifiers from `executorActive` to a revoke-only gate. (~10 min, redeploy)
2. **B3** — `ZiaLpAdapterV4.liquidityOf` try/catch → return 0 on burned; add a revert-on-burned mock NFPM + re-run zapOut/burnLp tests. (half a day)
3. Consider bundling **M2/F3** (forbid `quotedAmountOut==0` on zapOut/sweep) into the same redeploy — cheap, closes the compromised-executor vector.

**Server/TS (no redeploy — deploying the app is enough):**
4. **B1 + B5** — route LP exit actions to LpExit and swap buy/sell to `v4SwapVault`, with per-third ABI/preflight. (highest server priority)
5. **B2** — fix `repointRoster` field names + `record.vault=lpEntryVault`.
6. **H1/H4** — wire the all-three-enabled rule + distinguish read-fail from zero.
7. **H5** — inject error fragments into the ABIs so reverts decode (**do this early — it makes every remaining bug diagnosable**).
8. **H2/H10** — swap-position reads to `v4SwapVault`; scrub the RPC URL from client errors.

**UI:**
9. **H7** — assert `receipt.status` across the deploy/migrate pipeline (stop "revert = success").
10. **H6/H8/H9** — resume partial deploys + fan owner-controls out to all three thirds.

**Before real public (record as debt if it slips the deadline):**
11. Write the full V4 adversarial test set: reentrancy (`MaliciousZiaLpAdapterV4`), malicious adapter/ERC20, cap/cooldown bypass (fixture must use bounded policy), pause-blocks-entries-not-exits, mock-rejected-on-mainnet-chainid.
12. **H11/H12** — per-vault migration state + server-side `sourceVersion` verification.
13. **M6/M7/M8** — auth for the snapshot/status/remove routes + atomic nonce.

---

## 8. Principles while fixing (to avoid new bugs)

1. **Always ask "which third does this action belong to?"** before every call. Build a canonical table: entry→LpEntry, exit→LpExit, swap→Swap, and force every TS read/write to follow it. Most V4 bugs are violations of this table.
2. **Do not cast a record to `Record<string, unknown>`** — it disables the type-checker, which is exactly how B2 slipped past a green build. Use a typed helper for roster records.
3. **Mocks must reproduce mainnet revert behavior** (NFPM revert-on-burned), or green tests still brick in production (B3).
4. **Green tests ≠ correct** when the fixture is unbounded and mocks hide behavior. Caps/cooldown/pause/reentrancy need real tests to be trusted.
5. **Close H5 (ABI error decode) first** — without it every other bug surfaces as "execution reverted," dragging out diagnosis.
6. **429 is an architectural constraint, not flake** — V4 tripled the reads; caching/multicall/staggering must be the default, not retry-in-a-loop.
7. Update memory after fixing: `[[vault-v4-plan-status]]`, `[[lp-vault-v3-deploy-gaps]]`, `[[agent-key-enable-on-deploy]]`.

---

*Based on a read-only, multi-pass parallel review. Blockers B1–B5 were verified against `file:line`. High/Medium/Low findings are agent-reported with high confidence — verify each against its cited `file:line` before editing.*
