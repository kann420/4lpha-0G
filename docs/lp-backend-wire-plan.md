# LP Agent Backend — Final Unified Implementation Plan

## Overview

The LP Agent is a two-layer autonomous system on 0G mainnet (chain ID `16661`):

1. **LLM decision layer** — `lib/agent/runtime/lp-brain.ts` calls the 0G Compute Router (sole reasoning path) with a typed LP decision schema. The brain only ever *suggests* a `{poolAddress, tickLower, tickUpper, amount0G}` within the user's fence; it never signs, never calls the vault, and never invents pools/ticks/amounts outside the supplied allowlist.
2. **Policy Vault V3 enforcement layer** — the deployed `PolicyVaultV3` is deny-by-default: `zapInMintLp` reverts on `amount0Min==0 || amount1Min==0` (`PolicyVaultV3.sol:722`), enforces `perLpActionCap0G`, `maxLpExposure0G`, `cooldownSecondsLp`, `lpMinOutBps`, the on-chain pool allowlist, and the balance-delta check. The vault — not the server — is the final guardrail.

The executor (`lib/executor/policy-vault-lp.ts`) already `simulateContract`s every entrypoint before `writeContract`, so any off-chain quote drift reverts before gas is spent. `buildDraftLpRequest` (L354-356) throws when `quotedLiquidity / quotedAmount0 / quotedAmount1 / amount0Min / amount1Min` are undefined, so the brain/worker MUST supply all of them.

**No Solidity contract redeploy.** All six gaps close with server-only TypeScript + UI label changes. The LP fence is anchored on-chain via the existing `tightenPolicy` + ERC-7857 `IntelligentData` paths.

---

## ⚠️ Audit corrections (codex gpt-5.5 xhigh, read-only)

The codex audit returned **NO-GO as written** with repo-grounded findings. The corrections below **supersede** any conflicting claim later in this document. Verified against source.

1. **`lp-zia` filter ID does not exist.** `OgAgentFilterId` is `"capital-guard" | "blue-chip-rotation" | "stable-route" | "proof-strict"` (`lib/agent/single-agent.ts:15`); the deploy route derives its z.enum from `OG_AGENT_FILTER_PRESETS` (`app/api/agents/deploy/route.ts:16`). **Fix:** the LP deploy route must NOT pass `filterIds:['lp-zia']`. Either (a) add `"lp-zia"` to the `OgAgentFilterId` union + `OG_AGENT_FILTER_PRESETS` and a corresponding preset, or (b) reuse an existing preset (e.g. `proof-strict`) and tag LP via a separate `kind:'lp'` field on the deploy record. Decision deferred to §Open questions — but the plan's `deploySingleOgAgent({filterIds:['lp-zia']})` call is invalid as written.

2. **Gap 3 quote MUST mirror `ZiaLpAdapter._computeSwapAmount`.** The adapter computes the zap split on-chain: `swapAmount = ceilDiv(amount0G * numerator, range)` where `numerator = w0gIsToken0 ? (currentTick - tickLower) : (tickUpper - currentTick)`, returning `0` if `numerator <= 0` and `amount0G` if `numerator >= range` (`contracts/ZiaLpAdapter.sol:304-324`). Any off-chain quote that does not reproduce this exact heuristic will diverge from the on-chain swap amount and the vault's `amount0Min/amount1Min` floors. **Fix:** `lib/agent/lp/tick-math.ts` exposes `computeSwapAmount(amount0G, currentTick, tickLower, tickUpper, w0gIsToken0)` mirroring the Solidity ceilDiv, and `quoteLpMint` uses it to derive `quotedAmount0/quotedAmount1/amount0Min/amount1Min` so the simulation matches execution.

3. **`uniswapV3PoolAbi` MUST include `token0`/`token1`.** The adapter validates pool token order via `token0()`/`token1()` (`contracts/ZiaLpAdapter.sol:97-100, 211-213`) to determine `w0gIsToken0`. The plan's ABI list omitted them. **Fix:** add `token0() returns (address)` and `token1() returns (address)` to the ABI in `lib/contracts/zia-lp.ts`; the quote module reads them to set `w0gIsToken0` for `_computeSwapAmount`.

4. **"Reverts before gas is spent" is FALSE ordering.** The executor accepts/anchors the proof (gas spent) at `lib/executor/policy-vault-lp.ts:266-278` and only then runs the LP `simulateContract` at `:281-293`. Quote drift can revert *after* proof gas is already spent, leaving a stale accepted proof. **Fix:** state this honestly in the plan and the audit bundle; the `quoteSource` trace + `tickWidthBounded` flag remain, but the docs must not claim "before gas is spent." Mitigation: pre-flight the quote simulation *before* `acceptProof` when feasible (Gap 4 refinement — see if the executor can be reordered, or run a dry `simulateContract` upstream).

5. **`zappableZiaLpVaults()` is label-based, ignores `wrappedNative`.** Current impl is `ZIA_LP_VAULTS.filter(v => v.label.toLowerCase().includes("w0g"))` (`lib/contracts/zia-lp.ts:366-368`); the `wrappedNative` arg is unused. The vault backstops this on-chain (`PolicyVaultV3.sol:732-736`). **Fix:** Gap 1 strengthens `zappableZiaLpVaults()` to verify by token address (`pool.token0/token1 === wrappedNative`), not label, so API/allowlist drift can't expose a pool the vault later rejects. Label filter stays as a fallback only.

6. **Snapshot route line citations wrong.** LP positions are attached in `loadOgAgentWorkspace` at `lib/agent/single-agent-server.ts:287-302` and read in `readSellableLpPositions` at `:860-946`; `readVaultSnapshot` at `:696-734` only builds `lpPolicy`. **Fix:** the snapshot route composes `loadOgAgentWorkspace` + `readSellableLpPositions` + `LpActionExecutedV3` event logs (lower bound = AgenticID deploy block) + `ProofRegistry.isAccepted(actionHash)` per event.

7. **Remove the live 50-50 fallback.** The plan's "partner `/route` with 50-50 fallback" contradicts AGENTS.md (`real DEX integration only after router/token/pool/ABI/address/liquidity confirmed`, lines 239-245). **Fix:** when the partner route is unavailable, the brain returns `hold` (or surfaces a manual-only path) — it does NOT silently deploy real funds under a 50-50 quote. The 50-50 split is only ever computed by the on-chain adapter via `_computeSwapAmount`; the off-chain quote mirrors it or fails to `hold`.

8. **APR/staking honesty.** First mint is `zap-in-mint` only; the advertised APR comes from staking rewards (AGENTS.md:232-234). **Fix:** the UI must not imply APR is earning until the minted NFT is approved + deposited into the Zia stake vault. The deploy route's optional first mint may chain `zap-in-mint` → `stake` only if `allowStaking` and the stake vault is configured; otherwise it stops at mint and labels the position "unstaked — APR not earning."

9. **`buildIntelligentData` is at `single-agent-server.ts:1105-1111`** (plan said 1108-1110). The 6th `dataHash` entry for the LP fence hash still grafts cleanly.

10. **Max positions = "effective max" (exposure-derived), NOT on-chain count.** A strict on-chain position *count* cap would require a Solidity change (adding a field to `LpPolicy` + a check in `zapInMintLp`). The plan's exposure-derived approach (`perLpActionCap0G = maxPerPosition`, `maxLpExposure0G = maxPositions × maxPerPosition`) does NOT enforce count — a compromised executor could open many small NFTs summing under `maxLpExposure0G`. **Fix:** label the UI "effective max positions (exposure-bounded)" and document that strict count enforcement is a future contract change, not shipped here. This is honest and matches the no-contract-change constraint.

**Revised go/no-go:** GO after fixes 1–7 are incorporated (8–10 are labeling/honesty). The plan is directionally aligned with the deployed V3 vault; the blockers are the `lp-zia` filter, the quote model, and the live fallback — all addressable in pure TS before any mainnet tx.

---

## Gap 1 — Zia / TradeGPT API client (server-only)

**contractChange: no**

### Files
- Create `D:/4lpha-0G/lib/integrations/zia-tradegpt.ts`
- Create `D:/4lpha-0G/app/api/agents/lp/pools/route.ts`
- Modify `D:/4lpha-0G/components/agents/lp/LpAgentCreateWorkspace.tsx` (replace `MOCK_LP_POOLS.length`/`qualifyingPoolCount` with a fetch to the new route; keep MOCK fallback labeled clearly)
- Modify `D:/4lpha-0G/lib/contracts/zia-lp.ts` (add `uniswapV3PoolAbi` — shared with Gap 3)
- Modify `D:/4lpha-0G/.env.example`

### Signatures
```ts
// lib/integrations/zia-tradegpt.ts
import 'server-only';
export function resolveZiaBaseUrl(): { baseUrl: string; timeoutMs: number } | { error: Error };
export async function listZiaPools(chainId?: 16661): Promise<ZiaPool[]>;
export async function getZiaPool(poolAddress: Address, chainId?: 16661): Promise<ZiaPool>;
export async function getZiaToken(q: { symbol?: string; address?: Address; chainId?: 16661 }): Promise<ZiaToken>;
export async function planZiaRoute(input: { inToken: Address; outToken: Address; amount: string; recipient: Address; slippageTolerance?: number; chainId?: 16661 }): Promise<ZiaRoute>;
// zod: poolSchema, tokenSchema, routeRequestSchema, routeResponseSchema (.passthrough(false))
export class ZiaApiError extends Error { readonly code: string; readonly status?: number; }
```

### Approach
- Base URL from `process.env.ZIA_TRADEGPT_API_BASE_URL` only (never `NEXT_PUBLIC_*`). Strip userinfo/search before any logging. Refuse non-HTTPS, empty host, localhost. Timeout via `ZIA_TRADEGPT_API_TIMEOUT_MS` (default 10000). One 250ms retry on 429, then surface a sanitized `ZiaApiError`.
- `recipient == zeroAddress` rejected client-side before POST `/route` (docs: 400 otherwise). `chainId === 16661` enforced on every request and response.
- `GET /api/agents/lp/pools` route: call `listZiaPools`, **intersect with `zappableZiaLpVaults()`** (W0G-leg, vault-allowlisted) so the LLM cannot pick a pool the vault rejects, apply the user `minAprPct/maxAprPct` filter, return `{data:{pools, qualifyingCount, total}, meta:{source:'zia-tradegpt-partner'|'mock-fallback', warnings}}`. When the partner URL is unset, return `503 'partner-api-unconfigured'` so the create form falls back to `MOCK_LP_POOLS` labeled "mock — partner URL not configured".
- Surface `apr.staking` (not `apr.total`) and label it "staking APR" in the UI (AGENTS.md: advertised APR comes from staking rewards).
- Add `uniswapV3PoolAbi` to `zia-lp.ts`: `slot0`, `tickSpacing`, `fee`, `liquidity`, `ticks(int24)`.

### Validation
- zod `.safeParse` every upstream response; reject unknown core fields (poolAddress, feeTier, token addresses) with `ZiaApiError('invalid_zia_response', 502)`. `.catch` on cosmetic numeric fields. `isAddress` + lowercase pool/token addresses. Amounts match `^\d+(\.\d+)?$`.
- `sanitizeZiaError()` strips host, path, query, Authorization header before reaching client.

### Verification
- `npx tsc --noEmit`; `npm run build`.
- Manual: curl the route with URL unset → 503 + MOCK fallback; with URL set → typed pool array. Grep `.next/static` for the partner host (must be absent).

### Risks
- Partner schema drift → zod hard-reject on core fields, MOCK fallback path keeps the demo alive and labeled.
- Pool allowlist drift between API and `ZIA_LP_VAULTS` → intersect at the route so the count is honest.
- IP allowlist at partner → out of scope for code; flag to operator in `.env.example` comment.

---

## Gap 2 — LP brain + system prompt (0G Compute Router)

**contractChange: no**

### Files
- Create `D:/4lpha-0G/lib/agent/runtime/lp-brain.ts`
- Create `D:/4lpha-0G/lib/agent/runtime/lp-system-prompt.ts` (placed in `runtime/` to match `brain.ts`, not `lib/copilot/`)
- Modify `D:/4lpha-0G/lib/agent/runtime/types.ts` (add `LpBrainDecision`, `LpBrainFence`, `LpPoolCandidate`)

### Signatures
```ts
export interface LpBrainDecision {
  action: 'mint' | 'hold';
  poolAddress?: Address; tickLower?: number; tickUpper?: number; amount0G?: string;
  confidence: number; reasons: string[]; summary: string;
  model: string; rawMessage: string; normalized: boolean; source: '0g-compute-router';
  trace?: { provider?: string; requestId?: string; quoteSource?: 'partner-route' | 'executor-bridge'; tickWidthBounded: boolean };
}
export async function decideLpAction(input: {
  pools: LpPoolCandidate[]; fence: LpBrainFence; vaultBalance0G: string;
  deployment: OgAgentDeploymentRecord; workspace: OgAgentWorkspace;
  config?: { selectedModel?: string };
}): Promise<LpBrainDecision>;
export function buildLpSystemPrompt({ fence, poolCount, readiness }: { fence: LpBrainFence; poolCount: number; readiness: { vaultReady: boolean; storageUploadReady: boolean; vaultWarnings: string[] } }): string;
// zod: lpDecisionSchema = z.object({ action: z.enum(['mint','hold']), poolAddress, tickLower: z.number().int().min(-887272).max(887272), tickUpper: ..., amount0G, confidence: z.number().min(0).max(100).catch(50), reasons: z.array(z.string()).min(1).max(5).catch([...]), summary: z.string().min(1).max(500).catch('Reviewed LP pool context.') })
```

### Approach
- Mirror `lib/agent/runtime/brain.ts` exactly: `resolveOgComputeRouterConfig('mainnet')`, `callOgComputeRouter`, then `extractJsonObject` → `lpDecisionSchema.safeParse` → normalize. **No `brain.ts` refactor** (avoids the regression risk the judges flagged on plan 2). Keep `extractJsonObject`/`sanitizeReason` duplicated locally if needed; a shared `llm-helpers.ts` is deferred.
- System prompt styled after `lib/copilot/system-prompt.ts` (plain prose, no markdown, honesty rules, refusal of off-topic). Explicit fence section: only pick from supplied allowlisted pools; `tickLower<tickUpper`; both on the pool's `tickSpacing`; `amount0G <= perLpActionCap0G && <= (maxLpExposure0G - openLpExposure0G)`; **tick range width bounded** (see Risk mitigations — server-side max tick-width guard); return `hold` if nothing clears.
- Normalize on parse failure: return `{action:'hold', reasons:['0G Compute Router response could not be parsed safely']}`. Post-parse: reject poolAddress not in allowlist, reject amount > fence, reject tick band wider than the server-side max-width; any violation → `hold`.
- Never log the prompt; never put `sk-`/`mk-` keys or the Zia base URL in messages.

### Validation
- `tickLower/tickUpper` bounded to true V3 `[MIN_TICK=-887272, MAX_TICK=887272]`. `poolAddress` must be in the supplied candidate list. `amount0G > 0` and `<= fence.maxPerPosition0G`. `sanitizeReason` on every reason/summary.

### Verification
- `npx tsc --noEmit`; `npm run build`.
- Add `test/PolicyVaultV3.ts` extension or a `scripts/lp-brain-check.ts` Node smoke (repo uses Hardhat `test/*.ts`, not Vitest): inject a mock fence + 3 pools, stub `callOgComputeRouter` with valid JSON, invalid JSON, an invented poolAddress, an out-of-fence amount, an over-wide tick band → assert `hold` in the latter four. Confirm router key never appears in stdout.

### Risks
- LLM hallucinating pool/tick/amount → post-parse allowlist/fence check downgrades to `hold`; vault is the final guardrail regardless.
- Prompt-injection via malicious pool metadata (name/symbol) → JSON-only output contract + `sanitizeReason` on every field.
- Hold-loop burning Router tokens in a recurring worker → defer the autonomous worker loop to a follow-up (see Open questions); the deploy route triggers the first mint only.

---

## Gap 3 — Tick math + quoting module + V3 pool ABI

**contractChange: no**

### Files
- Create `D:/4lpha-0G/lib/agent/lp/tick-math.ts`
- Create `D:/4lpha-0G/lib/agent/lp/quote.ts` (addresses the `quotedLiquidity/quotedAmount0/quotedAmount1` source that `buildDraftLpRequest` requires — the gap judges flagged in plans 1/3)
- Modify `D:/4lpha-0G/lib/contracts/zia-lp.ts` (add `uniswapV3PoolAbi` — same addition as Gap 1; single shared constant)
- Modify `D:/4lpha-0G/lib/executor/policy-vault-lp.ts` (add an executor-bridge `resolveLpQuote` that computes `quoted*` + `amount0Min/amount1Min` when the caller omits them; keep caller-supplied authoritative; see Approach)

### Signatures
```ts
// tick-math.ts (pure bigint, no I/O)
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
export function priceToTick(price: number, decimals0: number, decimals1: number): number;
export function nearestUsableTick(tick: number, tickSpacing: number): number;
export function tickSpacingForFeeTier(feeTier: number): number;
export function getSqrtRatioAtTick(tick: number): bigint;
export function getLiquidityForAmount0(sqrtRatioLowerX96: bigint, sqrtRatioUpperX96: bigint, amount0: bigint): bigint;
export function getLiquidityForAmount1(sqrtRatioLowerX96: bigint, sqrtRatioUpperX96: bigint, amount1: bigint): bigint;
export function getLiquidityForAmounts(sqrtCurrentX96: bigint, sqrtLowerX96: bigint, sqrtUpperX96: bigint, amount0Desired: bigint, amount1Desired: bigint): { liquidity: bigint; amount0: bigint; amount1: bigint };
export function computeLpMinOuts(amount0Desired: bigint, amount1Desired: bigint, lpMinOutBps: number): { amount0Min: bigint; amount1Min: bigint }; // 1-wei floor enforced

// quote.ts
export interface LpQuoteInput { publicClient: PublicClient; poolAddress: Address; amount0GWei: bigint; tickLower: number; tickUpper: number; lpMinOutBps: number; recipient: Address; }
export interface LpQuoteResult { quotedLiquidity: bigint; quotedAmount0: bigint; quotedAmount1: bigint; amount0Min: bigint; amount1Min: bigint; currentTick: number; sqrtPriceX96: bigint; routeUsed: boolean; quoteSource: 'partner-route' | '50-50-fallback' | 'executor-bridge'; }
export async function quoteLpMint(input: LpQuoteInput): Promise<LpQuoteResult>;
```

### Approach
- Pure bigint math throughout (no `Number` for amounts). `computeLpMinOuts` enforces `amount0Min >= 1n && amount1Min >= 1n` — the vault forbids zero min-out (`PolicyVaultV3.sol:722`), and plans 1/2's `amount*(10000-bps)/10000` yields `0` for sub-bps-sized deposits.
- `quote.ts` reads `slot0`/`tickSpacing`/`liquidity` via `uniswapV3PoolAbi`, computes the 0G→W0G balancing swap split via `planZiaRoute` (Gap 1, off-chain). On partner-route failure, fall back to a deterministic 50/50 split with `routeUsed=false` and `quoteSource:'50-50-fallback'`. The vault does the actual wrap; `quote.ts` never calls `W0G.deposit`.
- **Executor bridge**: in `policy-vault-lp.ts` `buildDraftLpRequest`, when the caller (brain/worker) omits `quotedLiquidity/quotedAmount0/quotedAmount1/amount0Min/amount1Min`, compute them via `quoteLpMint` + `computeLpMinOuts`. **Caller-supplied values stay authoritative** so the proof/audit hash binds the LLM-intent quote; the bridge only fires on omission as defense-in-depth. The audit bundle MUST record `quoteSource` distinctly (`'llm-intent'` vs `'executor-bridge'`) so the two paths are distinguishable (judge concern).
- Keep the existing `simulateContract`-before-`writeContract` gate; if tick-math and the vault disagree, the simulation reverts before gas is spent.

### Validation
- `tick` in `[MIN_TICK, MAX_TICK]`, `tickLower < tickUpper`, both `nearestUsableTick`-ed to the pool's `tickSpacing`. `tickSpacing > 0`. `lpMinOutBps` in `[1, 9999]` (0 and 10000 forbidden). `amount0GWei > 0n`. `poolAddress` in `ZIA_LP_VAULTS`. `computeLpMinOuts` guarantees `amount0Min >= 1n && amount1Min >= 1n`.

### Verification
- `npx tsc --noEmit`; `npm run build`; `npx hardhat compile` (sanity — no contract change, but new TS ABI); `npx hardhat test` (PolicyVaultV3 suite must still pass — executor change is additive).
- Add `test/tick-math.ts` (Hardhat-style) or `scripts/tick-math-check.ts`: `nearestUsableTick(priceToTick(1.0, 18, 6), 10)` aligns to spacing; `computeLpMinOuts(1n, 1n, 9900)` returns `1n, 1n` (never 0); `getLiquidityForAmounts` matches a Uniswap V3 reference fixture.
- Manual: `quoteLpMint` against a live W0G/USDC pool on mainnet (read-only) returns `quotedLiquidity > minLiquidityFloor`.

### Risks
- Stale `slot0` between quote and mint → vault `deadline` + `simulateContract` catch it pre-gas; residual is a reverted simulation (no funds loss).
- Wrong token0/token1 ordering → read token0/token1 from the pool on-chain via the new ABI, not from the Zia API label.
- Audit-bundle drift when the executor computes the quote floor → record `quoteSource` distinctly in the audit bundle.

---

## Gap 4 — LP deploy route + detail snapshot route + metadata payload extension

**contractChange: no**

### Files
- Create `D:/4lpha-0G/app/api/agents/lp/deploy/route.ts`
- Create `D:/4lpha-0G/app/api/agents/lp/[id]/snapshot/route.ts`
- Create `D:/4lpha-0G/lib/agent/lp/lp-deploy.ts` (server orchestrator: mint → tighten → deposit → optional first mint)
- Create `D:/4lpha-0G/app/api/agents/lp/[id]/mint/route.ts` (per-card mint-new-NFT action route — the missing file the judges flagged)
- Modify `D:/4lpha-0G/lib/agent/single-agent-server.ts` (extend `buildAgentMetadataPayload` + `buildIntelligentData` with `lpPolicy` fence hash)

### Signatures
```ts
// lp-deploy.ts
export async function deployLpAgent(input: {
  name: string; ownerAddress: Address;
  lpFence: { maxPositions: number; maxPerPosition0G: string; minAprPct: number; maxAprPct: number | null; rangeMode: 'full'|'pm5'|'pm12'|'pm20'|'custom'; customLowerPct?: number; customUpperPct?: number; llmPicksRange: boolean; };
  depositNative0G: string; llmModel: string;
  confirmedSteps: Array<'mint-agentic-id'|'enable-agent-key'|'tighten-policy'|'deposit-native'|'first-mint'>;
  triggerFirstMint: boolean;
}): Promise<{ deployment: OgAgentDeploymentRecord; tightenTxHash?: Hex; depositTxHash?: Hex; firstMint?: PolicyVaultLpExecution; stepsExecuted: string[] }>;

// POST /api/agents/lp/deploy -> { data: {...}, meta: { network, stepsExecuted } } | { error: { code, message } }
// GET  /api/agents/lp/[id]/snapshot -> { data: { workspace: OgAgentWorkspace; lpSnapshot: LpAgentSnapshot } }
// POST /api/agents/lp/[id]/mint -> { data: { lpTxHash, tokenId, liquidity } }  (per-card mint-new-NFT-in-same-pool)
```

### Approach
- **Deploy route** mirrors `app/api/agents/deploy/route.ts`: `validateCopilotWalletGate`, `assertMainnetDeployEnv`, `requireLpMainnetEnv('deploy')` (Gap 7). The body zod schema: `name` 3-80, `maxPositions` int 1-10, `maxPerPosition0G` positive decimal ≤18 frac digits (reuse `parse0G`), `depositNative0G` positive decimal, `confirmedSteps` array gate.
- Each on-chain step is a **separate, user-confirmed transaction** (the vault has no multicall). The route refuses to run a step not listed in `confirmedSteps`. Returns tx hashes per step.
- **Non-owner deployer path** (judge concern): if `deployer !== vault.owner`, the route returns `403 'owner-required-for-tighten-deposit'` and instructs the owner to run those steps themselves via the owner wallet. For the demo (memory: owner `0xd7e0` is the deployer), this path is not exercised; the guard is the safety net.
- **Step 1** `deploySingleOgAgent({filterIds:['lp-zia'], name, ownerAddress})` — reuses existing AgenticID mint + `setAgentKeyEnabled(true)` (memory: `mintAgent` never enables the agent key; deploy must call it). DEPLOYER pays gas.
- **Step 2** `tightenPolicy` with `nextPolicy` from Gap 5's `buildTightenPolicyCall` (per-field `min(current, ui)`, throws `cannot_loosen_policy` before `simulateContract` if any field would loosen). `onlyOwner` — DEPLOYER must be vault owner.
- **Step 3** `depositNative(value: depositNative0G)` from the owner wallet. DEPLOYER funds the deposit (gas + the deposited 0G). `depositNative` only runs when `'deposit-native' ∈ confirmedSteps`. The route echoes the deposit tx hash back.
- **Step 4 (optional)** first mint: when `triggerFirstMint && 'first-mint' ∈ confirmedSteps && AGENT_TRADE_LIVE_ENABLED`, call `decideLpAction` (Gap 2) then `executeAgentLpAction`. Failure here MUST NOT roll back the AgenticID mint (already on-chain) — return `stepsExecuted` + a clear error for the failed step.
- **Snapshot route**: `loadOgAgentWorkspace({agentId, live:true, ownerAddress})` already populates `lpAdapter`, `lpPolicy`, `openLpExposure0G`, `lpDailySpent0G`, `sellableLpPositions` (`agentLpNfts/lpNftTickLower/Upper/DeployedNative`) via `readVaultSnapshot` (single-agent-server.ts:696-770). Extend with:
  - `LpActionExecutedV3` event logs via `publicClient.getLogs` from the **AgenticID deploy block** (registry `blockNumber`) as the lower bound — history-complete, unlike a 5000-block cap.
  - Zia vault `getDepositedTokenIds/liquidityOf` for staked NFTs.
  - `NFPM.positions(tokenId)` for fees (`tokensOwed0/1`).
  - `ProofRegistry.isAccepted(actionHash)` per event (judge concern) — verifier-anchored status alongside `storageRoot/proofTxHash`.
- **Per-card mint route** `POST /api/agents/lp/[id]/mint`: body `{poolAddress, tickLower, tickUpper, amount0G}` constrained to the same `poolAddress` as the source card (the LLM is seeded with the single existing pool as the only candidate; if it picks a different pool, the brain returns `hold`). Calls `executeAgentLpAction` with `kind:'zap-in-mint'`.
- **`buildAgentMetadataPayload` extension**: include `vault.lpPolicy` when `vaultVersion>=3`. **`buildIntelligentData`** adds a sixth entry `{ dataDescription: 'LP policy fence hash', dataHash: hashJson(lpPolicy) }` so the fence is anchored on-chain via the existing ERC-7857 path. Verified: `buildIntelligentData` currently has 5 entries (filters, owner/vault/executor, agentRef) at single-agent-server.ts:1108-1110.

### Validation
- Deploy route zod body (above). `wallet.chainId === 16661`. `maxPerPosition0G <= vault balance after deposit`. `confirmedSteps` must include every step the route will execute.
- Snapshot route: `agentId` matches `/^agent-0g-mainnet-\d+$/u`; `vaultVersion >= 3` else `409 'migrate-to-v3'` with a hint.
- Mint route: `poolAddress` in `ZIA_LP_VAULTS` AND in the agent's existing positions; `amount0G` ≤ `perLpActionCap0G` and `openLpExposure0G + amount0G <= maxLpExposure0G` (UI pre-check; vault enforces on-chain).

### Verification
- `npx tsc --noEmit`; `npm run build`; `npx hardhat compile`.
- Manual on 0G mainnet: (1) POST deploy with `confirmedSteps=['mint-agentic-id','enable-agent-key','tighten-policy','deposit-native']` → verify each tx on `https://chainscan.0g.ai`; (2) GET snapshot → positions empty but `lpPolicy` present; (3) POST `triggerFirstMint:true` → verify `LpActionExecutedV3` event and a new `tokenId` in `agentLpNfts`.
- Confirm 0G Storage audit upload + `ProofRegistry.acceptProof` remain wired (executor already does both — confirm `storageRoot` + `proofTxHash` in the response).

### Risks
- DEPLOYER-funded `depositNative` burning operator 0G without consent → `confirmedSteps` gate + explicit per-step tx-hash echo; deposit only runs when explicitly listed.
- `tightenPolicy` loosening a field by accident → per-field `min(current, ui)` validator throws `cannot_loosen_policy` before `simulateContract`; vault's on-chain tighten enforcement is the backstop.
- Unbounded `getLogs` → bounded by the AgenticID deploy block from the registry; upper bound is `latest`.
- Partial deploy failure → `stepsExecuted` returned; AgenticID mint is irreversible, so the route never rolls it back.

---

## Gap 5 — Max positions derived via `tightenPolicy` (no contract change)

**contractChange: no**

### Files
- Create `D:/4lpha-0G/lib/agent/lp/lp-fence.ts`
- Modify `D:/4lpha-0G/app/api/agents/lp/deploy/route.ts` (consume helper)
- Modify `D:/4lpha-0G/lib/agent/single-agent-server.ts` (`readVaultSnapshot`: derive `lpMaxPositions = floor(maxLpExposure0G / perLpActionCap0G)` for display)
- Modify `D:/4lpha-0G/lib/agent/single-agent.ts` (`OgAgentVaultSnapshot.lpPolicy.lpMaxPositions` stays a UI/derived field, not on-chain)

### Signatures
```ts
export function translateLpFence(input: { maxPositions: number; maxPerPosition0G: string; }, current: PolicyVaultV3LpPolicy): {
  perLpActionCap0G: bigint; lpDailyCap0G: bigint; maxLpExposure0G: bigint;
  cooldownSecondsLp: bigint; lpMinOutBps: number; minLiquidityFloor: bigint; allowStaking: boolean;
};
export function deriveMaxPositions(lp: { perLpActionCap0G: bigint; maxLpExposure0G: bigint }): number; // floor, guarded against divide-by-zero
export function buildTightenPolicyCall(current: PolicyVaultV3Policy, uiFenceLp: ReturnType<typeof translateLpFence>): { nextPolicy: PolicyVaultV3Policy; tightened: boolean };
```

### Approach
- The deployed `LpPolicy` has exactly 7 fields (verified: `perLpActionCap0G, lpDailyCap0G, maxLpExposure0G, cooldownSecondsLp, lpMinOutBps, minLiquidityFloor, allowStaking` — no `maxPositions`). Translate UI `maxPositions × maxPerPosition0G` into the existing caps:
  - `perLpActionCap0G = parse0G(maxPerPosition0G)`
  - `maxLpExposure0G = parse0G(maxPerPosition0G) * BigInt(maxPositions)` (exact multiply, so `floor(maxLpExposure0G / perLpActionCap0G) === N`)
  - `lpDailyCap0G = min(current.lpDailyCap0G, maxLpExposure0G)` (default: a full rebalance day cannot exceed total exposure — decision; see Open questions)
- `buildTightenPolicyCall` takes `min(current, ui)` per field; `allowStaking` may only go `true→false` (tighten); `lpMinOutBps` only increase; `cooldownSecondsLp` only increase. Returns `tightened=false` if no field decreased → the deploy route skips the on-chain `tightenPolicy` call to save gas.
- `readVaultSnapshot` derives `lpMaxPositions` and `lpMaxPerPosition0G = formatEther(perLpActionCap0G)` for display; UI shows "3/5 positions" honestly, labeled "effective max positions".

### Validation
- `maxPositions` int 1-10; `maxPerPosition0G` positive decimal ≤18 frac digits; `perLpActionCap0G > 0`; `maxLpExposure0G >= perLpActionCap0G`; translated field `<= current` (throw `cannot_loosen_policy` otherwise, before `simulateContract`).

### Verification
- `npx tsc --noEmit`; `npm run build`.
- `test/lp-fence.ts` (Hardhat) or `scripts/lp-fence-check.ts`: `translateLpFence({maxPositions:3, maxPerPosition0G:'0.5'}, current)` → `perLpActionCap0G=0.5e18`, `maxLpExposure0G=1.5e18`; `deriveMaxPositions === 3`; a loosen attempt throws.
- Manual: after deploy, `vault.policy()` returns the two caps matching UI `Max positions × Max per position`; attempt N+1 mints of P each → the (N+1)th reverts on `maxLpExposure0G`.

### Risks
- Display drift if an admin tightens `perLpActionCap0G` down → displayed N increases; label "effective max positions" to stay honest.
- A compromised executor opening N+1 small positions under the cap → bounded by `perLpActionCap0G` + `openLpExposure0G` on-chain; total 0G deployed cannot exceed `maxLpExposure0G`. This is the on-chain guarantee and it is honest.

---

## Gap 6 — Per-position "Deposit more" relabel → "Mint new NFT in this pool"

**contractChange: no**

### Files
- Modify `D:/4lpha-0G/components/agents/lp/LpPositionCard.tsx` (relabel button + tooltip; rename prop `onDepositMore → onMintNewInPool`)
- Modify `D:/4lpha-0G/components/agents/lp/LpPositionsWorkspace.tsx` (wire `onMintNewInPool` → POST `/api/agents/lp/[id]/mint`)
- Modify `D:/4lpha-0G/components/agents/lp/LpAgentDetailPage.tsx` (toast text)

### Approach
- The vault ships only `zapInMintLp/stakeLp/unstakeLp/zapOut/claimRewards` — **no `increaseLiquidityLp` entrypoint**. So "Deposit more" cannot mean "add liquidity to this NFT". Relabel the button to **"Mint new NFT in this pool"**.
- Click handler calls `POST /api/agents/lp/[id]/mint` (Gap 4) with the source `poolAddress`; the brain is seeded with that pool as the only candidate (it picks a fresh optimal band, possibly different from the source NFT's band). The existing NFT is untouched.
- Toast: `"Minting a new LP NFT in ${poolLabel}. Existing position #${tokenId} is unchanged."` — never "Added liquidity to #tokenId".
- Tooltip under the button: `"The vault cannot add liquidity to an existing NFT. This mints a new NFT in the same pool, bounded by the same per-position cap and total exposure cap."`
- **Honest mock state**: when `AGENT_TRADE_LIVE_ENABLED=false` or the executor is unavailable, the button is disabled with `"Coming soon — backend wiring"` (not a fake success).
- **`claimRewards` UI** (judge concern): the vault ships `claimRewards` but it reverts `RewardsNotConfigured`, and Zia's reward-claim/pending-reward methods are not available yet (docs L194-205). Surface a clearly-labeled **"Claim rewards (coming soon)"** control, disabled, with a tooltip explaining the Zia rewards API is not yet available. Do not imply a working claim.

### Validation
- No new request shape; reuses `executeAgentLpAction`'s `kind:'zap-in-mint'`. Toast must not claim "added liquidity to #tokenId". Button label must not say "Deposit more". `grep` for `increaseLiquidity` and `Deposit more` in `components/agents/lp/` must return nothing after the change.

### Verification
- `npm run build`. Manual: open `/agents/lp/<id>` on desktop and mobile, expand a position card, confirm the button reads "Mint new NFT in this pool", the tooltip explains semantics, and (in mock mode) the disabled state shows "Coming soon — backend wiring".

### Risks
- User confusion expecting compounding into one NFT → mitigated by the explicit relabel + tooltip + toast.
- LLM picking a different pool when seeded → pass the source `poolAddress` as the only candidate; the brain downgrades to `hold` if it deviates.

---

## Env fix — `OG_CHAIN_ID 16602 → 16661` for the LP executor

**contractChange: no**

### Files
- Create `D:/4lpha-0G/lib/agent/lp/lp-env-gate.ts` (shared helper, single source of truth)
- Modify `D:/4lpha-0G/lib/executor/policy-vault-lp.ts` (refactor `requireMainnetFlags` to call the shared helper — no behavior change)
- Modify `D:/4lpha-0G/.env.example` (document the mainnet LP block)

### Approach
- `requireMainnetFlags` already enforces `OG_NETWORK=mainnet && OG_CHAIN_ID=16661` + 4 flags (verified at `policy-vault-lp.ts:479-490`); `requireLiveTradingEnabled` (L492) separately enforces `AGENT_TRADE_LIVE_ENABLED`. The runtime guard exists; the gap is operator experience.
- Extract a shared `requireLpMainnetEnv(mode: 'deploy'|'execute')` returning `{ok:true} | {ok:false, code, message}`. `deploy` does not require `AGENT_TRADE_LIVE_ENABLED`; `execute` does. Refactor `policy-vault-lp.ts` to call it so the executor and deploy route cannot drift.
- When `OG_NETWORK=mainnet` but `OG_CHAIN_ID=16602`, return `code:'chain_id_mismatch'` with message `"LP actions require OG_CHAIN_ID=16661 (currently 16602). Set OG_CHAIN_ID=16661 in .env.local."`. Route handlers map it to `409`.
- `.env.example`: add a commented block:
  ```
  # LP Agent mainnet (mint/tighten/deposit/execute):
  #   OG_NETWORK=mainnet, OG_CHAIN_ID=16661, ENABLE_MAINNET_DEPLOY=true,
  #   ENABLE_REAL_DEX_ADAPTER=true, ENABLE_MOCK_DEX_ADAPTER=false,
  #   MAINNET_ALLOW_MOCK_LP_ADAPTER=false, AGENT_TRADE_LIVE_ENABLED=true (for execute)
  ```

### Verification
- `npx tsc --noEmit`; `npm run build`.
- Manual: set `OG_NETWORK=mainnet, OG_CHAIN_ID=16602` → POST `/api/agents/lp/deploy` returns `409 'chain_id_mismatch'`. Set both to mainnet → the deploy flow proceeds.

---

## Build order (low-risk first)

| Step | Gap | Type | Mainnet gas? | Notes |
|------|-----|------|--------------|-------|
| 1 | Env fix | Pure code | No | Unblocks all mainnet LP runs with a clear error; do first to fail-fast on misconfig. |
| 2 | Gap 1 Zia client + `uniswapV3PoolAbi` | Pure code | No | Server-only, no I/O contract. MOCK fallback keeps demo resilient. |
| 3 | Gap 3 tick-math + quote | Pure code | No | Pure bigint module + read-only `quoteLpMint`. Brain and executor both depend on it. |
| 4 | Gap 2 LP brain + system prompt | Pure code | No | Depends on Gap 1 (pools) + Gap 3 (tick validation). No `brain.ts` refactor. |
| 5 | Gap 5 max-positions translation | Pure code | No | Pure server logic, no contract. Consumed by Gap 4. |
| 6 | Gap 4 deploy + snapshot + mint routes + metadata extension | Server routes | **Yes — mainnet gas** | Depends on all above. Gate behind explicit per-step user confirmation. Ship last. |
| 7 | Gap 6 relabel + `claimRewards` coming-soon | UI only | No | Ships after Gap 4 so the mint-new-NFT action is actually wired. Can start in parallel with Gap 4. |

---

## Verification

- **Type/build**: `npx tsc --noEmit`; `npm run build` after every step.
- **Contracts**: `npx hardhat compile` (sanity — no contract change, but new TS ABI in `zia-lp.ts`); `npx hardhat test` (PolicyVaultV3 suite must still pass after the additive executor bridge).
- **Manual smoke (server, no gas)**: curl `/api/agents/lp/pools` with URL unset → 503 + MOCK fallback; with URL set → typed pool array. `quoteLpMint` against a live W0G/USDC pool (read-only). `decideLpAction` with a stubbed router → valid decision or `hold`.
- **Mainnet gates (require real gas, explicit user confirmation per step)**: POST `/api/agents/lp/deploy` with `confirmedSteps=['mint-agentic-id','enable-agent-key','tighten-policy','deposit-native']` → verify each tx on `https://chainscan.0g.ai`. GET snapshot → `lpPolicy` present, `positions` empty. POST with `triggerFirstMint:true` → verify `LpActionExecutedV3` event and a new `tokenId`. Confirm 0G Storage audit upload + `ProofRegistry.acceptProof` remain wired.
- **No-Vitest note**: the repo uses Hardhat (`test/*.ts`), not Vitest. All unit checks are Hardhat test files or `scripts/*-check.ts` Node smokes.
- **Client bundle leak check**: grep `.next/static` for the Zia partner host, `ZIA_TRADEGPT_API_BASE_URL`, and any `sk-`/`mk-` Router key after build — must be absent.

---

## Risk mitigations

| Risk | Mitigation |
|------|------------|
| `amount0Min/amount1Min == 0` reaching the vault | `computeLpMinOuts` enforces `>= 1n` each; vault also reverts (`PolicyVaultV3.sol:722`) as the backstop. |
| LLM hallucinating pool/tick/amount outside fence | Post-parse allowlist/fence check downgrades to `hold`; vault on-chain allowlist + caps are the final guardrail. |
| `tightenPolicy` accidentally loosening a field | `buildTightenPolicyCall` per-field `min(current, ui)` throws `cannot_loosen_policy` before `simulateContract`; vault on-chain tighten enforcement is the backstop. |
| DEPLOYER-funded `depositNative` burning operator 0G without consent | `confirmedSteps` array gate; deposit only runs when explicitly listed; per-step tx-hash echo. Non-owner deployer → `403 'owner-required-for-tighten-deposit'`. |
| Max tick-width not bounded on-chain | Server-side max tick-width preflight in the brain (rejects overly wide bands before audit upload); record `tickWidthBounded:true` in the decision trace. Vault caps funds, not strategy. |
| Stale `slot0` between quote and mint | Vault `deadline` + executor `simulateContract`-before-`writeContract` catch it pre-gas; residual is a reverted simulation (no funds loss). |
| Pool allowlist drift (Zia API vs `ZIA_LP_VAULTS`) | `/api/agents/lp/pools` intersects API pools with `zappableZiaLpVaults()`; brain only sees the intersection. |
| Secret leak of Zia base URL / Router key | `import 'server-only'`; env read server-side only; never `NEXT_PUBLIC_*`; `sanitizeZiaError` strips host/path/query; never log the prompt. |
| Unbounded `getLogs` on snapshot route | Lower bound = AgenticID deploy block from the registry; upper bound = `latest`. |
| Env-gate helper drift | `requireLpMainnetEnv` is the single source of truth; `policy-vault-lp.ts` `requireMainnetFlags` refactored to call it. |
| Audit-bundle quote-source drift | Audit bundle records `quoteSource: 'llm-intent' | 'executor-bridge'` distinctly; caller-supplied quote stays authoritative. |
| Mock masquerading as real | Button disabled with "Coming soon — backend wiring" when `AGENT_TRADE_LIVE_ENABLED=false`; MOCK pool fallback labeled "mock — partner URL not configured". |

---

## Open questions / decisions for the user

1. **Autonomous worker loop**: this plan wires the brain to fire only on (a) the deploy route's optional first mint and (b) the per-card "Mint new NFT" button. A recurring autonomous cycle (the `worker.ts` `lp-zia` branch from plan 2) is **deferred** to avoid the brain.ts-refactor / Router-token-burn risk on the hackathon timeline. Confirm the demo can be a one-shot deploy-time mint + manual per-card mints, or require the recurring loop before submission.
2. **LP brain default model id**: reuse `resolveRouterModel` (shared with Copilot), or add a dedicated `OG_COMPUTE_LP_MODEL` env? The plan reuses the shared default; confirm.
3. **`lpDailyCap0G` default**: the plan sets `lpDailyCap0G = min(current, maxLpExposure0G)` so a daily reset cannot re-deploy the full fence every day. Confirm, or leave to operator.
4. **`depositNative` funder**: the plan has DEPLOYER fund the deposit (gas + the deposited 0G), gated by `confirmedSteps`. For the demo, deployer === vault owner (`0xd7e0`), so this is fine. Confirm, or require a user-signed deposit tx for the non-owner case.
5. **QuoterV2 vs partner POST `/route` for the zap leg**: the plan uses partner `/route` (off-chain) with a 50/50 fallback flagged `routeUsed=false`. The repo ships `QuoterV2` at `0x23b55293b7F06F6c332a0dDA3D88d8921218425B` (`zia-lp.ts:7`). Confirm partner-route-first, or prefer on-chain QuoterV2.
6. **Partner IP allowlist**: docs say no auth key, but the partner may enforce an IP allowlist. Confirm reachability before the demo (operator task, not code).
7. **`claimRewards` UI**: the plan surfaces a disabled "Claim rewards (coming soon)" control. Confirm, or hide it entirely until Zia confirms the rewards API.

---

## Explicit no contract change confirmation

**No Solidity contract is redeployed or modified.** All six gaps close with:
- Server-only TypeScript modules (`lib/integrations/`, `lib/agent/`, `lib/executor/` additive bridge).
- New Next.js API routes (`app/api/agents/lp/`).
- UI label/tooltip/toast changes (`components/agents/lp/`).
- `.env.example` documentation.

The on-chain fence is anchored via the **existing** `tightenPolicy` entrypoint and the **existing** ERC-7857 `IntelligentData` array (extended with a sixth `dataHash` entry for the LP policy fence hash — metadata only, no contract change). `npx hardhat compile` is run only as a sanity check that the new TS ABI in `zia-lp.ts` aligns with the deployed bytecode; no `.sol` file is touched. `npx hardhat test` confirms the `PolicyVaultV3` suite still passes after the additive executor bridge.