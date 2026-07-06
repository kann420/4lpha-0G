# LP Agent â€” Handoff to Codex (real-money testing)

> Handoff from Claude CLI (session `15daba97-0e4a-422c-83b7-a0bf0a601b22`, branch
> `codex/copilot-session-durable-registry`). Claude is low on tokens; Codex takes
> over. Source-of-truth plan: `C:\Users\admin\.claude\plans\wiggly-forging-moore.md`
> (codex-audited, gpt-5.5 xhigh, findings folded + marked `[audit]`).

## What is already built (Phase A â†’ B â†’ D, C dropped)

All 12 implementation steps in the plan are **code-complete and committed to the
working tree (uncommitted)**. Verification already green:

- `npx tsc --noEmit` â€” clean
- `npm run build` â€” clean; routes `/api/agents/lp/[id]/automation|stake|unstake|zap-out`, `/api/vault/withdraw-native` listed
- `npx hardhat test test/PolicyVaultV3.ts` â€” 10 passing, 1 skipped
- `npx tsx scripts/lp-fence-check.ts` â€” all smoke checks pass
- LP worker dry-run: `node --conditions=react-server --import tsx scripts/og-agent-lp-worker.ts --once --all-agents --dry-run` â€” clean JSON, 0 agents processed (wiring proven, no on-chain writes)

Phase summary:
- **A** autonomous mint loop: `OgAgentRuntimeSettings.automation.autoMint` + `setAgentAutomation` + `/api/agents/lp/[id]/automation` + `lib/agent/runtime/lp-store.ts` + `lib/agent/runtime/lp-worker.ts` (`runLpAgentWorkerOnce`) + `scripts/og-agent-lp-worker.ts` + `start-production.mjs` wiring + `LpAutoMintToggle` UI + A8 pre-proof drift guard (`executeMainnetPolicyVaultLpAction`, 200 bps, throws `quote_drift` before `acceptProof`).
- **B** manual exits: `/api/agents/lp/[id]/stake|unstake|zap-out` + `runLpExitForAgent` (`lib/agent/lp/lp-exec.ts`) + `quoteLpZapOut` (`lib/agent/lp/lp-zapout-quote.ts`, mirrors adapter: decreaseLiquidity â†’ swap non-W0G leg â†’ unwrap â†’ native out) + UI state-disambiguation + live snapshot.
- **D** owner withdraw: `/api/vault/withdraw-native` + `withdrawMainnetVaultNative` (`lib/agent/mainnet-vault-withdraw.ts`) + `LpWithdrawNativeDialog` UI.
- **C** dropped: ERC-7857 stays identity-only (matches trading agent; `authorizeUsage`/`revokeAuthorization`/`delegateAccess` not called â€” shared documented gap).

## What is NOT done (Codex continues here)

Code-complete â‰  live-mainnet-ready. The 3 parts below must happen before any
real-0G test. **None of these were executed or verified on mainnet in this
session.**

---

## Phase 0 â€” Audit the B4 + D1 + D2 diff (READ-ONLY, do this FIRST)

Before continuing, independently audit the diff just shipped. Claude's self-audit
is below; Codex should verify independently and look for funds-loss paths it
missed.

### Audit scope (files)

B4 (UI live snapshot + per-card exit wiring):
- `components/agents/lp/LpAgentDetailPage.tsx` â€” rewritten: live snapshot fetch (`GET /api/agents/lp/[id]/snapshot`), mock fallback on 404/no-wallet, stake/unstake/zap-out via `useLpActionRequest`, `pendingAction` per `${tokenId}:${action}`, refresh after success, owner-only "Withdraw 0G" button + dialog.
- `components/agents/lp/LpPositionsWorkspace.tsx` â€” `onStakePosition`/`onUnstakePosition`/`onZapOutPosition` + `allowStaking` + `pendingAction` parsing.
- `components/agents/lp/LpPositionCard.tsx` â€” state-disambiguated buttons (stakedâ†’Unstake; !staked && allowStakingâ†’Stake; !stakedâ†’Zap out to 0G), `busy(action)` disables.
- `components/agents/lp/useLpActionRequest.ts` â€” NEW (84 lines): signs action-specific consent (`lp-stake`/`lp-unstake`/`lp-zap-out` + vault + agentId + tokenId + nonce + 5-min expiry) and POSTs.

D1 (owner withdraw route + helper):
- `app/api/vault/withdraw-native/route.ts` â€” NEW (124 lines): `validateCopilotActionConsent` action `vault-withdraw-native` + `vault` + `amount0G` + nonce + expiry; `ENABLE_MAINNET_WITHDRAW=true` gate; `confirmedSteps:["withdraw-native"]` gate; `resolveMainnetV3VaultForOwner`; delegates to helper.
- `lib/agent/mainnet-vault-withdraw.ts` â€” NEW (214 lines): DEPLOYER signs `withdrawNative([amountWei])`; on-chain `vault.owner === DEPLOYER` check (`signer_not_owner` 500); `vault.owner === input.owner` (403); `paused` check; `balanceBefore >= amount`; `simulateContract`+`writeContract`+`waitForReceipt`; returns `{txHash, amount0G, balanceBefore0G, balanceAfter0G}`.

D2 (withdraw UI):
- `components/agents/lp/LpWithdrawNativeDialog.tsx` â€” NEW (199 lines): modal with amount input + explicit "real gas / real funds" confirm checkbox; signs action-consent; POSTs `confirmedSteps:["withdraw-native"]`; toasts tx hash + refresh snapshot.
- `components/agents/lp/LpAgentDetailPage.tsx` â€” withdraw button (owner-only, `address === vaultOwner`) + dialog wiring.

Plus: `.env.example` â€” `ENABLE_MAINNET_WITHDRAW=false` documented.

### Claude self-audit (Codex: verify + look harder)

Ranked most-severe first. Verdicts are Claude's own; Codex should confirm or refute.

**[MEDIUM-HIGH] withdraw-native has a 5-min consent replay window.**
`validateCopilotActionConsent` (`lib/copilot/wallet-gate.ts`) validates expiry + payload + signature but does NOT track nonce uniqueness (no server nonce store). The nonce is client-generated (`useLpActionRequest`, `LpWithdrawNativeDialog` â€” `crypto.getRandomValues(16)`). For mint/stake/unstake/zap-out the on-chain NFT state change (burn / stake / unstake) backstops a replayed consent â€” the second call fails because the NFT state moved. For **withdraw-native** there is NO on-chain backstop: `withdrawNative(amount)` is a bare native send to the owner with no on-chain nonce/replay tracking. A captured owner consent (request interception) can be relayed a second time within the 5-min TTL â†’ double withdrawal (if vault balance still sufficient). `confirmedSteps` is not signed, so it is not a replay defense.
- **Fix options (pick one):** (a) server nonce store â€” track `${owner}:${nonce}` as used until `expiresAt`, reject reuse; (b) single-use consent â€” mark the consent consumed after the first successful withdraw; (c) shorten TTL for withdraw to ~60s. (a) is the plan's original design ("Nonce = server-generated random per request, returned to the client") â€” the implementation deviated to client-generated. Recommended: restore server-generated nonce + server store for ALL funds-moving routes, prioritizing withdraw-native.
- **Note:** this same deviation affects stake/unstake/zap-out/automation but the on-chain state backstop makes them lower risk. Withdraw is the one with no backstop.

**[LOW] `parsePositive0G` missing the 18-decimal-digit guard.**
`lib/agent/mainnet-vault-withdraw.ts` `parsePositive0G` validates `^\d+(\.\d+)?$` but does NOT reject inputs with >18 fractional digits. The LP executor's `parse0G` (`lib/executor/policy-vault-lp.ts:572-587`) explicitly rejects >18 digits to avoid `parseEther` inflation/truncation edge cases. Mirror that guard in `parsePositive0G` before relying on `parseEther`.

**[LOW] LP exit consent does not bind `poolAddress`.**
`useLpActionRequest` signs over `tokenId` but not `poolAddress` (the consent message builder `buildCopilotActionConsentMessage` has no `poolAddress` field). Not exploitable today: the routes look up the position by `tokenId && poolAddress` match, so a spoofed `poolAddress` â†’ 404 (the real position's `poolAddress` is on-chain truth). Defense-in-depth: add `poolAddress` to the consent payload + builder + `validateCopilotActionConsent` expected shape.

**[LOW] Single `pendingAction` state across positions.**
`LpAgentDetailPage` tracks one `pendingAction` string. Clicking position B's button while position A is mid-flight overwrites the state and re-enables A's button. Not a funds risk (vault nonce + on-chain state prevent double-spend), but per-position pending (a `Set<string>` or per-tokenId state) would be cleaner UX.

**[INFO] Mock fallback + withdraw owner gate.**
When the live snapshot is null (no wallet / 404), `vaultOwner` falls back to the mock owner (`0xd7e0...`). `isVaultOwner` still requires a connected `address === vaultOwner`, so with no wallet the button is hidden. The route re-verifies owner server-side. Safe, but the UI may briefly show the button for the mock owner address if that exact address is connected â€” harmless because the server rejects.

### How Codex should run this audit

Read-only, no file changes:
```
node "C:/Users/admin/.claude/plugins/cache/openai-codex/codex/1.0.5/scripts/codex-companion.mjs" task "Audit the B4+D1+D2 LP diff for funds-loss risks. Files: components/agents/lp/LpAgentDetailPage.tsx, components/agents/lp/LpPositionsWorkspace.tsx, components/agents/lp/LpPositionCard.tsx, components/agents/lp/useLpActionRequest.ts, components/agents/lp/LpWithdrawNativeDialog.tsx, app/api/vault/withdraw-native/route.ts, lib/agent/mainnet-vault-withdraw.ts, lib/copilot/wallet-gate.ts, lib/copilot/wallet-access.ts. Focus: action-consent replay window for withdraw-native (no on-chain nonce backstop), nonce tracking, parsePositive0G 18-decimal guard, consent payload binding (poolAddress), pendingAction UX. Report CONFIRMED / PLAUSIBLE / REFUTED per finding with file:line. Do not edit files." --model gpt-5.5 --effort xhigh
```
Task-text rules: no backticks, no apostrophes, no `${}` (escape or avoid). Read-only (no `--write`).

---

## Part 1 â€” Verify on-chain vault config (mainnet, READ-ONLY first)

The V3 singleton + ZiaLpAdapter are deployed (memory `mainnet-v3-lp-deploy`).
**Not verified in this session:** whether the mainnet vault instance is
configured for LP. Check each via `readContract` against the V3 vault address
(`resolveMainnetV3VaultForOwner(owner)` or env `POLICY_VAULT_V3_MAINNET_ADDRESS`)
using `policyVaultV3Abi` (`lib/contracts/policy-vault-v3.ts`):

1. `lpAdapter()` â€” returns the ZiaLpAdapter address; must equal the deployed adapter. If zero, `setLpAdapter` was never called.
2. `allowedLpPools(poolId)` for each Zia pool the agent will mint into â€” must be `true`. `poolId = poolAddress` (how the vault keys the allowlist â€” confirm in `PolicyVaultV3.sol`). If false, `allowLpPool` / batch-enable must be called (owner-only).
3. `allowedStakeVaults(stakeVault)` + `stakeVaultForLpPool(poolId)` â€” for the stake path. Must be configured if `lpPolicy.allowStaking === true`.
4. `policy()` â€” returns the 7 on-chain `LpPolicy` fields (`perLpActionCap0G, lpDailyCap0G, maxLpExposure0G, cooldownSecondsLp, lpMinOutBps, minLiquidityFloor, allowStaking`). If these are zero/default, `tightenPolicy` (owner-only, cannot loosen) was never run. Use `deriveTightenPolicyCall` / `lp-fence-check` to compute the tightening calldata.
5. `proofRegistry()` â€” must be the deployed ProofRegistry; `isAccepted(...)` must work for the executor's proof anchoring.
6. `paused()` â€” should be `false` for live testing.
7. `executor()` + `executorRevoked()` â€” executor must be set and not revoked.
8. `agentKeyEnabled(agentKey)` for the LP agent's key â€” must be `true` (see Part 2).

**Output:** a written checklist with each read result + the calldata needed for
any missing config. Do NOT broadcast config txs without explicit user
confirmation per step (owner = DEPLOYER, real gas).

---

## Part 2 â€” Env + agent provisioning + vault funding

### Env (`.env.local` or deployment secrets) â€” required for execute mode

```
OG_NETWORK=mainnet
OG_CHAIN_ID=16661
OG_RPC_URL=https://evmrpc.0g.ai
ENABLE_MAINNET_DEPLOY=true
ENABLE_REAL_DEX_ADAPTER=true
ENABLE_MOCK_DEX_ADAPTER=false
MAINNET_ALLOW_MOCK_LP_ADAPTER=false
AGENT_TRADE_LIVE_ENABLED=true
DEPLOYER_PRIVATE_KEY=<owner, 0x-prefixed 32-byte>
VAULT_EXECUTOR_PRIVATE_KEY=<executor, 0x-prefixed 32-byte>
ZIA_TRADEGPT_API_BASE_URL=<partner endpoint, .env.local only, server-side only>
OG_COMPUTE_API_KEY=<0G Router key, sk- or mk- prefixed, NEVER NEXT_PUBLIC_>
OG_STORAGE_INDEXER_URL=https://indexer-storage-turbo.0g.ai
POLICY_VAULT_V3_MAINNET_ADDRESS=<deployed V3 singleton>
PROOF_REGISTRY_ADDRESS=<deployed ProofRegistry mainnet>
AGENT_IDENTITY_ADDRESS=<deployed AgenticID mainnet>
```

Autonomous mint test only:
```
OG_AGENT_LP_WORKER_ENABLED=true
OG_AGENT_LP_WORKER_EXECUTE=true
```

Withdraw test only:
```
ENABLE_MAINNET_WITHDRAW=true
```

**Security (carry-over, non-negotiable):** never expose Router keys via
`NEXT_PUBLIC_*` / browser / logs / fixtures; never commit secrets; never
hardcode private keys; never ask the user to paste secrets into chat (ask for
env var names); Zia partner endpoint URL stays in `.env.local` server-side only.

### Agent provisioning

1. Mint the LP agent via the existing deploy flow (`/api/agents/lp/deploy` or the create page) with `filters:["lp-zia"]` + an LLM model. This mints the AgenticID, binds it to the V3 vault, records the deployment in the registry, and uploads the 0G Storage audit root.
2. **`setAgentKeyEnabled(agentKey, true)`** â€” `mintAgent` does NOT flip this (memory `agent-key-enable-on-deploy`, root cause of "copilot can't trade"). Call it on-chain (owner = DEPLOYER signs) and record the tx hash. Verify with `vault.agentKeyEnabled(agentKey) === true`.
3. Toggle `autoMint` via `POST /api/agents/lp/[id]/automation` (owner action-consent) â€” OR leave it off and test manual mint first.

### Vault funding

`depositNative()` is `onlyOwner` and payable. Send a SMALL amount of 0G (e.g.
0.5 0G) from the DEPLOYER (owner) wallet to the vault via `depositNative{value:
amount}`. Verify with `getBalance(vault)` and `vault.balance0G` snapshot field.
**DEPLOYER pays gas; real funds.** Confirm the amount with the user before
broadcasting.

---

## Part 3 â€” Live test order (gated, small amounts, explicit user opt-in per step)

Run each step only after the user explicitly confirms. Small amounts (start with
the minimum the fence allows). DEPLOYER pays gas. Never auto-broadcast.

1. **Fund vault** â€” Part 2 deposit (0.5 0G or less). Verify `getBalance(vault)` + snapshot.
2. **Manual mint** â€” `POST /api/agents/lp/[id]/mint` (or `LpPositionsWorkspace` "Mint new NFT in this pool") with a small amount. Verify: LP NFT minted, `lpTxHash`, `proofTxHash` (ProofRegistry `isAccepted`), 0G Storage audit root retrievable, snapshot shows the position with `staked:false`.
3. **Stake** â€” `POST /api/agents/lp/[id]/stake`. Verify: NFT moved into the Zia stake vault, position `staked:true`, `stakeVault` set.
4. **Unstake** â€” `POST /api/agents/lp/[id]/unstake`. Verify: NFT back to vault, `staked:false`.
5. **Zap-out** â€” `POST /api/agents/lp/[id]/zap-out`. Verify: NFT burned, native 0G returned to vault, `openLpExposure0G` decreased, `amountOutMin > 0` honored (no zero-slippage). Check the `quoteLpZapOut` floor vs actual native received.
6. **Owner withdraw** â€” `LpWithdrawNativeDialog` (owner-only). Verify: native 0G sent to owner, `balanceAfter0G` reflects the delta. **Only after Phase 0 replay-window finding is resolved OR the user accepts the risk.**
7. **Autonomous mint (optional, last)** â€” `OG_AGENT_LP_WORKER_EXECUTE=true` + `autoMint=true`, run `node --conditions=react-server --import tsx scripts/og-agent-lp-worker.ts --once --execute`. Verify one mint within the fence + run record in `.data/agents/runtime/<agentId>-lp-runs.json` with `lpTxHash` + `proofTxHash`.

After each step: re-run `GET /api/agents/lp/[id]/snapshot` and confirm on-chain
state matches the UI. If a step reverts, capture the revert reason
(`PolicyVaultV3` reverts are explicit: `LpBadDelta`, `ZeroAmountOutMin`,
`CooldownActive`, `LpCapExceeded`, `MaxExposureExceeded`, `PoolNotAllowed`,
etc.) and stop.

---

## Hard constraints (carry over from AGENTS.md + plan + memory)

- **Vault deny-by-default:** no executor arbitrary call / delegatecall / multicall / raw calldata / arbitrary target or recipient; `amountOutMin = 0` forbidden; balance-delta checks around swaps; per-trade + daily caps + cooldown + nonce + deadline + max slippage bps + max exposure + pause + revoke executor + owner withdrawal.
- **Never auto-broadcast mainnet.** Every mainnet tx in this handoff requires explicit per-step user confirmation (real gas + real DEPLOYER funds).
- **DEPLOYER = vault owner** for the demo (V3 singleton, deployer-owned, `0xd7e0...` per memory). User == deployer. `depositNative`/`withdrawNative` are `onlyOwner`.
- **ERC-7857 mainnet only; transfer path disabled; never wire `MockAgentDataVerifier` as mainnet verifier.**
- **Zia partner endpoint URL:** `.env.local` only, server-side only, never committed.
- **Solidity 0.8.24 / cancun / viaIR.** (No contract changes in B4/D1/D2 â€” all TS/UI.)
- **Workspace docs local-only:** never commit `CLAUDE.md` / `AGENTS.md` (gitignored).
- **Codex audit:** `--model gpt-5.5 --effort xhigh` (NO spark); task text no backticks / apostrophes / `${}`; read-only for audits (no `--write`).

## Memory pointers (read these before continuing)

- `lp-autonomous-architecture` â€” full LP architecture + Phase A/B/D shipped details
- `mainnet-v3-lp-deploy` â€” V3 singleton + ZiaLpAdapter mainnet addresses; owner `0xd7e0` vs executor `0xf56b`
- `agent-key-enable-on-deploy` â€” `mintAgent` does NOT enable `agentKeyEnabled`; deploy must call `setAgentKeyEnabled(true)`
- `codex-plugin-cc-workflow` â€” codex-plugin-cc installed; gpt-5.5 xhigh; audit reviews code diff not plan docs, so audit AFTER implementing (done â€” audit Phase 0)
- `copilot-session-storage` â€” action-consent message format + 5-min TTL + client-side nonce note

## Verification commands (re-run after any change)

```
npx tsc --noEmit
npm run build
npx hardhat compile
npx hardhat test test/PolicyVaultV3.ts
node --conditions=react-server --import tsx scripts/lp-fence-check.ts
node --conditions=react-server --import tsx scripts/og-agent-lp-worker.ts --once --all-agents --dry-run
```

## Open known gaps (documented, not blocking)

- `claimRewards` reverts `RewardsNotConfigured`; Zia reward-claim / pending-reward API not yet available. "Claim rewards" UI stays disabled "coming soon".
- ERC-7857 `authorizeUsage`/`revokeAuthorization`/`delegateAccess` not called by either agent type (mint auto-authorizes executor internally). Shared gap, out of scope per user decision.
- Server nonce store for action-consent is future hardening â€” see Phase 0 finding [MEDIUM-HIGH]. **This is the one real funds-safety item to fix before mainnet withdraw.**

---

## Latest UX/product handoff for Claude CLI (2026-07-05)

User tested LP Agent detail after live mint/stake and found these product bugs / desired changes. Implement these next; do not treat the current UI labels as final.

1. **Position stats panel is misleading after stake.** After staking Position `#4580`, the card correctly shows `Staked - In range`, but the stats still show placeholder `Balance`, `Assets`, `Unclaimed fee`, `Unrealized PnL`, and `Fee` values (`~ 0 0G`, `-`, etc.). For the MVP, remove these confusing fields from LP position cards and replace them with a simpler APR-focused presentation. The card should emphasize deployed amount, pool, stake status, and APR/reward context rather than fake balance/PnL/fee placeholders.

2. **Raw ticks are confusing for users.** Do not show `ticks [-294120, -290160]` as the primary range. Convert/display this as a user-facing price range, e.g. `Price range $0.10 - $0.20` (or the correct token pair units), with ticks only hidden in debug/advanced details if needed.

3. **`Mint new NFT in this pool` should become `Deposit` and top up the selected position.** Current button copy and behavior imply a new NFT mint. Desired UX: the per-position action should be named `Deposit` and should add more vault idle funds to the corresponding LP position/NFT instead of minting a separate new NFT in the same pool. If true top-up is not supported by current contracts/adapters, surface that as an implementation blocker and decide whether to add adapter support or use an honest alternate label.

4. **Auto-mint should default ON at LP agent deploy.** New LP agents should be created with `autoMint=true` by default so the worker can immediately read the new agent and mint when the vault has enough idle balance. Remove the big Auto-mint explanation panel from LP agent detail; keep only a small status badge showing `Auto-mint on/off`. The toggle can still exist somewhere minimal if needed, but the detail page should not spend a full panel explaining it.

5. **Stake should happen automatically after mint.** Product expectation: mint flow should immediately approve + stake the newly minted LP NFT into the matching Zia stake vault, then agent log should record `minted + staked`. This matters because advertised APR comes from staking; a plain minted LP NFT should not be presented as earning the staking APR. Manual `Stake` can remain as a recovery action for old/unstaked positions, but the normal mint path should end in staked state.
