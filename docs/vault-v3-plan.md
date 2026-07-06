# PolicyVault V3 + v2→v3 Migrate — Implementation Plan

> Status: Plan (no code edited). Audit target for Codex gpt-5.5 xhigh against AGENTS.md compliance, loss-of-funds risks, and correctness. Implementation source for Claude CLI.
> Source blueprints: v2Blueprint, adapterBlueprint, proofBlueprint, migrateBlueprint, testBlueprint, ziaLpBlueprint.

---

## 0. v3 Shipping Trim Addendum (implements Path A — EIP-170 24KB fit)

**Context.** 0G mainnet (chainId 16661) enforces EIP-170's 24576-byte deployed-bytecode cap. The
full V3 design in §2.1.11 (V2 swap surface + 9 LP primitives + claimRewards) compiles to ~33.6KB —
undeployable on mainnet. A 4-agent research workflow verified the cap is real on 0G and that a
clone-proxy does not help (V3 uses immutable constructor args, so EIP-1167 clones would share one
singleton's immutates = one executor/adapter for all users, breaking per-user vaults). Splitting the
contract is infeasible because every LP entrypoint is vault-context-bound (reads `policy`,
`lpNftOwner`, `openLpExposure0G`, `agentLpNotionalDeployed`, proof anchoring — none can live in a
separate singleton without re-opening the cap-bypass / approval-surface issues Codex already closed).
The only viable path is to **trim the shipped primitive set** so V3's deployed bytecode fits under
24KB. This is Path A, chosen by the user.

**Shipped in v3 (5 entrypoints + stub):** `zapInMintLp`, `stakeLp`, `unstakeLp`, `zapOut`,
`claimRewards` (stub, `revert RewardsNotConfigured()`), plus the full V2 swap surface (`buy`/`sell`)
byte-for-byte. This covers the complete APR-earning demo lifecycle the hackathon path requires:
deposit 0G → `zapInMintLp` (mint LP via single-sided native zap on a W0G-leg pool) → `stakeLp`
(vault-direct deposit into the Zia vault) → earn advertised APR → `unstakeLp` → `zapOut` (return
native 0G to the vault). `claimRewards` stays a clean revert until Zia ships a claim/pendingRewards
ABI (§2.1.11).

**Deferred to v4 (5 entrypoints):** `zapInIncreaseLiquidity`, `decreaseLiquidity`, `collectFees`,
`burnLp`, `sweepToken`. These compose the autonomy primitives (auto-compound, auto-rebalance,
take-profit/stop-loss) described in §1. They are removed from the v3 contract body and test suite,
but the `LpActionType` enum values are **reserved (not renumbered)** so v4 can re-add them without
shifting the `actionType` encoding, and `IPolicyVaultLpAdapter` still declares them (the interface
is the v4 surface; the v3 vault simply does not call them). Auto-compound/rebalance are off-chain
keeper orchestration that v4 unlocks — not required for the hackathon demo.

**Measured size.** `PolicyVaultV3` deployed bytecode = **23761 bytes** at
`solc 0.8.24 / evmVersion cancun / viaIR true / optimizer runs=200` (under 24576 by 815). The
trim fits at all measured runs values: `runs=1` 23598B, `runs=200` 23810B (pre-exit-lockup-fix) →
23761B (post-fix), `runs=500` 23947B. The default solidity profile is set to `runs=200` for
runtime-gas-friendlier bytecode; `production` stays `runs=500`. The 815-byte headroom is small —
do not add logic to V3 without re-measuring. (Codex correction: an earlier draft claimed `runs=1`
was required — that was measured against a source that still included `zapInIncreaseLiquidity`; the
shipped trim fits at runs=200/500 too.)

**Exit-lockup guard (Codex high-severity fix).** LP pool / stake-vault allowlists are enforced on
ENTRY actions only (`zapInMintLp`, `stakeLp` — both require `allowedLpPools[poolId]` and, for
stake, `allowedStakeVaults[stakeVault]`). EXIT actions (`unstakeLp`, `unstakeLpOwner`, `zapOut`)
are authorized by the recorded position (`lpNftPool[tokenId]` match, `stakeVaultForLpPool` canonical
mapping, `_isAgentStakedNft` / `_removeAgentStakedNft` membership) — NOT by the current allowlist.
`unstakeLp`/`unstakeLpOwner` no longer require `allowedStakeVaults`; `unstakeLp` no longer requires
`policy.lp.allowStaking`; `_validateLpRequest` no longer requires `allowedLpPools` (that check moved
into the two entry entrypoints). This ensures `disableLpPool` / `disableStakeVault` /
`allowStaking=false` tighten NEW deployments without locking exits — an owner cannot strand staked
NFTs or block `zapOut` by disabling a pool/vault, so "admin must not move/block user funds" holds.

**Factory strategy change — no mainnet on-chain factory.** `PolicyVaultFactoryV3` embeds V3's
creation bytecode via `new PolicyVaultV3(...)` and compiles to ~28.6KB even at `runs=200` — also over
the 24KB cap, so it cannot deploy on 0G mainnet either. The factory contract is **retained for EDR
tests only** (the `hardhatMainnet` network sets `allowUnlimitedContractSize: true`). The mainnet
deploy path is changed to: **the deployer/server deploys V3 singletons directly via a deploy
script** (`scripts/create-mainnet-vault-v3.ts`) using the V3 creation bytecode from the compiled
artifact — no on-chain factory embeds it. The "one V3 vault per owner" + "owner-bound creation"
guards the factory enforced on-chain are moved to **server-side enforcement** in the deploy script
(check the off-chain registry / `vaultOf` equivalent before deploying) and, if audit confirms it is
worth the surface, a tiny on-chain `VaultRegistry` (mapping `owner => vault`, `registerVault`
callable only by the deployer EOA, one-per-owner). V3's constructor is unchanged — it does not call
any registry (no extra size, no external call in the size-critical path). This sidesteps the factory
size problem entirely and is the honest mainnet path. The migrate button (v2→v3) targets the
server-side deploy route, not an on-chain factory call.

**V3 registry trust boundary.** Because no on-chain V3 factory exists on mainnet, the one-vault-per-owner guard is purely off-chain: `scripts/create-mainnet-vault-v3.ts` reads `.data/deployments/mainnet-policy-vault-v3-registry.json` and throws if an entry for the owner already exists. That file can be missing, stale, or branch-local, so the script additionally requires `MAINNET_V3_REDEPLOY_FORCE=true` when the registry is missing/empty before it will deploy, and prints a clear warning. The server resolver (`resolveMainnetV3VaultForOwner` in `lib/agent/mainnet-vault-resolver.ts`) treats an explicit env override (`NEXT_PUBLIC_POLICY_VAULT_V3_MAINNET_ADDRESS` / `POLICY_VAULT_V3_MAINNET_ADDRESS`) as authoritative over the registry, so UI/executor point at the operator-asserted V3. Neither source is on-chain truth; operators must keep the env var or the registry file aligned with the actually-funded vault.

**Test status.** `test/PolicyVaultV3.ts` has 10 tests (V2 buy/sell roundtrip on V3, zap-mint +
non-W0G reject, stake/unstake, exit-lockup guard — exits survive `disableStakeVault`/`disableLpPool`
while new entries are blocked, exit-lockup branch coverage — `stakeLp` rejected after
`allowStaking=false` while `unstakeLp` still proceeds, zap-out full-burn, claimRewards reverts with
the exact `RewardsNotConfigured` selector, replay reject, zero-min-out reject, factory V3
owner-bound). Full suite: **41 passing** on `--network hardhatMainnet` (10 V3 + 31 existing), no
regressions. The 3 tests for v4-deferred primitives (decrease+burn, burnLp min-out, sweep) and the
increase-liquidity test are removed.

**Audit note.** This addendum is the scope delta vs the Codex-READY plan below. The full §2.1.11
design (including v4-deferred primitives) stays as reference for the v4 re-add. The v3 shipping
contract + this addendum + the factory strategy change are the Codex re-audit target.

---

> **Body scope note.** §1 onward is the full v4-design reference written before the EIP-170 trim
> and the exit-lockup fix. Where it conflicts with §0, **§0 governs** for the v3 ship. Two
> corrections to read into the body: (1) the shipped v3 primitive set is the §0 five-entrypoint
> set, not the full nine; `zapInIncreaseLiquidity`/`decreaseLiquidity`/`collectFees`/`burnLp`/
> `sweepToken` are v4-deferred (the removed `LpTickMismatch` error belonged to `zapInIncreaseLiquidity`).
> (2) The body describes `_validateLpRequest` and exit actions (`unstakeLp`, `unstakeLpOwner`,
> `zapOut`) as gated by `allowedLpPools` / `allowedStakeVaults` / `allowStaking`. That gating was a
> high-severity exit-lockup bug and is **superseded by the §0 exit-lockup guard**: allowlists gate
> ENTRY actions only; exits are authorized by the recorded position. Do not restore the old
> allowlist-gating language on exits without re-auditing the lockup path.

---

## 1. Overview & Goals

**V3 = V2 swap surface, byte-for-byte preserved on the buy/sell path, PLUS a comprehensive LP primitive layer shipped from day one.** The LP layer covers the full Zia/TradeGPT LP lifecycle as narrow vault entrypoints: `zapInMintLp`, `zapInIncreaseLiquidity`, `decreaseLiquidity`, `collectFees`, `burnLp`, `stakeLp`, `unstakeLp`, `sweepToken`, `zapOut`, and a reserved `claimRewards` slot that reverts cleanly until Zia delivers a claim/pendingRewards ABI.

**Why ship the full LP primitive set now (v4 avoidance).** Future auto-rebalance, auto-compound, take-profit, and stop-loss are off-chain keeper orchestration over these primitives — they issue signed `LpActionRequest`s through the same proof-anchored, policy-bound, deny-by-default path the swap surface already uses. With `ZAP_IN_MINT_LP`, `SWEEP_TOKEN`, `decreaseLiquidity`, `collectFees`, `zapInIncreaseLiquidity`, `burnLp`, `stakeLp`, `unstakeLp`, and `zapOut` all present, the keeper can compose: auto-compound = `collectFees` → `SWEEP_TOKEN` (fees → desired ratio) → `zapInIncreaseLiquidity`; auto-rebalance = `unstakeLp` (if staked) → `decreaseLiquidity`/`zapOut` → `SWEEP_TOKEN` → `ZAP_IN_MINT_LP`/`stakeLp`; take-profit/stop-loss = `zapOut` (partial/full) at a price threshold. **No new funds-touching contract logic is needed for that round, so no v4 for autonomy.** A v4 is only justified if (a) Zia's rewards/claim shape later requires a separate distributor contract not predictable from today's `deposit/withdraw/depositorOf/getDepositedTokenIds/depositedCountOf/liquidityOf` surface, or (b) a future autonomy primitive genuinely cannot be composed from the shipped set (none currently identified), or (c) multi-hop zap for non-W0G-leg pools (USDC/USDT, USDC/WETH, USDC/LINK, USDC/SOL, WBTC/USDC) is needed — V3 `zapInMintLp`/`zapInIncreaseLiquidity` support only W0G-leg pools (one balancing swap + mint); the 5 non-W0G pools revert `LpPoolNotZappable` and require a multi-hop routing zap (wrap → W0G→leg0 via a routing pool → leg0→leg1 via the target pool → mint) which is a v4 enhancement to the existing zap primitive (Codex round-3 major fix). The hackathon demo path uses the 6 W0G-leg pools, which cover the 0G-native LP use cases.

**In scope for THIS plan:**
- `PolicyVaultV3.sol` + `PolicyVaultFactoryV3.sol` (immutable, per-user, VERSION=3).
- `IPolicyVaultLpAdapter.sol` interface + `ZiaLpAdapter.sol` (curated, deny-by-default) + `MockZiaLpAdapter.sol` (tests only).
- `lib/contracts/policy-vault-v3.ts` ABI + V3 factory registration in `policy-vault.ts`.
- `lib/contracts/zia-lp.ts` NFPM full ABI addition (separate from the narrow stake-only ABI).
- `lib/executor/policy-vault-lp.ts` LP executor wiring.
- Mainnet vault resolver + single-agent-server V3 pickup.
- Migrate button v2→v3 (UI + server route + registry update + agentKey re-enable on V3).
- Deploy scripts: `deploy-mainnet-factory-v3.ts`, `deploy-mainnet-zia-lp-adapter.ts`, `create-mainnet-vault-v3.ts`, verify script.
- Test suite `test/PolicyVaultV3.ts` + `test/PolicyVaultFactoryV3.ts`.
- Env placeholders in `.env.example`.

**Deferred to the LP-agent / Copilot plan (NOT this plan):**
- LP agent off-chain reasoning, route/pool selection, tick-range strategy, auto-rebalance/compound keeper.
- Copilot one-click LP UX.
- Real claim/pendingRewards integration (label as `pending` everywhere; `claimRewards` stays a reserved slot that reverts `RewardsNotConfigured`).
- APR capture display (label `pending` per AGENTS.md; do not imply advertised APR is captured).

---

## 2. Contract Changes

### 2.1 `contracts/PolicyVaultV3.sol`

**Inheritance & pragma:** source can keep `pragma solidity ^0.8.19;` because it is satisfied by the pinned `solc 0.8.24` profile. Import `IERC20`, `IProofRegistry`, `IPolicyVaultAdapter`, `IPolicyVaultLpAdapter`, `Ownable`, `ReentrancyGuard`, `SafeTransferLib`. Contract: `contract PolicyVaultV3 is Ownable, ReentrancyGuard`.

> Note on compiler: `hardhat.config.ts` profiles `0.8.24`/cancun/viaIR. AGENTS.md mandates the same compiler profile; do not downgrade to `0.8.19`, because `evmVersion: "cancun"` requires solc `0.8.24` or newer. The default profile stays `version: "0.8.24"`, `evmVersion: "cancun"`, `viaIR: true`, optimizer 200.

#### 2.1.1 Constants (V2 verbatim + V3 additions)

```solidity
address public constant NATIVE_TOKEN = address(0);
uint16 public constant BPS = 10_000;
bytes32 public constant MOCK_ADAPTER_KIND = keccak256("4LPHA_0G_MOCK_ADAPTER");
bytes32 public constant MOCK_LP_ADAPTER_KIND = keccak256("4LPHA_0G_MOCK_LP_ADAPTER");
uint256 private constant MAINNET_CHAIN_ID = 16661;
```

**Domain tags (Codex re-audit major 8 fix — removes the V3-tag contradiction):**
- Swap path `vaultActionHashFor(bool, TradeRequest)` keeps the V2 domain tag `"4LPHA_0G_POLICY_VAULT_ACTION"` **byte-for-byte** (see §2.1.10 rationale: no cross-version collision risk because `block.chainid`/`address(this)`/`owner()`/`executor`/`adapter`/`proofRegistry` cannot all match across a V2 and a V3 instance).
- LP path `vaultActionHashForLp(LpActionRequest)` uses a distinct tag `"4LPHA_0G_POLICY_VAULT_ACTION_LP"`.
- The earlier `LP_ACTION_DOMAIN_TAG = ..._ACTION_V3` constant is DROPPED (it was unused and contradicted §2.1.10).
- The outer `actionHashFor` wrapper (`"4LPHA_0G_POLICY_VAULT_PROOF"` + 3 roots) stays unchanged so `ProofRegistry.sol` needs NO change.

> The "byte-for-byte" claim in §1 applies to the swap **entrypoint bodies** (`buy`/`sell` logic, delta checks, events) and the swap `vaultActionHashFor(bool,TradeRequest)` composition + tag. It does NOT apply to `policyHash()`/`_policyHash`, which are EXTENDED to include `LpPolicy` (the full policy snapshot bound to every request). V3 `policyHash()` therefore differs from V2 `policyHash()` — this is fine because V3 is a new contract and the swap request's `policySnapshotHash` is read on-chain from the V3 instance, not carried over from V2.

#### 2.1.2 Storage layout — V2 port (verbatim) + V3 additions

**Immutables (V2 verbatim + LP adapter immutable):**
```solidity
address public immutable executor;
IPolicyVaultAdapter public immutable adapter;          // swap adapter (V2 verbatim)
IPolicyVaultLpAdapter public immutable lpAdapter;      // V3 new; address(0) allowed = swap-only vault
IProofRegistry public immutable proofRegistry;
bool public immutable mockAdapterAllowed;
bool public immutable mockLpAdapterAllowed;            // V3 new
```

If `lpAdapter == address(0)`, every LP entrypoint reverts `LpAdapterNotConfigured()`. The factory MUST pass `address(0)` (or a real curated adapter) — never a mock on mainnet.

**Policy + flags (V2 verbatim):**
```solidity
Policy public policy;        // extended struct (see 2.1.3)
bool public paused;
bool public executorRevoked;
```

**Allowlists / replay / pair min-out (V2 verbatim + LP allowlists):**
```solidity
mapping(bytes32 actionHash => bool used) public usedActionHashes;
mapping(address token => bool allowed) public allowedTokens;
mapping(bytes32 poolId => bool allowed) public allowedPools;            // swap pools
mapping(address tokenIn => mapping(address tokenOut => uint16 minOutBps)) private _minOutBpsByPair;
mapping(bytes32 lpPoolId => bool allowed) public allowedLpPools;        // V3 new (LP pools, distinct namespace)
mapping(address stakeVault => bool allowed) public allowedStakeVaults;  // V3 new (Zia staking vaults; superset check)
mapping(bytes32 lpPoolId => address stakeVault) public stakeVaultForLpPool; // V3 new — Codex re-audit major 10 fix: bind each LP pool to its one Zia staking vault (mirrors ZIA_LP_VAULTS pool→vault mapping). stakeLp requires request.stakeVault == stakeVaultForLpPool[lpNftPool[tokenId]].
// NOTE: rewardsContractFor / rewardsContractForVault / pendingRewardsContractForVault are DROPPED in V3
// (Codex re-audit major 12 fix). claimRewards is an unconditional reserved slot that reverts
// RewardsNotConfigured; no rewards storage or setter ships until Zia delivers a claim ABI (v4).
```

**Swap position / spend / cooldown accounting (V2 verbatim):**
```solidity
mapping(address token => uint256 units) public positionUnits;
uint256 public dailySpent0G;
uint256 public dailyWindowStart;
uint256 public lastTradeAt;
uint256 public openExposure0G;
```

**V2 agentKey mappings (verbatim):**
```solidity
mapping(bytes32 agentKey => bool enabled) public agentKeyEnabled;
mapping(bytes32 agentKey => mapping(address token => uint256 units)) public agentPositionUnits;
mapping(bytes32 agentKey => uint256 count) public agentOpenPositionCount;
```

**V3 LP accounting (NEW):**
```solidity
// Per-agent, per-pool LP NFT custody (minted but not staked)
mapping(bytes32 agentKey => mapping(bytes32 poolId => uint256[] tokenIds)) public agentLpNfts;
mapping(uint256 tokenId => bytes32 ownerAgentKey) public lpNftOwner;     // who can unstake/zap this NFT
mapping(uint256 tokenId => bytes32 poolId) public lpNftPool;             // bind NFT to its allowlisted pool

// Per-agent, per-stake-vault staked NFTs (NFT is in the Zia vault, not the policy vault)
mapping(bytes32 agentKey => mapping(address stakeVault => uint256[] tokenIds)) public agentStakedNfts;

// LP spend/exposure (separate from swap, independently tighten-able)
uint256 public lpDailySpent0G;
uint256 public lpDailyWindowStart;
uint256 public lastLpActionAt;
uint256 public openLpExposure0G;
mapping(bytes32 agentKey => uint256) public agentLpNotionalDeployed;     // cumulative per agent (for maxLpExposure per-agent if needed)

// Per-tokenId deployed-native bookkeeping (for pro-rata openLpExposure0G reduction on decreaseLiquidity/zapOut)
mapping(uint256 tokenId => uint256) public lpNftDeployedNative;          // native 0G deployed into this NFT at mint/increase
mapping(uint256 tokenId => int24) public lpNftTickLower;                  // bind ticks at mint for ZAP_IN_INCREASE matching
mapping(uint256 tokenId => int24) public lpNftTickUpper;
```

LP exposure is tracked separately from swap exposure (`openLpExposure0G` vs `openExposure0G`) so each cap is independently tunable and tightenable. LP daily window is a separate rolling 24h window (`lpDailyWindowStart`/`lpDailySpent0G`), mirroring the V2 swap-window logic verbatim but in its own slot. LP cooldown (`lastLpActionAt`) is likewise separate. LP actions and swap actions do NOT share a cooldown (a swap does not block a mint and vice versa); this is deliberate — they are independent risk surfaces and the policy struct carries independent cooldown fields.

#### 2.1.3 Structs

**Policy (V2 6 fields verbatim + LpPolicy sub-struct):**
```solidity
struct LpPolicy {
    uint256 perLpActionCap0G;       // per-action native input cap (MINT/INCREASE)
    uint256 lpDailyCap0G;           // separate daily cap for LP capital deployment
    uint256 maxLpExposure0G;        // max total LP-deployed native
    uint256 cooldownSecondsLp;      // LP-action cooldown
    uint16  lpMinOutBps;            // slippage bps for LP amount0Min/amount1Min floors
    uint256 minLiquidityFloor;      // absolute liquidity floor (supplements bps)
    bool    allowStaking;           // gate STAKE_LP / UNSTAKE_LP / CLAIM_REWARDS entirely
}

struct Policy {
    uint256 perTradeCap0G;
    uint256 dailyCap0G;
    uint256 maxExposure0G;
    uint256 cooldownSeconds;
    uint256 maxDeadlineWindowSeconds;
    uint16  defaultMinOutBps;
    LpPolicy lp;                    // V3 new
}
```

> **Per-agent LP exposure (Critique finding 10).** `LpPolicy` has no per-agent LP cap field; `maxLpExposure0G` is shared across all agents on the vault. This is acceptable because the factory model is one-vault-per-owner (single user), and within a single user's vault the LP exposure budget is shared by design. `agentLpNotionalDeployed[agentKey]` is still tracked for observability/per-agent UI display and could back a future `maxLpExposurePerAgent0G` field if multi-agent-per-vault ever ships. Document this as a constraint: LP exposure is shared across agents on the same vault; swap exposure remains per-agent via `agentPositionUnits` (V2 verbatim).

**TradeRequest (V2 verbatim — swap path unchanged):**
```solidity
struct TradeRequest {
    address tokenIn;
    address tokenOut;
    uint256 amountIn;
    uint256 quotedAmountOut;
    uint256 amountOutMin;
    uint256 deadline;
    uint256 nonce;
    bytes32 agentKey;
    bytes32 poolId;
    bytes32 vaultActionHash;
    bytes32 actionHash;
    bytes32 policySnapshotHash;
    bytes32 auditRoot;
}
```

**LpActionType enum (NEW discriminator):**
```solidity
enum LpActionType {
    SWAP_BUY,                  // 0  — NOT used in LpActionRequest; reserved for hash parity reference
    SWAP_SELL,                 // 1  — NOT used in LpActionRequest
    ZAP_IN_MINT_LP,            // 2  — single-sided 0G mint: wrap + balancing swap + mint in ONE tx (charges LP caps). The ONLY mint path on V3.
    ZAP_IN_INCREASE_LIQUIDITY, // 3  — single-sided 0G increase on an existing tokenId: wrap + balancing swap + increaseLiquidity (charges LP caps). The ONLY increase path on V3.
    DECREASE_LIQUIDITY,        // 4
    COLLECT_FEES,              // 5
    BURN_LP,                   // 6
    STAKE_LP,                  // 7
    UNSTAKE_LP,                // 8
    SWEEP_TOKEN,               // 9  — executor-callable swap of a custodied ERC20 → another allowlisted token/native, recipient = vault
    ZAP_OUT,                   // 10 — burn LP + swap non-native leg → native back to vault
    CLAIM_REWARDS              // 11 — reserved slot, unconditionally reverts RewardsNotConfigured (no storage)
}
```

The swap path keeps V2's `bool isBuy` discriminator in `vaultActionHashFor` for swaps (V3 swap hash uses `isBuy` in the same slot as V2). LP actions use a separate `vaultActionHashForLp` with `actionType`. This split keeps the swap hash byte-identical in shape to V2 (better for indexer/server reuse) and isolates LP hash logic in its own function. The `LpActionType` enum's first two slots (`SWAP_BUY`/`SWAP_SELL`) are reserved for documentation parity only and are NOT accepted by `vaultActionHashForLp` (LP entrypoints revert `InvalidActionType` if `actionType < ZAP_IN_MINT_LP`).

> **Why two-sided `MINT_LP` / `INCREASE_LIQUIDITY` (pre-custodied tokens) are DROPPED — Codex re-audit blocker 4 fix.** The prior draft kept `MINT_LP` for tokens "pre-positioned via a prior `buy`/`SWEEP_TOKEN`" with an undefined `amountIn0G`. That opens the LP-cap bypass: `buy` charges only swap caps and lands tokens in `positionUnits`; a follow-up `mintLp` with `amountIn0G == 0` charges NO LP caps. There is no clean way to charge LP caps on pre-custodied tokens without a parallel `lpCustodyBalance` accounting system that distinguishes LP-derived tokens from swap-acquired tokens — too much surface for v1. V3 therefore ships ONLY single-sided native capital deployment: `ZAP_IN_MINT_LP` (new position) and `ZAP_IN_INCREASE_LIQUIDITY` (existing position). Both take native 0G in (`amount0Desired`), charge the full `amountIn0G` against `perLpActionCap0G`/`lpDailyCap0G`/`maxLpExposure0G`, and use ONE delta convention (see §12 item 5). The keeper composes auto-compound as `collectFees` → `SWEEP_TOKEN` (fees → native) → `ZAP_IN_INCREASE_LIQUIDITY`; auto-rebalance as `unstakeLp`/`zapOut` → `SWEEP_TOKEN` → `ZAP_IN_MINT_LP`/`stakeLp`. No two-sided-from-pre-custodied path exists, so the bypass is closed by construction.

> **Why `ZAP_IN_MINT_LP` exists (Critique finding 3 fix).** A single-sided 0G mint done as two separate actions (`buy` then a two-sided mint) bypasses the LP cap system. `ZAP_IN_MINT_LP` does wrap+swap+mint in one proof-anchored action and charges the full `amountIn0G` against LP caps. The LP adapter embeds exactly one `swapExactIn` call against its immutable `swapRouter` — this is narrow (allowlisted router, fixed W0G wrap, recipient hard-pinned to the vault) and is NOT arbitrary calldata pass-through.

> **Why `SWEEP_TOKEN` exists (Critique finding 4 fix).** `decreaseLiquidity`/`collectFees`/auto-claim-on-unstake deposit ERC20 (fees/rewards) into the vault. The V2 `sell` path requires `positionUnits[tokenIn] >= amountIn` and is native-out only, so it cannot rebalance fee tokens. `SWEEP_TOKEN` is an executor-callable swap of a custodied allowlisted ERC20 → another allowlisted ERC20 (or native), recipient hard-pinned to `address(this)`, `amountOutMin > 0`, gated by LP policy + LP cooldown. Funds never leave the vault. This makes auto-compound (`collectFees` → `SWEEP_TOKEN` → `ZAP_IN_INCREASE_LIQUIDITY`) and auto-rebalance (`SWEEP_TOKEN` → `ZAP_IN_MINT_LP`) feasible off-chain without a v4.

**LpActionRequest (NEW):**
```solidity
struct LpActionRequest {
    uint8   actionType;          // LpActionType, must be >= ZAP_IN_MINT_LP (2)
    bytes32 agentKey;            // V2 carry-over
    bytes32 poolId;              // LP pool allowlist key (allowedLpPools, pool-address-encoded) for ALL LP actions
                                 // including SWEEP_TOKEN. The V2 allowedPools (curated route IDs) is NOT used by any
                                 // LP action. Encoding: bytes32(uint256(uint160(poolAddress))) — recoverable (see §2.1.12). NOT keccak256.

    address stakeVault;          // STAKE/UNSTAKE only; address(0) otherwise
    address tokenIn;             // SWEEP_TOKEN only (executor-supplied, allowlist-validated); address(0) otherwise
    address tokenOut;            // SWEEP_TOKEN only; address(0) otherwise (NATIVE_TOKEN = address(0) allowed for tokenOut)

    // Position identifiers
    uint256 tokenId;             // 0 for ZAP_IN_MINT_LP; > 0 for all others that act on an existing NFT
    int24   tickLower;           // ZAP_IN_MINT_LP / ZAP_IN_INCREASE_LIQUIDITY (must match stored lpNftTicks for INCREASE)
    int24   tickUpper;

    // Amounts (semantics vary by actionType; validated in _validateLpRequest)
    uint256 amount0Desired;      // ZAP_IN_MINT/ZAP_IN_INCREASE: native 0G input (= amountIn0G, charged to LP caps)
                                 // SWEEP_TOKEN: amount of tokenIn to swap
    uint256 amount1Desired;      // unused on V3 (single-sided native paths); 0
    uint128 liquidity;           // Codex round-4 BLOCKER 1 fix: uint128 (NFPM liquidity is uint128) — no truncation gap
                                 // between adapter call and accounting. ZAP_IN_MINT: min liquidity floor;
                                 // ZAP_IN_INCREASE: min liquidity added; DECREASE/ZAP_OUT: liquidity to burn;
                                 // 0 for COLLECT/BURN/STAKE/UNSTAKE/SWEEP/CLAIM. For DECREASE/ZAP_OUT, per-action
                                 // validation asserts request.liquidity <= lpAdapter.liquidityOf(tokenId).
    uint256 amount0Min;          // > 0 for ZAP_IN_MINT/ZAP_IN_INCREASE/DECREASE/ZAP_OUT (native/token0 floor)
    uint256 amount1Min;          // > 0 for ZAP_IN_MINT/ZAP_IN_INCREASE/DECREASE/BURN (token1 floor); SWEEP: amountOutMin floor

    // Quoted outputs (Codex re-audit major 9 fix — make lpMinOutBps enforceable). Each min is validated
    // against minLpOutFor(quote) in _validateLpRequest (Codex round-4 major 3 fix: ceilDiv, not
    // floor div, so a tiny nonzero residual cannot round the floor to 0 and bypass the min-out rule). Quoted
    // values are bound in vaultActionHashForLp.
    uint128 quotedLiquidity;     // expected liquidity for ZAP_IN_MINT/ZAP_IN_INCREASE; 0 otherwise (uint128 — NFPM type)
    uint256 quotedAmount0;       // expected token0 returned for DECREASE; 0 otherwise
    uint256 quotedAmount1;       // expected token1 returned for DECREASE/BURN; 0 otherwise
    uint256 quotedAmountOut;     // expected native out for ZAP_OUT; expected tokenOut for SWEEP_TOKEN; 0 otherwise

    // V2 carry-over proof/policy fields
    uint256 deadline;
    uint256 nonce;
    bytes32 vaultActionHash;
    bytes32 actionHash;
    bytes32 policySnapshotHash;
    bytes32 auditRoot;
}
```

`amount0Min`/`amount1Min` are explicit fields (NOT a packed `amountOutMin`) so the "never zero min-out" invariant is honest per action. For `ZAP_OUT` (single native output), `amount0Min` is the native-out floor and `amount1Min == 0` is allowed (validated per-action). For `SWEEP_TOKEN`, `amount1Min` is the `amountOutMin` floor (nonzero required). For `COLLECT_FEES`/`STAKE_LP`/`UNSTAKE_LP`/`CLAIM_REWARDS`, both min fields are `0` (no output to floor — these are custody moves; the security is the allowlist + recipient hard-pinned to vault).

`tokenIn`/`tokenOut` are only read by `SWEEP_TOKEN` (validated against `allowedTokens` + `allowedLpPools` in `_validateLpRequest`; `tokenOut == NATIVE_TOKEN` is normalized to `wrappedNative` for the pool-pair check — Codex round-4 major 4 fix); all other action types require `tokenIn == address(0) && tokenOut == address(0)` (else `InvalidActionType`). Both fields are bound into `vaultActionHashForLp` so a compromised executor cannot swap a sweep's tokens post-sign.

#### 2.1.4 Events

**V2 events kept verbatim:** `Deposited`, `ExecutorRevoked`, `NativeWithdrawn`, `PoolDisabled`, `PoolAllowed`, `PairMinOutBpsTightened`, `PausedSet`, `PolicyTightened`, `TokenAllowed`, `TokenDisabled`, `TokenRescued`, `TradeExecuted`, `AgentKeyEnabledSet`, `TradeExecutedV2`. `buy`/`sell` emit BOTH `TradeExecuted` and `TradeExecutedV2` exactly as V2 does.

**V3 new events:**
```solidity
event LpPoolAllowed(bytes32 indexed lpPoolId);
event LpPoolDisabled(bytes32 indexed lpPoolId);
event StakeVaultAllowed(address indexed stakeVault);
event StakeVaultDisabled(address indexed stakeVault);
event LpPolicyTightened(LpPolicy lpPolicy);

event LpActionExecutedV3(
    bytes32 indexed actionHash,
    bytes32 indexed agentKey,
    uint8   indexed actionType,
    bytes32 poolId,
    uint256 tokenId,
    uint256 nativeIn,           // 0G consumed on ZAP_IN_MINT/ZAP_IN_INCREASE (and on the wrap leg of ZAP_OUT's swap)
    uint256 nativeOut,          // 0G returned on ZAP_OUT
    int256  liquidityDelta,     // Codex re-audit major 14 fix: signed. + on ZAP_IN_MINT/ZAP_IN_INCREASE, - on DECREASE/BURN/ZAP_OUT
    bytes32 auditRoot,
    bytes32 policySnapshotHash
);

event Staked(bytes32 indexed agentKey, uint256 indexed tokenId, address indexed stakeVault, bytes32 poolId);
event Unstaked(bytes32 indexed agentKey, uint256 indexed tokenId, address indexed stakeVault, bytes32 poolId);
event OwnerUnstaked(uint256 indexed tokenId, address indexed stakeVault);
event NftRescued(address indexed nft, uint256 indexed tokenId, address indexed to);
```

> `RewardsContractSet` is DROPPED (Codex re-audit major 12 fix — no rewards storage or setter ships in V3). `OwnerUnstaked` + `NftRescued` are added for the owner-rescue audit trail (§2.1.8).

#### 2.1.5 Custom errors

**V2 errors kept verbatim:** `AdapterBlocked`, `BadDelta`, `BadPolicy`, `CooldownActive`, `DailyCapExceeded`, `DeadlineExpired`, `DeadlineTooFar`, `ExecutorIsRevoked`, `InvalidAdapter`, `InvalidAmount`, `InvalidAgentKey`, `InvalidProof`, `InvalidRecipient`, `InvalidTradePair`, `NotAllowed`, `LowMinOut`, `MaxExposureExceeded`, `NotExecutor`, `Paused`, `Replay`, `TradeCapExceeded`, `UnexpectedValue`.

**V3 new errors:**
```solidity
error LpAdapterNotConfigured();
error LpBadDelta();
error LpCapExceeded();
error LpDailyCapExceeded();
error LpExposureExceeded();
error LpCooldownActive();
error InvalidActionType();
error InvalidLpPool();
error InvalidStakeVault();
error InvalidLpAmount();
error LpInvalidMinOut();        // min < ceilDiv(quoted * lpMinOutBps, BPS) (renamed from InvalidLpMinOut for Lp-prefix consistency — Codex round-3 minor 1 fix; ceilDiv per round-4 major 3 fix)
error NotAgentLpNft();          // tokenId not owned by the agentKey
error StakingDisabled();        // policy.lp.allowStaking == false
error RewardsNotConfigured();   // claimRewards called — always reverts (no rewards storage on V3)
error LpPositionNotEmpty();     // burnLp / stakeLp on a tokenId with nonzero liquidity
error NotStakedNft();           // unstakeLp on a tokenId not in agentStakedNfts
error PoolMismatch();           // Codex round-2 major 2: request.poolId != lpNftPool[tokenId] on a tokenId action
error LpLiquidityFloor();       // Codex round-2 major 1: request.liquidity < policy.lp.minLiquidityFloor on a mint/increase
error LpTickMismatch();         // Codex round-3 minor 2 fix: zapInIncreaseLiquidity tickLower/tickUpper != stored lpNftTicks (was BadPolicy)
error LpPoolNotZappable();      // Codex round-3 major fix: zapInMintLp/zapInIncreaseLiquidity on a non-W0G-leg pool
```

#### 2.1.6 Modifiers (V2 verbatim + LP variants)

```solidity
modifier onlyExecutor() { ... }       // V2 verbatim
modifier executorActive() { ... }     // V2 verbatim

// LP entrypoints use the same executorActive gate (paused/revoked blocks LP too)
// plus an lpAdapterConfigured gate:
modifier lpAdapterConfigured() {
    if (address(lpAdapter) == address(0)) revert LpAdapterNotConfigured();
    _;
}
```

`nonReentrant` from `ReentrancyGuard` applied to `withdrawNative`, `rescueToken`, `buy`, `sell`, and all stateful LP entrypoints EXCEPT `claimRewards` (Codex round-6 major 1 fix — `claimRewards` is a standalone no-modifier entrypoint that only reverts, so it is exempt from `nonReentrant` as well as from `onlyExecutor`/`executorActive`/`lpAdapterConfigured`).

#### 2.1.7 Constructor

```solidity
constructor(
    address initialOwner,
    address executor_,
    address adapter_,
    address lpAdapter_,                 // V3 new; address(0) allowed (swap-only vault)
    address proofRegistry_,
    Policy memory initialPolicy,        // includes LpPolicy sub-struct
    address[] memory initialAllowedTokens,
    bytes32[] memory initialAllowedPools,
    bytes32[] memory initialAllowedLpPools,    // V3 new
    address[] memory initialAllowedStakeVaults, // V3 new
    address[] memory initialStakeVaultForLpPool, // V3 new — parallel to initialAllowedLpPools; stakeVaultForLpPool[poolId], address(0) allowed (no staking for that pool)
    bool allowMockAdapter,
    bool allowMockLpAdapter                    // V3 new
) Ownable(initialOwner)
```

Constructor body:
- All V2 validation verbatim (nonzero owner/executor/adapter/proofRegistry, code-length checks, `_validatePolicy`, non-empty token/pool allowlists, mock-swap-adapter mainnet gate).
- **V3 additions:**
  - `lpAdapter_` may be `address(0)` (swap-only vault) OR a contract with nonzero code. If nonzero code, validate `lpAdapter.lpAdapterKind() != bytes32(0)`.
  - Mock LP adapter gate: if `lpAdapter_ != address(0)` and `lpAdapter.lpAdapterKind() == MOCK_LP_ADAPTER_KIND`, require `allowMockLpAdapter && block.chainid != MAINNET_CHAIN_ID` else `AdapterBlocked()`. (Same shape as the swap mock gate.)
  - `initialAllowedLpPools` may be empty (LP disabled at construction) — do NOT revert on empty LP pool list (unlike swap pools which must be non-empty). Same for `initialAllowedStakeVaults`.
  - Require `initialStakeVaultForLpPool.length == initialAllowedLpPools.length` (parallel arrays) else `BadPolicy()`. For each `i`: if `initialStakeVaultForLpPool[i] != address(0)`, require `allowedStakeVaults[initialStakeVaultForLpPool[i]]` (else `NotAllowed()`) and set `stakeVaultForLpPool[initialAllowedLpPools[i]] = initialStakeVaultForLpPool[i]`. This binds each LP pool to its Zia vault at construction (Codex re-audit major 10 fix — pool→vault binding seeded, not left undefined for the executor to fill).
  - Seed `allowedLpPools` and `allowedStakeVaults` allowlists; emit `LpPoolAllowed` / `StakeVaultAllowed` per entry.
  - `_validateLpPolicy(initialPolicy.lp)` — bounds check: `lpMinOutBps` in `(0, BPS]`, `maxDeadlineWindowSeconds` reuse (LP uses the same deadline window as swaps, no separate field), `maxLpExposure0G` either `type(uint256).max` (unbounded sentinel — parity with V2 cap semantics where `type(uint256).max` means unbounded) OR a finite value `>= perLpActionCap0G`. Document the sentinel convention in natspec and tests.

#### 2.1.8 External functions — swap path (V2 VERBATIM except `receive()`)

Kept **byte-for-byte identical** to V2 (signatures, bodies, hash composition, events, delta checks) EXCEPT `receive()`, which is extended to also accept native from the LP adapter (Codex re-audit blocker 5 fix: `zapOut`/`zapInMintLp`'s wrap/unwrap path sends native from `lpAdapter` via `W0G.withdraw`, which V2's `receive()` would reject):

```solidity
function receive() external payable {
    if (msg.sender != owner() && msg.sender != address(adapter) && msg.sender != address(lpAdapter)) {
        revert NotAllowed();
    }
}
function depositNative() external payable onlyOwner
function withdrawNative(uint256 amount) external onlyOwner nonReentrant
function rescueToken(address token, uint256 amount) external onlyOwner nonReentrant
function setPaused(bool value) external onlyOwner
function revokeExecutor() external onlyOwner
function setAgentKeyEnabled(bytes32 agentKey, bool enabled) external onlyOwner
function setAgentKeysEnabled(bytes32[] calldata agentKeys, bool enabled) external onlyOwner
function disableToken(address token) external onlyOwner
function disablePool(bytes32 poolId) external onlyOwner
function tightenPolicy(Policy calldata nextPolicy) external onlyOwner
function tightenPairMinOutBps(address tokenIn, address tokenOut, uint16 minOutBps) external onlyOwner
function buy(TradeRequest calldata request) external payable onlyExecutor executorActive nonReentrant returns (uint256 amountOut)
function sell(TradeRequest calldata request) external payable onlyExecutor executorActive nonReentrant returns (uint256 amountOut)
function minOutBpsFor(address tokenIn, address tokenOut) public view returns (uint16)
function minOutFor(address tokenIn, address tokenOut, uint256 quotedAmountOut) public view returns (uint256)
function policyHash() public view returns (bytes32)
function actionHashFor(bytes32 vaultActionHash, bytes32 auditRoot, bytes32 policySnapshotHash) public pure returns (bytes32)
function vaultActionHashFor(bool isBuy, TradeRequest calldata request) public view returns (bytes32)

// V3 NEW — owner-only ERC721 rescue (Critique finding 1 fix). Without this, every LP NFT
// custodied by the vault AND every NFT deposited into a Zia staking vault is permanently
// stranded once revokeExecutor() or setPaused(true) fires (all LP entrypoints are
// onlyExecutor executorActive). Recipient is hard-pinned to owner() — never executor-supplied.
function rescueNft(address nft, uint256 tokenId) external onlyOwner nonReentrant
// V3 NEW — owner-only unstake for a stranded staked NFT. Calls IZiaVault(stakeVault).withdraw(tokenId)
// directly (Codex re-audit blocker 1 fix: the vault is the depositor of record, so the vault — not an
// adapter — must call ZiaVault.withdraw). Used only when the executor is revoked/paused and the owner
// must recover a staked NFT from a Zia vault. stakeVault must be in allowedStakeVaults.
function unstakeLpOwner(uint256 tokenId, address stakeVault) external onlyOwner nonReentrant
```

`buy`/`sell` bodies are V2 verbatim including the `BadDelta` triple-check, `forceApprove`→call→`forceApprove(…,0)` on sell, `_validateAgentKey`, `_validateBuySpendPolicy`, `_validateCooldown`, `_markAction`, `_recordBuySpend`, `_reduceOpenExposure`, `_recordTradeTimestamp`, and the dual `TradeExecuted` + `TradeExecutedV2` emits. **No LP state is touched on the swap path** (no mutation of `openLpExposure0G`, `lpDailySpent0G`, `agentLpNfts`, etc.).

`receive()` is the ONLY swap-path function whose body changes: V2 accepts native only from `owner()` or `address(adapter)`; V3 adds `address(lpAdapter)` so `zapOut`/`zapInMintLp`'s `W0G.withdraw` → native return to the vault is not reverted. If `lpAdapter == address(0)` (swap-only vault), the extra clause is harmless (no LP native returns happen). This does NOT loosen swap security — it only authorizes the curated LP adapter's native return, which is a fund-return path, not a fund-exit path.

`rescueNft` body: assert `IERC721(nft).ownerOf(tokenId) == address(this)` (vault holds it), then `IERC721(nft).transferFrom(address(this), owner(), tokenId)`. Recipient is `owner()` only — no `to` parameter. Emit `NftRescued(nft, tokenId, owner())`. This is the owner's recovery path for LP NFTs custodied by the vault when the executor is revoked. It does NOT bypass allowlists (the NFT is already in the vault; rescue just returns it to the owner). Negative test: executor cannot call `rescueNft`; a `to != owner()` is impossible by construction (no `to` arg).

`unstakeLpOwner` body: assert `stakeVault` in `allowedStakeVaults`, assert `tokenId` is in `agentStakedNfts[<any agentKey>][stakeVault]` (owner can recover any agent's stranded staked NFT — this is the owner's fund-recovery escape hatch; the agent attribution is preserved in `lpNftOwner[tokenId]`), assert `IZiaVault(stakeVault).depositorOf(tokenId) == address(this)` (vault is depositor of record), call `IZiaVault(stakeVault).withdraw(tokenId)` directly (vault-direct, no adapter), post-flight assert `NFPM.ownerOf(tokenId) == address(this)`, remove from `agentStakedNfts`, push back to `agentLpNfts[lpNftOwner[tokenId]][lpNftPool[tokenId]]`. Emit `Unstaked(...)` + `OwnerUnstaked(tokenId, stakeVault)`. Negative test: executor cannot call it.

`tightenPolicy` is EXTENDED (see 2.1.9) — the only swap-path function whose body changes, because the `Policy` struct grew. `actionHashFor`, `vaultActionHashFor(bool,TradeRequest)`, `_policyHash` are EXTENDED (see 2.1.10) — `_policyHash` body grows because `Policy` grew.

#### 2.1.9 `tightenPolicy` — extended tightening rules

V2 swap-field tightening rules are kept verbatim (perTradeCap ≤, dailyCap ≤, maxExposure ≤, cooldown ≥, maxDeadlineWindowSeconds ≤, defaultMinOutBps ≥). Add explicit clauses for every LpPolicy field:

```solidity
function tightenPolicy(Policy calldata nextPolicy) external onlyOwner {
    _validatePolicy(nextPolicy);
    Policy memory current = policy;
    // V2 verbatim swap-field clauses
    if (
        nextPolicy.perTradeCap0G > current.perTradeCap0G || nextPolicy.dailyCap0G > current.dailyCap0G
            || nextPolicy.maxExposure0G > current.maxExposure0G
            || nextPolicy.cooldownSeconds < current.cooldownSeconds
            || nextPolicy.maxDeadlineWindowSeconds > current.maxDeadlineWindowSeconds
            || nextPolicy.defaultMinOutBps < current.defaultMinOutBps
    ) { revert BadPolicy(); }
    // V3 LP clauses (same only-tighten discipline)
    LpPolicy memory n = nextPolicy.lp;
    LpPolicy memory c = current.lp;
    if (
        n.perLpActionCap0G > c.perLpActionCap0G ||
        n.lpDailyCap0G > c.lpDailyCap0G ||
        n.maxLpExposure0G > c.maxLpExposure0G ||
        n.cooldownSecondsLp < c.cooldownSecondsLp ||
        n.lpMinOutBps < c.lpMinOutBps ||
        (n.allowStaking && !c.allowStaking)           // Codex re-audit blocker 2 fix: turning staking ON is looser (adds STAKE/UNSTAKE/CLAIM capability) = forbidden; turning OFF is tighter = allowed
    ) { revert BadPolicy(); }
    // minLiquidityFloor: raising the floor = stricter slippage protection = tighter (allowed).
    // Lowering the floor = looser (forbidden). Standalone clause with the correct direction.
    if (n.minLiquidityFloor < c.minLiquidityFloor) revert BadPolicy();
    policy = nextPolicy;
    emit PolicyTightened(nextPolicy);
    emit LpPolicyTightened(nextPolicy.lp);
}
```

> `minLiquidityFloor` direction is load-bearing: a higher floor = stricter slippage protection = tighter (allowed); lowering = looser (forbidden, reverts `BadPolicy`). The standalone clause above encodes this correctly. Getting it backwards lets admin loosen LP slippage protection silently, violating AGENTS.md "admin must not loosen policy."

> `allowStaking` direction (Codex re-audit blocker 2 fix): the prior draft reverted on `(!n.allowStaking && c.allowStaking)` — i.e. it FORBADE turning staking OFF, which is the tighter direction — the exact inverse of correct. V3 reverts on `(n.allowStaking && !c.allowStaking)`: turning staking ON (adding the STAKE_LP/UNSTAKE_LP/CLAIM_REWARDS capabilities) is a loosening and forbidden; turning OFF is tighter and allowed. Test in §6.1: turning `allowStaking` false succeeds; turning true reverts `BadPolicy`.

`_validatePolicy` bounds:
```solidity
function _validatePolicy(Policy memory candidate) private pure {
    if (
        candidate.maxDeadlineWindowSeconds == 0 || candidate.maxDeadlineWindowSeconds > 1 days
            || candidate.defaultMinOutBps == 0 || candidate.defaultMinOutBps > BPS
    ) { revert BadPolicy(); }
    _validateLpPolicy(candidate.lp);
}

function _validateLpPolicy(LpPolicy memory lp) private pure {
    if (lp.lpMinOutBps == 0 || lp.lpMinOutBps > BPS) revert BadPolicy();
    // perLpActionCap0G, lpDailyCap0G, maxLpExposure0G, cooldownSecondsLp, minLiquidityFloor
    // have no explicit bounds (only relative tighten rules + the per-action validation).
    // allowStaking is a bool, no bounds.
}
```

**LP allowlist tightening (one-way, mirror V2 `disableToken`/`disablePool`):**
```solidity
function disableLpPool(bytes32 lpPoolId) external onlyOwner
function disableStakeVault(address stakeVault) external onlyOwner
```

**NO rewards-setter functions on V3 (Codex re-audit major 12 fix).** The prior draft shipped `proposeRewardsContract`/`acceptRewardsContract`/`clearRewardsContract` plus a `rewardsContractFor`/`rewardsContractForVault` dual-keyed storage, while §12 simultaneously recommended "no timelock" — contradictory and NOT VERIFIED. V3 ships NO rewards storage and NO setter. `claimRewards` is an unconditional reserved slot that reverts `RewardsNotConfigured` (see §2.1.11). When Zia later delivers a claim/pendingRewards ABI, v4 adds the stake-vault-keyed two-step timelock (`proposeRewardsContract(stakeVault,…)` + `acceptRewardsContract(stakeVault)` after 24h) together with the storage — at that point enabling `claimRewards` is a new funds-pulling action and the timelock is the AGENTS.md-required gate. Shipping the setter now with no claim ABI is dead, contradictory surface; it is dropped.

There is NO `allowLpPool` / `allowStakeVault` re-enable function (one-way disable only, mirroring V2's `disableToken`/`disablePool` which have no re-enable). Initial allowlist seeding happens only in the constructor. If a vault needs a new LP pool post-deploy, the answer is a new vault (v4), not a re-allow. This is the strictest reading of AGENTS.md "admin must not loosen policy." The migrate path (§4.1) constructs the V3 vault with LP either disabled (empty arrays, `lpAdapter == address(0)`) or fully seeded from the canonical `ZIA_LP_VAULTS` at construction time — there is no post-deploy LP-enable path.

#### 2.1.10 Hashes — extended

**`actionHashFor` — UNCHANGED (V2 verbatim):**
```solidity
return keccak256(abi.encode("4LPHA_0G_POLICY_VAULT_PROOF", vaultActionHash, auditRoot, policySnapshotHash));
```

**`vaultActionHashFor(bool, TradeRequest)` — UNCHANGED for swap path (V2 verbatim), domain tag bumped:**
> Decision: keep the V2 domain tag `"4LPHA_0G_POLICY_VAULT_ACTION"` for the swap path on V3. Rationale: the swap `vaultActionHash` is recomputed on-chain from the request; the server reads it on-chain via `vaultActionHashFor(...)`. Since V3 is a new contract instance, there is no cross-version hash collision risk (a V2 `vaultActionHash` and a V3 `vaultActionHash` for the same swap fields would only collide if `block.chainid`, `address(this)`, `owner()`, `executor`, `adapter`, `proofRegistry` all matched — impossible across versions). Bumping the tag would break indexer parity for no security gain. Keep V2 tag for swaps.

So `vaultActionHashFor(bool isBuy, TradeRequest calldata request)` on V3 is **byte-for-byte V2 verbatim**, including the `"4LPHA_0G_POLICY_VAULT_ACTION"` domain tag and the exact 19-field order.

**`vaultActionHashForLp(LpActionRequest)` — NEW, distinct domain tag:**
```solidity
function vaultActionHashForLp(LpActionRequest calldata request) public view returns (bytes32) {
    return keccak256(abi.encode(
        "4LPHA_0G_POLICY_VAULT_ACTION_LP",   // distinct domain tag — LP actions never collide with swap actions
        block.chainid,
        address(this),
        owner(),
        executor,
        address(adapter),
        address(lpAdapter),
        address(proofRegistry),
        request.actionType,          // uint8 discriminator
        request.agentKey,
        request.poolId,
        request.stakeVault,
        request.tokenIn,             // Codex re-audit blocker 3 fix: bind sweep routing
        request.tokenOut,            //   so a compromised executor cannot retarget a SWEEP_TOKEN post-sign
        request.tokenId,
        request.tickLower,
        request.tickUpper,
        request.amount0Desired,
        request.amount1Desired,
        request.liquidity,
        request.amount0Min,
        request.amount1Min,
        request.quotedLiquidity,     // Codex re-audit major 9 fix: bind quoted outputs so lpMinOutBps is enforceable
        request.quotedAmount0,
        request.quotedAmount1,
        request.quotedAmountOut,
        request.deadline,
        request.nonce,
        request.policySnapshotHash,
        request.auditRoot
    ));
}
```

Distinct domain tag `..._ACTION_LP` guarantees no collision between a swap `vaultActionHash` and an LP `vaultActionHash` even on identical primitive fields. `actionType` discriminator guarantees no collision between distinct LP action types. The `agentKey` slot is preserved (V2 parity for server-side hash builder reuse). `address(lpAdapter)` is mixed so a compromised executor cannot retarget an LP action to a different adapter address even if both are allowlisted. `tokenIn`/`tokenOut`/`quotedLiquidity`/`quotedAmount0`/`quotedAmount1`/`quotedAmountOut` are bound so the executor cannot swap a sweep's routing or inflate a quoted output after the keeper signed (the on-chain `min >= minLpOutFor(quote)` check uses the same quoted values the hash binds).

**`_policyHash` — extended to include LpPolicy:**
```solidity
function _policyHash(Policy memory candidate) private pure returns (bytes32) {
    return keccak256(abi.encode(
        candidate.perTradeCap0G,
        candidate.dailyCap0G,
        candidate.maxExposure0G,
        candidate.cooldownSeconds,
        candidate.maxDeadlineWindowSeconds,
        candidate.defaultMinOutBps,
        candidate.lp.perLpActionCap0G,
        candidate.lp.lpDailyCap0G,
        candidate.lp.maxLpExposure0G,
        candidate.lp.cooldownSecondsLp,
        candidate.lp.lpMinOutBps,
        candidate.lp.minLiquidityFloor,
        candidate.lp.allowStaking
    ));
}
```

Allowlist arrays (`allowedLpPools`, `allowedStakeVaults`) are NOT hashed into `_policyHash` — they are runtime-mutable via `disableLpPool`/`disableStakeVault` (one-way), so hashing them into `policySnapshotHash` would invalidate outstanding requests whenever an allowlist entry is disabled (which is the desired behavior for a disabled pool, since `_validateLpRequest` re-checks `allowedLpPools[poolId]` live). The per-request `policySnapshotHash` binds the numeric policy; the live allowlist check binds the pool/vault membership. This mirrors V2's design where `allowedPools` is not in `_policyHash` but is checked live in `buy`/`sell`.

#### 2.1.11 LP entrypoints — signatures & bodies

All LP entrypoints share this skeleton:
```solidity
function <name>(LpActionRequest calldata request)
    external payable onlyExecutor executorActive lpAdapterConfigured nonReentrant
    returns (...)
```

> **`claimRewards` is EXEMPT from this skeleton (Codex round-5 major 1 fix).** It is a standalone no-modifier entrypoint: `function claimRewards(LpActionRequest calldata) external payable { revert RewardsNotConfigured(); }` — NO `onlyExecutor`, NO `executorActive`, NO `lpAdapterConfigured`, NO `nonReentrant`. Any of those modifiers would let `NotExecutor`/`Paused`/`ExecutorIsRevoked`/`LpAdapterNotConfigured` fire before `RewardsNotConfigured`, contradicting the "immediately on entry, unconditionally" label. The body is the single `revert` statement and nothing else.

Common pre-flight (in `_validateLpRequest`):
1. `request.actionType >= ZAP_IN_MINT_LP` (else `InvalidActionType`).
2. `request.deadline >= block.timestamp` (else `DeadlineExpired`) and `<= block.timestamp + policy.maxDeadlineWindowSeconds` (else `DeadlineTooFar`).
3. Per-action amount/min/quoted validation (see per-action blocks) — nonzero where required, and every min validated against its quoted output via `minLpOutFor(quote)` (Codex re-audit major 9 fix; ceilDiv per round-4 major 3 fix so a tiny nonzero quote cannot round the floor to 0), else `InvalidLpAmount`/`LpInvalidMinOut`.
4. `request.tokenIn == address(0) && request.tokenOut == address(0)` UNLESS `actionType == SWEEP_TOKEN` (else `InvalidActionType`) — Codex re-audit blocker 3 fix.
5. `request.policySnapshotHash == _policyHash(policy)` (else `InvalidProof`).
6. `request.vaultActionHash == vaultActionHashForLp(request)` (else `InvalidProof`).
7. `request.actionHash == actionHashFor(request.vaultActionHash, request.auditRoot, request.policySnapshotHash)` (else `InvalidProof`).
8. `proofRegistry.isAccepted(request.actionHash, request.auditRoot, request.policySnapshotHash, request.vaultActionHash)` (else `InvalidProof`).
9. `!usedActionHashes[request.actionHash]` (else `Replay`).
10. `_validateAgentKey(request.agentKey)`.
11. **Pool allowlist — single LP namespace (Codex round-3 blocker fix):** every LP action including `SWEEP_TOKEN` requires `allowedLpPools[request.poolId]` (LP pool namespace, pool-address-encoded — recoverable so the adapter can re-derive the pool). SWEEP additionally requires `allowedTokens[request.tokenIn] && (request.tokenOut == NATIVE_TOKEN || allowedTokens[request.tokenOut])`. The V2 swap `allowedPools` (curated route IDs `keccak256("4LPHA_0G_ROUTE:...")`) is NOT touched by any LP action. Else `InvalidLpPool` / `NotAllowed`.
12. **LP cooldown — action-type-aware (Codex re-audit major 13 fix):** the cooldown check is NOT in the common pre-flight. It runs ONLY for capital-deploying actions (`ZAP_IN_MINT_LP`, `ZAP_IN_INCREASE_LIQUIDITY`, `STAKE_LP`, `SWEEP_TOKEN`) inside their per-action block: `policy.lp.cooldownSecondsLp == 0 || lastLpActionAt == 0 || block.timestamp >= lastLpActionAt + policy.lp.cooldownSecondsLp` (else `LpCooldownActive`). Capital-returning actions (`DECREASE_LIQUIDITY`, `COLLECT_FEES`, `BURN_LP`, `UNSTAKE_LP`, `ZAP_OUT`) are EXEMPT — emergency withdraw always available. `CLAIM_REWARDS` is NOT listed here because it is carved out of `_validateLpRequest` entirely (Codex round-4 major 2 fix) and reverts `RewardsNotConfigured` before reaching the cooldown check.

Then per-action validation + adapter call + delta check + accounting + emit. Common post-flight: `_markLpAction(request.actionHash)` (sets `usedActionHashes[actionHash] = true`). Capital-deploying actions additionally call `_recordLpActionTimestamp()` (sets `lastLpActionAt = block.timestamp`); capital-returning actions do NOT reset the cooldown clock.

> **`mintLp` (two-sided from pre-custodied tokens) is DROPPED — Codex re-audit blocker 4 fix.** See §2.1.3 enum note. The ONLY mint entrypoint is `zapInMintLp`; the ONLY increase entrypoint is `zapInIncreaseLiquidity`. Both are single-sided native, charging the full `amountIn0G` against LP caps, using one delta convention (§12 item 5). This closes the `buy`-then-`mintLp` cap bypass by construction.

**`zapInMintLp(LpActionRequest) returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)`:** (the ONLY mint entrypoint on V3 — Codex re-audit blocker 4 fix)
- Per-action: `actionType == ZAP_IN_MINT_LP`, `tokenId == 0`, `tickLower < tickUpper`, `amount0Desired > 0` (the native 0G input = `amountIn0G`, charged to LP caps), `amount1Desired == 0` (unused; the paired side is acquired by the adapter's internal swap), `liquidity > 0` (min liquidity floor), `liquidity >= policy.lp.minLiquidityFloor` (else `LpLiquidityFloor` — Codex round-2 major 1 fix), `quotedLiquidity > 0`, `amount0Min > 0 && amount1Min > 0`, `liquidity >= minLpOutFor(quotedLiquidity)` (else `LpInvalidMinOut`), `amount0Min >= minLpOutFor(quotedAmount0) && amount1Min >= minLpOutFor(quotedAmount1)` (else `LpInvalidMinOut`), `stakeVault == address(0)`. Cooldown applies (deploying).
- **W0G-leg requirement (Codex round-3 major fix):** the target pool MUST have W0G as one leg (`token0 == wrappedNative || token1 == wrappedNative`), else revert `LpPoolNotZappable`. The single-sided native zap is `wrap 0G → W0G` + ONE balancing swap `W0G ↔ non-W0G leg` via the target pool itself + `NFPM.mint`. This works for the 6 W0G-leg `ZIA_LP_VAULTS` pools (USDC/W0G, W0G/WETH, WBTC/W0G, W0G/USDC, W0G/WBTC, W0G/WETH-0.3%). The 5 non-W0G pools (USDC/USDT, USDC/WETH, USDC/LINK, USDC/SOL, WBTC/USDC) revert `LpPoolNotZappable` on V3 — they require a multi-hop zap (wrap → W0G→leg0 via a routing pool → leg0→leg1 via the target pool → mint) which is deferred to v4 (see §1 v4-triggers updated). This keeps the adapter to ONE swap + mint (narrow, auditable) and is honest about V3 coverage.
- LP spend policy: `amountIn0G = amount0Desired` checked against `perLpActionCap0G` (else `LpCapExceeded`), `lpDailyCap0G` (else `LpDailyCapExceeded`), `openLpExposure0G + amountIn0G <= maxLpExposure0G` (else `LpExposureExceeded`).
- Adapter call: vault wraps `amountIn0G` 0G → W0G (`W0G.deposit{value: amountIn0G}`), `forceApprove`s the LP adapter for the W0G, calls `lpAdapter.zapInMintLp(ZapInMintParams{poolId, vaultAddress, token0, token1, fee, tickLower, tickUpper, amount0G: amountIn0G, amount0Min, amount1Min, deadline})`. The adapter asserts the W0G-leg requirement, does ONE `swapExactIn` (W0G → non-W0G leg via the target pool, through the immutable `swapRouter`, recipient = vault) then `NFPM.mint` (recipient = vault), returns `tokenId`/`liquidity`/`amount0`/`amount1`. Vault then `forceApprove(…,0)`.
- Delta check: `nativeBefore - nativeAfter == amountIn0G` (exact), `nfpmBalanceAfter - nfpmBalanceBefore == 1`, `liquidity >= request.liquidity`, `amount0 >= amount0Min && amount1 >= amount1Min`, no leftover W0G (`W0G.balanceOf(vault) == w0gBefore`). Else `LpBadDelta`.
- Accounting: `lpNftOwner[tokenId] = agentKey`, `lpNftPool[tokenId] = poolId`, `lpNftDeployedNative[tokenId] = amountIn0G`, `lpNftTickLower[tokenId] = tickLower`, `lpNftTickUpper[tokenId] = tickUpper`, push `tokenId` to `agentLpNfts[agentKey][poolId]`, `openLpExposure0G += amountIn0G`, `agentLpNotionalDeployed[agentKey] += amountIn0G`, `_recordLpBuySpend(amountIn0G)`, `_recordLpActionTimestamp()`.
- Emit `LpActionExecutedV3(actionHash, agentKey, ZAP_IN_MINT_LP, poolId, tokenId, amountIn0G, 0, int256(liquidity), auditRoot, policySnapshotHash)`.
- The adapter's embedded `swapExactIn` is narrow: immutable `swapRouter` (allowlisted), fixed W0G wrap, recipient hard-pinned to the vault, `amountOutMin > 0` enforced. NOT arbitrary calldata.

**`zapInIncreaseLiquidity(LpActionRequest) returns (uint128 liquidity, uint256 amount0, uint256 amount1)`:** (the ONLY increase entrypoint on V3 — Codex re-audit blocker 4 fix; single-sided native, charges LP caps)
- Per-action: `actionType == ZAP_IN_INCREASE_LIQUIDITY`, `tokenId > 0`, `lpNftOwner[tokenId] == agentKey` (else `NotAgentLpNft`), `request.poolId == lpNftPool[tokenId]` (else `PoolMismatch` — Codex round-2 major 2 fix), `tickLower == lpNftTickLower[tokenId] && tickUpper == lpNftTickUpper[tokenId]` (must match the existing position, else `LpTickMismatch`), `amount0Desired > 0` (native 0G input = `amountIn0G`), `amount1Desired == 0`, `liquidity > 0` (min liquidity to add), `liquidity >= policy.lp.minLiquidityFloor` (else `LpLiquidityFloor` — Codex round-2 major 1 fix), `quotedLiquidity > 0`, `amount0Min > 0 && amount1Min > 0`, `liquidity >= minLpOutFor(quotedLiquidity)`, `amount0Min >= minLpOutFor(quotedAmount0) && amount1Min >= minLpOutFor(quotedAmount1)`, `stakeVault == address(0)`. Cooldown applies (deploying).
- **W0G-leg requirement (Codex round-3 major fix):** the existing position's pool MUST have a W0G leg (the adapter reads `token0`/`token1` from `NFPM.positions(tokenId)` and asserts one equals `wrappedNative`), else revert `LpPoolNotZappable`. Same single-swap-zap rationale as `zapInMintLp`; non-W0G-pool positions cannot be increased single-sided on V3.
- LP spend policy: `amountIn0G = amount0Desired` against `perLpActionCap0G`/`lpDailyCap0G` + `openLpExposure0G + amountIn0G <= maxLpExposure0G`.
- Adapter call: vault wraps `amountIn0G` → W0G, `forceApprove`s LP adapter, calls `lpAdapter.zapInIncreaseLiquidity(ZapIncreaseParams{tokenId, poolId, amount0G: amountIn0G, amount0Min, amount1Min, deadline})`. The adapter reads `token0`/`token1`/`fee` from the pool (via `v3Factory.getPool`) and `tickLower`/`tickUpper` from `NFPM.positions(tokenId)`, does ONE `swapExactIn` (W0G → paired token to the ratio the existing position needs) then `NFPM.increaseLiquidity` (recipient = vault), returns `liquidity`/`amount0`/`amount1`. Vault `forceApprove(…,0)`. The vault pre-validates `tickLower == lpNftTickLower[tokenId]` (stored at mint) so the adapter's NFPM read must agree; if not, `LpBadDelta` (the position ticks moved, which cannot happen for a fixed range).
- Delta check: `nativeBefore - nativeAfter == amountIn0G` (exact), `liquidity >= request.liquidity`, `amount0 >= amount0Min && amount1 >= amount1Min`, no leftover W0G. Else `LpBadDelta`.
- Accounting: `lpNftDeployedNative[tokenId] += amountIn0G`, `openLpExposure0G += amountIn0G`, `agentLpNotionalDeployed[agentKey] += amountIn0G`, `_recordLpBuySpend(amountIn0G)`, `_recordLpActionTimestamp()`. `agentLpNfts` unchanged (tokenId already tracked).
- Emit `LpActionExecutedV3(..., ZAP_IN_INCREASE_LIQUIDITY, ..., amountIn0G, 0, int256(liquidity), ...)`.

**`decreaseLiquidity(LpActionRequest) returns (uint256 amount0, uint256 amount1)`:**
- Per-action: `actionType == DECREASE_LIQUIDITY` (Codex round-3 major fix: each entrypoint pins its own actionType so the proof/audit hash cannot describe a different LP action while this body executes), `tokenId > 0`, `lpNftOwner[tokenId] == agentKey`, `request.poolId == lpNftPool[tokenId]` (else `PoolMismatch` — Codex round-2 major 2 fix: bind the request pool to the NFT's stored pool so the executor cannot misroute hash/audit/event attribution), `liquidity > 0` (liquidity to burn), `request.liquidity <= lpAdapter.liquidityOf(tokenId)` (Codex round-4 BLOCKER 1 fix: bounded by the position's current liquidity; `request.liquidity` is `uint128`, matching `DecreaseParams.liquidity` and the NFPM `uint128` type, so no truncation gap between the adapter call and the pro-rata accounting), `amount0Min > 0 && amount1Min > 0`, `quotedAmount0 > 0 && quotedAmount1 > 0`, `amount0Min >= minLpOutFor(quotedAmount0) && amount1Min >= minLpOutFor(quotedAmount1)` (else `LpInvalidMinOut`), `stakeVault == address(0)`. NO cooldown (capital-returning, exempt — see pre-flight step 12).
- No spend policy (this is a withdrawal, not a deployment).
- **NFT authorization (Codex round-2 blocker 1 fix):** NFPM `decreaseLiquidity`/`collect` require the caller to be the NFT owner or per-tokenId approved. The vault owns the NFT; the adapter is neither. So the vault calls `_approveLpAdapterForNft(tokenId)` (sets `NFPM.approve(address(lpAdapter), tokenId)` — exact-tokenId, never approve-all) BEFORE the adapter call. After the adapter returns, the vault still owns the NFT (decrease does not transfer it), so the vault calls `_clearLpAdapterNftApproval(tokenId)` (`NFPM.approve(address(0), tokenId)`) in the same outer tx. No approval persists across txs.
- Delta check: snapshot token0/token1 balances. Call `lpAdapter.decreaseLiquidity(DecreaseParams{tokenId, liquidity: request.liquidity, amount0Min, amount1Min, deadline})`. Assert `amount0 >= amount0Min && amount1 >= amount1Min` and `token0Delta == amount0 && token1Delta == amount1` (after `collect` — see below). NFPM's `decreaseLiquidity` only burns liquidity; the owed tokens are credited to the position's `tokensOwed` and require a separate `collect` to actually transfer. **Design: the LP adapter's `decreaseLiquidity` MUST call both NFPM.decreaseLiquidity AND NFPM.collect(recipient: vault) atomically** so the vault observes balance deltas. Assert on the observed deltas.
- Accounting (Critique finding 9 fix): reduce `openLpExposure0G` pro-rata by the liquidity removed, so the freed capital can be re-deployed via a subsequent `zapInMintLp`/`zapInIncreaseLiquidity`. Concretely: `uint256 deployed = lpNftDeployedNative[tokenId]; uint256 totalLiq = uint256(lpAdapter.liquidityOf(tokenId)) + uint256(request.liquidity);` (position liquidity AFTER decrease + the burned amount = total before decrease); `uint256 nativeFreed = deployed * uint256(request.liquidity) / totalLiq;` `openLpExposure0G -= nativeFreed;` `lpNftDeployedNative[tokenId] -= nativeFreed;` `agentLpNotionalDeployed[agentKey] -= nativeFreed;` (all floor at 0). The collected token0/token1 sit in the vault as custodian; owner can `rescueToken` OR the keeper can `SWEEP_TOKEN` → native → `zapInIncreaseLiquidity`/`zapInMintLp`. Full `zapOut` handles the remainder (returns native, zeroes the slot).
- Emit `LpActionExecutedV3(..., DECREASE_LIQUIDITY, ..., 0, 0, -int256(uint256(request.liquidity)), ...)`.

**`collectFees(LpActionRequest) returns (uint256 amount0, uint256 amount1)`:**
- Per-action: `actionType == COLLECT_FEES` (Codex round-3 major fix: pin actionType), `tokenId > 0`, `lpNftOwner[tokenId] == agentKey`, `request.poolId == lpNftPool[tokenId]` (else `PoolMismatch`), `amount0Min == 0 && amount1Min == 0` (collect pulls all accrued), `stakeVault == address(0)`, `liquidity == 0`. NO cooldown (capital-returning, exempt).
- **NFT authorization (Codex round-2 blocker 1 fix):** vault calls `_approveLpAdapterForNft(tokenId)` before, `_clearLpAdapterNftApproval(tokenId)` after (vault still owns the NFT after collect).
- Delta check: snapshot token0/token1. Call `lpAdapter.collectFees(CollectParams{tokenId, vaultAddress, type(uint128).max, type(uint128).max})`. Assert `token0Delta == amount0 && token1Delta == amount1`. Recipient hard-pinned to `address(this)` (vault) inside the adapter.
- Accounting: no exposure change. The collected tokens sit in the vault as custodian; owner can `rescueToken`.
- Emit `LpActionExecutedV3(..., COLLECT_FEES, ..., 0, 0, 0, ...)`.

**`burnLp(LpActionRequest) returns (uint256 amount0, uint256 amount1)`:** (Codex re-audit major 15 fix — correct Uniswap V3 burn semantics)
- Per-action: `actionType == BURN_LP` (Codex round-3 major fix: pin actionType), `tokenId > 0`, `lpNftOwner[tokenId] == agentKey`, `request.poolId == lpNftPool[tokenId]` (else `PoolMismatch`), `lpAdapter.liquidityOf(tokenId) == 0` (caller must `decreaseLiquidity`/`zapOut` first, else `LpPositionNotEmpty`), `lpNftDeployedNative[tokenId] == 0` (exposure already reconciled by the prior decrease, else `LpPositionNotEmpty`), `quotedAmount0 >= 0 && quotedAmount1 >= 0` (Codex round-3 major fix: a fully-decreased/collected NFT can have ZERO residual `tokensOwed` on one or both sides — the prior `> 0` requirement stranded empty NFTs the executor could not burn, leaving only owner-rescue), per-side min validation (Codex round-4 major 3 fix): `quotedAmount0 == 0 ? amount0Min == 0 : amount0Min > 0 && amount0Min >= minLpOutFor(quotedAmount0)` AND `quotedAmount1 == 0 ? amount1Min == 0 : amount1Min > 0 && amount1Min >= minLpOutFor(quotedAmount1)` (ceilDiv so a tiny nonzero residual cannot round the floor to 0 and let `amountMin == 0` through; the AGENTS.md nonzero-min-out rule holds whenever there is residual to collect), `stakeVault == address(0)`, `liquidity == 0`. NO cooldown (capital-returning, exempt).
- Body (correct semantics): the vault calls `_approveLpAdapterForNft(tokenId)` ONCE, then `lpAdapter.collectFees(CollectParams{tokenId, vaultAddress, type(uint128).max, type(uint128).max})` FIRST to collect any residual `tokensOwed` (returns `amount0`/`amount1`), asserting `token0Delta == amount0 && token1Delta == amount1` and `amount0 >= amount0Min && amount1 >= amount1Min`. THEN the vault calls `lpAdapter.burnLp(tokenId)` — `NFPM.burn` is void (returns nothing; it only reverts if liquidity != 0 or the caller is not the NFT owner or per-tokenId approved). Assert `nfpmBalanceBefore - nfpmBalanceAfter == 1` (NFT burned — unsigned, `before >= after`; the prior draft's `after - before == -1` was an unsigned underflow and did not compile). The `amount0`/`amount1` come from the collect step, NOT from burn.
- **NFT authorization (Codex round-2 blocker 1 fix):** the single `_approveLpAdapterForNft(tokenId)` covers BOTH the collect and the burn (the adapter is approved for that tokenId for the whole outer tx). DO NOT clear approval after burn — the NFT is burned, so the vault is no longer the owner and `NFPM.approve(address(0), tokenId)` would revert (ERC721 auto-clears approval on burn anyway). The approval dies with the NFT.
- Accounting: remove `tokenId` from `agentLpNfts[agentKey][poolId]`, delete `lpNftOwner[tokenId]`, `lpNftPool[tokenId]`, `lpNftTickLower[tokenId]`, `lpNftTickUpper[tokenId]`, `lpNftDeployedNative[tokenId]` (already 0, asserted). No exposure change (burn returns residual tokens, not native; exposure was reconciled at decrease time).
- Emit `LpActionExecutedV3(..., BURN_LP, ..., tokenId, 0, 0, 0, ...)`.

**`stakeLp(LpActionRequest)`:** (Codex re-audit blocker 1 fix — vault-direct ZiaVault.deposit; major 10 fix — stake vault bound to pool; round-2 blocker 2 fix — no clear-after-transfer)
- Per-action: `actionType == STAKE_LP` (Codex round-3 major fix: pin actionType), `tokenId > 0`, `lpNftOwner[tokenId] == agentKey`, `request.poolId == lpNftPool[tokenId]` (else `PoolMismatch`), `policy.lp.allowStaking == true` (else `StakingDisabled`), `request.stakeVault == stakeVaultForLpPool[lpNftPool[tokenId]]` (else `InvalidStakeVault` — Codex re-audit major 10 fix: bind the stake vault to the NFT's pool, mirroring ZIA_LP_VAULTS pool→vault), `allowedStakeVaults[request.stakeVault] == true` (superset check), `amount0Desired == 0 && amount1Desired == 0 && liquidity == 0 && amount0Min == 0 && amount1Min == 0` (pure custody move). Cooldown applies (deploying).
- Pre-flight: `NFPM.ownerOf(tokenId) == address(this)` (vault holds it).
- **Vault-direct stake (blocker 1 fix):** the vault (NFT owner of record AND the intended depositor of record) calls `NFPM.approve(request.stakeVault, tokenId)` itself, then calls `IZiaVault(request.stakeVault).deposit(tokenId)` DIRECTLY — no adapter on the stake path. `ZiaVault.deposit` pulls the NFT via `transferFrom(vault, ziaVault, tokenId)` (covered by the vault's approve). **DO NOT clear approval after deposit (Codex round-2 blocker 2 fix):** ERC721 auto-clears per-tokenId approval on transfer, AND the vault is no longer the owner after `transferFrom`, so a subsequent `NFPM.approve(address(0), tokenId)` would revert with `ERC721InvalidApprover`. The approval is gone with the transfer — no explicit clear needed. The `IPolicyVaultLpAdapter` is NOT involved in staking (see §2.3 — `stakeLp`/`unstakeLp` removed from the adapter interface). Because the VAULT (not an adapter) called `deposit`, `IZiaVault(stakeVault).depositorOf(tokenId) == address(this)` holds — which is what the post-flight asserts and what makes the later `unstakeLp`/`unstakeLpOwner` vault-direct `withdraw` succeed.
- Post-flight: `NFPM.ownerOf(tokenId) == request.stakeVault` AND `IZiaVault(request.stakeVault).depositorOf(tokenId) == address(this)`. Else `LpBadDelta`.
- Accounting: remove `tokenId` from `agentLpNfts[agentKey][poolId]`, push to `agentStakedNfts[agentKey][request.stakeVault]`. `lpNftOwner[tokenId]` stays `agentKey`. Do NOT delete `lpNftPool[tokenId]` (needed for unstake pool attribution). `_recordLpActionTimestamp()`.
- Emit `Staked(agentKey, tokenId, stakeVault, poolId)` + `LpActionExecutedV3(..., STAKE_LP, ...)`.

> The vault needs a minimal `IZiaVault` interface inline: `interface IZiaVault { function deposit(uint256 tokenId) external; function withdraw(uint256 tokenId) external; function depositorOf(uint256 tokenId) external view returns (address); }`. Narrow, explicit, no calldata pass-through. The vault only ever calls `deposit`/`withdraw` on an allowlisted, pool-bound `stakeVault`.

**`unstakeLp(LpActionRequest)`:** (Codex re-audit blocker 1 fix — vault-direct ZiaVault.withdraw; round-2 major 2 fix — pool binding)
- Per-action: `actionType == UNSTAKE_LP` (Codex round-3 major fix: pin actionType), `tokenId > 0`, `policy.lp.allowStaking == true`, `request.poolId == lpNftPool[tokenId]` (else `PoolMismatch`), `request.stakeVault == stakeVaultForLpPool[lpNftPool[tokenId]]`, `allowedStakeVaults[request.stakeVault]`, `stakeVault != address(0)`, `tokenId` in `agentStakedNfts[agentKey][stakeVault]` (else `NotStakedNft`). NO cooldown (capital-returning, exempt — emergency unstake).
- Body: the vault calls `IZiaVault(request.stakeVault).withdraw(tokenId)` DIRECTLY (vault is depositor of record from `stakeLp`, so withdraw succeeds). No adapter.
- Post-flight: `NFPM.ownerOf(tokenId) == address(this)` AND `IZiaVault(request.stakeVault).depositorOf(tokenId) == address(0)` (depositor cleared post-withdraw). Else `LpBadDelta`.
- Accounting: remove `tokenId` from `agentStakedNfts[agentKey][stakeVault]`, push back to `agentLpNfts[agentKey][lpNftPool[tokenId]]`.
- Emit `Unstaked(...)` + `LpActionExecutedV3(..., UNSTAKE_LP, ...)`.

**`zapOut(LpActionRequest) returns (uint256 amountOut)`:** (Codex re-audit major 11 fix — no ghost exposure; round-2 blocker 1 + major 2 fixes)
- Per-action: `actionType == ZAP_OUT` (Codex round-3 major fix: pin actionType), `tokenId > 0`, `lpNftOwner[tokenId] == agentKey`, `request.poolId == lpNftPool[tokenId]` (else `PoolMismatch`), `liquidity > 0` (full or partial to burn), `request.liquidity <= lpAdapter.liquidityOf(tokenId)` (Codex round-4 BLOCKER 1 fix: bounded by the position's current liquidity so a bogus `liquidity` cannot over-burn or desync accounting; `request.liquidity` is `uint128` so no truncation vs the adapter's `uint128`), `amount0Min > 0` (native-out floor), `quotedAmountOut > 0`, `amount0Min >= minLpOutFor(quotedAmountOut)` (else `LpInvalidMinOut`), `amount1Min == 0` allowed (single-token zap — `zapOut` returns native only, so a `amount1Min` floor does not apply; the `amount0Min` native floor is the binding slippage check), `stakeVault == address(0)`, NFT in vault (`tokenId` in `agentLpNfts[agentKey][poolId]`). NO cooldown (capital-returning, exempt — emergency exit).
- **Token derivation (Critique finding 11 fix):** the vault derives `tokenIn`/`tokenOut` from `lpNftPool[tokenId]` + the verified pool immutables, NOT from the executor. The executor supplies only `liquidity` and `amount0Min`. The non-native leg is swapped to W0G via the immutable `swapRouter` (allowlisted), then unwrapped to native. Recipient hard-pinned to the vault.
- **NFT authorization (Codex round-2 blocker 1 fix):** vault calls `_approveLpAdapterForNft(tokenId)` before `lpAdapter.zapOut`. If the burn is full (NFT burned), DO NOT clear after (vault no longer owns — same reasoning as `burnLp`). If partial (NFT retained), the vault calls `_clearLpAdapterNftApproval(tokenId)` after.
- Adapter call: `lpAdapter.zapOut(ZapOutParams{tokenId, poolId, liquidity: request.liquidity, amountOutMin: amount0Min, deadline})` (Codex round-3 major fix: `liquidity` is now passed so the adapter knows how much to decrease for partial zap; Codex round-4 BLOCKER 1 fix: `request.liquidity` is `uint128`, passed straight through — NO `uint128(...)` cast, so the adapter call, full/partial detection, event, and exposure accounting all use the SAME `uint128` value with no truncation gap; adapter reads token0/token1/fee/ticks from `NFPM.positions(tokenId)` internally — no poolId recovery needed for tokenId actions). The adapter does: `NFPM.decreaseLiquidity(request.liquidity)` + `NFPM.collect(recipient: vault)` + swap non-W0G leg to W0G via `swapRouter` + `W0G.withdraw` → native to vault + `NFPM.burn` (only if `request.liquidity == totalPositionLiquidity`, i.e. full burn).
- Delta check: `nativeDelta >= amount0Min && nativeDelta >= amountOut` (adapter-reported). Else `LpBadDelta`. Assert NFT burned (`nfpmBalanceBefore - nfpmBalanceAfter == 1`) when `request.liquidity == totalPositionLiquidity`; else liquidity reduced and NFT retained.
- **Accounting (major 11 fix — no ghost exposure):** if full burn (NFT burned): `uint256 deployed = lpNftDeployedNative[tokenId]; openLpExposure0G -= deployed; agentLpNotionalDeployed[agentKey] -= deployed;` (floor at 0) — subtract the STORED deployed native, NOT `nativeDelta`, so a loss (`nativeDelta < deployed`) still fully releases the exposure and a gain does not over-release. Delete `lpNftOwner[tokenId]`, `lpNftPool[tokenId]`, `lpNftDeployedNative[tokenId]`, ticks; remove `tokenId` from `agentLpNfts[agentKey][poolId]`. If partial (NFT retained): pro-rata like `decreaseLiquidity` (`nativeFreed = deployed * request.liquidity / totalLiq`; reduce `openLpExposure0G` + `lpNftDeployedNative[tokenId]` + `agentLpNotionalDeployed[agentKey]` by `nativeFreed`, floor at 0).
- Emit `LpActionExecutedV3(..., ZAP_OUT, ..., tokenId, 0, nativeDelta, -int256(uint256(request.liquidity)), ...)`.

**`claimRewards(LpActionRequest) returns (uint256 amount)`:** (Codex re-audit major 12 fix — unconditional reserved slot, no storage; Codex round-4 major 2 fix — carve out of shared pre-flight; Codex round-5 major 1 fix — carve out of the shared entrypoint skeleton too)
- **Standalone no-modifier entrypoint (Codex round-5 major 1 fix):** `function claimRewards(LpActionRequest calldata) external payable { revert RewardsNotConfigured(); }` — NO `onlyExecutor`, NO `executorActive`, NO `lpAdapterNotConfigured`, NO `nonReentrant` modifier, and carved out of `_validateLpRequest` entirely. The body is the single statement `revert RewardsNotConfigured();` executed IMMEDIATELY on entry — before any modifier revert, any `actionType`/`agentKey`/`stakeVault`/`allowStaking`/cooldown check, so NO other error (`NotExecutor`/`Paused`/`ExecutorIsRevoked`/`LpAdapterNotConfigured`/`InvalidActionType`/`InvalidProof`/`LpCooldownActive`) can fire first and mask the unconditional revert. This is the explicit "not yet implemented, reverts cleanly" label AGENTS.md requires. The off-chain keeper must NOT call `claimRewards` (it always reverts with `RewardsNotConfigured`). When Zia delivers a claim ABI, v4 re-introduces the entrypoint into the shared skeleton + `_validateLpRequest` with the stake-vault-keyed two-step timelock + storage + adapter routing.
- No emit (always reverts). The `CLAIM_REWARDS` enum slot remains so `vaultActionHashForLp` and off-chain hash builders stay forward-compatible, but the entrypoint never reaches the hash-check code path.

**`sweepToken(LpActionRequest) returns (uint256 amountOut)`:** (Critique finding 4 fix + Codex re-audit blocker 3 fix + round-2 blocker 4 fix + round-3 blocker fix — sweep routing, native-out, adapter consistency, and pool-namespace separation)
- Per-action: `actionType == SWEEP_TOKEN`, `tokenId == 0`, `stakeVault == address(0)`, `request.tokenIn != address(0)` (tokenIn is always a custodied ERC20, never native), `allowedTokens[request.tokenIn]` (else `NotAllowed`), `request.tokenOut == NATIVE_TOKEN || allowedTokens[request.tokenOut]` (else `NotAllowed`) — **native-out IS allowed** (Codex round-2 blocker 4 fix), `amount0Desired > 0` (amount of `tokenIn` to swap), `amount1Min > 0` (the `amountOutMin` floor — nonzero required, else `LpInvalidMinOut`), `quotedAmountOut > 0`, `amount1Min >= minLpOutFor(quotedAmountOut)` (else `LpInvalidMinOut`), `tickLower`/`tickUpper`/`liquidity`/`amount1Desired` == 0. Cooldown applies (deploying — rate-limits keeper churn of custodied value). Requires `lpAdapterConfigured` (sweep runs on the LP adapter, which holds the `swapRouter` + `W0G` immutables for native-out unwrap).
- **Pool namespace (round-3 BLOCKER fix):** sweep validates `allowedLpPools[request.poolId]` — NOT `allowedPools`. The V2 swap `allowedPools` is keyed by curated route IDs (`keccak256("4LPHA_0G_ROUTE:...")` from `curatedMainnetRouteIds()`), which are a one-way hash and a different namespace. The LP adapter sweep needs the recoverable pool address (`bytes32(uint256(uint160(poolAddress)))` per §2.1.12) to read `token0`/`token1`/`fee` from the pool. Reusing `allowedPools` would either pass a route-id the adapter cannot decode (revert) or force changing `allowedPools` encoding (breaks the V2-verbatim curated swap adapter). Sweep therefore uses the LP pool allowlist (`allowedLpPools`, pool-address-encoded), seeded from the same `ZIA_LP_VAULTS` pools. This keeps V2 swap untouched. Else `InvalidLpPool`.
- **Adapter call (single adapter path):** vault `forceApprove`s `request.tokenIn` on the **LP adapter** for `amount0Desired`, then calls `lpAdapter.sweepToken(SweepParams{tokenIn: request.tokenIn, tokenOut: request.tokenOut, amountIn: amount0Desired, amountOutMin: amount1Min, poolId: request.poolId, deadline})`. The adapter recovers `address pool = address(uint160(uint256(request.poolId)))`, reads `token0`/`token1`/`fee` from `IUniswapV3Pool(pool)` directly. **Native-out normalization (Codex round-4 major 4 fix):** the adapter computes `address effectiveTokenOut = (request.tokenOut == NATIVE_TOKEN) ? wrappedNative : request.tokenOut` and asserts `{tokenIn, effectiveTokenOut}` matches the pool's two tokens (in either order) — when the user asks for native out, the actual swap leg is W0G, NOT `address(0)`, so the pool-pair check must use `wrappedNative`. The adapter re-derives `v3Factory.getPool(token0, token1, fee) == pool` as defense-in-depth. Then it does ONE `swapExactIn` via its immutable `swapRouter` (recipient hard-pinned to `msg.sender` = vault): if `request.tokenOut == NATIVE_TOKEN`, swap `tokenIn → W0G` (the pool's W0G leg) then `W0G.withdraw` → native to vault; if `request.tokenOut` is an ERC20, swap `tokenIn → tokenOut` directly to the vault. The vault then `forceApprove(request.tokenIn, 0)` on the LP adapter. There is ONE sweep path (LP adapter), NOT the V2 swap adapter.
- Delta check: `tokenInDelta == amount0Desired` (exact consumed). If `tokenOut == NATIVE_TOKEN`: `nativeDelta >= amount1Min && nativeDelta >= amountOut`. Else: `tokenOutDelta >= amount1Min && tokenOutDelta >= amountOut`. Else `LpBadDelta`.
- Accounting: no `openLpExposure0G` change (custody reshuffle, not deployment). No `positionUnits` change (tokens are custodied fees/proceeds, not swap-acquired). `_recordLpActionTimestamp()`. Emit `LpActionExecutedV3(..., SWEEP_TOKEN, ..., 0, amountOut, 0, ...)`.
- **Deny-by-default:** `tokenIn` allowlisted, `tokenOut` allowlisted-or-native, `poolId` in `allowedLpPools` (LP namespace, pool-address-encoded), recipient = vault, `amountOutMin > 0`, `tokenIn`/`tokenOut`/`quotedAmountOut` bound in `vaultActionHashForLp`. The executor cannot pick an arbitrary target/recipient. Funds never leave the vault. This is the keeper's tool to rebalance collected fees into native for `zapInIncreaseLiquidity` (compound) or `zapInMintLp` (rebalance).

#### 2.1.12 Internal helpers (V2 verbatim + V3 LP additions)

V2 verbatim: `_validateRequest`, `_validateAgentKey`, `_validateBuySpendPolicy`, `_validateCooldown`, `_markAction`, `_setAgentKeyEnabled`, `_increaseAgentPosition`, `_decreaseAgentPosition`, `_recordBuySpend`, `_reduceOpenExposure`, `_recordTradeTimestamp`, `_validatePolicy`, `_policyHash` (extended per 2.1.10).

V3 new:
```solidity
function _validateLpRequest(LpActionRequest calldata request) private view
function _validateLpSpendPolicy(uint256 amountIn0G, LpPolicy memory lpPolicy) private view
function _validateLpCooldown(LpPolicy memory lpPolicy) private view
function _markLpAction(bytes32 actionHash) private
function _recordLpBuySpend(uint256 amountIn0G) private
function _reduceLpExposure(uint256 nativeReturned) private
function _recordLpActionTimestamp() private
function _pushAgentLpNft(bytes32 agentKey, bytes32 poolId, uint256 tokenId) private
function _removeAgentLpNft(bytes32 agentKey, bytes32 poolId, uint256 tokenId) private
function _pushAgentStakedNft(bytes32 agentKey, address stakeVault, uint256 tokenId) private
function _removeAgentStakedNft(bytes32 agentKey, address stakeVault, uint256 tokenId) private
function _validateLpPolicy(LpPolicy memory candidate) private pure
function minLpOutFor(uint256 quote) internal view returns (uint256)  // ceilDiv(quote * policy.lp.lpMinOutBps, BPS) — Codex round-4 major 3 fix (ceilDiv) + round-5 minor 1 fix (view, reads policy.lp.lpMinOutBps so it is computable; pure could not read the bps). All LP min-floor checks route through this helper.
// Codex round-2 blocker 1 fix — per-tokenId ERC721 approval for the LP adapter on NFPM-call entrypoints:
function _approveLpAdapterForNft(uint256 tokenId) private     // NFPM.approve(address(lpAdapter), tokenId) — exact-tokenId, never approve-all
function _clearLpAdapterNftApproval(uint256 tokenId) private  // NFPM.approve(address(0), tokenId) — ONLY when the vault still owns the NFT (decrease/collect/partial-zap). Burned/full-zap NFTs auto-clear; calling this after burn reverts (ERC721InvalidApprover).
```

**`poolId` encoding (Codex round-2 blocker 3 fix; round-4 major 1 fix — namespace cleanup):** `bytes32 poolId` is `bytes32(uint256(uint160(poolAddress)))` — the 20-byte pool address zero-padded to bytes32. This is RECOVERABLE: `address pool = address(uint160(uint256(poolId)))`. The vault and adapter use this single encoding for the LP namespace only (`allowedLpPools`, `stakeVaultForLpPool`, `vaultActionHashForLp`, `ZapInMintParams.poolId`, `SweepParams.poolId`, `poolTokens(poolId)`). The V2 swap `allowedPools` is a SEPARATE namespace — curated route IDs `keccak256("4LPHA_0G_ROUTE:...")` from `curatedMainnetRouteIds()` — and is NOT pool-address-encoded and is NOT used by any LP action. `keccak256(poolAddress)` is NOT used in the LP namespace (it is one-way and would make `poolTokens`/zap routing unrecoverable). The `allowedLpPools` allowlist stores `bytes32(uint256(uint160(poolAddress)))` keys; the adapter recovers the address and re-derives `token0`/`token1`/`fee` via `v3Factory.getPool` (for mint, where params carry token0/token1/fee) or `NFPM.positions(tokenId)` (for tokenId actions — decrease/collect/burn/zapOut — which return token0/token1/fee/ticks directly, so no poolId recovery is needed there).

### 2.2 `contracts/PolicyVaultFactoryV3.sol`

Mirror `PolicyVaultFactoryV2.sol` (56 lines) verbatim except:

```solidity
contract PolicyVaultFactoryV3 {
    uint256 public constant VERSION = 3;
    address private constant VAULT_CREATION_SENTINEL = address(1);

    error NotVaultOwner(address caller, address owner);
    error VaultAlreadyExists(address owner, address vault);

    mapping(address owner => address vault) public vaultOf;

    event VaultCreated(address indexed owner, address indexed executor, address indexed vault,
        address adapter, address lpAdapter, address proofRegistry, bool mockAdapterAllowed, bool mockLpAdapterAllowed);
    event VaultCreatedV3(address indexed owner, address indexed executor, address indexed vault,
        uint256 version, address adapter, address lpAdapter, address proofRegistry,
        bool mockAdapterAllowed, bool mockLpAdapterAllowed);

    function createVault(
        address owner,
        address executor,
        address adapter,
        address lpAdapter,                 // V3 new; address(0) allowed
        address proofRegistry,
        PolicyVaultV3.Policy calldata policy,
        address[] calldata allowedTokens,
        bytes32[] calldata allowedPools,
        bytes32[] calldata allowedLpPools,    // V3 new
        address[] calldata allowedStakeVaults, // V3 new
        address[] calldata stakeVaultForLpPool, // V3 new — parallel to allowedLpPools
        bool allowMockAdapter,
        bool allowMockLpAdapter               // V3 new
    ) external returns (address vault) {
        if (msg.sender != owner) revert NotVaultOwner(msg.sender, owner);
        address existingVault = vaultOf[owner];
        if (existingVault != address(0)) revert VaultAlreadyExists(owner, existingVault);
        vaultOf[owner] = VAULT_CREATION_SENTINEL;
        vault = address(new PolicyVaultV3(owner, executor, adapter, lpAdapter, proofRegistry,
            policy, allowedTokens, allowedPools, allowedLpPools, allowedStakeVaults, stakeVaultForLpPool,
            allowMockAdapter, allowMockLpAdapter));
        vaultOf[owner] = vault;
        emit VaultCreated(owner, executor, vault, adapter, lpAdapter, proofRegistry, allowMockAdapter, allowMockLpAdapter);
        emit VaultCreatedV3(owner, executor, vault, VERSION, adapter, lpAdapter, proofRegistry, allowMockAdapter, allowMockLpAdapter);
    }
}
```

Same re-entrancy sentinel pattern, same `msg.sender == owner` gate, same one-vault-per-owner. No proxy, no upgrade.

### 2.3 `contracts/interfaces/IPolicyVaultLpAdapter.sol` (NEW)

Full method signatures per adapterBlueprint §5:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

interface IPolicyVaultLpAdapter {
    function lpAdapterKind() external view returns (bytes32);

    // Zap-in mint (single-sided 0G → wrap → balancing swap → mint in ONE tx). Charges LP caps.
    // No two-sided mintLp: dropped (Codex re-audit blocker 4 — two-sided pre-custodied mint bypasses LP caps).
    struct ZapInMintParams {
        bytes32 poolId;
        address vaultAddress;
        address token0;          // W0G side
        address token1;          // paired side (acquired by internal swap)
        uint24  fee;
        int24   tickLower;
        int24   tickUpper;
        uint256 amount0G;        // native 0G input
        uint256 amount0Min;      // slippage floor (W0G side after wrap)
        uint256 amount1Min;      // slippage floor (paired side after swap)
        uint256 deadline;
    }
    function zapInMintLp(ZapInMintParams calldata p)
        external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);

    // Zap-in increase (single-sided 0G → wrap → balancing swap → add to existing position in ONE tx).
    // Charges LP caps. tickLower/tickUpper MUST match the stored position (vault enforces).
    struct ZapIncreaseParams {
        uint256 tokenId;
        bytes32 poolId;
        uint256 amount0G;        // native 0G input
        uint256 amount0Min;      // slippage floor (W0G side)
        uint256 amount1Min;      // slippage floor (paired side)
        uint256 deadline;
    }
    function zapInIncreaseLiquidity(ZapIncreaseParams calldata p)
        external payable returns (uint128 liquidity, uint256 amount0, uint256 amount1);

    struct DecreaseParams {
        uint256 tokenId;
        uint128 liquidity;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }
    function decreaseLiquidity(DecreaseParams calldata p)
        external payable returns (uint256 amount0, uint256 amount1);

    struct CollectParams {
        uint256 tokenId;
        address vaultAddress;
        uint128 amount0Max;
        uint128 amount1Max;
    }
    function collectFees(CollectParams calldata p)
        external payable returns (uint256 amount0, uint256 amount1);

    // burnLp: collect-then-burn. Adapter collects owed fees to vault, then burns the NFT.
    function burnLp(uint256 tokenId) external payable returns (uint256 amount0, uint256 amount1);

    // NOTE: stakeLp / unstakeLp / claimRewards are NOT in the adapter interface.
    // Staking is vault-direct: the vault calls NFPM.approve(stakeVault, tokenId) then
    // IZiaVault(stakeVault).deposit(tokenId) / .withdraw(tokenId) itself (Codex re-audit
    // blocker 1 fix — no adapter middleman on the stake path, vault owns the NFT throughout).
    // claimRewards is unimplemented (rewards not available); the vault entrypoint reverts unconditionally.

    struct ZapOutParams {
        uint256 tokenId;
        bytes32 poolId;
        uint128 liquidity;     // Codex round-3 major fix: liquidity to decrease (full or partial); adapter decreases exactly this amount.
                              // Codex round-4 BLOCKER 1 fix: matches LpActionRequest.liquidity (uint128) — passed straight through, no cast.
        uint256 amountOutMin;   // native-out floor
        uint256 deadline;
    }
    function zapOut(ZapOutParams calldata p) external payable returns (uint256 amountOut);

    // Sweep: swap a custodied allowlisted ERC20 → another allowlisted token/native, recipient = vault.
    // Uses the immutable swapRouter; tokenIn/tokenOut/poolId validated by the vault against allowlists.
    // Native-out normalization (Codex round-4 major 4 fix): when tokenOut == NATIVE_TOKEN, the adapter
    // validates the pool pair against {tokenIn, wrappedNative} (the actual swap leg is W0G), then unwraps.
    struct SweepParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 amountOutMin;
        bytes32 poolId;
        uint256 deadline;
    }
    function sweepToken(SweepParams calldata p) external payable returns (uint256 amountOut);

    // view helpers used by the vault for post-flight verification
    function ownerOf(uint256 tokenId) external view returns (address);
    function liquidityOf(uint256 tokenId) external view returns (uint128);
    function positionTicks(uint256 tokenId) external view returns (int24 tickLower, int24 tickUpper);
    function poolTokens(bytes32 poolId) external view returns (address token0, address token1, uint24 fee);
}
```

> Note: `sweepToken` reuses the swap router, so the `ZiaLpAdapter` holds the immutable `swapRouter` and the vault validates `tokenIn`/`tokenOut`/`poolId` against its own allowlists before calling. The adapter recipient is hard-pinned to `msg.sender` (the vault). This is the deny-by-default sweep path for auto-compound/rebalance. `depositorOf` is no longer in the adapter interface — the vault reads `IZiaVault(stakeVault).depositorOf(tokenId)` directly for staked-NFT verification.

### 2.4 `contracts/ZiaLpAdapter.sol` (NEW — curated, deny-by-default)

Immutables per adapterBlueprint §7:
```solidity
bytes32 public constant LP_ADAPTER_KIND = keccak256("4LPHA_0G_ZIA_LP_ADAPTER");
address public immutable nfpm;            // 0x5143bA6007C197b4cF66c20601b9dB97E0F98c6A
address public immutable wrappedNative;   // W0G 0x1Cd0690fF9a693f5EF2dD976660a8dAFc81A109c
address public immutable swapRouter;      // 0x18cCa38E51c4C339A6BD6e174025f08360FEEf30
address public immutable v3Factory;       // 0x6F3945Ab27296D1D66D8EEb042ff1B4fb2E0CE70
mapping(address => bool) public allowlistedZiaVaults;   // seeded in constructor
```

Constructor validates every immutable nonzero + nonzero code length (mirror `UniswapV3SwapRouter02Adapter` ctor). Seed `allowlistedZiaVaults` from the 11 `ZIA_LP_VAULTS` vault addresses (or a deployer-supplied subset). `receive()` accepts native only from `address(wrappedNative)`.

Deny-by-default posture (per adapterBlueprint §7, all 10 points): no caller-supplied targets (all immutables), Zia vault allowlist (used only for `allowlistedZiaVaults` validation on read paths; staking itself is vault-direct, see below), pool allowlist re-derived via `v3Factory.getPool(token0, token1, fee) == pool`, no raw calldata, recipient hard-pinned to `msg.sender` (the vault), `forceApprove`→call→`forceApprove(…,0)` on every token transfer, nonzero min-out enforced at adapter entry, `nonReentrant` on every entry, `LP_ADAPTER_KIND` is non-mock (passes vault gate).

No `stakeLp` / `unstakeLp` / `claimRewards` in the adapter (Codex re-audit blocker 1 fix). Staking is vault-direct: `PolicyVaultV3` calls `NFPM.approve(stakeVault, tokenId)` then `IZiaVault(stakeVault).deposit(tokenId)` / `.withdraw(tokenId)` itself. The adapter never takes NFT custody for staking. `claimRewards` is unimplemented — the vault entrypoint reverts `RewardsNotConfigured()` unconditionally; no adapter method exists for it.

### 2.5 `contracts/mocks/MockZiaLpAdapter.sol` (NEW — tests only)

```solidity
bytes32 public constant LP_ADAPTER_KIND = keccak256("4LPHA_0G_MOCK_LP_ADAPTER");
```

Implements `IPolicyVaultLpAdapter` with in-memory state: a `nextTokenId` counter, `mapping(uint256 => MockPosition)` storing `liquidity`/`token0`/`token1`/`tickLower`/`tickUpper`, `mapping(uint256 => address) ownerOf`. `zapInMintLp` mints a fake NFT to `vaultAddress`, consumes `amount0G` native (dummy wrap+swap+mint), returns `liquidity = amount0G` (dummy). `zapInIncreaseLiquidity` adds to stored `liquidity` on a matching `tokenId`. `decreaseLiquidity` + `collectFees` return owed amounts. `burnLp` burns (collect-then-burn). `zapOut` returns a fixed native amount. `sweepToken` returns a fixed amount. No `stakeLp`/`unstakeLp`/`claimRewards` (vault-direct staking; mock Zia vault is a separate `MockZiaVault` contract the vault calls directly). Constructor reverts `MainnetBlocked()` if `block.chainid == 16661` (mirror `MockDexAdapter`).

---

## 3. lib/ TS Changes

### 3.1 `lib/contracts/policy-vault.ts` — V3 factory registration

Per migrateBlueprint §2, three edits:

**(a)** Add V3 mainnet fallback constants near lines 24-25:
```ts
const MAINNET_POLICY_VAULT_FACTORY_V3_ADDRESS = "0x…";   // from deploy artifact
const MAINNET_POLICY_VAULT_FACTORY_V3_FROM_BLOCK = "<block>";
```

**(b)** Add `readFactoryVersion(networkId, 3)` to `getPolicyVaultFactoryVersions`:
```ts
const versions = [
  readFactoryVersion(networkId, 1),
  readFactoryVersion(networkId, 2),
  readFactoryVersion(networkId, 3),
].filter((version): version is PolicyVaultFactoryVersion => version !== null);
```

**(c)** Add `case 3` branches to `readFactoryAddressEnv` and `readFactoryFromBlockValue` (mainnet + testnet), reading `NEXT_PUBLIC_POLICY_VAULT_FACTORY_V3_MAINNET_ADDRESS` / `…_V3_MAINNET_FROM_BLOCK` (mainnet) and `…_V3_ADDRESS` / `…_V3_FROM_BLOCK` (testnet), with the V3 mainnet fallback constants when env is absent.

No other change needed — `getLatestPolicyVaultFactoryVersion` returns `.at(-1)` of the sorted array, so V3 automatically becomes "latest" once registered. `getPolicyVaultReadiness` parameterizes on `latestFactoryVersion.version`, so it will start requiring the V3 from-block env.

### 3.2 `lib/contracts/policy-vault-v3.ts` (NEW)

Export `policyVaultV3Abi` (full V3 ABI: swap surface + all LP entrypoints + `vaultActionHashForLp` + `lpActionType` enum mirror + view functions `agentLpNfts`/`lpNftOwner`/`agentStakedNfts`/`openLpExposure0G`/`stakeVaultForLpPool`/`allowedLpPools`/`allowedStakeVaults`). Export `policyVaultFactoryV3Abi` (`createVault` with V3 signature, `vaultOf`, `VERSION`). Export `lpActionType` TS enum mirroring the Solidity enum (for off-chain request building). Export `vaultActionHashForLp` as a TS function that calls the contract on-chain (mirror the V2 pattern — do NOT re-implement `abi.encode` in TS).

### 3.3 `lib/contracts/zia-lp.ts` — NFPM full ABI

Per ziaLpBlueprint §3, add a SEPARATE export `ziaNonfungiblePositionManagerFullAbi` containing `mint`, `increaseLiquidity`, `decreaseLiquidity`, `collect`, `burn`, `positions`, `transferFrom`, `safeTransferFrom` (both overloads), `getApproved`, `balanceOf`, `name`, `symbol`, `tokenURI`, `DOMAIN_SEPARATOR`, `PERMIT_TYPEHASH`, `permit`, `isApprovedForAll`. Do NOT mutate the existing narrow `ziaNonfungiblePositionManagerNftAbi` (stake-only path stays minimal and auditable).

Also export the 11 `ZIA_LP_VAULTS` vault addresses as a typed `Address[]` constant for the ZiaLpAdapter constructor + deploy script.

### 3.4 `lib/executor/policy-vault-lp.ts` (NEW)

Server-only LP executor. Mirrors `lib/executor/policy-vault-trade.ts` structure:
- `prepareMainnetPolicyVaultLpAction(vault, actionType, params, audit)` — reads vault state (`policy`, `allowedLpPools`, `allowedStakeVaults`, `agentLpNfts`, `openLpExposure0G`), validates the executor key, builds a `draft` `LpActionRequest` with zero hashes, reads `vaultActionHashForLp(draft)` + `actionHashFor(vaultActionHash, auditRoot, policySnapshotHash)` on-chain, returns the finalized request.
- `runMainnetPolicyVaultLpAction({broadcast})` — sends `acceptProof` (from deployer/registry-owner wallet) then the LP entrypoint (`zapInMintLp`/`zapInIncreaseLiquidity`/`decreaseLiquidity`/`collectFees`/`burnLp`/`stakeLp`/`unstakeLp`/`sweepToken`/`zapOut`) from the executor wallet, waits for receipts. Never invokes `claimRewards` (unconditional revert).
- Asserts `assertMainnetDeployEnv` (chainId 16661, `ENABLE_MAINNET_DEPLOY=true`, `DEPLOYER_PRIVATE_KEY` + `VAULT_EXECUTOR_PRIVATE_KEY` present). Never wires `MockZiaLpAdapter` as the live adapter (mainnet gate).

### 3.5 Mainnet vault resolver + single-agent-server

`lib/agent/mainnet-vault-resolver.ts` — NO change (already iterates `getPolicyVaultFactoryVersions`, which now includes V3).

`lib/agent/single-agent-server.ts` — `readVaultSnapshot` picks V3 via `.at(-1)` automatically. `buildIntelligentData` (lines 915-935) extended per proofBlueprint §6: split entry 3 into `"Agent swap route filter hash"` + `"Agent LP pool & stake filter hash"`, add entry 6 `"Agent LP policy & proof-anchor hash"`, optional entry 7 `"Agent staking vault allowlist hash"` (only if `allowStaking`). The LP filter hash inputs: `{ allowedLpPools, allowedStakeVaults, minAprBps, maxSlippageBps, allowStaking }`. Export `readAgentDeploymentRegistryArtifact`, `writeAgentDeploymentRegistry`, `agentKeyForDeployment`, `assertMainnetDeployEnv` for the migrate route (or add a `migrateAgentRecordsToVault(owner, fromVault, toVault)` helper).

### 3.6 `lib/contracts/curated-routes.ts` / `verified-tokens.ts`

No change — V3 LP paired tokens must come from the existing `verified-tokens.ts` allowlist (USDC.e, WETH, WBTC, SOL, cbBTC, LINK, oUSDT, st0G). The vault's `allowedTokens` (swap allowlist) and `allowedLpPools` (LP allowlist) are distinct namespaces; LP paired tokens are enforced via the LP adapter's `v3Factory.getPool` re-derivation + the vault's `allowedLpPools` check, NOT via `allowedTokens`.

---

## 4. Migrate Button (v2 → v3)

### 4.1 `components/app/useWalletPolicyVault.ts` — `migrateVault` rename + extension

Rename `migrateVault` → keep as `migrateVault` (the existing v1→v2 caller) BUT change its body to target the **latest** factory (which is now V3, picked automatically via `getPolicyVaultFactoryAddress(network.id)` = `getLatestPolicyVaultFactoryVersion(...).address`). The existing `migrateVault` already uses `creationConfig.factory` (the latest factory), so **no factory-address change is needed** — once V3 is registered, `migrateVault` automatically creates a V3 vault. The V3 `createVault` ABI adds five trailing args vs V2: `lpAdapter`, `allowedLpPools`, `allowedStakeVaults`, `stakeVaultForLpPool` (parallel to `allowedLpPools`), `allowMockLpAdapter`. The migrate flow constructs these from the canonical `ZIA_LP_VAULTS` (lib/contracts/zia-lp.ts): `allowedLpPools` = each pool address encoded as `bytes32(uint256(uint160(poolAddress)))` (NOT keccak256 — see §2.1.12 poolId encoding; the encoding must be recoverable so the adapter can re-derive `token0`/`token1`/`fee`), `allowedStakeVaults` = the 11 vault addresses, `stakeVaultForLpPool` = parallel array pairing each poolId to its vault (entry `i` is the Zia vault for `ZIA_LP_VAULTS[i]`), `lpAdapter` = `POLICY_VAULT_ZIA_LP_ADAPTER_MAINNET_ADDRESS`, `allowMockLpAdapter = false` (mainnet). A migrated vault thus ships LP-enabled from construction. (Owner may instead pass `lpAdapter == address(0)` + empty arrays for a swap-only migrated vault — both are valid V3 configurations.) The only required edits:

1. After the `revokeExecutor()` best-effort block on the legacy vault (line 336), the CLIENT (owner wallet) signs and sends `setAgentKeyEnabled(agentKey, true)` on the V3 vault for each of the owner's existing agent keys — directly via the wallet client, NOT via the server (Critique finding 6 fix: `setAgentKeyEnabled` is `onlyOwner`; the server must never hold or use the owner key, and the "auto-sign if deployer == owner" special case leaks owner-key scope to the server). The client reads the owner's agent keys from the existing registry snapshot (already available client-side via the agents list) and submits one tx per key, awaiting each receipt. The client verifies each tx receipt on-chain (status 1 + the `AgentKeyEnabled` event from the V3 vault contract at `toVault`) before adding the key to `confirmedAgentKeys`.
2. ONLY AFTER all `setAgentKeyEnabled` txs confirm (or are explicitly skipped by the user for keys they choose not to re-enable), the client POSTs to the server route `/api/agents/migrate-vault` with `{ owner, fromVault, toVault, confirmedAgentKeys: [...] }`. The server updates the off-chain registry (`.vault = toVault`, `.migratedFromVault = fromVault`, `.migratedAt`) for exactly the confirmed keys and returns the updated count. If the client skips some keys, those agents' registry entries stay at `fromVault` (v2) — they remain paused-on-v2, which is correct and safe.
3. Parameterize the completion status text (line 339) to `Vault migration to PolicyVault v${latestFactoryVersion} completed. N agent keys re-enabled on v3.`.

Note: `assertLegacyVaultIsNativeOnly` (the gate that forces all V2 token positions to be sold before migrate) MUST be extended to also check V2 LP positions — `agentLpNfts` does not exist on V2, so the existing token-position check is sufficient for v2→v3. V3→v4 migrate (if ever) would need an LP-position check. For v2→v3, the existing gate is correct: V2 has no LP positions, only swap positions, which must be sold first.

### 4.2 `app/api/agents/migrate-vault/route.ts` (NEW — server-only, registry-only)

The server route NEVER sends `setAgentKeyEnabled` txs (Critique finding 6 fix). It only updates the off-chain registry after the client confirms the on-chain txs.

```ts
export async function POST(req: Request) {
  const { owner, fromVault, toVault, confirmedAgentKeys } = await req.json();
  // validate inputs (Address parsing, checksum); confirmedAgentKeys: bytes32[] the client already enabled on toVault
  // assertMainnetDeployEnv()  // guards registry path resolution + chain id
  // load registry from AGENT_REGISTRY_PATH
  // for each agent where agent.owner == owner && agent.vault == fromVault && agent.agentKey in confirmedAgentKeys:
  //   - set agent.vault = toVault
  //   - set agent.migratedFromVault = fromVault
  //   - set agent.migratedAt = ISO timestamp (server wall-clock; not used on-chain)
  // write registry back atomically (temp file + rename)
  // return { updatedAgents: number, skipped: [...] }
  // Agents NOT in confirmedAgentKeys are left at fromVault (still paused on v2) — safe.
}
```

Exports needed from `single-agent-server.ts`: `readAgentDeploymentRegistryArtifact`, `writeAgentDeploymentRegistry`, `agentKeyForDeployment`, `assertMainnetDeployEnv`, `AGENT_REGISTRY_PATH` (or a single `migrateAgentRecordsToVault(owner, fromVault, toVault, confirmedAgentKeys)` helper — recommended, keeps the route thin). The route is pure registry I/O — no wallet, no signing, no `DEPLOYER_PRIVATE_KEY` use.

### 4.3 `components/surfaces/VaultSurface.tsx` — `VaultMigrationPanel`

`migrationRequired` flips to `true` automatically once V3 is registered and the wallet's latest vault is V2 — no new component needed. Edits to `VaultMigrationPanel` (lines 573-609):

1. Version-aware copy: `Migrate to PolicyVault v{walletVault.factoryVersions.at(-1)?.version}`.
2. Add an inline confirm flow (second state in the panel, or a modal) with this copy:
   - "This creates a new v3 vault via the v3 factory and moves only your native 0G balance."
   - "All v2 token positions must be sold first — the migrate will revert if any v2 positionUnits or token balances are nonzero."
   - "Your v2 vault is paused and its executor revoked; v2 history remains viewable but v2 can no longer trade."
   - "After migrate, your wallet signs and sends `setAgentKeyEnabled(agentKey, true)` on the v3 vault for each existing agent key (one tx per key, owner-signed only — the server never holds your owner key). Only keys you confirm on-chain are re-enabled; agents you skip stay paused on v2."
   - "On-chain AgenticID TokenData.vault still points at v2 — this is accepted divergence (same as v1→v2). The off-chain agent record is updated to v3."
   - Buttons: "Cancel" / "Confirm migrate to v3".
3. `onClick` now opens confirm state; only the confirm button fires `onMigrate`.

### 4.4 `components/app/VaultActionPanel.tsx` (optional)

Add `activeVaultVersion?: number` prop; render a `RailStatus` row "Vault version: v{activeVaultVersion}" next to the existing "Vault" row (lines 430-433). Thread `walletVault.activeVaultVersion` from `VaultSurface`.

### 4.5 `lib/agent/single-agent.ts` — optional provenance field

Add `migratedFromVault?: Address` and `migratedAt?: string` to `OgAgentDeploymentRecord` (lines 28-54) for migrate provenance. Not required for correctness; nice-to-have for the UI to link back to v2 history.

---

## 5. Deploy Scripts

### 5.1 `scripts/deploy-mainnet-factory-v3.ts` (DROPPED)

A `PolicyVaultFactoryV3` was drafted to mirror `scripts/deploy-mainnet-factory-v2.ts`, but
the factory bytecode exceeds the EIP-170 24576-byte deployed-bytecode cap (measured ~28596
bytes), so 0G mainnet rejects the deploy. V3 therefore ships as a **singleton vault** plus
an **off-chain registry** (`.data/deployments/mainnet-policy-vault-v3-registry.json`) that
maps `owner → vaultAddress`. There is no on-chain V3 factory. `resolveMainnetV3VaultForOwner`
in `lib/agent/mainnet-vault-resolver.ts` reads the registry (and treats an explicit
`NEXT_PUBLIC_POLICY_VAULT_V3_MAINNET_ADDRESS` / `POLICY_VAULT_V3_MAINNET_ADDRESS` env
override as authoritative over the registry). A future multi-user redesign would slim the
factory to fit the 24KB cap; that is out of scope for this hybrid (V2 stays the per-user
vault, V3 is the deployer-owned LP-demo vault).

### 5.2 `scripts/deploy-mainnet-zia-lp-adapter.ts` (NEW)

Same gate set (steps 1-7). Deploys `ZiaLpAdapter(nfpm, wrappedNative, swapRouter, v3Factory, allowlistedZiaVaults)` where `allowlistedZiaVaults` = the 11 `ZIA_LP_VAULTS` vault addresses from `lib/contracts/zia-lp.ts`. Write artifact to `.data/deployments/mainnet-zia-lp-adapter.json`. Print `POLICY_VAULT_ZIA_LP_ADAPTER_MAINNET_ADDRESS=…` (server-only) and `NEXT_PUBLIC_POLICY_VAULT_ZIA_LP_ADAPTER_MAINNET_ADDRESS=…` (address-only, safe for client display).

### 5.3 `scripts/create-mainnet-vault-v3.ts` (NEW)

Singleton `PolicyVaultV3` deploy via viem `deployContract` (there is no on-chain V3 factory —
see §5.1). The deployer is the vault `owner`. After deploy, the script writes the
`owner → vaultAddress` entry into the off-chain registry at
`.data/deployments/mainnet-policy-vault-v3-registry.json` (and a redacted artifact at
`.data/deployments/mainnet-policy-vault-v3.json`). `assertNoExistingV3Vault` blocks an
existing registry entry unless `MAINNET_V3_REDEPLOY_FORCE=true`. Constructor args from env +
`creationConfig`:
- `owner` = `DEPLOYER_PRIVATE_KEY` address (the user, for the LP demo; V3 is deployer-owned, not per-user).
- `executor` = `VAULT_EXECUTOR_PRIVATE_KEY` address.
- `adapter` = `NEXT_PUBLIC_POLICY_VAULT_ADAPTER_MAINNET_ADDRESS` (swap adapter, existing).
- `lpAdapter` = `POLICY_VAULT_ZIA_LP_ADAPTER_MAINNET_ADDRESS`.
- `proofRegistry` = `PROOF_REGISTRY_ADDRESS` (existing).
- `policy` = default mainnet policy + `LpPolicy{ perLpActionCap0G, lpDailyCap0G, maxLpExposure0G, cooldownSecondsLp, lpMinOutBps, minLiquidityFloor, allowStaking: true }` from env or hardcoded defaults.
- `allowedTokens`, `allowedPools` = existing swap allowlists.
- `allowedLpPools` = 11 `ZIA_LP_VAULTS` pool addresses encoded as `bytes32(uint256(uint160(poolAddress)))` (recoverable — see §2.1.12; NOT keccak256).
- `allowedStakeVaults` = 11 `ZIA_LP_VAULTS` vault addresses.
- `stakeVaultForLpPool` = parallel to `allowedLpPools`: entry `i` = `ZIA_LP_VAULTS[i].vaultAddress` (the Zia vault for that pool). Codex round-2 major 3 fix — this arg MUST be passed (the prior draft omitted it, which would fail ABI encoding or leave the pool→stakeVault binding empty).
- `allowMockAdapter = false`, `allowMockLpAdapter = false`.

Asserts `assertMainnetDeployEnv`. Prints the new vault address + tx hash.

### 5.4 `scripts/discover-mainnet-vault-v3.ts` (extend existing discover)

The existing discover script (`scripts/discover-mainnet-vault*.ts`) iterates factory versions. With V3 registered, it automatically picks up V3 vaults via `vaultOf` / `VaultCreatedV3` logs. Add `VaultCreatedV3` event decoding to the discover script if it currently decodes only `VaultCreatedV2`. No other change.

### 5.5 `scripts/verify-mainnet-v3.ts` (NEW)

Mirror existing verify scripts: read `.data/deployments/mainnet-policy-vault-factory-v3.json` + `.data/deployments/mainnet-zia-lp-adapter.json`, submit verification to the 0G explorer API (`https://chainscan.0g.ai/api`) with the compiler settings `0.8.24` / `cancun` / `viaIR: true` / optimizer 200. Assert verification status.

---

## 6. Tests

> Hardhat config: `0.8.24` / `evmVersion: "cancun"` / `viaIR: true` / optimizer 200. Toolbox: `@nomicfoundation/hardhat-toolbox-viem`. Test style: `node:test` `describe`/`it` + `node:assert/strict` + `network.create()` → `viem` / `networkHelpers`. No mocha/chai/bignumber.

### 6.1 `test/PolicyVaultV3.ts` (NEW)

**V2 swap-path regression on V3 (case 4.8 from testBlueprint):**
- Re-run the V2 `buy`/`sell`/agent-isolation scenario on V3 end-to-end: `buy` for agentA 0.1, `buy` for agentB 0.05, assert `positionUnits == 0.3`, `agentPositionUnits[A]==0.2`, `agentPositionUnits[B]==0.1`; `sell` 0.2 for agentB reverts (too much); `sell` 0.1 for agentB succeeds.
- Re-run "blocks trading while agent key disabled" on V3.
- Re-run "rejects zero min-out", "enforces finite trade caps, daily caps, cooldown, exposure", "blocks reentrancy", "rejects malicious adapter return values", "mock adapter rejected when allowMockAdapter=false".

**LP primitive happy paths (cases 4.1, 4.4):**
- `zapInMintLp` (single-sided 0G) happy path: native 0G consumed == amount0G, NFT minted to vault, `openLpExposure0G` increased by amount0G, `lpNftDeployedNative` set, ticks stored, no leftover W0G. **LP caps fire on the full amount0G** (the Critique finding 3 + Codex re-audit blocker 4 invariant): a `zapInMintLp` over `perLpActionCap0G` reverts `LpCapExceeded`; cumulative over `maxLpExposure0G` reverts `LpExposureExceeded`. V3 exposes NO two-sided `mintLp` (dropped — bypassed LP caps).
- `zapInIncreaseLiquidity` (single-sided 0G, existing position) happy path: tickLower/tickUpper match the stored position, native consumed == amount0G, liquidity added, `openLpExposure0G` increased, `lpNftDeployedNative` increased. Tick-mismatch reverts `LpTickMismatch`.
- `unstakeLp` + `zapOut` happy path: NFT returns to vault, zap-out returns native, `openLpExposure0G` decreased, `agentLpNfts` cleared, no leftover intermediate tokens.
- `sweepToken` happy path: custodied USDC → W0G → native (or → paired token), recipient = vault, `amountOutMin` enforced, `openLpExposure0G` unchanged, no `positionUnits` mutation.

**LP allowlist enforcement (cases 4.2, 4.3, 4.6):**
- `zapInMintLp` / `zapInIncreaseLiquidity` with non-allowlisted `poolId` reverts `InvalidLpPool`.
- `zapInMintLp` after `disableLpPool` reverts.
- `stakeLp` with `request.stakeVault != stakeVaultForLpPool[lpNftPool[tokenId]]` reverts `InvalidStakeVault` (Codex re-audit major 10 fix — pool→vault binding enforced).
- `stakeLp` to a vault not in `allowedStakeVaults` reverts `NotAllowed` (superset check).
- `stakeLp` when `policy.lp.allowStaking == false` reverts `StakingDisabled`.
- `sweepToken` with `request.tokenIn` or `request.tokenOut` not in `allowedTokens` (or `tokenOut != NATIVE_TOKEN`), or `request.poolId` not in `allowedLpPools` (LP pool namespace — round-3 blocker fix: sweep uses `allowedLpPools` NOT the V2 `allowedPools` curated route IDs), reverts `NotAllowed`/`InvalidLpPool`. `sweepToken` with `amount1Min == 0` reverts `LpInvalidMinOut`; with `amount1Min < minLpOutFor(quotedAmountOut)` reverts `LpInvalidMinOut`. `sweepToken` with a V2 curated-route-id `poolId` (keccak256 route id) reverts `InvalidLpPool` (negative: confirms sweep does NOT accept the V2 swap namespace).
- V3 ABI exposes no `recipient`/`to` parameter on any LP entrypoint (ABI-shape test, mirror V1). `zapOut`/`sweepToken` recipient is `address(this)` by construction (no `to` arg).

**Codex round-2 blocker/major fixes — NFT authorization, pool binding, floor, encoding, native-out sweep:**
- `decreaseLiquidity`/`collectFees`/`burnLp`/`zapOut` (full+partial): assert `NFPM.getApproved(tokenId) == address(lpAdapter)` is set DURING the outer tx and cleared after when the vault still owns the NFT (decrease/collect/partial-zap). For `burnLp`/full-`zapOut`, assert no post-burn `approve(address(0), tokenId)` call is made (would revert — NFT burned, auto-cleared). Assert the adapter reverts `ERC721InvalidSender`/equivalent if the vault forgets the per-tokenId approval (negative mock that skips approval). (Round-2 blocker 1.)
- `stakeLp`: assert NO `NFPM.approve(address(0), tokenId)` call after `IZiaVault.deposit` (would revert — NFT left the vault, auto-cleared). (Round-2 blocker 2.)
- `zapInMintLp`/`zapInIncreaseLiquidity` with `request.liquidity < policy.lp.minLiquidityFloor` reverts `LpLiquidityFloor`. Raise `minLiquidityFloor` via `tightenPolicy`, then a request that passed before now reverts. (Round-2 major 1.)
- For every tokenId action (`zapInIncreaseLiquidity`/`decreaseLiquidity`/`collectFees`/`burnLp`/`stakeLp`/`unstakeLp`/`zapOut`): `request.poolId != lpNftPool[tokenId]` reverts `PoolMismatch`. (Round-2 major 2.)
- `poolId` encoding: assert `vault.allowedLpPools(bytes32(uint256(uint160(poolAddress)))) == true` and that `bytes32(uint256(uint160(poolAddress)))` is the key used by `vaultActionHashForLp` + the adapter `poolTokens` view. Negative: a `keccak256(poolAddress)` key is NOT set (the allowlist uses the padded-address encoding). (Round-2 blocker 3.)
- `sweepToken` with `request.tokenOut == NATIVE_TOKEN` (address(0)) SUCCEEDS and returns native to the vault (the prior `!= address(0)` guard would have forbidden this). Assert the swap routes through `lpAdapter.sweepToken` (W0G unwrap path), NOT the V2 swap adapter. (Round-2 blocker 4.)
- `create-mainnet-vault-v3.ts` (or its unit-test equivalent): assert the `createVault` call includes the `stakeVaultForLpPool` parallel array arg and that `stakeVaultForLpPool.length == allowedLpPools.length` (else constructor reverts `BadPolicy`). (Round-2 major 3.)

**Codex round-4 fixes — liquidity type, claimRewards carve-out, burnLp ceilDiv, sweep native-out normalization, namespace text:**
- BLOCKER 1 (liquidity type/truncation): `LpActionRequest.liquidity` is `uint128` (ABI-shape test: `uint256` would fail). `decreaseLiquidity`/`zapOut` with `request.liquidity > lpAdapter.liquidityOf(tokenId)` reverts (over-burn guard). Partial `zapOut` with `request.liquidity == liquidityOf(tokenId)` is treated as full burn (NFT burned, slot zeroed); with `request.liquidity < liquidityOf(tokenId)` is partial (NFT retained, pro-rata exposure release). Fuzz: for random `uint128 liquidity <= liquidityOf`, the adapter `decreaseLiquidity` amount, the event `int256` value, and the `nativeFreed = deployed * liquidity / totalLiq` accounting all use the SAME `uint128` value — assert no truncation path exists (the prior `uint128(request.liquidity)` cast on a `uint256` field is gone by construction). (Round-4 BLOCKER 1.)
- MAJOR 1 (namespace text): confirm by grep over the plan + generated ABI that NO LP action reads `allowedPools`; `sweepToken` reads `allowedLpPools` only; V2 `allowedPools` remains curated route IDs. (Round-4 major 1.)
- MAJOR 2 (claimRewards carve-out): `claimRewards` reverts `RewardsNotConfigured` IMMEDIATELY — assert it reverts even when `request.actionType` is wrong, `agentKey` is zero, `stakeVault` is nonzero, `allowStaking == false`, and cooldown is active (no other error fires first; the carve-out bypasses `_validateLpRequest` entirely). (Round-4 major 2.)
- MAJOR 3 (burnLp tiny-residual ceilDiv): `burnLp` with a tiny nonzero `quotedAmount0` (e.g. `1` wei) where `ceilDiv(1 * lpMinOutBps, BPS) == 1` requires `amount0Min >= 1` (the prior floor-div `1 * bps / BPS == 0` would have allowed `amount0Min == 0`, bypassing the nonzero-min-out rule). Per-side: `quotedAmount0 == 0` allows `amount0Min == 0`; `quotedAmount0 > 0` requires `amount0Min > 0`. (Round-4 major 3.)
- MAJOR 4 (sweep native-out normalization): `sweepToken` with `tokenOut == NATIVE_TOKEN` against a `tokenIn`/W0G pool SUCCEEDS — the adapter normalizes `effectiveTokenOut = wrappedNative` for the pool-pair check, swaps `tokenIn → W0G` via the pool, then `W0G.withdraw` → native. Negative: `sweepToken` with `tokenOut == NATIVE_TOKEN` and a `poolId` whose pool is `{tokenIn, someOtherToken}` (not W0G) reverts (the normalized pair does not match). (Round-4 major 4.)

**Codex round-5 fixes — claimRewards skeleton carve-out, minLpOutFor view helper:**
- MAJOR 1 (claimRewards skeleton carve-out): `claimRewards` is a STANDALONE no-modifier entrypoint — ABI-shape test that it has NONE of `onlyExecutor`/`executorActive`/`lpAdapterConfigured`/`nonReentrant`. Call `claimRewards` from a NON-executor, with the vault PAUSED, with the executor REVOKED, and with `lpAdapter` unset — in every case it reverts `RewardsNotConfigured`, NOT `NotExecutor`/`Paused`/`ExecutorIsRevoked`/`LpAdapterNotConfigured`. This proves no modifier can mask the unconditional revert. (Round-5 major 1.)
- MINOR 1 (minLpOutFor computability): `minLpOutFor` is `internal view` reading `policy.lp.lpMinOutBps` (a `pure` helper could not read the bps). Unit test: `minLpOutFor(1)` returns `ceilDiv(1 * lpMinOutBps, BPS) == 1` (not 0); `minLpOutFor(0)` returns 0; for a `quote = BPS - 1` and `lpMinOutBps = 9990`, the result is `ceilDiv((BPS-1) * 9990, BPS)` (rounds UP, never 0 for nonzero quote). All LP min-floor checks (`zapInMintLp`/`zapInIncreaseLiquidity`/`decreaseLiquidity`/`burnLp`/`zapOut`/`sweepToken`) route through this helper. (Round-5 minor 1.)

**Owner rescue paths (Critique finding 1 — BLOCKER fix):**
- `rescueNft(owner, nft, tokenId)` recovers a custodied LP NFT to `owner()` after `revokeExecutor()` + `setPaused(true)`. Assert recipient is `owner()` (no `to` arg exists).
- `unstakeLpOwner(owner, tokenId, stakeVault)` recovers a stranded staked NFT from a Zia vault after executor revoke. Assert NFT returns to vault, then `rescueNft` to owner.
- Negative: executor calls `rescueNft` → reverts `NotOwner`/`OwnableUnauthorizedAccount`. Executor calls `unstakeLpOwner` → reverts. No `to != owner()` path exists by construction.

**Hostile-token handling (Critique finding 7 fix — missing malicious-ERC20 test):**
- Deploy `HostileToken` (fee-on-transfer + transfer-blocking flag). `zapInMintLp`/`zapInIncreaseLiquidity` with a hostile token in the pool reverts `LpBadDelta` with ZERO state mutation (snapshot all six state slots before/after, assert byte-for-byte unchanged).
- Fee-on-transfer token approved in `allowedTokens` is rejected at the allowlist level (document the verified-tokens-only policy); runtime `LpBadDelta` is the backstop.

**LP cap honesty for single-sided (Critique finding 3 + Codex re-audit blocker 4 fix):**
- V3 exposes NO two-sided `mintLp` (dropped — it bypassed LP caps via pre-custodied `buy`). The only LP deploy paths are `zapInMintLp` and `zapInIncreaseLiquidity`, both single-sided native, both charging LP caps on the full amount. Test that `zapInMintLp` over `lpDailyCap0G` reverts even when the equivalent V2 `buy` would fit under `dailyCap0G`. This is the invariant the single-sided zap entrypoints exist to enforce.

**Per-agent LP NFT isolation (case 4.5):**
- `unstakeLp(agentB, tokenIdA)` reverts `NotAgentLpNft`.
- `zapOut(agentB, tokenIdA)` reverts `NotAgentLpNft`.
- `agentLpNfts[A]` and `agentLpNfts[B]` disjoint after each op.

**claimRewards reserved slot (case 4.7 — Codex re-audit major 12 fix):**
- `claimRewards` reverts `RewardsNotConfigured` UNCONDITIONALLY on V3 (no `rewardsContractFor` storage, no setter, no condition). Assert no state mutated on revert. There is no `setRewardsContract` on V3 — the negative test for "setter does not exist" is an ABI-shape check (no selector). When Zia delivers a claim ABI, v4 adds the stake-vault-keyed two-step timelock + storage + the real claim path together.

**LP policy tightening (case 4.10):**
- `tightenPolicy` lowering `perLpActionCap0G` succeeds; raising reverts `BadPolicy`.
- Lowering `maxLpExposure0G` succeeds; raising reverts.
- Raising `minLiquidityFloor` succeeds (tighter); lowering reverts `BadPolicy` (correct direction per §2.1.9 correction).
- Turning `allowStaking` false succeeds; turning true reverts `BadPolicy` (Codex re-audit blocker 2 fix — was reversed).
- `zapInMintLp` over `perLpActionCap0G` reverts `LpCapExceeded` even with proof accepted.
- `zapInMintLp` cumulative over `maxLpExposure0G` reverts `LpExposureExceeded`.

**Two-asset BadDelta variants (case 4.11):**
- `MaliciousLpAdapter.zapInMintLp` consumes W0G but does not mint NFT → vault `LpBadDelta`; `agentLpNfts`/`lpDailySpent0G` unchanged.
- `MaliciousLpAdapter.zapInMintLp` leaves USDC balance nonzero → `LpBadDelta`; no state mutation.
- `MaliciousLpAdapter.zapOut` returns `amountOutMin` but sends 0 native → `LpBadDelta`; NFT remains in `agentLpNfts`, `openLpExposure0G` unchanged.
- Snapshot helper reads all six state slots (`dailySpent0G`, `openExposure0G`, `positionUnits`, `agentLpNfts`, `agentStakedNfts`, `openLpExposure0G`) before/after; assert byte-for-byte unchanged on revert.

**LP cooldown asymmetry (Critique finding 15 + §2.1.11 invariant):**
- `zapInMintLp` / `zapInIncreaseLiquidity` / `stakeLp` / `sweepToken` within `cooldownSecondsLp` reverts `LpCooldownActive`.
- `decreaseLiquidity` / `collectFees` / `burnLp` / `unstakeLp` / `zapOut` within `cooldownSecondsLp` SUCCEED (capital-returning actions exempt — emergency withdraw always available). `claimRewards` is NOT in this list: it ALWAYS reverts `RewardsNotConfigured` regardless of cooldown (Codex round-3 minor 4 fix — the prior text implied it succeeded, contradicting the unconditional revert).

**decreaseLiquidity pro-rata exposure (Critique finding 9 fix):**
- `zapInMintLp` with `amountIn0G = 10`, then `decreaseLiquidity` 50% of liquidity. Assert `openLpExposure0G` dropped by ~5 (pro-rata via `lpNftDeployedNative`), `lpNftDeployedNative[tokenId]` dropped by ~5, and a subsequent `zapInIncreaseLiquidity` of the freed ~5 succeeds (no ghost-exposure lockout).
- Full `zapOut` zeroes `openLpExposure0G` contribution and `lpNftDeployedNative[tokenId]`.

**Mock LP adapter mainnet gate (new case):**
- Deploy V3 with `MockZiaLpAdapter` + `allowMockLpAdapter=false` reverts `AdapterBlocked`.
- Deploy V3 with `MockZiaLpAdapter` + `allowMockLpAdapter=true` succeeds on `hardhatMainnet` (simulated chainId != 16661).
- Add a chainId-16661 fork test (or a constructor unit test that asserts the `block.chainid == MAINNET_CHAIN_ID` branch reverts) — see testBlueprint §5 mainnet-fork note.

**Migrate v2→v3 (case 4.9):**
- Deploy V2 vault, deposit 1 0G, buy 0.1 0G of token for agentA (`agentPositionUnits[A] = 0.2`).
- Owner calls `v2.withdrawNative(0.8)` + `v3.depositNative{value: 0.8}` (or a `migrateToV3` helper if V3 exposes one — decision: NO `migrateToV3` helper on the contract; migrate is an off-chain owner flow per §4. The test simulates the off-chain flow).
- Pre-migrate: `assertLegacyVaultIsNativeOnly` forces the user to sell the 0.2 token position first. Sell 0.2 for agentA. Then migrate.
- Assert: v2 balance == 0, v3 balance == 0.8 (or remaining after sell), `v2.paused() == true`, `v2.executorRevoked() == true`, `v3.agentKeyEnabled(agentA) == false` initially, then owner calls `v3.setAgentKeyEnabled(agentA, true)`, then v3 `buy` for agentA succeeds, v2 `buy`/`sell` revert (paused + revoked), `v2.withdrawNative` still owner-only and works for residual sweep.

### 6.2 `test/PolicyVaultFactoryV3.ts` (NEW)

- `createVault` with `msg.sender == owner` succeeds; `vaultOf[owner]` set; `VaultCreatedV3` emitted with `version == 3`.
- `createVault` from non-owner reverts `NotVaultOwner`.
- Second `createVault` for same owner reverts `VaultAlreadyExists`.
- `createVault` with `lpAdapter == address(0)` succeeds (swap-only vault); LP entrypoints revert `LpAdapterNotConfigured`.
- `createVault` with `MockZiaLpAdapter` + `allowMockLpAdapter=false` reverts `AdapterBlocked`.
- Re-entrancy via constructor (`VAULT_CREATION_SENTINEL`) — same test as V2 factory.

### 6.3 AGENTS.md required vault security tests — V3 coverage map

| Required test | V3 coverage |
|---|---|
| Executor cannot withdraw | `withdrawNative`/`rescueToken` `onlyOwner` — V2 verbatim, V3 inherits. Test re-run. |
| Executor cannot arbitrary-call | V3 ABI-shape test: no `execute`/`multicall`/`delegatecall`/`recipient` selector. LP entrypoints have no recipient param. |
| Executor cannot select arbitrary recipient | Same ABI-shape test. `zapOut` returns native to `address(this)` only. |
| Zero min-out / zero slippage rejected | Swap path: `_validateRequest` (V2 verbatim). LP path: `_validateLpRequest` requires `amount0Min > 0 && amount1Min > 0` for MINT/INCREASE/DECREASE; `amount0Min > 0` (native floor) for ZAP_OUT with `amount1Min == 0` allowed (zapOut returns native only — Codex round-3 minor 3 fix); BURN allows a side's min to be 0 when its quoted residual is 0 (empty NFT). SWEEP requires `amount1Min > 0`. Test each. |
| Daily cap + per-trade cap bypass blocked | Swap: V2 verbatim. LP: `perLpActionCap0G` + `lpDailyCap0G` tests (case 4.10). |
| Cooldown bypass blocked | Swap: V2 verbatim. LP: `cooldownSecondsLp` test (case 4.10 + cooldown asymmetry). |
| Reentrancy blocked | `nonReentrant` on all stateful LP entrypoints EXCEPT `claimRewards` (standalone no-modifier revert-only entrypoint — Codex round-6 major 1 fix). Test with `ReenteringLpAdapter` mock (new mock under `contracts/mocks/`); the reentrancy test scope excludes `claimRewards` (it reverts `RewardsNotConfigured` before any state touch, no reentrancy surface). |
| Malicious ERC20 handled/rejected | **ADDED for V3 (Critique finding 7).** `HostileToken` (fee-on-transfer, transfer-blocking) test: `zapInMintLp`/`zapInIncreaseLiquidity`/`decreaseLiquidity` revert `LpBadDelta` with zero state mutation. Fee-on-transfer tokens banned at the `allowedTokens` allowlist level; runtime balance-delta is the backstop. |
| Malicious adapter cannot drain | `MaliciousLpRouter` BadDelta tests (case 4.11). `MaliciousLpAdapter.zapOut` returns `amountOutMin` but sends 0 native → `LpBadDelta`, NFT retained. |
| Admin cannot move user funds | `withdrawNative`/`rescueToken` owner-only — V2 verbatim. `rescueNft`/`unstakeLpOwner` owner-only, recipient hard-pinned to `owner()`. ADD explicit test: admin `rescueToken` cannot drain beyond deposited amount; `rescueNft` recipient is always `owner()` (no `to` arg). |
| Owner can recover LP NFTs after executor revoke | **NEW V3 row (Critique finding 1 — BLOCKER fix).** `rescueNft` + `unstakeLpOwner` recover custodied AND staked NFTs to `owner()` after `revokeExecutor()`/`setPaused(true)`. Executor cannot call them. |
| Mock adapter rejected in production config | `MockZiaLpAdapter` + `allowMockLpAdapter=false` reverts; chainId-16661 path reverts (new mainnet-fork test). |

### 6.4 `test/ZiaLpAdapter.ts` (NEW — adapter unit tests)

Unit-test `ZiaLpAdapter` against `MockUniswapV3Pool`/`MockUniswapV3Factory`/`MockWrappedNative` mocks (extend the existing mock family). Cover: `zapInMintLp` recipient hard-pinned to vault, `zapInIncreaseLiquidity` tick-match enforced, `collectFees` recipient hard-pinned, `zapOut` returns native to `msg.sender`, `sweepToken` recipient hard-pinned to `msg.sender`, `burnLp` collect-then-burn semantics, NO `stakeLp`/`unstakeLp`/`claimRewards` methods on the adapter (ABI-shape negative test — staking is vault-direct), `forceApprove`→call→`forceApprove(…,0)` pattern (assert zero approval after each call).

### 6.5 New mocks under `contracts/mocks/`

- `MockZiaLpAdapter.sol` (tests only, `MOCK_LP_ADAPTER_KIND`, `MainnetBlocked` at chainId 16661).
- `MockZiaVault.sol` (implements `deposit`/`withdraw`/`depositorOf`/`getDepositedTokenIds`/`depositedCountOf`/`liquidityOf` in-memory — the vault calls this directly for stake/unstake, NOT via the LP adapter).
- `MaliciousLpAdapter.sol` (returns `amountOutMin` without moving tokens; consumes input without minting NFT; etc. — for BadDelta tests).
- `ReenteringLpAdapter.sol` (attempts re-entry into vault `zapInMintLp` from within the `zapInMintLp` callback).
- `HostileToken.sol` (fee-on-transfer + optional transfer-blocking flag) — for the missing malicious-ERC20 test.

---

## 7. Proof Anchoring for LP Actions

**Flow (per proofBlueprint §4.7):**
1. Off-chain keeper uploads redacted LP audit bundle to 0G Storage → `auditRoot`, `storageRef`.
2. Reads `policyHash()` from the V3 vault (now covers swap + LP policy).
3. Builds a `draft` `LpActionRequest` with zero hashes; calls `vault.vaultActionHashForLp(draft)` + `vault.actionHashFor(vaultActionHash, auditRoot, policySnapshotHash)` **on-chain** (TS never re-implements `abi.encode`).
4. Computes `modelMetadataHash = hashJson({ copilotAudit, lpQuoteSource, lpRouteSelector, actionType })`.
5. `proofRegistry.acceptProof(actionHash, auditRoot, policySnapshotHash, modelMetadataHash, storageRef, vaultActionHash, agentRef)` from the **deployer/ProofRegistry-owner** wallet (same key as V2 path B in `curated-trade.ts`).
6. Dispatches `zapInMintLp`/`zapInIncreaseLiquidity`/`decreaseLiquidity`/`collectFees`/`burnLp`/`stakeLp`/`unstakeLp`/`sweepToken`/`zapOut` (never `claimRewards` — it reverts unconditionally) on the vault from the **executor** wallet with the finalized `LpActionRequest`.

**Vault-side validation** (`_validateLpRequest`): the same four hash checks as V2 (policySnapshotHash, vaultActionHash, actionHash, `proofRegistry.isAccepted`) + the `usedActionHashes` replay guard. `actionHashFor` is unchanged (still `"4LPHA_0G_POLICY_VAULT_PROOF"` + 3 roots) — so `ProofRegistry.sol` needs NO change. The LP discrimination lives entirely inside `vaultActionHashForLp` (domain tag `..._ACTION_LP` + `actionType` discriminator + LP-specific fields).

**Who calls `acceptProof` and when:** the ProofRegistry owner (deployer key) calls `acceptProof` BEFORE the executor sends the LP entrypoint tx — exactly the V2 ordering in `curated-trade.ts` (accept-proof receipt confirmed → then trade tx). The executor never accepts proofs.

**`policySnapshotHash` continuity:** `request.policySnapshotHash == _policyHash(currentPolicy)` where `_policyHash` now covers the extended `Policy` struct (swap fields + LpPolicy fields). Any policy tighten between request build and execution invalidates the LP request (same V2 invariant). Allowlist mutations (`disableLpPool`/`disableStakeVault`) are checked live in `_validateLpRequest` (not hashed into `policySnapshotHash`) — so disabling a pool mid-flight also invalidates an outstanding LP request for that pool.

---

## 8. ERC-7857 AgenticID Wiring

**AgenticID contract UNCHANGED** at `0x058c5f4c72810d7d4fc0bef3875a8f779de7e59c` (mainnet). No re-mint. No `updateVault`. No re-key.

**agentKey is vault-version-agnostic:** `agentKey = keccak256(identityAddress, tokenId)` (per `agentKeyForDeployment` in `single-agent-server.ts` lines 571-581). The same `agentKey` is enabled on V3 via `setAgentKeyEnabled(sameKey, true)`. This is approach (b) per the confirmed scope.

**IntelligentData filter hash for LP (per proofBlueprint §6):**
- Entry 3 split: `"Agent swap route filter hash"` (swap filters) + `"Agent LP pool & stake filter hash"` (`{ allowedLpPools, allowedStakeVaults, minAprBps, maxSlippageBps, allowStaking }`).
- Entry 6 (new): `"Agent LP policy & proof-anchor hash"` (`{ lpPolicyHash, proofRegistryAddress, vaultActionHashDomainTag }`).
- Entry 7 (optional, only if `allowStaking`): `"Agent staking vault allowlist hash"` (`hashJson(allowedStakeVaults)`).
- A hybrid agent (swap + LP) carries both filter hashes; a pure LP agent carries the LP filter hash + empty-swap-list hash. The verifier enforces that an LP `LpActionRequest.agentKey` was minted with entries 6 (and 7 if staking) present.

**Mainnet-only mint gate:** `mintAgent` and all AgenticID operations remain mainnet-only (`assertMainnetDeployEnv` / `chainId === 16661`). No Galileo AgenticID path. `MockAgentDataVerifier` is NEVER wired as the live mainnet verifier (per AGENTS.md). The `iTransfer`/`iClone` path stays disabled (no real TEE/ZKP verifier wired) — unchanged from current state.

**Post-migrate divergence (accepted, with required audit — Critique finding 8 fix):** on-chain `TokenData.vault` on the AgenticID NFT still points at the V2 vault address. Off-chain `OgAgentDeploymentRecord.vault` is updated to V3. This is the same divergence already accepted for v1→v2. **Required audit before implementation:** grep the repo for every read of `agentRecord(tokenId)` / `TokenData.vault` / `agent.vault` (in `contracts/AgenticID.sol`, `lib/agent/single-agent-server.ts`, `lib/agent/single-agent.ts`, `lib/executor/*`, `lib/agent/runtime/*`, any verifier, any UI consumer) and confirm NONE compares the on-chain `TokenData.vault` to the acting vault address (i.e. no `require(agentRecord(tokenId).vault == msg.sender)` or equivalent). If any such check exists, it MUST be relaxed to "vault in {v2, v3}" or the migrate must call `updateVault` on AgenticID (which the plan rules out — `iTransfer`/`iClone` disabled, no setter). The audit result must be documented in this section before Codex sign-off. Current evidence: `AgenticID.sol` exposes `agentRecord` as a pure view with no cross-contract caller; `PolicyVaultV3` does NOT call into AgenticID at all (the linkage is one-directional via `agentKey`). So no on-chain consumer compares vault addresses. The TS `readVaultSnapshot` picks the active vault via `versionedVaults.at(-1)` (factory version), NOT via `TokenData.vault` — so the divergence is invisible to the runtime. Document this in `memory/agentic-id-erc7857.md` after the audit.

---

## 9. Env Vars (`.env.example` placeholders only)

Per ziaLpBlueprint §7, add (placeholders, no values):

```env
# --- V3 Policy Vault (Zia LP native) ---
POLICY_VAULT_V3_ADDRESS=
POLICY_VAULT_V3_MAINNET_ADDRESS=
NEXT_PUBLIC_POLICY_VAULT_V3_ADDRESS=
NEXT_PUBLIC_POLICY_VAULT_V3_MAINNET_ADDRESS=
NEXT_PUBLIC_POLICY_VAULT_FACTORY_V3_ADDRESS=
NEXT_PUBLIC_POLICY_VAULT_FACTORY_V3_MAINNET_ADDRESS=
NEXT_PUBLIC_POLICY_VAULT_FACTORY_V3_FROM_BLOCK=
NEXT_PUBLIC_POLICY_VAULT_FACTORY_V3_MAINNET_FROM_BLOCK=

# Zia LP adapter (server-only address; NEXT_PUBLIC_ variant for client display, address-only)
POLICY_VAULT_ZIA_LP_ADAPTER_ADDRESS=
POLICY_VAULT_ZIA_LP_ADAPTER_MAINNET_ADDRESS=
NEXT_PUBLIC_POLICY_VAULT_ZIA_LP_ADAPTER_MAINNET_ADDRESS=

# Zia V3 contract addresses (mirrors of constants in lib/contracts; NEXT_PUBLIC_ for client evidence)
NEXT_PUBLIC_ZIA_NFT_POSITION_MANAGER_MAINNET_ADDRESS=0x5143ba6007C197b4cF66c20601b9dB97E0F98c6A
NEXT_PUBLIC_ZIA_SWAP_ROUTER_MAINNET_ADDRESS=0x18cCa38E51c4C339A6BD6e174025f08360FEEf30
NEXT_PUBLIC_ZIA_QUOTER_V2_MAINNET_ADDRESS=0x23b55293b7F06F6c332a0dDA3D88d8921218425B
NEXT_PUBLIC_ZIA_UNISWAP_V3_FACTORY_MAINNET_ADDRESS=0x6F3945Ab27296D1D66D8EEb042ff1B4fb2E0CE70
```

Reuse existing: `ZIA_TRADEGPT_API_BASE_URL`, `VAULT_EXECUTOR_PRIVATE_KEY`, `DEPLOYER_PRIVATE_KEY`, `ENABLE_REAL_DEX_ADAPTER`/`ENABLE_MOCK_DEX_ADAPTER`, `NEXT_PUBLIC_POLICY_VAULT_WRAPPED_NATIVE_MAINNET_ADDRESS` (W0G — do not duplicate). No new secret env names. No `ZIA_*_KEY` (Zia has no auth key).

---

## 10. Smoke Paths

**AGENTS.md required smoke paths — V3 must pass:**
- Vault deposit: `depositNative` on V3 (owner).
- Policy update: `tightenPolicy` on V3 (owner) — swap + LP fields.
- Executor buy through mock adapter: V3 `buy` with `MockDexAdapter` (testnet/local only; mainnet uses real adapter).
- Executor sell through mock adapter: V3 `sell` with `MockDexAdapter`.
- Pause: `setPaused(true)` on V3.
- Revoke executor: `revokeExecutor()` on V3.
- Owner withdraw: `withdrawNative` on V3.

**New LP smoke (mainnet fork or mock):**
- `zapInMintLp` (single-sided 0G → wrap → balancing swap → mint NFT to vault) on a mainnet fork using the real `ZiaLpAdapter` + real NFPM, OR with `MockZiaLpAdapter` locally. Assert NFT in vault, `agentLpNfts` set, `openLpExposure0G` increased.
- `stakeLp` (vault-direct): vault calls `NFPM.approve(stakeVault, tokenId)` + `IZiaVault(stakeVault).deposit(tokenId)` (mainnet fork: real `ZIA_LP_VAULTS[0].vaultAddress`; mock: `MockZiaVault`). Assert `depositorOf(tokenId) == vault`.
- Track staked tokenIds via `ZiaVault.getDepositedTokenIds(vault)`.
- `unstakeLp` (vault-direct `IZiaVault.withdraw`) → NFT returns to vault.
- `zapOut` → native 0G returns to vault; `openLpExposure0G` decreased.

**AGENTS.md "Required smoke paths before submission" (live, not unit tests):** one live 0G Compute call, one 0G Storage upload + verified retrieval/root, one 0G Chain Galileo proof tx — these are app-level smokes, not V3-specific; V3 must not break them. The V3-specific live smoke is: a real mainnet `zapInMintLp` + `stakeLp` via `ZiaLpAdapter` (fund the V3 vault with real 0G, execute the primitive, verify on-chain). Label as `pending` if gas/rpc constraints prevent it during the hackathon window; the unit + fork tests are the bar.

---

## 11. Implementation Order

**Phase 1 — Contracts compile.**
- Write `contracts/interfaces/IPolicyVaultLpAdapter.sol`.
- Write `contracts/PolicyVaultV3.sol` (port V2 + LP layer).
- Write `contracts/PolicyVaultFactoryV3.sol`.
- Write `contracts/ZiaLpAdapter.sol`.
- Write `contracts/mocks/MockZiaLpAdapter.sol` + `MockZiaVault.sol` + `MaliciousLpAdapter.sol` + `ReenteringLpAdapter.sol` + `HostileToken.sol`.
- Keep `hardhat.config.ts` aligned to `0.8.24`/cancun/viaIR/optimizer 200.
- **Verify:** `npx hardhat compile`.

**Phase 2 — Tests.**
- Write `test/PolicyVaultV3.ts` (all cases in §6.1).
- Write `test/PolicyVaultFactoryV3.ts` (§6.2).
- Write `test/ZiaLpAdapter.ts` (§6.4).
- **Verify:** `npx hardhat test`.

**Phase 3 — Deploy scripts.**
- Write `scripts/deploy-mainnet-factory-v3.ts`.
- Write `scripts/deploy-mainnet-zia-lp-adapter.ts`.
- Write `scripts/create-mainnet-vault-v3.ts`.
- Extend `scripts/discover-mainnet-vault*.ts` for `VaultCreatedV3`.
- Write `scripts/verify-mainnet-v3.ts`.
- **Verify:** `npx tsc --noEmit` (scripts are TS; no hardhat execution on mainnet during plan phase).

**Phase 4 — lib TS.**
- `lib/contracts/policy-vault.ts`: V3 factory registration (3 edits per §3.1).
- `lib/contracts/policy-vault-v3.ts` (NEW): V3 ABIs + `lpActionType` enum + `vaultActionHashForLp` TS helper.
- `lib/contracts/zia-lp.ts`: add `ziaNonfungiblePositionManagerFullAbi` (separate from narrow ABI).
- `lib/executor/policy-vault-lp.ts` (NEW): LP executor wiring.
- `lib/agent/single-agent-server.ts`: extend `buildIntelligentData` (LP entries 6/7); export helpers for migrate route (or add `migrateAgentRecordsToVault`).
- `lib/agent/single-agent.ts`: optional `migratedFromVault`/`migratedAt` fields.
- **Verify:** `npx tsc --noEmit`.

**Phase 5 — Migrate UI.**
- `components/app/useWalletPolicyVault.ts`: add post-migrate `/api/agents/migrate-vault` call; parameterize status text.
- `app/api/agents/migrate-vault/route.ts` (NEW): server-only route.
- `components/surfaces/VaultSurface.tsx`: `VaultMigrationPanel` v3 copy + confirm flow.
- `components/app/VaultActionPanel.tsx`: optional `activeVaultVersion` prop.
- `.env.example`: V3 env placeholders.
- **Verify:** `npm run build` + `npx tsc --noEmit`.

**Phase 6 — Smoke.**
- Local: `npx hardhat test` (full suite green).
- Mainnet fork (if available): run `zapInMintLp` → `stakeLp` → `unstakeLp` → `zapOut` smoke via `lib/executor/policy-vault-lp.ts` against a forked mainnet RPC.
- Live mainnet (if gas budget allows): `deploy-mainnet-factory-v3.ts` → `deploy-mainnet-zia-lp-adapter.ts` → `create-mainnet-vault-v3.ts` → `verify-mainnet-v3.ts` → one real `zapInMintLp` + `stakeLp`.
- Browser: open the app, verify Discover / Copilot / Agents / Vault on desktop + mobile; verify the "Migrate to v3" panel renders for a V2 wallet; run the confirm flow on a throwaway wallet.
- **Verify:** browser visual QA + the AGENTS.md smoke checklist.

---

## 12. Risks & Open Questions

1. **`minLiquidityFloor` tighten-direction bug (load-bearing).** §2.1.9 flags that the floor's tighten direction is inverted in the multi-field `if` body. The implementer MUST write `if (n.minLiquidityFloor < c.minLiquidityFloor) revert BadPolicy();` as a separate clause. Getting this backwards lets admin lower the LP slippage floor silently = loss-of-funds risk. Codex: audit this specifically.

2. **`claimRewards` shape risk (v4 hedging).** `ZiaVault` ABI has no `claim`/`pendingRewards` today. `claimRewards` is a reserved slot that reverts `RewardsNotConfigured`. If Zia later ships a claim method on the vault itself, `ZiaLpAdapter.claimRewards` can be updated to route to it — but that requires redeploying the adapter (immutable, no proxy). If the claim shape requires a separate distributor contract (e.g. a Merkle-distributor with per-epoch roots), that is the v4 trigger. Label APR capture as `pending` everywhere per AGENTS.md.

3. **Zia `withdraw(tokenId)` auto-claim unknown.** Per `docs/integrations/zia-tradegpt-partner-api.md` Missing Information §194-205: unknown whether `ZiaVault.withdraw(tokenId)` auto-claims accrued rewards or only returns the LP NFT. If it auto-claims, the rewards land in the vault as an ERC20 the vault must `rescueToken` (owner-only) or sweep. If it does not, rewards may be stranded until a claim method exists. The V3 design handles both: `unstakeLp` only moves the NFT; any ERC20 that arrives via auto-claim sits in the vault as custodian and is swept via `rescueToken`. Document this in the UI.

4. **Tick-range strategy unknown.** V3 ships the primitive (`zapInMintLp` with `tickLower`/`tickUpper`); the off-chain keeper chooses the range. This plan does NOT encode a tick-range strategy. The keeper (next LP-agent plan) must choose ranges; the vault only validates `tickLower < tickUpper` and binds the range in the hash + `lpNftTicks` storage. Open: should the vault enforce a per-pool allowed tick-range band (e.g. reject extreme out-of-range mints)? AGENTS.md "allowlisted... pools" suggests yes, but tick ranges are continuous, not a finite allowlist. Recommend: do NOT enforce tick bands in V3 (too coarse); enforce via the off-chain keeper's `IntelligentData` LP filter hash (entry 6) which binds the agent to a chosen strategy. Codex: flag if this is insufficient.

5. **Two-asset delta accounting complexity.** LP mint/increase consume two tokens and return one NFT + liquidity; the delta check is more complex than V2's single-asset swap. The §2.1.11 design uses single-sided native zap (`zapInMintLp`/`zapInIncreaseLiquidity`): the vault wraps 0G → W0G, `forceApprove`s the LP adapter for the W0G, the adapter does the balancing swap + mint internally and returns `amount0`/`amount1` (the consumed amounts), then the vault `forceApprove(…,0)`. The delta check is `W0GBalanceDelta + nativeDelta == amountIn0G` (the vault's native in = W0G consumed + any residual) and the returned `amount0`/`amount1` are validated against `amount0Min`/`amount1Min` and the quoted floors. The implementer MUST pick ONE adapter calling convention (vault pre-funds W0G via `forceApprove`, adapter pulls via `transferFrom`) and assert the delta check matches it. Risk: a mismatched delta check either reverts valid mints or accepts malicious adapter returns. Codex: audit the chosen convention against `ZiaLpAdapter.zapInMintLp` body.

6. **Single-sided 0G mint = one proof-anchored zap action.** RESOLVED: `zapInMintLp` does wrap+balancing-swap+mint in ONE tx inside the LP adapter, charging LP caps on the full `amount0G`. The two-action `buy`→`mintLp` path is dropped (it bypassed LP caps — Codex re-audit blocker 4). The LP adapter embeds a single `swapExactIn` via the immutable `swapRouter` (recipient = vault) then `NFPM.mint` — this is narrow (immutable router, allowlisted pool, recipient hard-pinned), not arbitrary calldata pass-through. The intermediate-state risk (swap succeeds, mint fails) is internal to the adapter call and reverts atomically; the vault's `forceApprove(…,0)` runs in the same outer tx.

7. **Mainnet gas for migrate.** v2→v3 migrate is: `createVault` (V3 factory) + `withdrawNative` (V2) + `depositNative` (V3) + `setPaused` (V2) + `revokeExecutor` (V2) + N × `setAgentKeyEnabled` (V3) for each agent. For a wallet with several agents, this is 6 + N txs. On mainnet 0G, gas is real 0G. The `migrateVault` hook batches these as separate owner-signed txs (not a multicall — V2/V3 have no multicall per AGENTS.md). Risk: a partial migrate (e.g. `createVault` + `withdrawNative` succeed, `depositNative` reverts) leaves funds in the owner's EOA, not the V3 vault. The hook should handle this: if `depositNative` fails, surface the error and let the user retry `depositNative` manually (the V3 vault exists, native is in the EOA). Document the partial-migrate recovery.

8. **LP cooldown asymmetry.** §2.1.11 decision: LP cooldown applies to MINT/INCREASE/STAKE only (capital-deploying); DECREASE/COLLECT/BURN/UNSTAKE/ZAP/CLAIM are exempt. Rationale: blocking withdrawals during cooldown is a fund-availability risk; the risk we want to block is rapid capital deployment. Codex: flag if this asymmetry is a concern. Alternative: apply cooldown to all LP actions (mirror V2 swap where both buy AND sell reset `lastTradeAt`) — but this blocks emergency unstake/zap during cooldown, which is worse for the user.

9. **`rewardsContract` set/clear dropped from V3 (Codex re-audit major 12 fix).** RESOLVED: V3 ships NO `rewardsContractFor`/`rewardsContractForVault` storage, NO `proposeRewardsContract`/`acceptRewardsContract`/`clearRewardsContract` setters, NO `RewardsContractSet` event. `claimRewards` is an unconditional `revert RewardsNotConfigured()` reserved slot. The prior draft shipped the setter + storage while §12 simultaneously said "no timelock" — contradictory and NOT VERIFIED (no Zia claim ABI exists). When Zia delivers a claim/pendingRewards ABI, v4 adds the stake-vault-keyed two-step timelock (`proposeRewardsContract(stakeVault,…)` + `acceptRewardsContract(stakeVault)` after 24h) together with the storage and the real claim path — at that point enabling `claimRewards` is a new funds-pulling action and the timelock is the AGENTS.md-required gate. No loosening surface ships on V3.

10. **`receivedActionHashFor` domain tag bump.** V3 swap path keeps the V2 domain tag `..._ACTION` (per §2.1.10 rationale — no cross-version collision risk). LP path uses `..._ACTION_LP`. If Codex prefers a hard version bump for ALL V3 actions (swap + LP) to `..._ACTION_V3`, the implementer should bump the swap tag too and update the server hash builder in `policy-vault-trade.ts` to call the new V3 tag. Risk: breaking indexer parity for the swap path. Recommend: keep V2 tag for swaps, separate tag for LP.

11. **` OgAgentDeploymentRecord.vault` mutation during migrate.** §4.2 route updates the registry file while the on-chain migrate txs are in-flight. If the registry write succeeds but a `setAgentKeyEnabled` tx fails, the registry points at V3 but the agentKey is not enabled on V3 (agent shows "paused" on V3). Recovery: the route should write the registry only AFTER all `setAgentKeyEnabled` txs confirm; if any fails, leave the registry at V2 and surface the error. The `migratedFromVault` field preserves the V2 address for rollback.

12. **Hardhat 0.8.24/cancun alignment.** AGENTS.md and `hardhat.config.ts` now agree on `solc 0.8.24`, `evmVersion: "cancun"`, `viaIR: true`, optimizer 200 for the default profile. Source files with `pragma solidity ^0.8.19` still compile under that profile. The verify script must submit `0.8.24`/cancun to the explorer.

---

**End of plan.** Codex audit targets: AGENTS.md deny-by-default compliance (§2.1.9, §2.1.11, §2.4), loss-of-funds risks (§12 items 5, 7, 11), correctness of hash composition (§2.1.10), tighten-direction correctness (§2.1.9 — fixed inline), and the v4-avoidance rationale (§1).

---

## 13. Critique Resolutions (adversarial pre-audit — all 15 findings addressed)

This plan was redrafted through an adversarial critique pass before reaching Codex. Findings and where they were resolved:

| # | Severity | Finding | Resolution in this plan |
|---|---|---|---|
| 1 | BLOCKER | No owner-rescue path for ERC721 LP NFTs (custodied or staked) — stranded after revoke/pause | §2.1.8: added `rescueNft(nft, tokenId)` + `unstakeLpOwner(tokenId, stakeVault)`, both `onlyOwner nonReentrant`, recipient hard-pinned to `owner()` (no `to` arg). §6: owner-rescue + negative tests. §6.3: new coverage row. |
| 2 | MAJOR | `stakeLp` NFT-approval mechanics wrong (adapter is not NFT owner) | §2.1.11 stakeLp: vault-direct — vault calls `NFPM.approve(stakeVault, tokenId)` then `IZiaVault(stakeVault).deposit(tokenId)` itself; `unstakeLp` calls `IZiaVault(stakeVault).withdraw(tokenId)` directly. NO `stakeLp`/`unstakeLp` in the adapter interface (§2.3). The adapter never takes NFT custody for staking. |
| 3 | MAJOR | LP caps bypassed for single-sided 0G mints (two-action swap+mint) | Added `ZAP_IN_MINT_LP` actionType + `zapInMintLp` entrypoint (§2.1.11, §2.3) that does wrap+swap+mint in ONE proof-anchored action charging the full `amount0G` against LP caps. Dropped the two-sided `mintLp`/`increaseLiquidity` entrypoints (Codex re-audit blocker 4 — they bypassed LP caps via pre-custodied `buy`). Only single-sided `zapInMintLp`/`zapInIncreaseLiquidity` ship. §1 + §6: cap-honesty invariant tests. |
| 4 | MAJOR | v4-avoidance overstated for auto-compound/rebalance (no executor sweep of collected fees) | Added `SWEEP_TOKEN` actionType + `sweepToken` entrypoint (§2.1.11, §2.3) — executor-callable swap of custodied allowlisted ERC20 → allowlisted token/native, routing via `request.tokenIn`/`request.tokenOut` + `allowedLpPools` (LP pool namespace, pool-address-encoded — round-3 blocker fix: NOT the V2 `allowedPools` curated route IDs) + `quotedAmountOut` floor, recipient hard-pinned to vault, `amount1Min > 0`. §1 v4-avoidance claim rewritten honestly: autonomy feasible with the shipped primitive set; v4 only for rewards/claim distributor. |
| 5 | MAJOR | `minLiquidityFloor` tighten-direction bug in §2.1.9 code body | §2.1.9: replaced buggy folded clause with correct standalone `if (n.minLiquidityFloor < c.minLiquidityFloor) revert BadPolicy();`. Removed the load-bearing prose aside. |
| 6 | MAJOR | Migrate `setAgentKeyEnabled` signing undefined for non-deployer owners; server leaks owner-key scope | §4.1 + §4.2 rewritten: CLIENT (owner wallet) signs and sends all `setAgentKeyEnabled` txs; server route `/api/agents/migrate-vault` is registry-only, updates off-chain records AFTER client confirms txs, never holds/uses the owner key. |
| 7 | MAJOR | Two-asset delta check breaks on fee-on-transfer / hostile tokens | §2.1.11 zapInMintLp/zapInIncreaseLiquidity: single-sided native zap (vault wraps 0G → W0G, `forceApprove`s adapter, adapter does balancing-swap + mint internally, vault `forceApprove(…,0)`). Delta assertion on the vault's W0G + native balances; fee-on-transfer tokens banned at `allowedTokens` allowlist level; runtime `LpBadDelta` is the backstop. §6: `HostileToken` test with zero-state-mutation snapshot. |
| 8 | MAJOR | `TokenData.vault` divergence may break verifier/consumers reading `agentRecord(tokenId).vault` | §8: required audit step (grep all `agentRecord`/`TokenData.vault`/`agent.vault` read sites) + current evidence that no on-chain consumer compares vault addresses (AgenticID `agentRecord` is pure view, PolicyVaultV3 never calls into AgenticID, TS `readVaultSnapshot` picks active vault via factory version not `TokenData.vault`). Audit result must be documented before Codex sign-off. |
| 9 | MAJOR | `decreaseLiquidity` does not reduce `openLpExposure0G` — locks freed capital | §2.1.2: added `lpNftDeployedNative[tokenId]` storage. §2.1.11 decreaseLiquidity: pro-rata reduction `nativeFreed = deployed * liquidityDecreased / totalLiq` applied to `openLpExposure0G` + `lpNftDeployedNative` + `agentLpNotionalDeployed`. §6: pro-rata exposure test. |
| 10 | MINOR | No per-agent LP exposure cap | §2.1.3: documented that LP exposure is shared across agents on the same vault — acceptable because the factory model is one-vault-per-owner. `agentLpNotionalDeployed` tracked for observability. |
| 11 | MINOR | `zapOut` `tokenIn` derivation not specified (executor could pick malicious pool) | §2.1.11 zapOut: vault derives `tokenIn`/`tokenOut` from `lpNftPool[tokenId]` + verified pool immutables; executor supplies only `liquidity` + `amount0Min`. §2.3: `ZapOutParams` dropped `tokenIn`/`tokenOut`/`amountIn` args; added `poolTokens(poolId)` view. |
| 12 | MINOR | `rewardsContractFor` keyed by `poolId` but `claimRewards` validates via `stakeVault` | RESOLVED by removal (Codex re-audit major 12): V3 ships NO `rewardsContractFor`/`rewardsContractForVault` storage at all. `claimRewards` is an unconditional `revert RewardsNotConfigured()` — no keying needed. The rekeying question is moot on V3. |
| 13 | MINOR | `setRewardsContract` arguably a loosening | RESOLVED by removal (Codex re-audit major 12): V3 ships NO `setRewardsContract`/`proposeRewardsContract`/`acceptRewardsContract`/`clearRewardsContract`. No loosening surface exists. The two-step timelock is deferred to v4 alongside the real claim ABI (when enabling `claimRewards` becomes a funds-pulling action). |
| 14 | MINOR | `maxLpExposure0G` unbounded sentinel inconsistent | §2.1.7: unified to `type(uint256).max` = unbounded (parity with V2 cap semantics), documented in natspec + tests. |
| 15 | MINOR | LP cooldown asymmetry under-documented for audit | §2.1.11: one-line invariant — LP cooldown gates capital-deploying actions only (ZAP_IN_MINT_LP/ZAP_IN_INCREASE_LIQUIDITY/STAKE_LP/SWEEP_TOKEN); capital-returning actions (DECREASE_LIQUIDITY/COLLECT_FEES/BURN_LP/UNSTAKE_LP/ZAP_OUT/CLAIM_REWARDS) are exempt. §6: explicit test that `zapOut`/`unstakeLp`/`decreaseLiquidity` succeed within active cooldown. |

**Verdict of the pre-audit pass:** the first draft was "not ready for Codex as-is" (findings 1–3 blockers/majors changing contract surface, 4 requiring a new primitive or honest downgrade, 5 a code-body correction, 6–9 design decisions). All were resolved inline, then Codex gpt-5.5 xhigh re-audited (round 1) and returned 7 blockers + 9 majors; the round-1 revision fixed all of them: dropped two-sided `mintLp`/`increaseLiquidity` (blocker 4 cap bypass), vault-direct staking (blocker 1), `tightenPolicy` allowStaking direction (blocker 2), sweep routing via request fields + quoted floors (blocker 3), `receive()` admits LP adapter native (blocker 5), per-action cooldown (major 13), `quotedLiquidity`/`quotedAmountOut` hash-binding + min-floor (major 9), `stakeVaultForLpPool` constructor seeding (major 10), `int256 liquidityDelta` events (major 14), `burnLp` collect-then-burn + unsigned NFT-burn delta (major 15), `claimRewards` unconditional revert + no rewards storage/setters (major 12), `decreaseLiquidity`/`zapOut` exposure accounting (major 11), policyHash-extended-not-byte-identical note (major 8). Codex round 2 then returned 4 new blockers + 3 majors introduced by the revision; this round-2 revision fixes all of them: per-tokenId ERC721 approval helper `_approveLpAdapterForNft`/`_clearLpAdapterNftApproval` for `decreaseLiquidity`/`collectFees`/`burnLp`/`zapOut` NFPM calls (blocker 1 — adapter was not NFT-owner/approved), no clear-after-transfer in `stakeLp` (blocker 2 — ERC721 auto-clears on transfer, post-deposit `approve(0)` would revert), `poolId` encoding unified to `bytes32(uint256(uint160(poolAddress)))` recoverable form (blocker 3 — keccak256 was one-way and made poolTokens/zap routing unrecoverable), `sweepToken` native-out allowed via `tokenOut == NATIVE_TOKEN || allowlisted` and routed through `lpAdapter.sweepToken` not the V2 swap adapter (blocker 4 — internal inconsistency + native-out forbidden), `minLiquidityFloor` enforced on mint/increase (major 1), `request.poolId == lpNftPool[tokenId]` on every tokenId action (major 2), `stakeVaultForLpPool` arg in `create-mainnet-vault-v3.ts` (major 3). The plan is resubmitted for Codex gpt-5.5 xhigh round-3 re-audit with this resolution map. Codex should verify each round-2 fix is actually encoded in the referenced section.

**Round-3 revision (Codex round-3 audit returned 1 blocker + 4 majors + 4 minors):** fixed sweep pool namespace (round-3 BLOCKER — sweep uses `allowedLpPools` pool-address-encoded, NOT the V2 `allowedPools` curated route IDs, so the adapter can recover the pool address and V2 swap stays untouched); W0G-leg requirement on `zapInMintLp`/`zapInIncreaseLiquidity` (round-3 major — 5 non-W0G `ZIA_LP_VAULTS` pools revert `LpPoolNotZappable`, multi-hop zap deferred to v4, §1 v4-triggers updated); `liquidity` added to `ZapOutParams` (round-3 major — partial zap now passes the amount to decrease); explicit `actionType == <TYPE>` pinned on all seven tokenId entrypoints (round-3 major — prevents proof/audit hash describing a different LP action while another body executes); `burnLp` allows zero min on empty sides (round-3 major — empty NFTs no longer stranded); minors fixed — `LpInvalidMinOut` name unified, `LpTickMismatch` error declared, §6.3 ZAP min-fields row corrected for `zapOut` `amount1Min == 0`, §6.1 `claimRewards` removed from cooldown-exempt SUCCEED list (always reverts). Resubmitted for Codex gpt-5.5 xhigh round-4 re-audit.

**Round-4 revision (Codex round-4 audit returned 1 blocker + 4 majors, all NEW issues introduced by the round-3 revision; the round-3 fixes were confirmed present):** BLOCKER 1 — `LpActionRequest.liquidity` changed from `uint256` to `uint128` (matches NFPM + `DecreaseParams`/`ZapOutParams`), `request.liquidity <= lpAdapter.liquidityOf(tokenId)` bounded on `decreaseLiquidity`/`zapOut`, the `uint128(request.liquidity)` cast removed from `zapOut` so adapter call + full/partial detection + event + pro-rata accounting all use the same `uint128` value with no truncation gap (§2.1.3, §2.1.11, §2.3; §6 fuzz test). MAJOR 1 — sweep namespace text cleanup: `LpActionRequest.poolId` comment + `tokenIn`/`tokenOut` note + §2.1.12 encoding list now all say `allowedLpPools` only; V2 `allowedPools` (curated route IDs) explicitly excluded from the LP encoding list (§2.1.3, §2.1.12). MAJOR 2 — `claimRewards` carved out of `_validateLpRequest` entirely; the entrypoint body is the single statement `revert RewardsNotConfigured();` executed before any actionType/agentKey/stakeVault/cooldown check, so no other error can mask the unconditional revert (§2.1.11; pre-flight step 12 + §6 updated). MAJOR 3 — `burnLp` per-side min validation rewritten as `quoted == 0 ? min == 0 : min > 0 && min >= ceilDiv(quoted * lpMinOutBps, BPS)`; all LP min-floors switched from floor-div to `ceilDiv` via `minLpOutFor` so a tiny nonzero quote cannot round the floor to 0 (§2.1.9 helper, §2.1.11 burnLp + pre-flight step 3 + error comment; §6 tiny-residual test). MAJOR 4 — `sweepToken` native-out normalization: the adapter computes `effectiveTokenOut = (tokenOut == NATIVE_TOKEN) ? wrappedNative : tokenOut` and validates the pool pair against `{tokenIn, effectiveTokenOut}` before swapping to W0G and unwrapping (§2.1.11 sweepToken + §2.3 SweepParams note; §6 normalization test). Resubmitted for Codex gpt-5.5 xhigh round-5 re-audit.

**Round-5 revision (Codex round-5 audit returned 0 blockers + 1 major + 1 minor; the round-4 fixes were confirmed present):** MAJOR 1 — `claimRewards` was carved out of `_validateLpRequest` but NOT out of the shared entrypoint skeleton, so the `onlyExecutor`/`executorActive`/`lpAdapterConfigured`/`nonReentrant` modifiers could still fire `NotExecutor`/`Paused`/`ExecutorIsRevoked`/`LpAdapterNotConfigured` before `RewardsNotConfigured`. Fix: §2.1.11 skeleton now explicitly exempts `claimRewards`; the entrypoint is a standalone no-modifier `function claimRewards(LpActionRequest calldata) external payable { revert RewardsNotConfigured(); }` with NO `onlyExecutor`/`executorActive`/`lpAdapterConfigured`/`nonReentrant` (§2.1.11 skeleton note + claimRewards block; §6 ABI-shape + non-executor/paused/revoked/no-adapter revert test). MINOR 1 — `minLpOutFor` was declared `public pure` but could not read `policy.lp.lpMinOutBps` in a `pure` context. Fix: changed to `internal view` reading `policy.lp.lpMinOutBps`, all LP min-floor checks route through it (§2.1.12; §6 unit test). Resubmitted for Codex gpt-5.5 xhigh round-6 re-audit.

**Round-6 revision (Codex round-6 audit returned 0 blockers + 1 major + 1 minor; the round-5 fixes were confirmed present):** MAJOR 1 — §2.1.6 + §6.3 still said `nonReentrant` applies to "ALL LP entrypoints", contradicting the `claimRewards` no-modifier carve-out. Fix: both blanket statements changed to "all stateful LP entrypoints EXCEPT `claimRewards`"; the §6.3 reentrancy coverage row scopes the `ReenteringLpAdapter` test away from `claimRewards` (revert-only, no reentrancy surface) (§2.1.6, §6.3). MINOR 1 — the per-action validation text in §2.1.11 still used raw `ceilDiv(quoted... * lpMinOutBps, BPS)` instead of routing through the `minLpOutFor` helper. Fix: every LP min-floor check in §2.1.11 (and the struct comment / error comment / pre-flight step 3 / hash-binding note) now reads `minLpOutFor(quoted...)`; `burnLp` keeps its `quoted == 0 ? min == 0 : min > 0 && min >= minLpOutFor(quoted)` per-side shape. The `minLpOutFor` definition in §2.1.12 retains the `ceilDiv(quote * policy.lp.lpMinOutBps, BPS)` body (that IS the implementation) (§2.1.11, §2.1.12). Resubmitted for Codex gpt-5.5 xhigh round-7 re-audit.

**§12 risk items updated:** item 1 (minLiquidityFloor) — RESOLVED inline in §2.1.9. Item 6 (single-sided mint) — RESOLVED via `zapInMintLp`/`zapInIncreaseLiquidity`; the two-action path is dropped. Item 8 (cooldown) — RESOLVED + documented as invariant in §2.1.11 (per-action, deploying-only). Item 9 (rewardsContract loosening) — RESOLVED by removal (no setter/storage on V3). Remaining open §12 items: 2 (claimRewards v4 trigger — by design), 3 (Zia withdraw auto-claim unknown — handled via custodian sweep), 4 (tick-range strategy — deferred to keeper), 5 (two-asset delta convention — pinned to single-sided zap + W0G forceApprove pattern), 7 (mainnet gas / partial-migrate recovery), 10 (domain tag — kept V2 for swaps, `..._ACTION_LP` for LP), 11 (registry write ordering — client-confirms-first per finding 6), 12 (hardhat 0.8.24/cancun alignment).
