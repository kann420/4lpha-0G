# V4 Implementation Plan — 4lpha-0G PolicyVaultV4 (3-Way Split) + VaultRegistryV4 + ZiaLpAdapterV4 + Migration

> Synthesis of 6 subsystem designs, revised to close all 43 audited gaps. Where tension existed, the more conservative/secure option was chosen. Most consequential changes vs the prior draft: (1) the single-vault + factory design is replaced by a **three-contract per-user split** (`PolicyVaultV4Swap` + `PolicyVaultV4LpEntry` + `PolicyVaultV4LpExit`) coordinated by a tiny **`VaultRegistryV4`** (no `new`, no embedded child bytecode), because empirical compile-and-measure shows the two-contract LP vault projects to ~27.7-30.2KB — over EIP-170's 24576B cap by 3.1-5.6KB (the prior draft's ~22.7KB estimate sat inside the error band; the honest pessimistic range is ~22-27KB and the 3-way split is now PRIMARY, not a fallback); (2) the size-gate mechanism is a Hardhat-3-native node script (`scripts/check-contract-size.ts`), NOT `hardhat-contract-sizer` (which does not exist for Hardhat 3 — GAP 21); (3) `VaultRegistryV4` keys registration by `msg.sender` (the vault itself) and re-verifies `Ownable(storedVault).owner()==owner` on read, closing the pre-registration grief vector (GAP 10); (4) the resolver gates V4 activation on agentKey enabled on ALL THREE vault halves (GAP 17/35); (5) the deployer-owned-source migration path now hard-asserts on-chain that no non-deployer agent owns positions/NFTs before the deployer withdraws (GAP 12). Codex executes this end-to-end. All file paths absolute.

---

## 1. Goals & Non-Goals

### Goals
1. **Inherit ALL V2 swap surface + ALL V3 LP surface with zero regressions**, with explicit, documented exceptions forced by the EIP-170 3-way split: (a) `tightenPolicy` is split into three non-atomic owner txs (one per vault third) — V3 tightened swap+LP atomically in one tx, V4 cannot (GAP 4); (b) the LP vault `vaultActionHashForLp` encoding intentionally drops `address(adapter)` because the V4 LP adapter is a different contract from V3's and can never match a V3 hash anyway (GAP 7); (c) `policyHash()` is per-vault (Swap = V2 6-field hash, LpEntry = 7-field LpPolicy hash) — NOT the V3 13-field combined hash (GAP 7); (d) pause does NOT freeze executor LP exits — only `revokeExecutor` is a full kill switch (GAP 2); (e) `disableAgentKey` blocks LP ENTRIES only, not exits (GAP 3/11).
2. **Restore the 5 deferred LP entrypoints** (`zapInIncreaseLiquidity`, `decreaseLiquidity`, `collectFees`, `burnLp`, `sweepToken`) that V3 omitted entirely — by pushing heavy LP orchestration into `ZiaLpAdapterV4` so each vault third stays thin. Enforcement (validation + delta + accounting) stays in the vaults — non-negotiable.
3. **Per-user three-vault split + on-chain `VaultRegistryV4`.** Each user deploys their own `PolicyVaultV4Swap` + `PolicyVaultV4LpEntry` + `PolicyVaultV4LpExit` (wagmi `deployContract`, self-serve) then the USER calls `registry.register*(vault)` for each (owner-called — Codex R7-REG, unspoofable); `registry.vaultOf(owner)` (returning all three addresses) is the single source of truth. No `new`-factory (the V3 factory deployed bytecode measures 28766B / 28.77KB — over the 24576B cap by ~4.2KB — GAP 24). No env flip, no restart. **Per-user vaults deploy exclusively via UI `createVaultV4` (wagmi `deployContract`); hardhat `deploy:vault:mainnet:*:v4` scripts are dropped from the per-user path.**
4. **V1 → V4, V2 → V4, V3 → V4 migration** with idempotent per-item resume, LP-NFT preservation path (V3), loss-of-funds matrix, and explicit postcondition gates before every step advances. The deployed V3 singletons (`0xfd39`, `0x7a2A…`) are **DEPLOYER-owned**; for deployer-owned source vaults, the DEPLOYER signs source-side owner actions — but ONLY after a hard on-chain precondition gate asserts no non-deployer agent owns any position/NFT/staked-NFT in the source vault (GAP 12).
5. **User-signed owner actions; deployer-signed mint + acceptProof; shared executor approved per-vault — except source-side owner actions on deployer-owned legacy vaults (gated).** DEPLOYER signs `mintAgent` + `acceptProof` AND source-side owner actions on deployer-owned V1/V2/V3 vaults (only after the GAP 12 inventory gate passes). USER signs every owner action on their own V4 vaults and on any user-owned legacy vault. Shared `VAULT_EXECUTOR_PRIVATE_KEY` is the immutable `executor` on all three vault thirds; per-user isolation comes from per-user vaults.
6. **Close the documented V3 defects:** the `lpDailySpent0G` global-singleton lockout (per-user LP vault resets the daily window), the env-override owner-resolution bug, and the missing `increaseLiquidity` in the adapter's inline NFPM interface.
7. **Full AGENTS.md compliance** for the 5 new LP functions (deny-by-default, no arbitrary call/delegatecall/multicall/recipient, allowlisted adapters/pools/tokens, **nonzero amountOutMin with NO exception** — `collectFees` enforces `amount0Min > 0 && amount1Min > 0` (>= 1 wei) and is documented as a post-decrease residual collector only, NOT usable on active/asymmetric positions — GAP 13; per-trade/daily/max-exposure caps, cooldown on ALL deploying actions including `zapInMintLp` + `stakeLp` (GAP 1), nonces, deadline, balance-delta checks, admin cannot move funds, mock rejected in prod at the contract level).
8. **Carry V3's `rescueNft`** (owner-only NFT recovery) into the **LP Entry vault (primary — rescues an NFT stranded in LpEntry after a failed `importLpNft`, GAP 24) and LP Exit vault (secondary — for the rare case an NFT lands on LpExit)** — closes the revokeExecutor loss-of-funds hole for un-staked NFTs (G-03).
9. **LP vaults have full owner recovery paths** (`depositNative`/`withdrawNative`/`rescueToken` — GAP 6/8/33) — closes the strand-funds blocker where native from `zapOut`/`sweepToken`-native-out and ERC20 from `collectFees`/`decreaseLiquidity` would otherwise be permanently stranded.
10. **≥99% confidence** that the implementation passes the full test matrix (section 9) and the 10 required mainnet smoke paths on first integration, conditional on the native size-gate script confirming each contract < 24576B — which is the FIRST V4 task implemented.

### Non-Goals
- No in-place upgrade of deployed V1/V2/V3 vaults. V4 is fresh deploy; existing vaults drained + retired.
- No per-user executor keys. Shared server executor; per-vault isolation boundary.
- No `iTransfer`/`iClone` wiring (stays disabled per ERC-7857 policy).
- No real DEX swap adapter change. LP adapter's internal balancing swap uses the real SwapRouter on mainnet.
- No on-chain loosen/reset of LP caps. LP caps are tighten-only (V3 semantics preserved); migration headroom is a create-time decision.
- No `new`-based factory (24KB blocker). No standalone `/copilot` page. No BNB/Mantle/ZeroDev/legacy-LP paths.
- No hardhat user-vault deploy scripts. No `hardhat-contract-sizer` dependency (does not exist for Hardhat 3 — GAP 21).

---

## 2. Architecture Overview

```
                         ┌────────────────────────────────────────────┐
   USER wallet ─────────▶│  VaultRegistryV4  (<2KB, no `new`)          │
   (signs owner acts)    │  - swapVaultOf(owner)                       │
                         │  - lpEntryVaultOf(owner) / lpExitVaultOf(owner) │
                         │  - registerSwap / registerLpEntry / registerLpExit │
                         │  - vaultOf(owner) -> (swap, lpEntry, lpExit)│
                         │  Keyed by msg.sender (the vault); re-verifies │
                         │  Ownable(storedVault).owner()==owner on read │
                         └──────┬──────────────────────────────────────┘
                                │ user deploys each third (wagmi deployContract),
                                │ USER calls registry.register*(vault) per third (owner-called)
              ┌─────────────────┼─────────────────┐
              ▼                 ▼                   ▼
 ┌────────────────────┐ ┌──────────────────────┐ ┌──────────────────────────┐
 │ PolicyVaultV4Swap   │ │ PolicyVaultV4LpEntry  │ │ PolicyVaultV4LpExit       │
 │ (per-user)          │ │ (per-user)            │ │ (per-user)                │
 │ Ownable(user)       │ │ Ownable(user)         │ │ Ownable(user)             │
 │ ReentrancyGuard     │ │ ReentrancyGuard       │ │ ReentrancyGuard           │
 │ ─ V2 swap surface   │ │ ─ zapInMintLp         │ │ ─ unstakeLp               │
 │   buy/sell/deposit/ │ │ ─ zapInIncreaseLiquidity│ │ ─ unstakeLpOwner          │
 │   withdraw/rescue/  │ │ ─ stakeLp             │ │ ─ zapOut                  │
 │   admin             │ │ ─ sweepToken          │ │ ─ decreaseLiquidity       │
 │ ─ tightenPolicy(6)  │ │ ─ importLpNft         │ │ ─ collectFees             │
 │ ─ poolAddressOf     │ │ ─ depositNative       │ │ ─ burnLp                  │
 │ Immutables:         │ │ ─ tightenLpPolicy(7) │ │ ─ rescueNft               │
 │  executor,          │ │ ─ NFT accounting      │ │ ─ withdrawNative          │
 │  swapAdapter,       │ │   (lpNftOwner/Pool/   │ │ ─ rescueToken             │
 │  proofRegistry,     │ │    Ticks/DeployedNative,│ │ ─ receive + onERC721Received│
 │  mockAdapter,       │ │    agentLpNfts/       │ │ Immutables:               │
 │  vaultRegistry      │ │    agentStakedNfts,   │ │  executor, lpAdapter,     │
 │ receive():          │ │    exposure/daily)    │ │  proofRegistry,           │
 │  owner|swapAdapter  │ │ Immutables:           │ │  mockLpAdapter,           │
 │                     │ │  executor, lpAdapter, │ │  vaultRegistry,           │
 │ ~10KB deployed      │ │  proofRegistry,       │ │  lpEntry (immutable ref   │
 │                     │ │  mockLpAdapter,       │ │  for NFT accounting)      │
 │                     │ │  vaultRegistry        │ │ receive(): owner|lpAdapter│
 │                     │ │ receive(): owner|lpAdapter│ ~10-12KB deployed       │
 │                     │ │ ~10-12KB deployed     │ │                          │
 └──────────┬──────────┘ └──────────┬────────────┘ └──────────┬───────────────┘
            │ typed CALL             │ typed CALL                │ typed CALL
            ▼                        ▼                           ▼
 ┌────────────────────────┐  ┌─────────────────────────────────────────────┐
 │ SwapAdapter (existing) │  │ ZiaLpAdapterV4 (new deploy)                  │
 │ 0xfaa8…6db unchanged   │  │ wrap/balancing-swap/NFPM/unwrap/refund        │
 └────────────────────────┘  │ 5 implemented bodies; recipient=msg.sender    │
                              └─────────────────────────────────────────────┘
                ▲
                │ EXECUTOR (shared server key) signs buy/sell + all LP entry/exit
                │ DEPLOYER signs acceptProof on shared ProofRegistry + mintAgent
                │           AND source-side owner actions on deployer-owned legacy vaults
                │           (ONLY after GAP 12 on-chain inventory gate passes)
                │ USER signs all owner-only on ALL THREE vault thirds + own legacy vaults
```

**Key architectural levers:**
- **Three-contract split gives each surface its own 24KB budget** without `delegatecall` (forbidden). Swap surface ≈ V2 size (~10KB); LP Entry surface ≈ ~10-12KB; LP Exit surface ≈ ~10-12KB. NFT accounting (the shared state) lives on `PolicyVaultV4LpEntry`; `PolicyVaultV4LpExit` holds an immutable `lpEntry` ref and calls typed `onlyLpExit`-gated getters/setters on it (no arbitrary call — fixed immutable address, typed interface).
- **`VaultRegistryV4` replaces the `new`-factory.** The V3 factory deployed bytecode measures 28766B (28.77KB) — over the 24576B cap by ~4.2KB (GAP 24). The registry holds only three `mapping(address=>address)` + register + events (~1-2KB); **Codex R7-REG FIX: registration is OWNER-CALLED — the USER calls `register*(vault)` after deploy (`msg.sender == Ownable(vault).owner()`), NOT constructor self-registration. The prior self-registration model was spoofable (a fake contract whose `owner()` returns the victim could register under the victim and survive `vaultOf` re-verification → wrong-target funding / drain). Owner-called registration is unspoofable; `vaultOf` re-verifies `Ownable(storedVault).owner()==owner` on read as defense-in-depth.** No `new`, no embedded child bytecode, no admin role.
- **Resolver race fixed (GAP 17/35):** `resolveActiveVaultForOwner(owner, agentKey)` reads `agentKeyEnabled(agentKey)` on ALL THREE V4 vault thirds; V4 is active only when ALL THREE are enabled. Until then, per-operation-type routing: swap ops fall back to V3/V2 when swap not active; LP ops fall back to V3 when either LP third not active. Resolution switches to V4-only only after all three keys are on-chain-verified.
- **Signer model:** DEPLOYER signs `mintAgent` + `acceptProof` + source-side owner actions on deployer-owned legacy vaults (gated by GAP 12 inventory). USER signs every owner action on all three vault thirds (and on user-owned legacy vaults). EXECUTOR (shared key) signs all `buy`/`sell`/LP entry+exit, approved per-vault via the immutable `executor` check.
- **LP vault `receive()` does NOT allowlist `swapAdapter`:** the swap adapter never sends native to the LP vaults (it sends native to the Swap vault on buy/sell). Both LP thirds' `receive()` accepts only `owner()` + `address(lpAdapter)`. The LP `vaultActionHashForLp` encoding intentionally drops `address(adapter)` (V4 uses a new `ZiaLpAdapterV4` address different from V3's `0x049a`, so the LP hash can never equal a V3 hash anyway). LP golden vectors are V4-own reference hashes (GAP 7).

---

## 3. Contracts — Full Spec

`pragma solidity ^0.8.24;` `evmVersion: "cancun"`, `viaIR: true`, optimizer runs 200. All three vaults inherit `Ownable` (slot 0 = `_owner`), `ReentrancyGuard` (slot 1 = `_status`). All three require `initialOwner == msg.sender` in the constructor (self-serve anti-grief: only the owner can deploy their own vault, preventing a front-run that bricks the one-vault-per-owner slot).

### 3.1 `D:\4lpha-0G\contracts\PolicyVaultV4Swap.sol` — storage

```solidity
struct Policy {                                 // swap-only (6 fields — no LP sub-struct)
    uint256 perTradeCap0G;
    uint256 dailyCap0G;
    uint256 maxExposure0G;
    uint256 cooldownSeconds;
    uint256 maxDeadlineWindowSeconds;
    uint16  defaultMinOutBps;                   // GAP 2 FIX: uint16 (V2/V3 parity), NOT uint256
}
Policy public policy;                            // slot 2
bool public paused;                              // slot 3
bool public executorRevoked;                     // slot 4
mapping(bytes32 actionHash => bool used) public usedActionHashes;            // 5
mapping(address token => bool allowed) public allowedTokens;                 // 6
mapping(bytes32 poolId => bool allowed) public allowedPools;                // 7
mapping(bytes32 agentKey => bool enabled) public agentKeyEnabled;           // 8
mapping(bytes32 agentKey => mapping(address token => uint256 units)) public agentPositionUnits;   // 9
mapping(bytes32 agentKey => uint256 count) public agentOpenPositionCount;   // 10
mapping(address token => uint256 units) public positionUnits;               // 11
mapping(address tokenIn => mapping(address tokenOut => uint16 minOutBps)) private _minOutBpsByPair; // 12
uint256 public dailySpent0G;        // 13
uint256 public dailyWindowStart;    // 14
uint256 public lastTradeAt;         // 15
uint256 public openExposure0G;      // 16
// immutables (not retained storage)
address public immutable executor;
IPolicyVaultAdapter public immutable swapAdapter;
IProofRegistry public immutable proofRegistry;
bool public immutable mockAdapterAllowed;
IVaultRegistryV4 public immutable vaultRegistry;   // immutable ref for setLpExitVault verification (no self-register — Codex R7-REG)
```

### 3.2 `D:\4lpha-0G\contracts\PolicyVaultV4LpEntry.sol` — storage (NFT accounting lives here)

```solidity
struct LpPolicy {
    uint256 perLpActionCap0G;
    uint256 lpDailyCap0G;
    uint256 maxLpExposure0G;
    uint256 cooldownSecondsLp;
    uint16  lpMinOutBps;                          // GAP 2 FIX: uint16 (V3 parity)
    uint256 minLiquidityFloor;
    bool    allowStaking;
}
LpPolicy public policy;                          // slot 2
bool public paused;                               // slot 3
bool public executorRevoked;                      // slot 4
mapping(bytes32 actionHash => bool used) public usedActionHashes;            // 5
mapping(bytes32 agentKey => bool enabled) public agentKeyEnabled;           // 8 (LP-side agentKey gate)
mapping(bytes32 poolId => bool allowed) public allowedLpPools;            // 17
mapping(bytes32 poolId => address stakeVault) public stakeVaultForLpPool;  // 18
mapping(address stakeVault => bool allowed) public allowedStakeVaults;     // 19
mapping(uint256 tokenId => bytes32 agentKey) public lpNftOwner;            // 20  (NFT accounting — shared)
mapping(uint256 tokenId => bytes32 poolId) public lpNftPool;               // 21
mapping(uint256 tokenId => int24) public lpNftTickLower;                    // 22
mapping(uint256 tokenId => int24) public lpNftTickUpper;                    // 23
mapping(uint256 tokenId => uint256) public lpNftDeployedNative;            // 24
mapping(bytes32 agentKey => mapping(bytes32 poolId => uint256[] tokenIds)) public agentLpNfts; // 25
// GAP 8 FIX: getter is (bytes32,bytes32)->uint256[], matching §3.2 and V3 line 197
mapping(bytes32 agentKey => mapping(address stakeVault => uint256[] tokenIds)) public agentStakedNfts; // 26
mapping(bytes32 agentKey => mapping(uint256 tokenId => bool staked)) private _isStaked;   // 27 (O(1) helper)
mapping(bytes32 agentKey => uint256) public agentLpNotionalDeployed; // per-agentKey (V3 correction)
uint256 public openLpExposure0G;         // 28
uint256 public lpDailySpent0G;           // 29 (per-user in V4)
uint256 public lpDailyWindowStart;       // 30
uint256 public lastLpActionAt;            // 31
address public constant NATIVE_TOKEN = address(0);
// immutables — NO swapAdapter: the swap adapter never sends native to the LP vaults
address public immutable executor;
IPolicyVaultLpAdapter public immutable lpAdapter;
IProofRegistry public immutable proofRegistry;
bool public immutable mockLpAdapterAllowed;
IVaultRegistryV4 public immutable vaultRegistry;
// GAP 12: ref to the LpExit vault (used to authorize exit-side accounting callbacks).
// G-EXEC-1 FIX: plain storage (NOT immutable) — set once via one-time `setLpExitVault` onlyOwner
// (reverts if already set), because LpEntry deploys BEFORE LpExit and cannot pass the address as a
// constructor arg. See §3.3b + §3.7.2. `bool internal _lpExitVaultSet;` guards one-time-settable.
address public lpExitVault;
bool internal _lpExitVaultSet;
```

> **`agentStakedNfts` shape preserved verbatim (GAP 3):** `mapping(bytes32 agentKey => mapping(address stakeVault => uint256[] tokenIds)) public agentStakedNfts;` with the `(bytes32, address) -> uint256[]` getter — identical to V3 (PolicyVaultV3.sol:200). A SEPARATE `_isStaked[agentKey][tokenId]` bool provides O(1) staked-checks without replacing the V3 getter.

> **NFT accounting on LpEntry (GAP 22):** `lpNftOwner`/`lpNftPool`/`lpNftTickLower`/`lpNftTickUpper`/`lpNftDeployedNative`/`agentLpNfts`/`agentStakedNfts`/`agentLpNotionalDeployed`/`openLpExposure0G`/`lpDailySpent0G`/`lpDailyWindowStart`/`lastLpActionAt` all live on `PolicyVaultV4LpEntry`. The Exit vault reads/writes them via typed `onlyLpExit`-gated functions exposed by LpEntry (see §3.7.3b).

### 3.2b `D:\4lpha-0G\contracts\PolicyVaultV4LpExit.sol` — storage

```solidity
// LpExit holds NO NFT accounting — it calls back to LpEntry.
// Local storage:
bool public paused;                               // slot 3 (LpExit has its own pause)
bool public executorRevoked;                      // slot 4
// GAP 14 FIX: separate sweep-route allowlist, NOT overloading allowedLpPools
// SIZE-2: allowedSweepPools + addSweepPool/disableSweepPool live on LpExit (sweep is exit-style)
mapping(bytes32 sweepPoolId => bool allowed) public allowedSweepPools;     // 32
// Codex 2.1 FIX: LpExit-local TOKEN allowlist for sweepToken. LpExit is a separate contract from
// Swap and CANNOT read Swap's `allowedTokens` (line 117). sweepToken converts a stray ERC20 →
// native/tokenOut, so tokenIn MUST be allowlisted here (admin-gated) so the executor cannot
// sweep-convert an arbitrary/malicious token (AGENTS.md "allowlisted input/output tokens").
// tokenOut (if non-NATIVE) is checked against this same map.
mapping(address token => bool allowed) public allowedSweepTokens;          // 32
// immutables
address public immutable executor;
IPolicyVaultLpAdapter public immutable lpAdapter;   // same adapter address as LpEntry
IProofRegistry public immutable proofRegistry;
bool public immutable mockLpAdapterAllowed;
IVaultRegistryV4 public immutable vaultRegistry;
IPolicyVaultV4LpEntry public immutable lpEntry;     // immutable ref for NFT accounting
```

> **LpExit has its own `paused`/`executorRevoked`** (independent of LpEntry). The UI pauses/revokes both LP thirds together. Per GAP 2, LpExit exits use `onlyExecutorNotRevoked` (pause does NOT block exits — deliberate exit-lockup; `revokeExecutor` is the hard kill). `revokeExecutor` on LpExit DOES block exits (the hard kill).

### 3.3 Constructor — `PolicyVaultV4Swap`

```solidity
constructor(
    address initialOwner, address executor_, address swapAdapter_, address proofRegistry_,
    Policy memory initialPolicy, address[] memory initialAllowedTokens, bytes32[] memory initialAllowedPools,
    bool allowMockAdapter, address vaultRegistry_
) Ownable(initialOwner) {
    if (initialOwner != msg.sender) revert NotAllowed();   // self-serve anti-grief
    executor = executor_; swapAdapter = IPolicyVaultAdapter(swapAdapter_);
    proofRegistry = IProofRegistry(proofRegistry_); vaultRegistry = IVaultRegistryV4(vaultRegistry_);
    _validatePolicy(initialPolicy); policy = initialPolicy;
    // GAP 14: contract-level mock rejection, byte-identical to V3:327-343
    AdapterKind kind = IPolicyVaultAdapter(swapAdapter_).adapterKind();
    if (kind == MOCK_ADAPTER_KIND && (!allowMockAdapter || block.chainid == MAINNET_CHAIN_ID))
        revert AdapterBlocked();
    mockAdapterAllowed = allowMockAdapter;
    for (uint i = 0; i < initialAllowedTokens.length; i++) {
        allowedTokens[initialAllowedTokens[i]] = true;
        emit TokenAllowed(initialAllowedTokens[i]);
    }
    for (uint i = 0; i < initialAllowedPools.length; i++) {
        allowedPools[initialAllowedPools[i]] = true;
        emit PoolAllowed(initialAllowedPools[i]);
    }
    // Codex R7-REG FIX: NO self-registration. The USER calls registry.registerSwap(address(this))
    // after deploy (§10 step 3). vaultRegistry retained as immutable ref for setLpExitVault verification.
    paused = false; executorRevoked = false;
}
```

### 3.3b Constructor — `PolicyVaultV4LpEntry`

Same shape: `if (initialOwner != msg.sender) revert NotAllowed();`; `lpKind == MOCK_LP_ADAPTER_KIND && (!allowMockLpAdapter || block.chainid == MAINNET_CHAIN_ID) → revert AdapterBlocked();` (GAP 14); seed `allowedLpPools`/`allowedStakeVaults`/`stakeVaultForLpPool` (GAP 14) — emit `LpPoolAllowed` / `StakeVaultAllowed`; (**SIZE-2: `allowedSweepPools` is NOT seeded here — it lives on LpExit storage (§3.2b) and is seeded in the LpExit constructor / `addSweepPool` on LpExit**); `vaultRegistry` is retained as an immutable ref (NO self-registration — Codex R7-REG FIX: the USER calls `registry.registerLpEntry(address(this))` after deploy, §10 step 3). **The `lpExitVault` is plain storage (G-EXEC-1) set via a one-time `setLpExitVault` onlyOwner call after LpExit deploys, guarded by `_lpExitVaultSet` (reverts if already set), not executor-controlled** (Codex R7-LOW 4.2 FIX: deleted the stale "deploys LpExit first OR passes address(0)" parenthetical — it contradicted the immutable `lpEntry` deploy order; the only valid order is LpEntry → LpExit → Swap → setLpExitVault). Deploy order: **LpEntry first, then LpExit (which receives `lpEntry` as a constructor arg), then Swap.** **Codex 4.2 FIX:** the alternative "deploy LpExit first, then `lpExit.setLpEntry(lpEntry)`" is INVALID — `lpEntry` is declared `immutable` in LpExit (§3.2b line 205) and cannot be set after construction. The only valid order is: **deploy LpEntry → deploy LpExit(passing lpEntry) → deploy Swap.** LpEntry's `lpExitVault` is set via a one-time `setLpExitVault` onlyOwner call after LpExit deploys.

### 3.3c Constructor — `PolicyVaultV4LpExit`

`if (initialOwner != msg.sender) revert NotAllowed();`; `lpKind == MOCK_LP_ADAPTER_KIND && (!allowMockLpAdapter || block.chainid == MAINNET_CHAIN_ID) → revert AdapterBlocked();`; `lpEntry = IPolicyVaultV4LpEntry(lpEntryAddress_)` (immutable, passed as constructor arg); **seed `allowedSweepPools` (SIZE-2 — the sweep allowlist lives on LpExit storage, §3.2b; seeded here in the LpExit constructor, emit `SweepPoolAllowed` per entry) AND seed `allowedSweepTokens` (Codex 2.1 — LpExit-local token allowlist for sweepToken, since LpExit cannot read Swap's `allowedTokens`; emit `SweepTokenAllowed` per entry)**; `vaultRegistry` retained as immutable ref (NO self-registration — Codex R7-REG FIX: USER calls `registry.registerLpExit(address(this))` after deploy, §10 step 3).

### 3.4 Modifiers

`onlyExecutor` (`msg.sender == executor`), `onlyExecutorNotRevoked` (`!executorRevoked`) — used on EXITS so pause does not block them (GAP 2/16), `executorActive` (`!paused && !executorRevoked`) — used on ENTRIES, `lpAdapterConfigured` (`address(lpAdapter) != address(0)`), `nonReentrant`, `onlyLpExit` (`msg.sender == lpExitVault`).

**Entry functions** (`buy`, `sell`, `zapInMintLp`, `zapInIncreaseLiquidity`, `stakeLp`): `onlyExecutor executorActive lpAdapterConfigured nonReentrant`. **SIZE-2 FIX: `sweepToken` moved to Exit functions (custody conversion, exit-style).**
**Exit functions** (`decreaseLiquidity`, `collectFees`, `burnLp`, `unstakeLp`, `zapOut`, `sweepToken`): `onlyExecutor onlyExecutorNotRevoked lpAdapterConfigured nonReentrant` (GAP 2/16 — pause stops entries, not exits; revokeExecutor remains the hard kill; SIZE-2: sweep has NO cooldown). `unstakeLpOwner`, `rescueNft`, `importLpNft`, `depositNative`, `withdrawNative`, `rescueToken` are `onlyOwner nonReentrant` (no executor gate, so they work after revokeExecutor).

### 3.5 Errors (full set — union of all three vaults)

> **GAP 5 FIX (conservative option — byte-identical V2 error ABI):** `PolicyVaultV4Swap` KEEPS the exact V2 error names: `TradeCapExceeded`, `MaxExposureExceeded`, `InvalidAmount`, `InvalidTradePair`, `InvalidAdapter`, `LowMinOut`, `NotExecutor` (NOT renamed to `CapExceeded`/`ExposureExceeded`/`InsufficientBalance`/etc.). The §3.7.1 label is "V2 verbatim" (error names + logic). `single-agent-server.ts` error parsing stays unchanged for swap errors. This preserves byte-identical swap ABI so off-chain parsers keyed on V2 error names do not break.

**Swap vault (V2 byte-identical error set — GAP 5):** `NotOwner, Paused, ExecutorIsRevoked, NotAllowed, Replay(bytes32), DeadlineExpired, DeadlineTooFar, TradeCapExceeded, DailyCapExceeded, MaxExposureExceeded, CooldownActive, BadDelta, BadPolicy, InvalidProof, UnexpectedValue, AdapterBlocked, TokenDisabled, PoolDisabled, InvalidAgentKey, InvalidAmount, InvalidRecipient, InvalidTradePair, InvalidAdapter, LowMinOut, NotExecutor`.

**LP Entry vault adds:** `LpPoolNotZappable, InvalidLpPool, LpInvalidMinOut, LpCapExceeded, LpDailyCapExceeded, LpExposureExceeded, LpCooldownActive, NotAgentLpNft, InvalidStakeVault, StakingDisabled, NotStakedNft, PoolMismatch, InvalidLpAmount, RewardsNotConfigured, LpBadDelta, InvalidActionType, BadParams, InsufficientLiquidity, LpTickMismatch, LpPositionNotEmpty, LpLiquidityFloor, NotVaultNft, AlreadyRegistered`.

> **GAP 6 FIX:** `LpAdapterNotConfigured` is ADDED to the LP error set (both LpEntry and LpExit). The `lpAdapterConfigured` modifier reverts with `LpAdapterNotConfigured()` (not `BadParams`). This closes the unspecified-revert gap.

**LP Exit vault adds (beyond shared LP errors):** `LpEntryMismatch` (if `msg.sender != lpExitVault` on a `onlyLpExit` gate), `NotLpEntry`.

### 3.6 Events (GAP 3 — full parity with V2/V3)

**Swap vault (V2 parity):** `Deposited, NativeWithdrawn, TokenRescued, PausedSet, ExecutorRevoked, AgentKeyEnabledSet, TokenDisabled, PoolDisabled, PairMinOutBpsTightened, PolicyTightened, TradeExecuted, TradeExecutedV2, TokenAllowed, PoolAllowed`.

> `TradeExecuted` is KEPT alongside `TradeExecutedV2` — `single-agent-server.ts` parses `TradeExecuted` as a fallback for V1 vaults and both are emitted per trade in V2/V3. `TokenAllowed`/`PoolAllowed` emitted in the constructor when seeding allowlists.

**LP Entry vault (V3 parity — GAP 3):** `LpPolicyTightened, LpPoolDisabled, StakeVaultDisabled, LpActionExecutedV3, LpNftImported, Staked, LpPoolAllowed, StakeVaultAllowed, Deposited, NativeWithdrawn, TokenRescued`. (**SIZE-2 FIX: `SweepPoolAllowed` moved to LpExit.**)

> `Staked` emitted by `stakeLp` (V3 parity). `LpPoolAllowed`/`StakeVaultAllowed` (GAP 14) emitted in the constructor when seeding allowlists. `Deposited`/`NativeWithdrawn`/`TokenRescued` emitted by `depositNative`/`withdrawNative`/`rescueToken` (GAP 6/8/33).

**LP Exit vault:** `NftRescued, Unstaked, OwnerUnstaked, LpActionExecutedV3, NativeWithdrawn, TokenRescued, SweepPoolAllowed` (**SIZE-2: `SweepPoolAllowed` moved here from LpEntry — sweep lives on LpExit; emitted in the constructor when seeding `allowedSweepPools`**).

### 3.7 Function surface

#### 3.7.1 `PolicyVaultV4Swap` — V2 swap + admin (V2 verbatim — GAP 5: error names + logic byte-identical)

| Function | Signature + modifiers | Behavior |
|---|---|---|
| `receive` | `receive() external payable` | Accepts native from `owner()` or `address(swapAdapter)`; else `revert NotAllowed()` (V2/V3 parity). |
| `depositNative` | `external payable onlyOwner` | Owner tops up; emit `Deposited`. |
| `withdrawNative` | `(uint256 amount) external onlyOwner nonReentrant` | Owner pulls native; emit `NativeWithdrawn`. |
| `rescueToken` | `(address token, uint256 amount) external onlyOwner nonReentrant` | Owner rescues ANY ERC20 — NO deny-list (V2/V3 verbatim). emit `TokenRescued`. |
| `setPaused` | `(bool value) external onlyOwner` | Pause swap entry; emit `PausedSet`. Does not block LP vaults (separate contracts; owner pauses all via UI). |
| `revokeExecutor` | `() external onlyOwner` | Irreversibly revoke swap executor; emit `ExecutorRevoked`. |
| `setAgentKeyEnabled` / `setAgentKeysEnabled` | `onlyOwner` | Per-key / batch. |
| `disableToken` / `disablePool` | `onlyOwner` | One-way deny-list (tighten only). |
| `tightenPairMinOutBps` | `onlyOwner` | Tighten per-pair min-out. |
| `tightenPolicy` | `(Policy calldata next) external onlyOwner` | Tighten base 6 fields (each ≤ existing); cannot loosen. Does NOT touch LP (LP lives in LpEntry/LpExit — **documented non-verbatim split forced by EIP-170, not atomic with LP tighten — GAP 4**). |
| `buy` | `(TradeRequest calldata) external payable onlyExecutor executorActive nonReentrant returns (uint256)` | V2 verbatim: validate agentKey/tokenIn/tokenOut/pool/deadline/nonce/replay, enforce per-trade+daily caps, **cooldown (buy enforces)**, max exposure, `amountOutMin` floor (nonzero, ≥ `minOutFor`), balance-delta around `swapAdapter.buy`; update position units + daily window; emit `TradeExecuted` + `TradeExecutedV2`. |
| `sell` | `(TradeRequest calldata) external payable onlyExecutor executorActive nonReentrant returns (uint256)` | Symmetric; **sell does NOT require `agentKeyEnabled` — INTENTIONAL DIVERGENCE from V2/V3 (V2:366 and V3:571 DO gate sell via `_validateAgentKey`; V4 drops the gate to extend GAP 3/11 swap exit-lockup symmetry with LP exits). Only `buy` calls `_validateAgentKey`.** **sell DOES enforce cooldown via `_validateCooldown` (V2:370/V3:575 byte-identical).** Reverts `CooldownActive` (V2 error name preserved — GAP 5). |

Views (V2 + V3 parity — **GAP 4: `poolAddressOf` carried verbatim**): `minOutBpsFor`, `minOutFor`, `policyHash` (V2 6-field hash — GAP 7), `actionHashFor`, `vaultActionHashFor(bool, TradeRequest)`, **`poolAddressOf(bytes32) -> address` (pure view — V3 line 1128)**. `TradeRequest` keeps V2 field order — `vaultActionHashFor` encoding byte-identical to V2/V3 (swapAdapter `0xfaa8` unchanged).

#### 3.7.2 `PolicyVaultV4LpEntry` — V3 LP entry surface + NFT accounting

| Function | Signature + modifiers | Behavior |
|---|---|---|
| `receive` | `receive() external payable` | Accepts native from `owner()` AND `address(lpAdapter)` ONLY; else `revert NotAllowed()`. **NOT byte-identical to V3:403-408** — V3 references `address(adapter)` (swap adapter) which is NOT an LP-vault immutable in V4; the swap adapter never sends native to the LP vaults. Documented intentional divergence. Load-bearing: `zapInMintLp`/`zapInIncreaseLiquidity` refund-native-in from `lpAdapter` (`W0G.unwrap` refund) ends with `safeTransferNative(this, refund)` where `this == LpEntry vault`. |
| `depositNative` | `external payable onlyOwner` | V3:423 verbatim. Owner tops up for `zapInMintLp`/`zapInIncreaseLiquidity`. emit `Deposited`. |
| `withdrawNative` | `(uint256 amount) external onlyOwner nonReentrant` | V3:430 verbatim. Owner pulls native. emit `NativeWithdrawn`. |
| `rescueToken` | `(address token, uint256 amount) external onlyOwner nonReentrant` | V3:438 verbatim. Owner rescues ANY ERC20. emit `TokenRescued`. |
| `zapInMintLp` | `(LpActionRequest) external payable onlyExecutor executorActive lpAdapterConfigured nonReentrant returns (uint256,uint128,uint256,uint256)` | V3 verbatim. `liquidity > 0 && >= policy.minLiquidityFloor` else `revert LpLiquidityFloor()`. Refund-aware `lpNftDeployedNative = amountIn0G − w0gRefund`. **Cooldown enforced (GAP 1).** |
| `stakeLp` | `onlyExecutor executorActive lpAdapterConfigured nonReentrant` | V3 verbatim; `allowStaking` + `allowedStakeVaults` + `stakeVaultForLpPool` gates; marks `agentStakedNfts` + `_isStaked`; emit `Staked`. **Cooldown enforced (GAP 1).** |
| `importLpNft` | `(uint256 tokenId, bytes32 agentKey, bytes32 poolId, int24 tickLower, int24 tickUpper, uint256 deployedNative0G) external onlyOwner nonReentrant lpAdapterConfigured` | See §3.7.4. |
| `onERC721Received` | `(address, address, uint256, bytes) external pure returns (bytes4)` returning `0x150b7a02` | V3:413-415 verbatim. Required for migration `safeTransferFrom(sourceOwnerWallet, lpEntryVault, tokenId)` (NFT custody lives on LpEntry — Codex R7-LOF: `sourceOwnerWallet` is the USER wallet for user-owned V3 or the DEPLOYER rescue wallet for deployer-owned V3). |
| `rescueNft` | `(uint256 tokenId, address to) external onlyOwner nonReentrant` | **G-03 FIX:** NFT custody lives on LpEntry (per `onERC721Received` + `importLpNft`), so `rescueNft` lives on LpEntry. `to` hard-pinned to `owner()` (no arbitrary recipient — AGENTS.md compliance). Pulls a stranded NFT out of the LpEntry vault back to the owner wallet (GAP 24 loss-of-funds recovery). emit `NftRescued`. **B.3 ABI-scan carve-out (G-03b-toArg):** `rescueNft(uint256,address)` on LpEntry is exempted from the no-recipient-arg rule — `to` is ignored in the body and hard-pinned to `owner()`; the arg exists only for V3 signature parity. |

**LP Entry admin (onlyOwner):** `disableLpPool(bytes32)`, `disableStakeVault(address)`, `tightenLpPolicy(LpPolicy calldata next)` (tighten each of the 7 LP fields; cannot loosen — GAP 25), `setLpExitVault(address)` (one-time, onlyOwner, sets the one-time-settable storage `lpExitVault` (G-EXEC-1: plain storage, NOT immutable — reverts if already set, guarded by `_lpExitVaultSet`); **Codex 1.3 FIX: verifies `candidate == vaultRegistry.lpExitVaultOf(owner())` AND `IPolicyVaultV4LpExit(candidate).lpEntry() == address(this)` — the candidate is the registry's LpExit for this owner AND points back to this LpEntry, preventing wiring LpExit to a foreign LpEntry**), `setPaused`, `revokeExecutor`, `setAgentKeyEnabled`/`setAgentKeysEnabled`. **SIZE-2 FIX: `addSweepPool(bytes32)`/`disableSweepPool(bytes32)`/`allowedSweepPools` (GAP 14 — separate sweep-route allowlist) MOVED to LpExit (sweep lives on LpExit now).**

Views: `vaultActionHashForLp(LpActionRequest) -> bytes32` (GAP 1/7: encoding does NOT include `address(adapter)`), **REG-1: `actionHashFor(bytes32 vaultActionHash, bytes32 auditRoot, bytes32 policySnapshotHash) view returns (bytes32)`** (byte-identical to V3:1056-1062), **REG-3: `function policyHash() public view returns (bytes32)`** returning the 7-field `_policyHash(currentPolicy)` (V3:1052-1054), `_policyHash` (7-field LpPolicy hash — GAP 7), `minLpOutFor`, **REG-4: `poolAddressOf(bytes32) pure view returns (address)`** (pure, no storage, ~0.1KB — V3:1128), `agentLpNfts(bytes32,bytes32) -> uint256[]` (GAP 8 FIX: `(bytes32,bytes32)`, NOT `address`), `lpNftDeployedNative(uint256)`, `agentStakedNfts(bytes32, address) -> uint256[]` (V3 shape), `isLpNftStaked(bytes32, uint256) -> bool`, `openLpExposure0G`, `lpDailySpent0G`, `lpDailyWindowStart`, `lastLpActionAt`, `agentLpNotionalDeployed(bytes32)`, `lpNftOwner(uint256)`, `lpNftPool(uint256)`, `lpNftTickLower(uint256)`, `lpNftTickUpper(uint256)`. **GAP 7 note (REG-3):** the public selector name `policyHash` is preserved on both Swap (6-field) and LpEntry (7-field) so off-chain `functionName: "policyHash"` reads work unchanged across both vault thirds; the field-count difference is internal to the hash body, not the selector.

**`LpActionRequest` struct (G-R3-9 — byte-identical field order to V3 `PolicyVaultV3.sol:LpActionRequest`, load-bearing for `vaultActionHashForLp` — GAP 7):**
```solidity
struct LpActionRequest {
    uint8 actionType;
    uint256 tokenId;
    bytes32 poolId;
    address stakeVault;
    uint256 amount0Desired;
    uint256 amount1Desired;
    uint256 amount0Min;
    uint256 amount1Min;
    uint128 liquidity;
    uint256 deadline;
}
```
Field order matches V3 EXACTLY — the V4 `vaultActionHashForLp` encoding (which drops `address(adapter)` per GAP 1/7) relies on this order; any reordering breaks the off-chain/on-chain hash equality (REG-7). Shared in `lib/types/vault-policy-shapes.ts` (GAP 36).

#### 3.7.3 `PolicyVaultV4LpExit` — V3 LP exit surface + 4 new exit wrappers

| Function | Signature + modifiers | Behavior |
|---|---|---|
| `receive` | `receive() external payable` | Accepts native from `owner()` AND `address(lpAdapter)` ONLY; else `revert NotAllowed()`. Load-bearing: `zapOut`-native-out ends with `safeTransferNative(vault, amountOut)`. Load-bearing: `sweepToken`-native-out (SIZE-2 — sweep lives on LpExit) also ends with `safeTransferNative(vault, amountOut)` where `vault == msg.sender == LpExit vault`. |
| `withdrawNative` | `(uint256 amount) external onlyOwner nonReentrant` | V3:430 verbatim. Owner pulls native freed by `zapOut`. emit `NativeWithdrawn`. |
| `rescueToken` | `(address token, uint256 amount) external onlyOwner nonReentrant` | V3:438 verbatim. Owner rescues ERC20 from `collectFees`/`decreaseLiquidity`. emit `TokenRescued`. |
| `unstakeLp` | `onlyExecutor onlyExecutorNotRevoked lpAdapterConfigured nonReentrant` | EXIT; exit-lockup survives `disableStakeVault`. No cooldown. emit `Unstaked`. Calls back to `lpEntry` to update `_isStaked`/`agentStakedNfts`. |
| `unstakeLpOwner` | `(uint256 tokenId, address stakeVault) external onlyOwner nonReentrant` | V3 verbatim (PolicyVaultV3.sol:625). Owner-only rescue; NO `_validateLpRequest`, NO proof-registry call. emit `OwnerUnstaked`. |
| `zapOut` | `onlyExecutor onlyExecutorNotRevoked lpAdapterConfigured nonReentrant returns (uint256)` | EXIT by `lpEntry.lpNftOwner(tokenId)==agentKey` + `lpEntry.lpNftPool(tokenId)==poolId`; **G-02 BLOCKER FIX: `require request.amountOutMin > 0 && request.amountOutMin >= minLpOutFor(quotedNativeOut)` (nonzero bps floor)**; approve adapter for NFT; call `lpAdapter.zapOut`; delta-check native received; **G-02: `require nativeReceived >= request.amountOutMin else LpBadDelta()`**; **require lpAdapter.liquidityOf(tokenId)==0 else revert LpPositionNotEmpty() (purge gate — LpExit asserts before invoking purgeLpNft, mirroring burnLp — N-2/G-02-zapOut-purge-gate)**; delete NFT slots (on lpEntry via `onlyLpExit` callback `purgeLpNft`, which also reduces `openLpExposure0G`/`agentLpNotionalDeployed` by the deleted `lpNftDeployedNative[tokenId]` per B5). No cooldown. **Pre-snapshot `totalLiq = lpAdapter.liquidityOf(tokenId)` BEFORE the adapter call** (GAP 18). |
| `sweepToken` | `(LpActionRequest) external payable onlyExecutor onlyExecutorNotRevoked lpAdapterConfigured nonReentrant` | SIZE-2: moved from LpEntry. Custody conversion, exit-style, NO cooldown (§3.4). GAP 14 + Codex 2.1: requires `allowedSweepTokens[tokenIn]` (LpExit-local token allowlist, admin via `addSweepToken`/`disableSweepToken` on LpExit) + `allowedSweepPools[poolId]` (admin via `addSweepPool`/`disableSweepPool` on LpExit). native out → LpExit vault via `receive()`. |
| `onERC721Received` | returns `0x150b7a02` | Required if the NFT is ever sent to LpExit (e.g. rescue routing). |
| `claimRewards` | `(LpActionRequest) external payable` | **REG-2 BLOCKER FIX:** byte-identical to V3:1029-1034 — unconditional `revert RewardsNotConfigured()` stub. No modifier (V3 had no modifier on `claimRewards`); kept out of the executor-gated modifier set so the selector is present for off-chain probing but always reverts. |
| `rescueNft` | `(uint256 tokenId) external onlyOwner nonReentrant` | **G-03 FIX B.1:** LpExit can hold an NFT (per `onERC721Received`), so a LpExit `rescueNft` is provided with a DISTINCT signature (no `to` arg — recipient hard-pinned to `owner()`, no arbitrary recipient) for the case an NFT ever lands on LpExit. emit `NftRescued`. The primary NFT custody rescue lives on LpEntry (§3.7.2 `rescueNft(uint256, address to)` with `to` pinned to owner) — NFTs normally live on LpEntry. |

**LP Exit admin (onlyOwner):** `setPaused` (GAP 2: pause on LpExit does NOT block exits — exits use `onlyExecutorNotRevoked`; only `revokeExecutor` blocks exits), `revokeExecutor` (hard kill — blocks all exits), `setAgentKeyEnabled`/`setAgentKeysEnabled` (note: per GAP 3/11, exits skip the agentKey check, so enabling/disabling on LpExit is for revoke/pause gating only; the agentKey gate for ENTRIES lives on LpEntry). **SIZE-2 FIX: `addSweepPool(bytes32)`/`disableSweepPool(bytes32)`/`allowedSweepPools` admin + `SweepPoolAllowed` event (GAP 14) MOVED here from LpEntry (sweep is a custody conversion → exit-style on LpExit, no cooldown).** **Codex 2.1 FIX: `addSweepToken(address)`/`disableSweepToken(address)`/`allowedSweepTokens` admin + `SweepTokenAllowed` event ALSO live here on LpExit (LpExit-local token allowlist — LpExit cannot read Swap's `allowedTokens`).**

**Views:** **REG-4: `poolAddressOf(bytes32) pure view returns (address)`** (pure, no storage, ~0.1KB — V3:1128) so LP callers can read it locally on LpExit as well as LpEntry. `allowedSweepPools(bytes32) -> bool` (moved from LpEntry). LP exit action-hash preflight reads `actionHashFor` on LpEntry (pure view, identical result on either third; LpExit does not re-declare it to save size — VR3-4).

#### 3.7.3b `PolicyVaultV4LpEntry` — `onlyLpExit`-gated accounting callbacks (GAP 22)

LpEntry exposes typed setters/getters for LpExit to read/write the shared NFT accounting. All gated `onlyLpExit` (`lpExitVault` is plain storage (G-EXEC-1) set via a one-time `setLpExitVault` onlyOwner call after LpExit deploys, guarded by `_lpExitVaultSet` (reverts if already set), not executor-controlled — NOT arbitrary target):

```solidity
function lpNftOwnerOf(uint256 tokenId) external view onlyLpExit returns (bytes32);
function lpNftPoolOf(uint256 tokenId) external view onlyLpExit returns (bytes32);
function lpNftTicksOf(uint256 tokenId) external view onlyLpExit returns (int24, int24);
function lpNftDeployedNativeOf(uint256 tokenId) external view onlyLpExit returns (uint256);
function isStaked(bytes32 agentKey, uint256 tokenId) external view onlyLpExit returns (bool);
function markUnstaked(bytes32 agentKey, uint256 tokenId, address stakeVault) external onlyLpExit;
// G-01 BLOCKER FIX: finalizeExit split into TWO onlyLpExit callbacks:
function reduceLpDeployment(uint256 tokenId, uint256 nativeFreed) external onlyLpExit;
// reduceLpDeployment (decreaseLiquidity path): reduces openLpExposure0G / agentLpNotionalDeployed
// / lpNftDeployedNative pro-rata by nativeFreed; KEEPS the slot entries AND the agentLpNfts entry
// (a partial decrease does NOT remove the tokenId from the roster).
function purgeLpNft(uint256 tokenId) external onlyLpExit;
// purgeLpNft (zapOut/burnLp path): deletes lpNftOwner/Pool/Ticks/DeployedNative slots, removes
// the tokenId from agentLpNfts, AND reduces openLpExposure0G by the deleted lpNftDeployedNative[tokenId]
// and agentLpNotionalDeployed[agentKey] by the same — revert on underflow (N-2: purgeLpNft accounting
// was underspecified). Codex 1.3 FIX: the `lpAdapter.liquidityOf(tokenId)==0` purge gate is
// enforced INSIDE purgeLpNft (`require lpAdapter.liquidityOf(tokenId)==0 else revert
// LpPositionNotEmpty()`) AND on the LpExit caller side (§3.7.3 zapOut + A.3.4 burnLp assert it
// before invoking — defense-in-depth). Fail-closed: any other revert from the liquidityOf read
// propagates (no silent purge on a non-empty position → no loss-of-funds via premature slot delete).
```

> These are typed interface calls to a fixed immutable address (set at construction), NOT executor-controlled arbitrary calls. AGENTS.md-compliant: no `execute(address,bytes)`, no `delegatecall`, no recipient field.

#### 3.7.4 V4 NEW — `importLpNft` (owner-only, migration ingest — lives on LpEntry)

```solidity
function importLpNft(uint256 tokenId, bytes32 agentKey, bytes32 poolId,
                     int24 tickLower, int24 tickUpper, uint256 deployedNative0G)
    external onlyOwner nonReentrant lpAdapterConfigured {
    if (IERC721(lpAdapter.nfpm()).ownerOf(tokenId) != address(this)) revert NotVaultNft();
    if (lpNftOwner[tokenId] != bytes32(0)) revert AlreadyRegistered();
    if (!agentKeyEnabled[agentKey]) revert NotAllowed();
    if (!allowedLpPools[poolId]) revert InvalidLpPool();
    (int24 tl, int24 tu) = lpAdapter.positionTicks(tokenId);
    // GAP 15: positionTicks is trusted because lpAdapter is immutable and bytecode-verified at
    // deploy (MAINNET_DEPLOY_ZIA_LP_ADAPTER_V4=true with NFPM/SWAP_ROUTER/W0G verification).
    // A lying adapter is a liveness risk (blocks future zapInIncreaseLiquidity via LpTickMismatch)
    // recoverable via rescueNft, NOT a loss-of-funds risk. Optionally cross-check the imported
    // ticks against the orchestrator-supplied tickLower/tickUpper and revert on mismatch to catch
    // adapter divergence early:
    if (tl != tickLower || tu != tickUpper) revert LpTickMismatch();
    lpNftTickLower[tokenId] = tl; lpNftTickUpper[tokenId] = tu;
    _validateLpSpendPolicy(deployedNative0G, policy);
    lpNftOwner[tokenId] = agentKey; lpNftPool[tokenId] = poolId;
    lpNftDeployedNative[tokenId] = deployedNative0G;
    _pushAgentLpNft(agentKey, poolId, tokenId);
    _recordLpBuySpend(deployedNative0G);   // GAP 13/18: consume per-user lpDailyCap0G window ONCE at import
    emit LpNftImported(tokenId, agentKey, poolId, deployedNative0G);
}
```

> **GAP 13/18 FIX (daily cap consumption):** `_recordLpBuySpend(deployedNative0G)` consumes the per-user `lpDailyCap0G` rolling-24h window ONCE at import time. The orchestrator's pre-flight MUST check `lpDailyCap0G` headroom across ALL NFTs selected for preservation (sum of `deployedNative0G <= lpDailyCap0G`, accounting for the rolling window) and seed `lpDailyCap0G` at deploy with enough headroom. **GAP 18 FIX (fail-fast):** if total preservation notional exceeds the seeded caps, the orchestrator ABORTS with an explicit "caps insufficient to honor preservation preference" error requiring operator acknowledgment (re-seed caps by redeploying, or explicit per-NFT opt-in to exit) — NOT a silent preserve→exit downgrade.

#### 3.7.5 V4 NEW — 5 deferred LP entrypoints (thin wrappers; heavy logic in adapter)

**`zapInIncreaseLiquidity`** (LpEntry; `onlyExecutor executorActive lpAdapterConfigured nonReentrant`): `ZAP_IN_INCREASE_LIQUIDITY` (3): tick match else `LpTickMismatch`; `amount0Desired>0 && amount1Desired==0`; `liquidity>0 && >= minLiquidityFloor` else `LpLiquidityFloor`; mins >0 and ≥ `minLpOutFor(quoted)`; `_validateLpSpendPolicy` + `_validateLpCooldown` (**GAP 1: cooldown enforced**); snapshot; wrap W0G, forceApprove; `lpAdapter.zapInIncreaseLiquidity`; revoke; delta: native consumed == amount0Desired, `if (w0gRefund >= amount0Desired) revert LpBadDelta()` (GAP 19), `w0gRefund <= amount0Desired`, `liquidity>=request.liquidity`, `amount0>=amount0Min`, `amount1>=amount1Min`; refund-aware `lpNftDeployedNative += amount0Desired - w0gRefund`; spend/notional/daily +=.

**`sweepToken`** (**SIZE-2 FIX: moved to LpExit**; `onlyExecutor onlyExecutorNotRevoked lpAdapterConfigured nonReentrant` — exit-style, NO cooldown — sweep is a custody conversion, not capital-deploying; this also resolves the GAP 1 cooldown-on-sweep question by dropping it): `SWEEP_TOKEN` (9): `tokenId==0 && stakeVault==0`; `tokenIn!=0 && allowedSweepTokens[tokenIn]` (Codex 2.1 — LpExit-local token allowlist); `tokenOut==NATIVE || allowedSweepTokens[tokenOut]`; `amount0Desired>0 && amount1Min>0 && amount1Min>=minLpOutFor(quotedAmountOut)`; **GAP 14 FIX: `allowedSweepPools[poolId]` required (separate sweep-route allowlist, NOT `allowedLpPools`)**; forceApprove tokenIn; `lpAdapter.sweepToken`; revoke; delta: tokenIn delta == amount0Desired, native/tokenOut delta ≥ amount1Min and ≥ amountOut else `LpBadDelta`. NO spend/exposure/daily writes. **LpExit vault is the sweep host: `addSweepPool`/`disableSweepPool`/`allowedSweepPools` + `addSweepToken`/`disableSweepToken`/`allowedSweepTokens` (Codex 2.1) admin + `SweepPoolAllowed`/`SweepTokenAllowed` events live on LpExit (moved from LpEntry by SIZE-2).**

**`decreaseLiquidity`** (LpExit; `onlyExecutor onlyExecutorNotRevoked lpAdapterConfigured nonReentrant`): `DECREASE_LIQUIDITY` (4): ownership+pool (via `lpEntry.lpNftOwnerOf`/`lpNftPoolOf`); `liquidity>0 && <=lpAdapter.liquidityOf(tokenId)`; mins >0; **GAP 10: `require amount0Min >= minLpOutFor(quotedAmount0) && amount1Min >= minLpOutFor(quotedAmount1)` (bps slippage floor)**; **GAP 18: `totalLiq = lpAdapter.liquidityOf(tokenId)` snapshot BEFORE adapter call**; approve adapter for NFT; `lpAdapter.decreaseLiquidity`; revoke; **GAP 12: delta check uses `>=` floor: `require balanceDelta0 >= amount0Min && balanceDelta1 >= amount1Min` else `LpBadDelta`** (adapter calls `NFPM.collect` after `decreaseLiquidity`, transferring principal + accrued fees, so balance delta EXCEEDS the decreaseLiquidity return). pro-rata `nativeFreed = lpEntry.lpNftDeployedNativeOf(tokenId) * liquidity / totalLiq`; call `lpEntry.reduceLpDeployment(tokenId, nativeFreed)` to reduce `openLpExposure0G`/`agentLpNotionalDeployed`/`lpNftDeployedNative` pro-rata (G-01: KEEPS slots + `agentLpNfts` entry — a partial decrease does NOT remove the tokenId from the roster). NO cooldown.

**`collectFees`** (LpExit; `onlyExecutor onlyExecutorNotRevoked lpAdapterConfigured nonReentrant`): `COLLECT_FEES` (5): **GAP 9 FIX: enforce `amount0Min > 0 && amount1Min > 0` (>= 1 wei)** AND `stakeVault==0 && liquidity==0` else `InvalidActionType`; delta-check `balanceDelta0 >= amount0Min && balanceDelta1 >= amount1Min` else `LpBadDelta`. `collectFees` MUST NOT swap, wrap, or unwrap — calls only `NFPM.collect` with recipient hard-pinned to vault. **GAP 13 FIX (liveness constraint): documented in contract + README + adapter doc — `decreaseLiquidity` (which calls `NFPM.collect` MAX,MAX in the adapter, returning principal + all fees) is the PRIMARY fee-collection path; `collectFees` is ONLY for the post-decrease residual on a zero-liquidity position. The >=1 wei floor means `collectFees` reverts `LpBadDelta` when either fee side has 0 accrued and is unusable on active/asymmetric positions. Keep the floor (AGENTS.md compliance) but note the liveness constraint so operators do not expect `collectFees` to work on active positions.** No spend/exposure/notional/daily writes.

**`burnLp`** (LpExit; `onlyExecutor onlyExecutorNotRevoked lpAdapterConfigured nonReentrant`): `BURN_LP` (6): require `lpAdapter.liquidityOf(tokenId)==0 && lpEntry.lpNftDeployedNativeOf(tokenId)==0` else `LpPositionNotEmpty`; `_burnSideOk` per side else `LpInvalidMinOut`; approve adapter for NFT; `lpAdapter.collectFees(max,max)` then `lpAdapter.burnLp(tokenId)`; delta: token deltas ≥ returned, NFPM balance drops by exactly 1 else `LpBadDelta`; call `lpEntry.purgeLpNft(tokenId)` (G-01: gated on `liquidityOf(tokenId)==0` already required above) to remove from `agentLpNfts` and delete slots. NO cooldown.

**`_burnSideOk`** restored from `.bak`: `if (quoted==0) return minOut==0; return minOut>0 && minOut>=minLpOutFor(quoted);`.

### 3.8 AGENTS.md compliance mapping for the 5 new LP functions

- **No arbitrary call/delegatecall/multicall/recipient:** typed external CALL via `IPolicyVaultLpAdapter` on the immutable `lpAdapter`. LpExit→LpEntry accounting callbacks are typed calls to a fixed immutable address, gated `onlyLpExit` — NOT executor-controlled. No `delegatecall`, no `.call()`, no `assembly`. Adapter recipients hard-pinned to `msg.sender` (vault). Sweep has no recipient field.
- **Allowlisted adapter/pools/tokens:** immutable `lpAdapter`; `lpNftPool[tokenId]==poolId` (exit by record); `sweepToken` requires `allowedSweepTokens` (LpExit-local, Codex 2.1) + **`allowedSweepPools[poolId]` (GAP 14 — separate sweep-route allowlist, NOT `allowedLpPools`)**.
- **Nonzero amountOutMin — NO exception (GAP 9):** all deploying/decrease/sweep/burn/**zapOut** (G-02 FIX: zapOut explicitly added to the nonzero-floor list — was omitted) paths require `>0` + `>= minLpOutFor(quoted)`. `collectFees` enforces `amount0Min > 0 && amount1Min > 0` (>= 1 wei). No AGENTS.md rule deviation. **GAP 13: liveness constraint documented** — `collectFees` is post-decrease residual only. **G-06 LOW (single documented AGENTS.md exception):** `burnLp` `_burnSideOk` — when a side has `quoted==0` (no expected output), `minOut==0` is permitted on that side (the single documented AGENTS.md exception, justified by zero-expected-output → no slippage surface). All other sides/sides-with-quoted->0 still enforce `>0 && >= minLpOutFor(quoted)`. Tested by B.4 case `burnLp with quoted==0 && minOut==0 → passes`.
- **Per-trade/daily/max-exposure caps:** only `zapInIncreaseLiquidity` (and `importLpNft` at import time) deploys native → enforces all three. Exits release capital. Sweep converts stray custody (no native deploy).
- **Cooldown (GAP 1 FIX):** **Cooldown enforced on `zapInMintLp`, `stakeLp`, `zapInIncreaseLiquidity` (deploying/entry actions); `decreaseLiquidity`/`collectFees`/`burnLp`/`unstakeLp`/`zapOut`/`sweepToken` exempt (capital-returning — SIZE-2: sweep moved to LpExit as exit-style, no cooldown).** `sell` enforces cooldown (V2/V3 parity). This closes the GAP 1 internal inconsistency — §3.7.2 labels `zapInMintLp`/`stakeLp` "V3 verbatim" AND §3.8 now explicitly lists both as cooldown-enforcing.
- **Nonces/replay:** all 5 call `_markLpAction(actionHash)`; reused hashes rejected.
- **Deadline:** validated in `_validateLpRequest`; `deadlineTooFar` enforced.
- **Balance-delta checks:** each function snapshots pre/post balances; `decreaseLiquidity` uses `>=` floor (GAP 12) and enforces the bps slippage floor (GAP 10); vault never trusts adapter-returned amounts.
- **Policy snapshot binding:** `request.policySnapshotHash == _policyHash(currentPolicy)` (per-vault — GAP 7: Swap uses 6-field, LpEntry uses 7-field) and `request.vaultActionHash == vaultActionHashForLp(request)`.
- **Admin cannot move funds / cannot loosen:** all 5 are `onlyExecutor`. `tightenLpPolicy` tightens only (cannot loosen — GAP 25). `disableLpPool`/`disableStakeVault` one-way, do not block exits. `rescueNft`/`rescueToken`/`unstakeLpOwner`/`importLpNft`/`depositNative`/`withdrawNative` are `onlyOwner` (the user, on their own vault).
- **Mock rejected in prod at the contract level (GAP 14):** constructor reverts `AdapterBlocked()` if `kind==MOCK && (!allowMock || block.chainid==16661)` for both swap and LP adapters.
- **Owner recovery paths on ALL vault thirds (GAP 6/8/33):** LpEntry carries `depositNative`/`withdrawNative`/`rescueToken`; LpExit carries `withdrawNative`/`rescueToken`; both native from `zapOut`/`sweep`-native-out and ERC20 from `collectFees`/`decreaseLiquidity` are owner-recoverable regardless of executor state.

### 3.9 Bytecode size budget reasoning (revised — GAPs 20-24)

1. **Empirical measurement (GAP 22/24):** V3 deployed = 23931B. A buy/sell-gutted V3 probe = 20219B, so the real LP base is ~19.7KB (NOT the prior draft's ~17KB — the swap-attributable portion is only ~3.7KB, not ~6-7KB). Adding the 5 new wrappers (7.5-10KB) + `importLpNft` (~0.5KB) projects a single LP vault to ~27.7-30.2KB — OVER the 24576B cap by 3.1-5.6KB. Delegating orchestration to `ZiaLpAdapterV4` does NOT save the budget because ALL enforcement (validation + delta + accounting) stays in the vault, and that enforcement IS the bulk.
2. **Therefore the 3-way split (Swap + LpEntry + LpExit) is the PRIMARY design (GAP 22 FIX)** — not a "secondary fallback." **SIZE-1 HIGH FIX:** per-third budget is Swap ~10KB (V2=9582B anchor + `poolAddressOf` + `registry.registerSwap`), LpExit ~14KB, LpEntry ~19-21KB conservative (bottom-up ~16-18KB) — **4 wrappers** (sweepToken moved to LpExit by SIZE-2) + 7 `onlyLpExit` callbacks + 16 views + 10 admin + NFT accounting + LP errors/events + boilerplate. **LpEntry is the binding constraint; keep ≥1.5KB headroom below 23000B.** The size probe (§3.9.5) is a CONFIRMATION step, not a branch point.
3. **The V3 `new`-factory is NOT a viable alternative (GAP 24):** the actual measured `PolicyVaultFactoryV3` deployed bytecode is 28766B (28.77KB), over the 24576B cap by ~4.2KB. (The prior draft's "~38KB" figure is replaced with the empirically measured 28766B.) Conclusion unchanged: no `new`-factory; use `VaultRegistryV4`.
4. **Hard gate (GAP 21 — FIRST V4 task):** a Hardhat-3-native node script `scripts/check-contract-size.ts` globs `artifacts/contracts/**/*.json`, reads each `deployedBytecode`, computes `(hex.length-2)/2`, and asserts `< 24576` for `PolicyVaultV4Swap`/`PolicyVaultV4LpEntry`/`PolicyVaultV4LpExit`/`VaultRegistryV4`/`ZiaLpAdapterV4` (prints a table). Wired as `"contracts:size": "node scripts/check-contract-size.ts"`; chained `contracts:compile && npm run contracts:size` in CI. The A.0 test calls the same script directly (or uses `artifacts.readArtifact(...).deployedBytecode`). ~20 lines. **`hardhat-contract-sizer` is NOT used** (it does not exist for Hardhat 3 — GAP 21).
5. **SIZE-4 LOW (adapter not a size risk):** `ZiaLpAdapterV4` ≈ V3 `ZiaLpAdapter` (measured 7909B, already implements all 10 LP methods per `contracts/ZiaLpAdapter.sol`) + V4 delta ~0.3KB = ~8.2KB — well under 24576B; not a size risk.

### 3.9.5 Size probe (GAP 23 — run FIRST, as confirmation not branch point)

Before writing real wrapper bodies, compile a minimal `PolicyVaultV4LpEntry` + `PolicyVaultV4LpExit` skeleton with:
- The real storage layouts from §3.2/§3.2b.
- The wrapper signatures + enforcement scaffolding (`_validateLpRequest`/`_markLpAction`/`_validateLpSpendPolicy`/`_validateLpCooldown`/`_removeAgentLpNft`/`_pushAgentLpNft`). (**B5: exposure reduction on purge happens INSIDE `purgeLpNft` itself — no separate `_reduceLpExposure` scaffolding helper; `reduceLpDeployment` does the partial-decrease exposure reduction inline.**)
- `importLpNft` + `rescueNft` + `onERC721Received` + `depositNative`/`withdrawNative`/`rescueToken`.
- The `onlyLpExit` accounting callbacks on LpEntry.
- **GAP 23 FIX: gate with wrapper bodies PRESENT (compile a skeleton whose 5 wrappers carry their real validation/delta/accounting against `MockZiaLpAdapterV4`), NOT empty bodies.** The empty-body threshold (23KB) is a FLOOR, not the decision: even an empty-body LP base of 20.2KB leaves only 4.3KB for 5 wrappers that actually need 7.5-10KB. The decision is made upfront via `LP-base + estimated-wrappers < 24576` (20.2 + 7.5..10 = 27.7..30.2 → split NOW).

Run `node scripts/check-contract-size.ts`. Decision rule:
- **SIZE-1 FIX: pass threshold is `< 23000B` per LP third (NOT `< 24576B`)** so a 24.0KB LpEntry probe FAILS and forces preemptive shedding (keeps ≥1.5KB headroom under the 24576B cap for LpEntry — the binding constraint).
- **If the probe with wrapper bodies present confirms each LP third < 23000B**, proceed (the 3-way split is already PRIMARY). **SIZE-3 (revised):** the vault `deployedBytecode` depends only on vault source + the fixed `IPolicyVaultLpAdapter` interface (§5.1); the mock-vs-real adapter changes the LINKED ADDRESS, not vault bytecode. So the `<23000B` probe against the mock-linked vault is representative of the real-linked vault. No mock-vs-real body delta multiplication is needed. (Original SIZE-3 premise that mock under-estimates real-adapter CALL overhead was flawed — withdrawn.)
- **If any LP third with wrapper bodies present exceeds 23000B**, shed further: `sweepToken` has ALREADY been moved to LpExit (SIZE-2 — do not re-move); remaining shed options: (a) split `importLpNft` accounting from the entry wrappers; (b) move `rescueNft(uint256,address)` body off LpEntry; (c) **Codex 3.1 FIX (state-ownership-preserving):** extract one or two LpEntry view *bodies* (e.g. `agentStakedNfts`/`isLpNftStaked`) into a small external/internal library (`LpEntryViewLib` — `internal` library fns are inlined at compile, no runtime CALL overhead, no `delegatecall`) keeping the canonical NFT-accounting state (`lpNftOwner`/`agentStakedNfts`/`agentLpNotionalDeployed`/etc.) ON LpEntry; OR inline-compress duplicate view logic. Do NOT move the underlying state to LpExit — that breaks the LpEntry-owns-NFT-accounting invariant (§3.7.3b / GAP 22) and would require read-through `onlyLpExit` callbacks that reverse the state-ownership model. The `VaultRegistryV4` already supports the 3-mapping shape; no further registry change needed.

Also compile a swap-stripped V3 variant to confirm the real swap-attributable portion (~3.7KB) for the §3.9.1 arithmetic record.

### 3.10 The tighten-split (intentional non-verbatim change forced by EIP-170 — GAP 4)

V3 tightened swap+LP atomically in one tx (PolicyVaultV3.sol:665-691). V4 splits into **three non-atomic owner txs**: `tightenPolicy` (base 6) on Swap, `tightenLpPolicy` (LP 7) on LpEntry, and (if LpExit carries any tightenable field) on LpExit. Mid-sequence the vault trio can be partially tightened (swap caps tightened, LP caps not yet), a window a compromised executor could exploit.

**GAP 4 mitigation (documented, not fully fixable — inherent to EIP-170):**
- The UI issues all tighten txs back-to-back and documents the multi-tx tighten in README + `useWalletPolicyVault`.
- **All tighten ops are tighten-ONLY (each field ≤ existing).** A partially-tightened state is still safe: a compromised executor cannot exceed either the old or new cap mid-sequence because both are tighten-only (the tighter of the two always binds).
- **Test A.4.6 (GAP 4):** assert the partially-tightened state is still safe — LP caps remain at their pre-tighten tighter-or-equal values; a compromised executor cannot exceed either cap mid-sequence.
- Operator awareness documented: V4 tighten is NOT atomic.

---

## 4. Contract: `D:\4lpha-0G\contracts\VaultRegistryV4.sol` (replaces the `new`-factory — GAP 10 grief-vector fix)

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IOwnable { function owner() external view returns (address); }

contract VaultRegistryV4 {
    uint256 public constant VERSION = 4;
    mapping(address owner => address swapVault) public swapVaultOf;
    mapping(address owner => address lpEntryVault) public lpEntryVaultOf;
    mapping(address owner => address lpExitVault) public lpExitVaultOf;

    error AlreadyRegistered(address owner, address existing);
    error NotVaultOwner(address caller, address claimedOwner);

    event SwapVaultRegistered(address indexed owner, address indexed vault, uint256 version);
    event LpEntryVaultRegistered(address indexed owner, address indexed vault, uint256 version);
    event LpExitVaultRegistered(address indexed owner, address indexed vault, uint256 version);

    // Codex R7-REG BLOCKER FIX: owner-called registration (NOT self-registration). The prior
    // self-registration model (register*(owner) called from the vault constructor, keyed by
    // IOwnable(msg.sender).owner()) was SPOOFABLE — a fake contract whose owner() returns the
    // victim could register itself under the victim and survive vaultOf re-verification, causing
    // DoS + wrong-target funding. Owner-called registration is unspoofable: only msg.sender ==
    // IOwnable(vault).owner() (the real owner, signing the register tx) can register a vault under
    // themselves. The vault constructor no longer self-registers; the USER calls register*(vault)
    // after deploy.
    function registerSwap(address vault) external {
        if (IOwnable(vault).owner() != msg.sender) revert NotVaultOwner(msg.sender, vault);
        if (swapVaultOf[msg.sender] != address(0)) revert AlreadyRegistered(msg.sender, swapVaultOf[msg.sender]);
        swapVaultOf[msg.sender] = vault;
        emit SwapVaultRegistered(msg.sender, vault, VERSION);
    }
    function registerLpEntry(address vault) external {
        if (IOwnable(vault).owner() != msg.sender) revert NotVaultOwner(msg.sender, vault);
        if (lpEntryVaultOf[msg.sender] != address(0)) revert AlreadyRegistered(msg.sender, lpEntryVaultOf[msg.sender]);
        lpEntryVaultOf[msg.sender] = vault;
        emit LpEntryVaultRegistered(msg.sender, vault, VERSION);
    }
    function registerLpExit(address vault) external {
        if (IOwnable(vault).owner() != msg.sender) revert NotVaultOwner(msg.sender, vault);
        if (lpExitVaultOf[msg.sender] != address(0)) revert AlreadyRegistered(msg.sender, lpExitVaultOf[msg.sender]);
        lpExitVaultOf[msg.sender] = vault;
        emit LpExitVaultRegistered(msg.sender, vault, VERSION);
    }
    function vaultOf(address owner) external view returns (address swapVault, address lpEntryVault, address lpExitVault) {
        address s = swapVaultOf[owner];
        address le = lpEntryVaultOf[owner];
        address lx = lpExitVaultOf[owner];
        // GAP 10 FIX: re-verify ownership on read; silently ignore fake registrations.
        if (s != address(0) && IOwnable(s).owner() != owner) s = address(0);
        if (le != address(0) && IOwnable(le).owner() != owner) le = address(0);
        if (lx != address(0) && IOwnable(lx).owner() != owner) lx = address(0);
        return (s, le, lx);
    }
}
```

**GAP 10 FIX (pre-registration grief/spoof vector closed — Codex R7-REG BLOCKER):**
- The PRIOR self-registration model (vault constructor calls `register*(owner)`, registry keys by `IOwnable(msg.sender).owner()`) was SPOOFABLE: an attacker deploys `FakeVault` whose `owner()` returns the victim, calls `registerSwap(victim)` from `FakeVault` (msg.sender == `FakeVault`, `IOwnable(FakeVault).owner() == victim` → passes), setting `swapVaultOf[victim] = FakeVault`. The overwrite-on-stale variant only overwrites when the fake's `owner()` CHANGES — but a fake contract can return `owner()==victim` FOREVER, so `vaultOf(victim)` re-verification (line 528) passes and resolves to `FakeVault`. The executor/TS then routes the victim's trades/native to `FakeVault`, which is attacker-controlled → fund-loss/drain. This is a real loss-of-funds path, not just grief.
- **Codex R7-REG FIX: owner-called registration.** `register*(address vault)` is called BY the owner (msg.sender == `IOwnable(vault).owner()`), NOT self-registration from the vault constructor. An attacker cannot call `registerSwap(fakeVault)` with `msg.sender == victim` without the victim's key, and cannot register a fake under the victim at all (`msg.sender == attacker != victim` → `NotVaultOwner`). No overwrite logic needed — spoof is impossible at registration time. The `vaultOf` read-time `IOwnable(s).owner() != owner` re-verify (lines 528-530) is retained as defense-in-depth (handles post-registration ownership transfer, which V4 does not perform). The vault constructors DROP self-registration; the USER calls `registry.register*(vault)` after each deploy (§10 step 3, §6 steps 7-9). **Test D.5 (GAP 10/39):** an attacker deploying a fake vault whose `owner()` returns the victim CANNOT register it under the victim (`registerSwap(fakeVault)` from attacker → `NotVaultOwner(attacker, fakeVault)`); `vaultOf(victim)` returns `(0,0,0)` until the victim registers their own real vault.

**Notes:**
- **No `new`, no embedded child creation bytecode** — deployed bytecode is ~1-2KB. Well under 24576B.
- **No privileged setter, no admin role, no `Ownable`** — the registry is a public good.
- **One-vault-per-owner:** each `register*` reverts if a real (owner-verified) vault already holds the slot; a stale/fake entry is overwriting-eligible.
- **Permissionless self-serve:** the user deploys all three thirds via wagmi `deployContract` (their EOA = `msg.sender` = `initialOwner`). No deployer role can create a vault on behalf of another user.

---

## 5. Contract: `D:\4lpha-0G\contracts\ZiaLpAdapterV4.sol` — V4 Adapter

New file (copy `ZiaLpAdapter.sol`, extend). `pragma 0.8.24`, `cancun`, `viaIR: true`. Same constants (`NFPM=0x5143…8c6A`, `SWAP_ROUTER=0x18cC…Ef30`, `W0G=0x1Cd0…109c`), same `ADAPTER_KIND`, same `receive()`, same `_computeSwapAmount`.

### 5.1 Interface — `IPolicyVaultLpAdapter.sol`
Structs unchanged. Existing views: `lpAdapterKind`, `wrappedNative`, `nfpm`, `ownerOf`, `liquidityOf`, `positionTicks`, `poolTokens`.

### 5.2 Inline interface gap — add `increaseLiquidity` to `INonfungiblePositionManager`
(unchanged)

### 5.3 Implementation sketches (recipient hard-pinned to `msg.sender` = vault)

**B.1 `zapInIncreaseLiquidity`:** (unchanged; vault-side `w0gRefund >= amount0Desired → LpBadDelta` is the defense-in-depth — GAP 19).

**B.2 `decreaseLiquidity` (GAP 12):** `NFPM.decreaseLiquidity` then `NFPM.collect(CollectParams{recipient: msg.sender, MAX, MAX})` → transfers principal + accrued fees to vault. Return `(amount0, amount1)`. The vault uses `>=` floor. No swap/unwrap/burn.

**B.3 `collectFees` (GAP 9/13/30):** `NFPM.collect` only. MUST NOT swap, wrap, or unwrap. Documented as post-decrease residual collector (GAP 13).

**B.4 `burnLp`:** (unchanged)

**B.5 `sweepToken` (GAP 14):** Native-out: `forceApprove(tokenIn, SWAP_ROUTER, p.amountIn)`; `exactInputSingle(tokenIn→W0G, recipient=address(this), amountIn, 0)`; revoke; `W0G.withdraw(w0gTotal)`; `amountOut = address(this).balance - nativeBefore`; `safeTransferNative(msg.sender, amountOut)` — `msg.sender` is the LpExit vault (SIZE-2: sweep moved to LpExit), whose `receive()` accepts native from `address(lpAdapter)`. If `amountOut < p.amountOutMin` → `revert SlippageExceeded()`.

### 5.4 No arbitrary call/delegatecall/multicall — confirmation
(unchanged; verified by ABI-scan test §9.2 GAP 35)

### 5.5 Deploy plan — `D:\4lpha-0G\scripts\deploy-mainnet-zia-lp-adapter-v4.ts`
(unchanged)

---

## 6. Migration System

### 6.1 Design principles
Idempotent per-item resume with a per-owner state file. Each step is postcondition-gated and recorded. **GAP 15:** native withdraw→EOA→deposit hop uses the proven idempotent pattern from `vault-migrate.ts:395-504`. **GAP 17:** on resume, for each agent per vault third, read `agentKeyEnabled` on-chain; if true, skip broadcast and proceed to JSON re-point. JSON re-point is idempotent. **GAP 19:** `pause+revoke+drain V3` is a hard postcondition gate recorded as `v3Retired:boolean`; V3 ghost notional is only harmless once `v3Retired==true`. **GAP 20:** `v3Retired:false` in the state file is treated as "migration incomplete — do not trust V3 LP accounting for NFTs in the per-NFT completed list"; the resolver falls back to V3 only for NFTs NOT in the completed-preserve list, and the UI flags V3 as "migration pending retirement." **GAP 35:** `resolveActiveVaultForOwner(owner, agentKey)` reads `agentKeyEnabled(agentKey)` on ALL THREE V4 vault thirds; V4 is active only when ALL THREE are enabled.

### 6.2 V1 → V4 (GAP 27 — distinct V1 branch; GAP 14 — deployer-owned source)

**GAP 12 FIX (hard on-chain precondition gate before any deployer-owned-source withdraw):** before any source-side owner withdraw on a deployer-owned V1/V2/V3 singleton, the orchestrator inventories EVERY position/NFT/staked-NFT in the source vault and asserts each maps to a deployer-owned agent (`identity owner == DEPLOYER`) AND that no non-deployer agentKey has `positionUnits`/`lpNftOwner`/`agentStakedNfts` entries. If the inventory is non-empty for any non-deployer agent, HALT the deployer-owned-source sub-path and require the USER to sign source-side actions on their own funds (or route those specific positions to a user-signed exit). Record this assertion in the state file as a gate, not just a memory assumption.

1. Resolve V1 via `resolveMainnetVaultVersionsForOwner(owner)` → `sourceVault`. Determine ownership: if `Ownable(sourceVault).owner() == DEPLOYER`, this is the deployer-owned-source sub-path; if `== user`, the USER signs source-side actions.
2. **GAP 12 inventory gate** (for deployer-owned-source): inventory native + `allowedTokens` balances + global `positionUnits` per token + (V3) all LP NFTs/staked NFTs. Assert each non-zero entry maps to a deployer-owned agent. If any non-deployer agent has a position → HALT, require user-signed exit for those positions. **MIG-4: resolve each `agentKey → (identityAddress, tokenId)` via `mainnet-agents.json` roster ONLY; if absent or `identityAddress` does not match a verified AgenticID (GAP 25) → HALT `AgentKeyUnresolvable` (fail-closed, do NOT assume `0x058c`).**
3. Inventory: native + `allowedTokens` balances + global `positionUnits` per token.
4. **Rescue-sell token positions (V1-specific):** for each token with `positionUnits[token] > 0`: DEPLOYER `acceptProof` + EXECUTOR `sell` via `executeCuratedTrade`. **DROP the "re-enable agentKey on V1" step entirely** — V1 has no such function. Postcondition: `positionUnits[token] == 0 && ERC20(token).balanceOf(vault) == 0`.
5. `assertLegacyVaultIsNativeOnly` gate. **GAP 19 FIX:** if this gate fails (rescue-sell failed for token X — pool disabled, cooldown active, token delisted), surface `'rescue-sell failed for token X; call rescueToken(X, balance) on the old vault as the owner, then re-POST to resume'`. Optionally auto-attempt `onlyOwner rescueToken` to the V4 Swap vault for unsellable tokens when the source vault is deployer-owned.
6. **Source owner action:** if deployer-owned-source (and GAP 12 gate passed), DEPLOYER `withdrawNative(v1Balance)` on V1; else USER. Record `withdrawnAmount0G` + `withdrawTxHash`.
7. USER deploys `PolicyVaultV4LpEntry` (wagmi `deployContract`) → then USER calls `registry.registerLpEntry(lpEntryVault)` (owner-called — Codex R7-REG FIX, NOT self-registration).
8. USER deploys `PolicyVaultV4LpExit` (wagmi `deployContract`, passing `lpEntry` address) → then USER calls `registry.registerLpExit(lpExitVault)`. USER calls `lpEntry.setLpExitVault(lpExit)` (one-time).
9. USER deploys `PolicyVaultV4Swap` (wagmi `deployContract`) → then USER calls `registry.registerSwap(swapVault)` (owner-called — Codex R7-REG FIX).
10. **Native hop (idempotent — GAP 15):** if deployer==V4 owner, DEPLOYER `depositNative{value: v1Balance}` on the V4 Swap vault; else the deployer transfers raw native to the user EOA and the USER signs `depositNative`. On resume, if V4 Swap vault balance >= `withdrawnAmount0G - reserve`, skip deposit; re-deposit any EOA residual. Record `depositTxHash`.
11. USER `setAgentKeyEnabled(agentKey, true)` on ALL THREE V4 vaults per agent. **On resume (GAP 17):** read `agentKeyEnabled` on-chain per vault third; if true, skip broadcast.
12. Server re-points `mainnet-agents.json` idempotently: `swapVault`/`lpEntryVault`/`lpExitVault` from registry, `migratedFromVault`, `vaultVersion=4`, record on-chain-verified `agentKeyEnabled:true` per agent per vault third. **GAP 27:** record `identityAddress` per agent (NOT assumed `0x058c` — see §6.6.1).
13. USER (or DEPLOYER if deployer-owned) `setPaused(true)` + `revokeExecutor()` on V1. **GAP 19:** record `v1Retired:true` in state file.

### 6.3 V2 → V4
Structurally identical to V1→V4 but V2 HAS `agentKey`/`setAgentKeyEnabled`/`agentPositionUnits`, so the rescue-sell re-enables agentKey on V2 if disabled (owner-signed) before DEPLOYER+EXECUTOR sell. Postcondition: `positionUnits[token]==0 && agentPositionUnits[agentKey][token]==0 && balance==0`. Same GAP 12 inventory gate, GAP 15 native-hop, GAP 17 agentKey resume.

### 6.4 V3 → V4 (the hard path — LP NFTs)

**GAP 13/18 conservative cap policy + fail-fast (GAP 18):** LP caps are tighten-only. Before `createVault`, the orchestrator inventories every `lpNftDeployedNative[tokenId]` across the owner's V3 NFTs. **GAP 18 FIX:** pre-compute total preservation notional (sum of `deployedNative0G` for NFTs marked "preserve") and compare against the seeded V4 caps (accounting for the rolling-24h `lpDailyCap0G` window). If insufficient, ABORT the migration with an explicit "caps insufficient to honor preservation preference" error requiring operator acknowledgment (re-seed caps by redeploying the LP vaults with higher headroom, or explicit per-NFT opt-in to exit) — NOT a silent preserve→exit downgrade. `initialAllowedLpPools` is seeded with the union of (curated zappable pools ∪ every V3-NFT pool `lpNftPool[tokenId]`) with matching `stakeVaultForLpPool` (GAP 24).

**Two sub-paths per NFT:**

**A.3.i NFT-preserving (preferred):**
1. If staked: SOURCE_OWNER `unstakeLpOwner(tokenId, stakeVault)` on V3 — **Codex 1.2 FIX (branched signer):** DEPLOYER signs if `Ownable(V3).owner()==DEPLOYER` (deployer-owned singleton `0xfd39` / `0x7a2A...`, per §6.6 / line 864) AND the GAP 12 deployer-rescue gate is passed; else USER signs (user-owned V3 vault). A plain USER signature on a deployer-owned V3 reverts `OwnableUnauthorizedAccount`.
2. SOURCE_OWNER `rescueNft(lpAdapter.nfpm(), tokenId)` on V3 (same DEPLOYER-vs-USER branch as step 1). NFT → source owner wallet (DEPLOYER rescue wallet or USER wallet respectively).
3. **Full pre-flight (checked BEFORE step 2, re-checked before step 4):** assert on V4 LpEntry vault: `allowedLpPools[poolId]`, `agentKeyEnabled[agentKey]`, `perLpActionCap0G >= deployedNative0G`, `lpDailyCap0G - lpDailySpent0G >= deployedNative0G` (rolling-24h), `maxLpExposure0G - openLpExposure0G >= deployedNative0G`, `lpNftOwner[tokenId]==0`. **Codex R7-LOF FIX (split fallback by rescue stage):** if the PRE-step-2 check fails → route to A.3.ii BEFORE moving the NFT (NFT still in V3, V3 `zapOut` valid). If the re-check before step 4 fails AFTER step 2 already moved the NFT to the source owner wallet → do NOT route to A.3.ii (V3 `zapOut` is invalid — V3 `lpNftOwner` was cleared by `rescueNft`); instead HALT and either (a) fix the V4 precondition (re-seed caps / allowlist the pool / enable agentKey) then retry step 4, or (b) exit via the direct NFPM manual path (`decreaseLiquidity`+`collect` from the source owner wallet — the NFT is a standard Uni V3 NFT, per MIG-8).
4. SOURCE_OWNER `safeTransferFrom(sourceOwnerWallet, v4LpEntryVault, tokenId)` on NFPM — **Codex R7-LOF BLOCKER FIX (deployer-owned V3 custody):** for a deployer-owned V3, step 2 rescued the NFT to the DEPLOYER rescue wallet, so the DEPLOYER must sign `safeTransferFrom(deployerRescueWallet, v4LpEntryVault, tokenId)`; for a user-owned V3, the USER signs from `userWallet`. A USER cannot `safeTransferFrom` an NFT they do not own (`ERC721InsufficientApproval`/not-owner revert). `sourceOwnerWallet` = DEPLOYER rescue wallet OR user wallet per the step-1 branch.
5. USER `importLpNft(tokenId, agentKey, poolId, tickLower, tickUpper, deployedNative0G)` on V4 LpEntry vault (ticks read from adapter inside import + cross-checked against orchestrator-supplied ticks — GAP 15; `deployedNative0G` copied verbatim from V3).
6. Optional re-stake: EXECUTOR `stakeLp` on V4 if Zia vault is in V4 `allowedStakeVaults`.
7. **Loss-of-funds fallback (G-03: `rescueNft` lives on LpEntry where NFTs are custodied):** if `importLpNft` reverts after the NFT is inside the V4 LpEntry vault, the owner calls V4 (LpEntry) `rescueNft(tokenId, owner())` to pull the NFT back to the wallet, then retries or exits. **MIG-8 FIX (exit path after V4 rescueNft):** once the NFT is back in the user wallet, the exit path is: (a) re-import to V4 LpEntry (if the import issue is fixed) then V4 `zapOut`, OR (b) user manually `decreaseLiquidity`+`collect` via the NFPM directly (the NFT is a standard Uni V3 NFT). **V3 `zapOut` is NOT available** (V3 `lpNftOwner` was cleared by the prior V3 `rescueNft`).

**GAP 16 FIX (A.3.i resume — MIG-3 HIGH FIX: stage-dispatch PRIMARY, ownerOf-dispatch SECONDARY WITHIN the transfer stage only):** In the orchestrator resume logic, dispatch FIRST on the recorded per-NFT `stage`, then (only within the `transfer` stage) branch on `nfpm.ownerOf(tokenId)` read on-chain:
- (a) if `stage == transfer` AND `ownerOf == v4LpEntryVault`, skip `safeTransferFrom` and proceed directly to `importLpNft` (NFT already in the vault).
- (b) if `stage == transfer` AND `ownerOf == sourceOwnerWallet` (userWallet for user-owned V3, deployerRescueWallet for deployer-owned V3 — Codex R7-LOF), execute `safeTransferFrom(sourceOwnerWallet, v4LpEntryVault, tokenId)` then `import`.
- (c) if `stage == transfer` AND `ownerOf` is any other address (not v4LpEntryVault, not sourceOwnerWallet), halt with a "NFT in unexpected location" error and surface to the operator.
- (d) **MIG-3 / GAP-VR3-5 FIX (key on `ownerOf`, NOT `stage`):** if `ownerOf(T) == V3 source vault` (regardless of recorded stage) → re-issue V3 `rescueNft(tokenId)` (owner-only, idempotent — recovers an NFT whose V3 rescue was interrupted before the NFT left the V3 vault); if `stage == rescueNft` AND `ownerOf(T) == sourceOwnerWallet` (userWallet OR deployerRescueWallet — Codex R7-LOF) → advance to the `transfer` stage (do NOT re-issue — the rescue already succeeded); if `stage == rescueNft` AND `ownerOf(T)` is any other address → halt. The bare `stage==rescueNft` re-issue trigger is DROPPED (it re-issued a succeeded `rescueNft` → spurious revert on resume).
Record the `ownerOf`-verified state + `stage` (not just the txHash) as the resume checkpoint, mirroring the GAP 17 on-chain-verified checkpoint pattern.

**A.3.ii NFT-exiting fallback** (underwater / stale ticks / pre-flight fails / caps insufficient and cannot be re-seeded — GAP 18):
1. If staked: SOURCE_OWNER `unstakeLpOwner` on V3 (same Codex 1.2 DEPLOYER-vs-USER branch as A.3.i step 1 — deployer-owned V3 requires DEPLOYER signature; a USER signature reverts `OwnableUnauthorizedAccount`).
2. **GAP 23 FIX:** before V3 `zapOut`, SOURCE_OWNER `setAgentKeyEnabled(agentKey, true)` on V3 (same Codex 1.2 branch — deployer-owned V3 requires DEPLOYER signature, NOT user-signed) if disabled — V3 `zapOut` routes through `_validateLpRequest → _validateAgentKey` which reverts `NotAllowed` if `agentKeyEnabled` is false. (V4 drops this — GAP 11 — but V3 still requires it.)
3. EXECUTOR `zapOut` on V3 (DEPLOYER `acceptProof` + EXECUTOR). NFT burned, native → V3. **MIG-5 / GAP-VR3-6 FIX: record `zapOutTxHash` per NFT in the state file. Resume gating (NFPM `ownerOf(T)` wrapped in try/catch — GAP-VR4-1 TIGHTENED to fail-closed on non-burn reverts):** treat as burned/succeeded → skip to withdraw+deposit ONLY if BOTH (a) `ownerOf(T)` reverts with the specific `ERC721InvalidTokenId` selector (match the E.4.13b wording — do NOT catch arbitrary reverts) AND (b) V3 `lpNftOwner[T]==0` (V3 clears `lpNftOwner` on burn — cross-check confirms it was actually burned, not a transient revert); OR if `ownerOf(T)` returns a live non-V3 address (transferred) AND `lpNftOwner[T]==0`; if `lpNftOwner[T]==agentKey AND ownerOf(T)==V3` → re-issue `zapOut`; **ANY OTHER revert (RPC transient, 429-retry-exhausted, non-`ERC721InvalidTokenId` contract revert, or `lpNftOwner[T]!=0` while `ownerOf` reverted) → HALT fail-closed — do NOT skip `zapOut`, do NOT strand a live NFT in a V3 that will be revoked later**; otherwise halt.
4. **GAP 16 FIX (second withdraw+deposit cycle, idempotent — MIG-1 BLOCKER FIX):** SOURCE_OWNER `withdrawNative` on V3 (same Codex 1.2 branch — deployer-owned V3 requires DEPLOYER) → USER `depositNative` on V4 Swap vault (USER owns V4). Each step postcondition-gated and idempotent. **MIG-1: skip per-NFT iff `exitDepositTxHash[NFT]` is mined AND confirmed AND V4 Swap accounting reconciles per-NFT — track a `perNftDeposited0G` map in the state file (NOT aggregate balance reconciliation); aggregate-balance skip is forbidden because it can mask a missing deposit for one NFT among many.** State file records `exitWithdrawTxHash`/`exitDepositTxHash`/`perNftDeposited0G[NFT]` per NFT. **V3 `zapOut` requires `executorActive` (not paused, not revoked) — so pause+revoke V3 happens only AFTER ALL NFTs are resolved.**

**GAP 12 FIX (full V3→V4 sequence — per-NFT loop placed explicitly):**
1. Resolve V3 → inventory (native + tokens + all LP NFTs + staked NFTs + per-NFT `lpNftDeployedNative`).
2. **GAP 12 inventory gate** (if V3 deployer-owned): assert all positions/NFTs map to deployer-owned agents; HALT if non-deployer agent has a position. **MIG-2 BLOCKER FIX (enumeration method):** enumeration = NFPM `Transfer` event scan filtered to/from the V3 vault address + V3 `lpNftOwner[tokenId]` direct reads over the enumerated tokenId set; if `agentLpNfts`/`agentStakedNfts` getters are absent (revert/selector-mismatch — true on deployed `0xfd39`), enumeration MUST fall back to the event scan, NOT return empty — revert-with-halt on enumeration failure (`InventoryEnumerationUnavailable`). **GAP-VR3-4 FIX (event-scan from-block — HIGH loss-of-funds):** the orchestrator MUST use `fromBlock = min(NFPM_DEPLOY_BLOCK, V3_DEPLOY_BLOCK)` for the NFPM `Transfer` event scan, with a hard assert `require(fromBlock <= NFPM_DEPLOY_BLOCK)`; pin `NFPM_DEPLOY_BLOCK` from `.data/deployments/` (or explorer binary search if absent). A wrong/stale from-block misses pre-existing NFTs → deployer sweeps non-deployer funds. **MIG-4 HIGH FIX (agentKey resolution):** for each enumerated NFT/position, resolve `agentKey → (identityAddress, tokenId)` via `mainnet-agents.json` roster ONLY. If `agentKey` is absent from the roster OR `identityAddress` does not match one of the verified AgenticID contracts (GAP 25) → HALT with `AgentKeyUnresolvable` (fail-closed, do NOT skip, do NOT assume canonical `0x058c`).
3. Seed V4 caps from inventory (including `lpDailyCap0G` headroom across ALL NFTs — GAP 13). **GAP 18: abort if caps insufficient for preservation preference.**
4. Rescue-sell token positions (EXECUTOR sell; re-enable agentKey on V3 if disabled). **GAP 19: surface rescueToken fallback if rescue-sell fails.**
5. `assertLegacyVaultIsNativeOnly` gate.
6. Deploy V4 LpEntry + LpExit + Swap (USER wagmi `deployContract`; `setLpExitVault` one-time).
   - **Precondition (Codex 1.1 FIX — deploy MUST precede the native hop AND all NFT transfers):** the V4 Swap vault must exist before `depositNative` can target it; A.3.i pre-flight also requires the V4 LpEntry vault to exist + agentKey enabled + caps seeded.
7. **Native hop #1 (idempotent — GAP 15):** `withdrawNative` on V3 → `depositNative` on V4 Swap vault. (Codex 1.1 FIX: now ordered AFTER step 6 deploy — was incorrectly step 6, depositing native into a non-existent V4 Swap vault.)
8. Enable agent keys on ALL THREE V4 vaults (USER, per agent).
   - **Precondition:** A.3.i pre-flight requires `agentKeyEnabled[agentKey]==true` on V4. Deploy + enable keys MUST precede all NFT transfers.
9. **Per-NFT loop (A.3.i preserve OR A.3.ii exit) — runs AFTER enable keys, BEFORE re-point:**
   - For each NFT: pre-flight (A.3.i step 3) → choose i/ii → execute. A.3.ii produces a second withdraw+deposit cycle recorded per-NFT. **GAP 41: per-NFT lossless postcondition** — after `importLpNft`, assert V4 `lpNftDeployedNative[tokenId] == V3 lpNftDeployedNative[tokenId]` (captured before rescueNft), `lpNftPool == V3 pool`, and ticks read from adapter match V3 recorded ticks; for A.3.ii, assert native conserved per NFT (not just aggregate).
10. Re-point `mainnet-agents.json` (idempotent — GAP 17: verify `agentKeyEnabled` on ALL THREE vaults on-chain before JSON write; JSON re-point is a no-op if `vaultVersion==4` and addresses already match).
11. `pause+revoke+drain V3`. **MIG-6 FIX (hard PRE-condition gate):** `allNftsResolved==true` (every NFT in the inventory list has `stage==imported` OR `stage==exitDeposited`) MUST be asserted on-chain + state-file BEFORE `setPaused(true)`+`revokeExecutor()`; else HALT with `NftsUnresolved`. **GAP-VR3-7 FIX (explicit per-NFT on-chain assertion):** for each NFT in the inventory list, assert on-chain: (preserve) V4 LpEntry `lpNftOwner[T]==agentKey`; (exit) V3 `lpNftOwner[T]==0` AND V4 Swap native credit for T recorded in `perNftDeposited0G`. All MUST hold before `setPaused(true)`+`revokeExecutor()`. **GAP 19:** record `v3Retired:true` as a hard postcondition gate. **GAP 20:** until `v3Retired==true`, V3 ghost notional for migrated NFTs is treated as "migration incomplete."

### 6.5 Orchestrator — `D:\4lpha-0G\lib\agent\vault-migrate-v4.ts`
Ports the proven idempotent pattern from `vault-migrate.ts:395-504`:
- `withdrawOldVault`: `waitForReceipt` (150-retry), record `withdrawnAmount0G` + `withdrawTxHash`, residual-tolerance gate.
- `depositNewVault`: idempotency — skip if V4 balance >= withdrawn-minus-reserve; record `depositTxHash`.
- `rescueLpNfts`: records per-NFT `stage: unstake → rescueNft → transfer → import → restake` (A.3.i) OR `stage: unstakeLpOwner → zapOut → exit-withdraw → exitDeposited` (A.3.ii) with pre-flight results. **GAP 16: transfer-stage resume branches on `nfpm.ownerOf(tokenId)` on-chain.** Re-running is idempotent: an NFT already imported → `AlreadyRegistered` handled gracefully (skip, no re-transfer, no double-count of daily cap); an A.3.ii exit already completed → `positionUnits==0` postcondition → skip.
- V1 vs V2/V3 branches dispatch on `sourceVersion`; deployer-owned-source vs user-owned-source dispatch on `Ownable(source).owner()`; **GAP 12 inventory gate runs before any deployer-owned-source withdraw.**

### 6.6 Loss-of-funds matrix (revised)

- **GAP 33:** native from `zapOut`/`sweepToken`-native-out and ERC20 from `collectFees`/`decreaseLiquidity` stranded in LP vaults. **FIX:** LpEntry + LpExit carry `withdrawNative`/`rescueToken` (V3:430/438 verbatim). Test A.5 asserts owner can recover.
- **GAP 24:** `safeTransferFrom` mined but `importLpNft` reverts → NFT stranded in V4 LpEntry vault. **Recovery (G-03):** V4 (LpEntry) `rescueNft(tokenId, owner())` — `rescueNft` lives on LpEntry where NFTs are custodied (NOT LpExit). **MIG-8:** post-rescue exit path is re-import + V4 `zapOut` OR user manual `decreaseLiquidity`+`collect` via NFPM; V3 `zapOut` NOT available (V3 `lpNftOwner` cleared).
- **GAP 16:** `safeTransferFrom` mined but receipt lost → NFT in V4 LpEntry, import not run. **Recovery:** ownerOf-based resume branch (§6.4 A.3.i GAP 16 fix) — orchestrator detects `ownerOf == v4LpEntryVault` and proceeds to import, no manual rescue needed.
- **GAP 28:** pre-flight before `rescueNft` asserts all 4 cap/allowlist/key/registry preconditions. If any fails → A.3.ii before any transfer.
- **GAP 29 (acceptable residuals — gated on `v3Retired` — GAP 19/20):** V3 per-NFT ghost notional/exposure/registry entries for NFTs moved out via `rescueNft`. Harmless ONLY once `v3Retired==true` is recorded. Before that gate, a future operator could believe V3 still owes the position (GAP 20: treat `v3Retired:false` as incomplete).
- **GAP 14 (deployer EOA window — GAP 12 gated):** native transits the deployer EOA between source-withdraw and V4-deposit for deployer-owned source vaults. Mitigated by idempotent re-deposit-on-resume (GAP 15) AND the GAP 12 inventory gate (no non-deployer funds present).
- **GAP 19 (stranded ERC20 recovery):** if `assertLegacyVaultIsNativeOnly` fails (rescue-sell failed), surface `rescueToken(X, balance)` manual step. V1/V2/V3 all expose `onlyOwner rescueToken`.
- **Unacceptable residuals (halt):** native > 0 on old after `withdrawNative` done; `positionUnits` > 0 after rescue-sell done; `ownerOf(tokenId) != V4 LpEntry vault` after `importLpNft` done; registry not re-pointed after all on-chain done; `v3Retired==false` at migration-done; native/ERC20 stranded in LP vaults with no `withdrawNative`/`rescueToken` path.

### 6.6.1 AgenticID contract reality (GAP 25 — THREE contracts, verify on-chain)

**GAP 25 FIX (blocker):** the codebase carries agents minted on potentially THREE AgenticID contracts: `0x058c5f4c72810d7d4fc0bef3875a8f779de7e59c` (canonical per README/code/plan), `0xa6c5723f024f207311060f4d0976f85a6a069064` (recorded in `.data/deployments/mainnet-agentic-id.json` with deployer + txHash), and `0x7a968138` (legacy, EXCLUDED — lacks `supportsInterface`, not a V4 mint candidate unless rediscovered via chainscan). The prior draft's §6.6.1 only reconciled `0x058c` vs `0x7a968138` and never mentioned `0xa6c5`.

**Before any V4 work, verify on-chain (chainId 16661)** which of `0x058c` / `0xa6c5` is deployed, supports the three canonical ERC-7857 interface IDs (`IERC7857`/`IERC7857Metadata`/`IERC7857DataVerifier` — NOT just ERC-165 `0x01ffc9a7`, per §10 GAP 25 / Codex R7-LOW 5.1), and has minted the existing roster (`0x7a968138` is EXCLUDED unless rediscovered via chainscan — it lacks `supportsInterface` and is not a V4 mint candidate). Reconcile `AGENT_IDENTITY_MAINNET_ADDRESS` in `.env.local` with the verified canonical address. Expand this section to enumerate ALL deployed AgenticID contracts (three, not two), state which is the V4 mint target, and record `identityAddress` per agent from the existing roster (do not assume `0x058c`).

**V4 migration rules:**
1. **New V4 agents mint on the verified canonical AgenticID only** (post-gap-25 verification). The mint target env var is reconciled before any mint.
2. **Agents already on legacy contracts are NOT re-minted.** Their `agentKey` (derived from `identityAddress:tokenId`) is set via `setAgentKeyEnabled` on all three V4 vault thirds unchanged — `agentKey` derivation is identity-address-scoped and version-independent.
3. **The roster `identityAddress:tokenId` keying MUST be preserved** so a removed legacy `#N` agent does not shadow a live canonical `#N` agent after migration.
4. **`mainnet-agents.json` must record `identityAddress` per agent** (not assume canonical).

### 6.7 Consent + nonce scope (GAP 25)

**FIX:** Add `'vault-migrate-v4'` to the `ACTION_NONCE_SCOPES` tuple in `lib/copilot/action-nonce-store.ts` AND add the matching consent action string `'Action: vault-migrate-v4'` in `lib/copilot/wallet-access.ts`. The `app/api/vault/migrate-v4/route.ts` calls `consumeActionNonce({scope:'vault-migrate-v4'})`. The prior "unchanged" claim is DROPPED. `capPreset` removed; no `newVault` address in consent.

### 6.8 UI — `D:\4lpha-0G\components\surfaces\VaultV4MigrationPanel.tsx`
(unchanged)

### 6.9 API routes (new)
`app/api/vault/v4-status/route.ts` returns `{v4SwapAddress, v4LpEntryAddress, v4LpExitAddress}` from registry. `app/api/vault/migrate-v4/route.ts` consumes `vault-migrate-v4` nonce scope.

---

## 7. App Changes — File-by-File

### 7.1 `D:\4lpha-0G\lib\contracts\policy-vault-v4.ts` (NEW)
Mirror `policy-vault-v3.ts`. **G-EXEC-2 BLOCKER FIX: export ONE canonical name `NEXT_PUBLIC_POLICY_VAULT_V4_REGISTRY_MAINNET_ADDRESS`** (placeholder `ZERO_ADDRESS` until deployed) — consumed by `resolveMainnetV4VaultForOwner` and the deploy script print; matches §10/§11.2. Do NOT use the prior `MAINNET_VAULT_REGISTRY_V4_ADDRESS` variant. Export `vaultRegistryV4Abi` (`swapVaultOf`/`lpEntryVaultOf`/`lpExitVaultOf`/`vaultOf`/`registerSwap`/`registerLpEntry`/`registerLpExit`/`VERSION`/events), `policyVaultV4SwapAbi` (V2 byte-identical error names — GAP 5; includes `poolAddressOf` — GAP 4; `TradeExecuted` + `TradeExecutedV2` + `TokenAllowed` + `PoolAllowed` — GAP 3), `policyVaultV4LpEntryAbi` (includes `depositNative`/`withdrawNative`/`rescueToken` — GAP 6/8/33; `Staked`/`LpPoolAllowed`/`StakeVaultAllowed` — GAP 3/14; **REG-1/3/4: `actionHashFor`/`policyHash`/`poolAddressOf`**; **G-03: `rescueNft(uint256,address)`**; **SIZE-2: `SweepPoolAllowed`/`allowedSweepPools` REMOVED from LpEntry ABI — moved to LpExit**), `policyVaultV4LpExitAbi` (includes `unstakeLp`/`unstakeLpOwner`/`zapOut`/`decreaseLiquidity`/`collectFees`/`burnLp`/`withdrawNative`/`rescueToken`; **REG-2: `claimRewards(LpActionRequest)`**; **REG-4: `poolAddressOf`**; **G-03: `rescueNft(uint256)` (distinct signature, no `to` arg)**; **SIZE-2: `sweepToken`/`addSweepPool`/`disableSweepPool`/`allowedSweepPools`/`SweepPoolAllowed` event — moved from LpEntry; Codex 2.1: `addSweepToken`/`disableSweepToken`/`allowedSweepTokens`/`SweepTokenAllowed` event — LpExit-local token allowlist (LpExit cannot read Swap's `allowedTokens`)**), policy/struct components. `agentStakedNfts` getter typed `(bytes32, address) -> uint256[]` (V3 shape). `agentLpNfts` getter typed `(bytes32, bytes32) -> uint256[]` (GAP 8). **GAP 2:** `defaultMinOutBps` typed `uint16`; `lpMinOutBps` typed `uint16`. **GAP 7:** document that `policyHash` is per-vault (Swap = V2 6-field hash, LpEntry = 7-field LpPolicy hash), NOT V3 13-field. **GAP 36:** shared struct field-lists (`Policy`, `LpPolicy`, `TradeRequest`, `LpActionRequest`) are extracted into `lib/types/vault-policy-shapes.ts` and referenced by both `policy-vault-v3.ts` and `policy-vault-v4.ts` (AGENTS.md compliance: "Put shared shapes in lib/types/").

**G-EXEC-7 MEDIUM (v3.ts shared-shapes compliance):** add §7.1.1 entry — `lib/contracts/policy-vault-v3.ts` — replace inline `Policy`/`LpPolicy`/`TradeRequest`/`LpActionRequest` declarations with imports from `lib/types/vault-policy-shapes.ts`; keep V3-specific addresses/ABI entries. No behavior change. (Or if `v3.ts` is intended frozen, add an explicit note: "v3.ts is NOT edited in V4; the shared-shapes extraction is v4-only — documented partial compliance.")

### 7.1.1 `D:\4lpha-0G\lib\contracts\policy-vault-v3.ts` (shared-shapes compliance)
Replace inline `Policy`/`LpPolicy`/`TradeRequest`/`LpActionRequest` declarations with `import { Policy, LpPolicy, TradeRequest, LpActionRequest } from 'lib/types/vault-policy-shapes.ts'`; keep V3-specific addresses/ABI entries. No behavior change.

### 7.2 `D:\4lpha-0G\lib\agent\mainnet-vault-resolver.ts`
- **ADD** `resolveMainnetV4VaultForOwner(owner, agentKey?, client?)`: reads `registry.vaultOf(owner)` → `(swapVault, lpEntryVault, lpExitVault)`; `address(0)` for any → null. **NO env-override short-circuit** (GAP 26).
- **ADD** `resolveActiveVaultForOwner(owner, agentKey, client?)` → `{ v4Swap, v4LpEntry, v4LpExit, v3, v2Latest, v2Versions, swapActive, lpActive, active }`. **GAP 17/35 FIX:** `swapActive = swapVault.agentKeyEnabled(agentKey)`; `lpActive = lpEntryVault.agentKeyEnabled(agentKey) && lpExitVault.agentKeyEnabled(agentKey)`. `active = swapActive && lpActive`. Precedence: V4 (per-operation-type — swap ops route to V4 when `swapActive`, LP ops when `lpActive`) > V3 > V2-latest. Until both halves are on-chain-verified, fall back to V3 for the not-yet-enabled half.
- **KEEP** V3/V2/V1 legacy resolvers for migration source detection.

### 7.3 `D:\4lpha-0G\components\app\useWalletPolicyVault.ts`
- Replace `PolicyVaultPolicy` with `PolicyVaultV4SwapPolicy` + `PolicyVaultV4LpPolicy`. `toV4SwapPolicy`, `toV4LpPolicy`.
- `discoverVaults`: DELETE V3-registry fetch; ADD `v4 = await resolveMainnetV4VaultForOwner(account, activeAgentKey)`; precedence V4 → else latest V2/V3 into `legacyVaults`.
- **ADD** `createVaultV4(swapPolicyOverride?, lpPolicyOverride?)`: THREE user wagmi txs — (1) `deployContract(PolicyVaultV4LpEntry, [...])` → `lpEntryVault`; (2) `deployContract(PolicyVaultV4LpExit, [...lpEntryVault...])` → `lpExitVault`; (3) `deployContract(PolicyVaultV4Swap, [...])` → `swapVault`; (4) `lpEntry.setLpExitVault(lpExitVault)` (one-time); (5) USER calls `registry.registerLpEntry(lpEntryVault)` + `registry.registerLpExit(lpExitVault)` + `registry.registerSwap(swapVault)` (owner-called — Codex R7-REG, 3 txs). Set `vaultAddress=swapVault`, `lpEntryVaultAddress=lpEntryVault`, `lpExitVaultAddress=lpExitVault`, `vaultVersion=4`.
- **ADD** `migrateToV4({sourceVault, sourceVersion})`: idempotent native-hop → **G-EXEC-8 FIX: (4) USER signs `depositNative{value: withdrawnNative}` on V4 Swap vault (and optionally V4 LpEntry if LP migration intends to keep LP native) BEFORE `setAgentKeyEnabled`** → `setAgentKeyEnabled` per agent on ALL THREE vaults → POST `/api/vault/migrate-v4` → `setPaused`+`revokeExecutor` on old → record `v3Retired:true`.
- **GAP 2/4:** document that V4 tighten is three-tx, not atomic — `tightenSwapPolicy` + `tightenLpPolicy` (+ LpExit if applicable) issued back-to-back. **GAP 2:** document that V4 pause does NOT freeze executor LP exits (only `revokeExecutor` does).
- **DELETE** all V3-migration fields/funcs.
- **ADD** return fields: `v4SwapAddress`, `v4LpEntryAddress`, `v4LpExitAddress`, `legacyVaults`, `isMigratingToV4`, `migrateToV4`, `createVaultV4`, `v4MigrationAvailable`.

### 7.4 `D:\4lpha-0G\components\surfaces\VaultSurface.tsx` (GAP 30 — CHANGED, not unchanged)
**FIX:** Move `VaultSurface.tsx` into the §7 edit list with explicit changes:
- **REMOVE** `VaultV3MigrationPanel` and `VaultV3UnlimitedPanel` (VaultSurface.tsx:144-167).
- **Wire "Create V4 Vault"** to `createVaultV4` (three wagmi `deployContract` txs + `setLpExitVault`).
- **ADD** the V4 migration panel (`VaultV4MigrationPanel`).
- **DROP** the "unchanged" label. The prior draft's internal contradiction (§7.4 "unchanged" vs §7.12 "DELETE V3 panels") is resolved.

### 7.5 `D:\4lpha-0G\components\agents\lp\LpAgentCreateWorkspace.tsx` (GAP 31 — CHANGED, not unchanged)
**FIX:** Move `LpAgentCreateWorkspace.tsx` into the §7 edit list:
- **Update** to resolve the V4 vault PAIR via `useWalletPolicyVault` (`v4LpEntryAddress`, `v4LpExitAddress`).
- **Gate** on BOTH LP halves ready + `agentKey` enabled on both.
- **Surface** a "Create V4 Vault" prerequisite step (or block) when no V4 pair exists.
- **Replace** the "V3" copy (LpAgentCreateWorkspace.tsx:230 "Policy Vault V3 resolved") and the single-vault read (line 276 `workspace.vault.vault`) with V4 LP-third resolution.
- **DROP** the "unchanged" label.

### 7.6 `D:\4lpha-0G\lib\agent\lp\lp-deploy.ts` (GAP 28 — tighten signer model flip)
**FIX:** Move `tightenPolicy`/`tightenLpPolicy` out of the server `lp-deploy` path into a client-side wagmi `writeContract` in the LP create/policy UI. V4 requires tighten to be USER-signed (three txs, one per vault third); the server cannot sign tighten. **The `runTightenPolicy`/`runDepositNative` `DeployerRuntime` signer path is DELETED for V4.** The `deployerIsVaultOwner` branch is removed. The "unchanged" label is DROPPED.

### 7.7 `D:\4lpha-0G\lib\agent\single-agent-server.ts` (GAP 27 — add swapVault/lpEntryVault/lpExitVault)
- `deploySingleOgAgent`: DELETE `deployerIsVaultOwner` branch; always leave `agentKeyEnableTxHash: undefined`; return `nextActions` (three `set_agent_key_enabled` actions — one per vault third).
- **GAP 27 FIX:** `readVaultSnapshot`: `v4Swap, v4LpEntry, v4LpExit = resolveMainnetV4VaultForOwner(owner, agentKey)`; if V4 active → `vaultVersion=4`, use `policyVaultV4SwapAbi` for swap reads + `policyVaultV4LpEntryAbi`/`policyVaultV4LpExitAbi` for LP reads; populate `swapVault`, `lpEntryVault`, `lpExitVault` on the snapshot. `TradeExecuted` parsing retained (GAP 3).
- DELETE `migrateOwnerVaultToV3`.

### 7.7.1 `D:\4lpha-0G\lib\agent\single-agent.ts` (GAP 27 — update OgAgentVaultSnapshot)
**GAP 27 FIX:** Add `swapVault?: Address`, `lpEntryVault?: Address`, `lpExitVault?: Address` to `OgAgentVaultSnapshot` (line 125-167). Populate all three from `registry.vaultOf(owner)` in `readVaultSnapshot` when `vaultVersion==4`. Update `lp-exec.ts:60`/`lp-mint.ts:75`/`lp-context.ts` to use `lpEntryVault` (for entry actions) / `lpExitVault` (for exit actions), falling back to `vault` for legacy. **REG-6 FIX: also add `lp-exec.ts:225` and `single-agent-server.ts:1060` to the edit list** with the same `lpEntryVault` retargeting + version-gated ABI selection as `lp-mint.ts:75`. **Add `lib/agent/single-agent.ts` to the §7 file list.**

### 7.8 `D:\4lpha-0G\lib\executor\policy-vault-lp.ts` (GAP 26 — CHANGED, not unchanged)
**FIX:** Move `policy-vault-lp.ts` into the §7 edit list:
- Switch all reads to `policyVaultV4LpEntryAbi` (entry) / `policyVaultV4LpExitAbi` (exit) when `vaultVersion==4`, keeping `policyVaultV3Abi` for legacy V3.
- Resolve the V4 LP vault third specifically (LpEntry for entries, LpExit for exits) via `registry.lpEntryVaultOf(owner)` / `registry.lpExitVaultOf(owner)` — NOT the swap half, NOT the V3 singleton.
- Update `resolveVault` (line 513) signature to pick the LP third.
- Update error strings (line 114 "No mainnet V3 Policy Vault resolved" → version-gated).
- Add an ABI-selection helper (version-gated) shared with `single-agent-server.readVaultSnapshot`.
- **REG-6 FIX:** list `lpNftOwner`/`lpNftPool`/`lpNftDeployedNative` reads as LpEntry-targeted (these storage slots live on LpEntry in V4 — reads must use `policyVaultV4LpEntryAbi` against `lpEntryVault`, not the V3 singleton or the Swap vault).
- **REG-7 FIX:** any TS-side reconstruction of `vaultActionHashForLp` (audit verifier, replay cache) MUST use the V4 encoding (no `address(adapter)`; `LpActionRequest` field order preserved) and be version-gated (V3 encoding for V3 vaults, V4 encoding for V4 vaults). See §9 A.1.13 sub-case for the TS-vs-on-chain hash equality assertion.
- **DROP** the "unchanged" label.

### 7.9 API routes
`app/api/vault/v4-status/route.ts` returns `{v4SwapAddress, v4LpEntryAddress, v4LpExitAddress}` from registry. `app/api/vault/migrate-v4/route.ts` consumes `vault-migrate-v4` nonce scope.

### 7.10 `D:\4lpha-0G\lib\copilot\wallet-gate.ts` + `action-nonce-store.ts` (GAP 25 — CHANGED)
- `action-nonce-store.ts`: **ADD `'vault-migrate-v4'` to `ACTION_NONCE_SCOPES`**.
- `wallet-access.ts`: **ADD `'Action: vault-migrate-v4'`**.
- The prior "unchanged" claim is DROPPED.

### 7.10.1 `D:\4lpha-0G\components\agents\useAgentOwnerControls.ts` (GAP 32 — NEW file to edit)
**ADD** to the §7 file list. `setAgentKeyEnabledOnActiveVault` loops over `[v4SwapAddress, v4LpEntryAddress, v4LpExitAddress]` and issues three user-signed `setAgentKeyEnabled` txs. Current single-vault targeting is replaced with three-half iteration. Add a `setAgentKeyEnabledOnAllV4Vaults` helper.

### 7.11 `D:\4lpha-0G\lib\contracts\zia-lp.ts`
(unchanged)

### 7.12 Files to DELETE / KEEP
**DELETE:** `lib/agent/vault-migrate.ts`, `app/api/vault/migrate-v3/route.ts`, `app/api/vault/v3-status/route.ts`, `app/api/agents/migrate-vault/route.ts`, V3 panels in `VaultSurface.tsx` (GAP 30), V3 fields in `useWalletPolicyVault.ts`, `migrateOwnerVaultToV3` in `single-agent-server.ts`.
**KEEP (GAP 31):** `app/api/vault/withdraw-native/route.ts` (scope `'vault-withdraw-native'` unchanged) — reused by V4 migration for the old-vault native pull.

### 7.13 Contract files + scripts to create (GAPs 33, 34)
**Contracts:**
- `contracts/PolicyVaultV4Swap.sol`
- `contracts/PolicyVaultV4LpEntry.sol`
- `contracts/PolicyVaultV4LpExit.sol`
- `contracts/VaultRegistryV4.sol`
- `contracts/ZiaLpAdapterV4.sol`
- `contracts/interfaces/IPolicyVaultV4LpEntry.sol` (the `onlyLpExit` accounting callback interface)
- `contracts/interfaces/IVaultRegistryV4.sol` (G-EXEC-6 FIX — defines `registerSwap`/`registerLpEntry`/`registerLpExit` (each `(address vault) external` — Codex R7-REG FIX: owner-called, `msg.sender == IOwnable(vault).owner()`, NOT self-registration; supersedes the Codex 4.1 1-arg self-register model which was spoofable), `swapVaultOf`/`lpEntryVaultOf`/`lpExitVaultOf`/`vaultOf` views, `VERSION() -> uint8`, events `SwapVaultRegistered`/`LpEntryVaultRegistered`/`LpExitVaultRegistered` (matching the impl at §7.13 lines 501-503 — Codex R7-LOW event-name fix). Implemented by `VaultRegistryV4`; imported by all three vault contracts and by `lib/contracts/policy-vault-v4.ts`.)
- `contracts/mocks/MockZiaLpAdapterV4.sol` — real bodies for the 5 new selectors + V3-carried selectors.
- `contracts/mocks/MaliciousZiaLpAdapterV4.sol` — returns fake `(liquidity, amount0, amount1)`, transfers nothing, lies on `liquidityOf`, re-enters.
- `contracts/mocks/MaliciousERC20.sol` — re-enters on transfer, `balanceOf` lie, fee-on-transfer.
- `contracts/mocks/DrainingAdapter.sol` — returns huge amountOut but sends nothing.
- `contracts/mocks/ReenteringFactory.sol` — re-enters `registerSwap`/`registerLpEntry`/`registerLpExit`.
- `test/policy-vault-v4-swap.ts`, `test/policy-vault-v4-lp-entry.ts`, `test/policy-vault-v4-lp-exit.ts`, `test/zia-lp-adapter-v4.ts`, `test/vault-registry-v4.ts`, `test/vault-migrate-v4.ts`.

**Scripts (GAP 34 — add deploy scripts to create-list):**
- `scripts/deploy-mainnet-vault-registry-v4.ts` (readback: `VERSION()==4`, all three `*VaultOf(deployer)==address(0)`; write `.data/deployments/mainnet-vault-registry-v4.json`; print `NEXT_PUBLIC_POLICY_VAULT_V4_REGISTRY_MAINNET_ADDRESS` (G-EXEC-2 canonical name) + `NEXT_PUBLIC_VAULT_REGISTRY_V4_MAINNET_FROM_BLOCK`).
- `scripts/deploy-mainnet-zia-lp-adapter-v4.ts` (readback: `lpAdapterKind()`, `nfpm()`, `wrappedNative()`; verify `NFPM`/`SWAP_ROUTER`/`W0G` bytecode; write `.data/deployments/mainnet-zia-lp-adapter-v4.json`; print `NEXT_PUBLIC_POLICY_VAULT_ZIA_LP_ADAPTER_V4_MAINNET_ADDRESS`).
- `scripts/check-contract-size.ts` (GAP 21 — Hardhat-3-native size gate; globs `artifacts/contracts/**/*.json`, reads `deployedBytecode`, asserts `< 24576` for all V4 contracts).
- `scripts/lp-mainnet-v4-smoke.ts` (smoke paths F.1-F.14).

**Docs (GAP 33):**
- `docs/vault-v4-plan.md` — the finalized V4 plan-of-record, written to disk before execution begins.

### 7.14 `package.json` scripts (GAP 21 — no hardhat-contract-sizer; GAP 30 — no hardhat user-vault scripts)
```json
"contracts:size": "node scripts/check-contract-size.ts",
"contracts:compile": "hardhat compile && npm run contracts:size",
"deploy:vault:mainnet:registry:v4": "hardhat run scripts/deploy-mainnet-vault-registry-v4.ts --network ogMainnet",
"deploy:vault:mainnet:zia-lp-adapter:v4": "hardhat run scripts/deploy-mainnet-zia-lp-adapter-v4.ts --network ogMainnet",
"smoke:v4:compute": "node scripts/lp-mainnet-v4-smoke.ts compute",
"smoke:v4:storage": "node scripts/lp-mainnet-v4-smoke.ts storage",
"smoke:v4:galileo-proof": "node scripts/lp-mainnet-v4-smoke.ts galileo-proof",
"smoke:v4:deposit-swap": "node scripts/lp-mainnet-v4-smoke.ts deposit-swap",
"smoke:v4:deposit-lp": "node scripts/lp-mainnet-v4-smoke.ts deposit-lp",
"smoke:v4:policy-swap": "node scripts/lp-mainnet-v4-smoke.ts policy-swap",
"smoke:v4:policy-lp": "node scripts/lp-mainnet-v4-smoke.ts policy-lp",
"smoke:v4:buy": "node scripts/lp-mainnet-v4-smoke.ts buy",
"smoke:v4:sell": "node scripts/lp-mainnet-v4-smoke.ts sell",
"smoke:v4:pause": "node scripts/lp-mainnet-v4-smoke.ts pause",
"smoke:v4:revoke": "node scripts/lp-mainnet-v4-smoke.ts revoke",
"smoke:v4:withdraw": "node scripts/lp-mainnet-v4-smoke.ts withdraw",
"smoke:v4:lp-lifecycle": "node scripts/lp-mainnet-v4-smoke.ts lp-lifecycle",
"smoke:v4:lp-v4": "node scripts/lp-mainnet-v4-smoke.ts lp-v4",
"smoke:v4:lp-partial": "node scripts/lp-mainnet-v4-smoke.ts lp-partial",
"smoke:v4:sweep": "node scripts/lp-mainnet-v4-smoke.ts sweep"
```
> No `deploy:vault:mainnet:swap:v4` / `:lp-entry:v4` / `:lp-exit:v4` hardhat scripts — per-user vaults deploy via UI `createVaultV4` (wagmi `deployContract` with the user's connector). `contracts:size` uses the native node script (GAP 21), NOT `hardhat size`.

### 7.15 hardhat config (GAPs 21, 29 — reconcile with existing hardhatMainnet; NO hardhat-contract-sizer)
- **GAP 21 FIX:** do NOT `npm i -D hardhat-contract-sizer` (does not exist for Hardhat 3). Do NOT add `import "hardhat-contract-sizer"`. Do NOT add `contractSizer`. Do NOT add a `hardhat size` task. Use `scripts/check-contract-size.ts` (§7.13) wired as `contracts:size` and chained in `contracts:compile`.
- **GAP 29 FIX:** do NOT add a new `hardhatMainnet` network entry. RECONCILE with the existing one: keep `hardhatMainnet` as `edr-simulated` + `allowUnlimitedContractSize:true` (needed by V1/V2/V3 factory tests where the 28766B factory exceeds EIP-170 — GAP 24). Rely on `scripts/check-contract-size.ts` + A.0 size unit test as the <24576 gate for V4. Update §9.8 to reference the existing network.
- Gate `contracts:compile` (and CI) to fail if any V4 contract's deployed bytecode >= 24576 (via the chained `contracts:size`).

---

## 8. Mint & Executor Auth Model (revised — GAPs 14, 28)

| Action | Signer | Pays gas | Target |
|---|---|---|---|
| `mintAgent` (Agentic ID) | DEPLOYER | DEPLOYER | Verified canonical AgenticID (GAP 25 — post-on-chain-verification) |
| `acceptProof` (shared proof registry) | DEPLOYER | DEPLOYER | ProofRegistry |
| `re-stake` `stakeLp` on V4 (migration) | EXECUTOR (+DEPLOYER `acceptProof`) | EXECUTOR | V4 LpEntry vault |
| Deploy `PolicyVaultV4LpEntry` | USER | USER | constructor does NOT self-register (Codex R7-REG) |
| Deploy `PolicyVaultV4LpExit` | USER | USER | constructor does NOT self-register; `lpEntry` immutable set at construction (Codex R7-REG) |
| Deploy `PolicyVaultV4Swap` | USER | USER | constructor does NOT self-register (Codex R7-REG) |
| `registry.registerLpEntry`/`registerLpExit`/`registerSwap(vault)` (Codex R7-REG — owner-called, unspoofable) | USER | USER | VaultRegistryV4 |
| `setLpExitVault` (one-time on LpEntry) | USER | USER | V4 LpEntry vault |
| `depositNative` (V4 Swap vault) | USER | USER | V4 Swap vault |
| `depositNative` (V4 Swap, post-migration — G-EXEC-8) | USER | USER | V4 Swap vault (and optionally V4 LpEntry if LP migration keeps LP native) |
| `depositNative` (V4 LpEntry vault — GAP 6) | USER | USER | V4 LpEntry vault |
| `withdrawNative` (V4 Swap/LpEntry/LpExit) | USER | USER | respective V4 vault |
| `rescueToken` (V4 Swap/LpEntry/LpExit) | USER | USER | respective V4 vault |
| `setAgentKeyEnabled` (per agent, per vault third) | USER | USER | ALL THREE V4 vaults |
| `setPaused` / `revokeExecutor` | USER | USER | ALL THREE V4 vaults (+ old) |
| `tightenPolicy` (base 6) | USER (client-side wagmi — GAP 28) | USER | V4 Swap vault |
| `tightenLpPolicy` (LP 7, tighten-only) | USER (client-side wagmi — GAP 28) | USER | V4 LpEntry vault |
| `disableToken`/`disablePool` | USER | USER | V4 Swap vault |
| `disableLpPool`/`disableStakeVault` (GAP 14) | USER | USER | V4 LpEntry vault |
| `addSweepPool`/`disableSweepPool` (GAP 14 — SIZE-2: sweep lives on LpExit) | USER | USER | V4 LpExit vault |
| `addSweepToken`/`disableSweepToken` (Codex 2.1 — LpExit-local token allowlist for sweepToken) | USER | USER | V4 LpExit vault |
| `tightenPairMinOutBps` | USER | USER | V4 Swap vault |
| `importLpNft` / `unstakeLpOwner` / `rescueNft` | USER | USER | V4 LpEntry (`importLpNft` + primary `rescueNft` — NFT stranded in LpEntry after failed import) / V4 LpExit (`unstakeLpOwner` + secondary `rescueNft` — NFT actually sent to LpExit) |
| `buy` / `sell` | EXECUTOR | EXECUTOR | V4 Swap vault |
| `zapInMintLp` / `zapInIncreaseLiquidity` / `stakeLp` | EXECUTOR | EXECUTOR | V4 LpEntry vault |
| `unstakeLp` / `zapOut` / `decreaseLiquidity` / `collectFees` / `burnLp` / `sweepToken` (SIZE-2: sweep moved to LpExit) | EXECUTOR | EXECUTOR | V4 LpExit vault |
| **Source-side owner actions on deployer-owned legacy vaults (GAP 14 — gated by GAP 12 inventory)** | **DEPLOYER** | DEPLOYER | V1/V3 source vault |
| Env flip | REMOVED | — | — |

> **GAP 28 FIX (mint-vault-selection rule):** for a V4 LP agent, `mintAgent` records the **V4 LpEntry vault** address (the NFT-custody half); for a swap-only agent, the **V4 Swap vault**. The on-chain recorded vault ref is informational (the executor resolves off-chain via `registry.vaultOf(owner)`), so no re-mint is needed for migration, but new mints MUST pass the correct half. This rule is added to §8 and §7.7.

> **GAP 14 correction:** the DEPLOYER signs source-side `withdrawNative`/`unstakeLpOwner`/`rescueNft` on deployer-owned V1/V3 singletons — but ONLY after the GAP 12 on-chain inventory gate asserts no non-deployer agent owns any position/NFT. There IS a window where native sits in the deployer EOA; resume is idempotent (§6.5).

---

## 9. Test Plan

Framework: `node:test` + `node:assert/strict`, viem via `network.create()`. Run `npx hardhat test` (V1/V2/V3 + AgenticID + adapter) AND `npx hardhat test --network hardhatMainnet` (V4 suites — uses the EXISTING `hardhatMainnet` network — GAP 29). Gate V4 suites on `network.name === "hardhatMainnet"`.

### 9.1 `D:\4lpha-0G\test\policy-vault-v4-swap.ts` + `policy-vault-v4-lp-entry.ts` + `policy-vault-v4-lp-exit.ts`

`deployFixture()` deploys: `ProofRegistry`, `AgenticID` (+ `MockAgentDataVerifier`), `MockZiaLpAdapterV4` (real bodies), `MockNfpm`, `MockZiaVault`, `MockWrappedNative`, `MockAssetToken`, `VaultRegistryV4`, `PolicyVaultV4LpEntry`, `PolicyVaultV4LpExit` (with `lpEntry` ref), `PolicyVaultV4Swap`, `setLpExitVault`; then the owner calls `registry.registerLpEntry/registerLpExit/registerSwap(vault)` for each third (owner-called — Codex R7-REG, NOT constructor self-registration).

**A.0 Size invariant (GAPs 20, 21, 22, 29):** `node scripts/check-contract-size.ts` and a unit test assert deployed bytecode < 24576 for `PolicyVaultV4Swap`, `PolicyVaultV4LpExit`, `VaultRegistryV4`, `ZiaLpAdapterV4` (EIP-170 hard cap); AND assert < 23000 for `PolicyVaultV4LpEntry` specifically (SIZE-1 conservative probe threshold — the binding constraint, forces >=1.5KB headroom). **GAP 21:** uses the native node script (NOT `hardhat size`/`hardhat-contract-sizer`). **GAP 23:** the probe runs with wrapper bodies PRESENT against `MockZiaLpAdapterV4`.

**A.1 V2 swap/admin regression:** A.1.1–A.1.12 as original. **A.1.13 (GAP 1/7) hash-encoding golden vectors:** pin a fixed `TradeRequest` and a fixed `LpActionRequest` with known expected keccak hashes. **Swap-vault `vaultActionHashFor` is V2/V3-identical** (swapAdapter `0xfaa8` unchanged). **LP-vault `vaultActionHashForLp` is a V4-own reference hash** (encoding drops `address(adapter)` — GAP 7). **GAP 7: `policyHash` per-vault golden-vector test** — pin Swap 6-field hash + LpEntry 7-field hash (NOT V3 13-field). `actionHashFor` identical. **A.1.14 (GAP 2) sell enforces cooldown:** sell within `cooldownSeconds` of a buy → `CooldownActive`. **A.1.15 (GAP 42) Swap-vault `receive()` test:** send native from `swapAdapter` (via mock adapter call) → accepted; from random address → `NotAllowed`; from owner → accepted.

**A.2 V3 LP regression:** A.2.1 `zapInMintLp` (`liquidity < minLiquidityFloor` → `LpLiquidityFloor`; refund-aware deployed native; **GAP 1: cooldown enforced — within `cooldownSecondsLp` → `LpCooldownActive`**). A.2.2 `stakeLp` (emit `Staged`; **GAP 1: cooldown enforced — within `cooldownSecondsLp` → `LpCooldownActive`**). A.2.3 `unstakeLp` (exit-lockup survives `disableStakeVault`; emit `Unstaked`). A.2.4 `unstakeLpOwner(uint256, address)` (emit `OwnerUnstaked`). A.2.5 `zapOut` (NFT burned, exposure 0, no ghost notional, survives `disableLpPool`; **GAP 2: `receive()` from `lpAdapter` accepted; A.2.5b: `receive()` from non-owner/non-lpAdapter → `NotAllowed`**). A.2.6 `claimRewards` on **LpExit** (REG-2 — selector lives on LpExit, not LpEntry) → unconditional revert `RewardsNotConfigured` (byte-identical to V3:1029-1034); assert calling on LpEntry has no such selector (ABI scan). A.2.7 view-parity (includes `poolAddressOf` — GAP 4; `agentLpNfts(bytes32,bytes32)` — GAP 8). A.2.8 `onERC721Received` returns `0x150b7a02`. **A.2.9 (GAP 1) zapInMintLp/stakeLp within cooldownSecondsLp reverts `LpCooldownActive`** (explicit — closes the §3.8 documentation defect with a test).

**A.3 V4 new LP functions (happy + every gate + delta + replay + deadline + proof):**
- A.3.1 `zapInIncreaseLiquidity` (3): happy; `LpTickMismatch`; `LpLiquidityFloor`; mins; caps; cooldown (GAP 1); agentKey disabled →`NotAllowed`; replay → `Replay`; delta mismatch (adapter returns wrong native consumed or wrong W0G refund) → `LpBadDelta`; `w0gRefund >= amount0Desired` → `LpBadDelta` (GAP 19); `w0gRefund > amount0Desired` → `LpBadDelta`; `liquidity < request.liquidity` → `LpBadDelta`; `amount0 < amount0Min` → `LpBadDelta`; `amount1 < amount1Min` → `LpBadDelta`; paused → `Paused`; executor revoked → `ExecutorIsRevoked`; `lpAdapter == address(0)` → `LpAdapterNotConfigured` (GAP 6); mock adapter in prod config → `AdapterBlocked`; deadline expired → `DeadlineExpired`; deadline > window → `DeadlineTooFar`; `policySnapshotHash != _policyHash(currentPolicy)` → `BadPolicy`; `vaultActionHash != vaultActionHashForLp(request)` → `BadParams`.

- A.3.2 `decreaseLiquidity` (4) — lives on **LpExit** (`onlyExecutor onlyExecutorNotRevoked lpAdapterConfigured nonReentrant`): happy — existing tokenId, `liquidity > 0 && <= lpAdapter.liquidityOf(tokenId)`, `amount0Min > 0 && amount1Min > 0`; pre-snapshot `totalLiq = lpAdapter.liquidityOf(tokenId)` (GAP 18); approve adapter for NFT; `lpAdapter.decreaseLiquidity` (calls `NFPM.collect` with recipient hard-pinned to vault → returns principal + accrued fees); delta: `balanceDelta0 >= amount0Min && balanceDelta1 >= amount1Min` (GAP 12 `>=` floor) AND `balanceDelta0 >= minLpOutFor(quotedAmount0) && balanceDelta1 >= minLpOutFor(quotedAmount1)` (GAP 10 bps floor); pro-rata `nativeFreed = lpEntry.lpNftDeployedNativeOf(tokenId) * liquidity / totalLiq`; `lpEntry.reduceLpDeployment(tokenId, nativeFreed)` reduces `openLpExposure0G` + `agentLpNotionalDeployed[agentKey]` by `nativeFreed` and reduces `lpNftDeployedNative[tokenId]` by `nativeFreed`; **KEEPS slots** (`lpNftOwner`/`lpNftPool`/`lpNftTicks` remain, tokenId stays in `agentLpNfts`) — G-01; NO cooldown (capital-returning); NO daily cap write; event with `-liquidity`. Failures: actionType != 4 → `InvalidActionType`; msg.value != 0 → `UnexpectedValue`; `lpEntry.lpNftOwnerOf(tokenId) != agentKey` → `NotAgentLpNft`; `lpEntry.lpNftPoolOf(tokenId) != poolId` → `PoolMismatch`; `liquidity == 0 || liquidity > totalLiq` → `InvalidLpAmount`; `amount0Min == 0 || amount1Min == 0 || quotedAmount0 == 0 || quotedAmount1 == 0` → `LpInvalidMinOut`; `amount0Min < minLpOutFor(quotedAmount0) || amount1Min < minLpOutFor(quotedAmount1)` → `LpInvalidMinOut` (GAP 10); stakeVault != 0 → `InvalidActionType`; agentKey disabled on LpExit → **still allowed** (exit-lockup — GAP 3/11); `revokeExecutor` on LpExit → `ExecutorIsRevoked` (hard kill); pause on LpExit → **still allowed** (GAP 2 — pause does not freeze exits); replay → `Replay`; delta mismatch → `LpBadDelta`; `lpEntry` immutable mismatch (should never happen) → `NotLpEntry`; `nativeFreed > lpNftDeployedNative` (pro-rata bounds) → assert `openLpExposure0G` never underflows (revert on underflow).

- A.3.3 `collectFees` (5) — lives on **LpExit** (`onlyExecutor onlyExecutorNotRevoked lpAdapterConfigured nonReentrant`): happy — tokenId owned by agentKey; `amount0Min > 0 && amount1Min > 0` (>= 1 wei — GAP 9/13); `stakeVault == 0 && liquidity == 0` else `InvalidActionType`; `lpAdapter.collectFees(MAX, MAX)` calls only `NFPM.collect(recipient=vault)` — NO swap, NO wrap, NO unwrap; delta: `balanceDelta0 >= amount0Min && balanceDelta1 >= amount1Min` else `LpBadDelta`; NO spend/exposure/notional/daily/cooldown writes; `usedActionHashes` written; event with 0 liquidity delta. **GAP 13 liveness constraint test:** assert `collectFees` reverts `LpBadDelta` when either fee side has 0 accrued (the >=1 wei floor cannot be met) — i.e. it is NOT usable on active/asymmetric positions; document that `decreaseLiquidity` is the PRIMARY fee-collection path. Failures: actionType != 5; msg.value != 0; tokenId ownership; pool mismatch; `amount0Min == 0 || amount1Min == 0` → `LpInvalidMinOut` (GAP 9 — no exception); `stakeVault != 0 || liquidity != 0` → `InvalidActionType`; agentKey disabled → **still allowed** (capital-returning yield — exit-lockup); replay → `Replay`; delta mismatch → `LpBadDelta`; adapter tries to swap/wrap/unwrap inside `collectFees` → adapter invariant test (C.2) rejects.

- A.3.4 `burnLp` (6) — lives on **LpExit** (`onlyExecutor onlyExecutorNotRevoked lpAdapterConfigured nonReentrant`): happy — pre-condition `lpAdapter.liquidityOf(tokenId) == 0 && lpEntry.lpNftDeployedNativeOf(tokenId) == 0` (run `decreaseLiquidity` first) else `LpPositionNotEmpty`; `stakeVault == 0 && liquidity == 0`; `_burnSideOk(quotedAmount0, amount0Min) && _burnSideOk(quotedAmount1, amount1Min)` (restored from `.bak`: `if (quoted==0) return minOut==0; return minOut>0 && minOut>=minLpOutFor(quoted)`); single NFT approval covers collect+burn; `lpAdapter.collectFees(MAX, MAX)` then `lpAdapter.burnLp(tokenId)`; delta: NFPM balance-of-vault drops by exactly 1 else `LpBadDelta`; token0/token1 deltas >= returned; `lpEntry.purgeLpNft(tokenId)` removes tokenId from `agentLpNfts` and deletes `lpNftOwner`/`lpNftPool`/`lpNftTickLo`/`lpNftTickUpper`/`lpNftDeployedNative` slots; ONLY callable when `lpAdapter.liquidityOf(tokenId)==0` (G-01); NO exposure/daily writes (already reconciled at decrease time). Failures: `liquidityOf(tokenId) != 0 || lpNftDeployedNativeOf(tokenId) != 0` → `LpPositionNotEmpty`; `_burnSideOk` false (quoted>0 but minOut==0 or minOut < minLpOutFor(quoted)) → `LpInvalidMinOut`; `stakeVault != 0 || liquidity != 0` → `InvalidActionType`; agentKey disabled → **still allowed** (exit-lockup); replay → `Replay`; NFPM balance delta != 1 → `LpBadDelta`; token deltas != returned → `LpBadDelta`.

- A.3.5 `sweepToken` (9) — lives on **LpExit** (`onlyExecutor onlyExecutorNotRevoked lpAdapterConfigured nonReentrant`) — SIZE-2 moved from LpEntry; custody conversion, exit-style, **NO cooldown** (GAP 1 — sweep is NOT rate-limited); agentKey disabled → still allowed (sweep is keeper hygiene, capital-returning — GAP 3/11); paused on LpExit → still allowed (GAP 2 — pause does not freeze exits); executor revoked → `ExecutorIsRevoked`. Happy (native out) — `tokenId == 0 && stakeVault == 0`; `tokenIn != 0 && allowedSweepTokens[tokenIn]` (Codex 2.1 — LpExit-local); `tokenOut == NATIVE_TOKEN`; `amount0Desired > 0 && amount1Min > 0 && quotedAmountOut > 0 && amount1Min >= minLpOutFor(quotedAmountOut)`; `tickLower==0 && tickUpper==0 && liquidity==0 && amount1Desired==0`; **GAP 14: `allowedSweepPools[poolId]` required** (separate sweep-route allowlist on LpExit, NOT `allowedLpPools`); `_markLpAction`; forceApprove tokenIn to adapter; `lpAdapter.sweepToken`; forceApprove back to 0; delta: tokenIn delta == amount0Desired, native delta >= amount1Min && >= amountOut else `LpBadDelta`; NO `lastLpActionAt` write (no cooldown); NO spend/exposure/daily write (sweep of stray tokens, not native deploy); event with amountOut. Happy (token out) — `tokenOut` allowlisted (not NATIVE); `tokenOutDelta >= amount1Min && >= amountOut`. Failures: actionType != 9; msg.value != 0; `tokenId != 0 || stakeVault != 0 || tokenIn == 0 || !allowedSweepTokens[tokenIn] || !(tokenOut == NATIVE_TOKEN || allowedSweepTokens[tokenOut])` → `NotAllowed` (Codex 2.1 — LpExit-local `allowedSweepTokens`); `!allowedSweepPools[poolId]` → `NotAllowed` (GAP 14); `amount0Desired == 0 || amount1Min == 0 || quotedAmountOut == 0 || amount1Min < minLpOutFor(quotedAmountOut)` → `LpInvalidMinOut`; `tickLower != 0 || tickUpper != 0 || liquidity != 0 || amount1Desired != 0` → `InvalidActionType`; agentKey disabled → **still allowed** (sweep is keeper hygiene, capital-returning — GAP 3/11); paused on LpExit → **still allowed** (GAP 2 — pause does not freeze exits); executor revoked → `ExecutorIsRevoked`; replay → `Replay`; delta mismatch → `LpBadDelta`; `lpAdapter == address(0)` → `LpAdapterNotConfigured` (GAP 6); `amountOut < amountOutMin` → `LpBadDelta` / adapter `SlippageExceeded`.

- A.3.6 (GAP 1 cross-cutting) — explicit cooldown-enforced test on every deploying/entry LP action: `zapInMintLp`, `zapInIncreaseLiquidity`, `stakeLp` each within `cooldownSecondsLp` of the prior deploying action → `LpCooldownActive`; at `cooldownSecondsLp + 1` → passes. Exits (`decreaseLiquidity`/`collectFees`/`burnLp`/`unstakeLp`/`zapOut`/`sweepToken`) each within cooldown → **pass** (capital-returning, no cooldown — SIZE-2: sweep is exit-style on LpExit, NOT rate-limited).

### A.4 V4 LP exit-lockup invariants (Codex high-sev fix — must hold across all 5 new functions)

| # | Test | Expected |
|---|---|---|
| A.4.1 | `disableLpPool` after mint → `zapInIncreaseLiquidity` for that pool blocked (`InvalidLpPool` ENTRY); `decreaseLiquidity`/`collectFees`/`burnLp` for the existing position on that pool still pass (EXIT by recorded `lpNftPool[tokenId]`) |
| A.4.2 | `disableStakeVault` after stake → new `stakeLp` to that vault blocked; `unstakeLp`/`unstakeLpOwner` of existing staked NFT still pass |
| A.4.3 | `setAgentKeyEnabled(false)` on LpEntry after mint → `zapInIncreaseLiquidity`/`stakeLp` blocked (`NotAllowed`); `decreaseLiquidity`/`collectFees`/`burnLp`/`zapOut`/`unstakeLp`/`sweepToken` on LpExit still pass (exits skip the agentKey check — GAP 3/11; `sweepToken` on LpExit — exits skip agentKey (GAP 3/11), sweep not blocked by LpEntry agentKey disable — SIZE-2) |
| A.4.4 | `setPaused(true)` on LpEntry → all ENTRY LP blocked; `setPaused(true)` on LpExit → exits **still pass** (GAP 2 — pause does not freeze exits; only `revokeExecutor` is the hard kill). Assert an LP exit passes while LpExit is paused. |
| A.4.5 | `revokeExecutor` on either LpEntry or LpExit → ALL LP on that third blocked (executor is the only caller). `revokeExecutor` on LpExit blocks exits (the hard kill — GAP 2). |
| A.4.6 (GAP 4 — tighten non-atomicity) | Issue `tightenPolicy` on Swap but NOT `tightenLpPolicy` on LpEntry mid-sequence; assert a compromised executor cannot exceed either the old or new swap cap (tighter binds) AND cannot exceed the unchanged LP cap. Partially-tightened state is still safe. |

### A.5 Owner recovery paths on LP vaults (GAP 6/8/33)

| # | Test | Expected |
|---|---|---|
| A.5.1 | LpEntry `depositNative` (owner) → `Deposited`; `withdrawNative` (owner) → `NativeWithdrawn`; executor → `NotOwner` |
| A.5.2 | LpExit `withdrawNative` (owner) recovers native from `zapOut`/`sweepToken`-native-out; `rescueToken` (owner) recovers ERC20 from `collectFees`/`decreaseLiquidity`; executor → `NotOwner` |
| A.5.3 | `rescueNft` on **LpEntry** (owner) recovers an NFT stranded in the V4 LpEntry vault after a failed `importLpNft` (GAP 24 loss-of-funds recovery) — call `lpEntry.rescueNft(tokenId, owner())` (`to` arg hard-pinned to owner per §3.7.2); assert NFT returns to owner wallet. Separately assert `lpExit.rescueNft(uint256)` only fires when `NFPM.ownerOf(tokenId)==LpExit` (G-03 — secondary, NFT actually lands on LpExit). |
| A.5.4 | Recovery works after `revokeExecutor` (owner paths are `onlyOwner`, no executor gate). |

---

## B. AGENTS.md 12 required vault security tests — mapped to V4

| # | Required | V4 test case | Concrete assertion |
|---|---|---|---|
| 1 | Executor cannot withdraw | `policy-vault-v4-swap.ts` §B.1 + `policy-vault-v4-lp-exit.ts` §B.1 | executor calls `withdrawNative` on Swap → `NotOwner`; on LpEntry → `NotOwner`; on LpExit → `NotOwner`; executor calls `rescueToken` on any third → `NotOwner`; executor calls `unstakeLpOwner` on LpExit → `NotOwner`; executor calls `rescueNft` on LpEntry (primary — NFT stranded in LpEntry after failed `importLpNft`, G-03) → `NotOwner`; executor calls `rescueNft` on LpExit (secondary — NFT actually lands on LpExit) → `NotOwner`; executor calls `importLpNft` on LpEntry → `NotOwner` |
| 2 | Executor cannot arbitrary-call | §B.2 ABI scan | `grep -E 'delegatecall|\.call\(|\.call\{|assembly|staticcall|multicall' contracts/*.sol` returns nothing in the V4 vaults (only typed external CALLs to immutable `swapAdapter`/`lpAdapter`/`lpEntry`; the broadened pattern catches `.call{value:}(`); no `execute(address,bytes)`/`multicall`/`transfer(recipient,amount)` selector in any V4 vault ABI. **(B2-grep-fidelity, GAP-T8):** Additionally, deploy each V4 vault (Swap/LpEntry/LpExit) and assert the deployed bytecode (`eth_getCode`) does NOT contain the 4-byte selectors `execute(address,bytes)` (`0x1cff79cd`), `multicall(bytes[])` (`0xac9650d8`), `transfer(address,uint256)` (`0xa9059cbb`), or a fallback that forwards calldata — scan deployed bytecode for each selector literal. **Manual review note:** any `.call{value:}` recipient must be one of `{owner(), address(this), address(lpAdapter)}`. |
| 3 | Executor cannot select arbitrary recipient | §B.3 | no function in any V4 vault ABI takes a `recipient`/`to`/`target` argument that routes funds; `sweepToken` recipient hard-pinned to `address(this)` (LpExit vault); `collectFees` recipient hard-pinned to vault; `zapOut` recipient hard-pinned to LpExit vault; `decreaseLiquidity` recipient hard-pinned to vault; LpExit→LpEntry accounting callbacks are typed calls to a fixed immutable `lpEntry` address, gated `onlyLpExit` — NOT executor-controlled |
| 4 | Zero min-out / zero slippage rejected (NO exception — GAP 9) | §B.4 | `buy`/`sell` `amountOutMin == 0` → revert; `zapInMintLp` `amount0Min == 0` → `LpInvalidMinOut`; `zapInIncreaseLiquidity` `amount0Min == 0 || amount1Min == 0` → `LpInvalidMinOut`; `decreaseLiquidity` `amount0Min == 0 || amount1Min == 0` → `LpInvalidMinOut` (GAP 10 bps floor also enforced); `collectFees` `amount0Min == 0 || amount1Min == 0` → `LpInvalidMinOut` (GAP 9/13 — >= 1 wei, NO exception); `burnLp` `_burnSideOk` with `quoted > 0 && minOut == 0` → `LpInvalidMinOut`; `sweepToken` `amount1Min == 0` → `LpInvalidMinOut`; `zapOut` `amountOutMin == 0` → revert. Floor is `>0 && >= minLpOutFor(quoted)` everywhere. **(G-06-B4-positive — the single documented AGENTS.md exception):** `burnLp` `_burnSideOk` with `quoted==0` on a side AND `minOut==0` on that side → passes (zero expected output, no slippage surface); assert both sides independently (mixed `quoted>0` / `quoted==0` case). |
| 5 | Daily cap + per-trade cap cannot be bypassed | §B.5 | Swap: `perTradeCap=0.5, dailyCap=1.0`; two 0.5 buys pass; third → `DailyCapExceeded`; single 0.6 → `CapExceeded` (V2 error name preserved — GAP 5). LP: `perLpActionCap=0.5, lpDailyCap=1.0`; same matrix on `zapInMintLp` + `zapInIncreaseLiquidity` + `importLpNft` (GAP 13/18 — import consumes the per-user `lpDailyCap0G` rolling-24h window ONCE at import). Cross-window reset: `time.increase(86400)` → spent resets to 0. **V3 global-singleton lockout hazard preserved as documented behavior:** tightening `lpDailyCap` below current `lpDailySpent0G` locks all agents out until the rolling 24h window elapses; V4 test asserts the lock-out (now per-user, not global — V4 corrects the V3 defect). `importLpNft` daily-cap headroom pre-flight: total preservation notional > seeded `lpDailyCap0G` → orchestrator ABORT (GAP 18 fail-fast). |
| 6 | Cooldown cannot be bypassed | §B.6 | Swap cooldown 60s: buy at t=0 passes; buy at t=30 → `CooldownActive`; buy at t=61 passes; sell enforces cooldown (V2/V3 parity — GAP 1). LP cooldown 60s: `zapInMintLp` at t=0; `zapInIncreaseLiquidity` at t=30 → `LpCooldownActive`; at t=61 passes; `stakeLp` also cooldown-enforced (GAP 1); `sweepToken` exempt (SIZE-2: exit-style on LpExit, NO cooldown). **Exits bypass cooldown:** `decreaseLiquidity`/`collectFees`/`burnLp`/`zapOut`/`unstakeLp`/`sweepToken` each pass within the cooldown window — assert each. |
| 7 | Reentrancy blocked | §B.7 | Deploy `ReenteringAdapter`/`ReenteringZiaLpAdapter` that re-enters `buy`/`sell`/`zapInMintLp`/`zapInIncreaseLiquidity`/`stakeLp`/`sweepToken`/`unstakeLp`/`zapOut`/`decreaseLiquidity`/`collectFees`/`burnLp` from the adapter callback → blocked by `nonReentrant` on every entrypoint; assert no double-spend. Test ALL entrypoints (V2/V3 only tested `buy`). Deploy `ReenteringFactory` that re-enters `registerSwap`/`registerLpEntry`/`registerLpExit` → blocked (registry has no `nonReentrant` but owner-called auth `IOwnable(vault).owner()==msg.sender` + `AlreadyRegistered` on a non-zero slot prevents grief/spoof — Codex R7-REG; no overwrite semantics needed). |
| 8 | Malicious ERC20 handled/rejected | §B.8 + new `MaliciousERC20.sol` | (a) As tokenOut of `buy`: reenter-on-receive → `nonReentrant` blocks. (b) As tokenIn of `sweepToken`: `balanceOf` lie (first call returns X, second returns X+delta) → `LpBadDelta` revert. (c) As paired LP token: `balanceOf` lie after `zapInMintLp` → delta check reverts. (d) Fee-on-transfer token: delta check catches the shortfall. Assert vault never credits more than actual balance delta. |
| 9 | Malicious adapter cannot drain | §B.9 + new `DrainingAdapter.sol` + `MaliciousZiaLpAdapterV4.sol` | (a) `MaliciousAdapter` (no-delta, from V1) → `buy` reverts on delta. (b) `DrainingAdapter` returns huge `amountOut` but sends nothing → `BadDelta` revert. (c) `MaliciousZiaLpAdapterV4` calls back into vault `withdrawNative` from within `zapInMintLp` → `nonReentrant` blocks. (d) Adapter that lies on `liquidityOf` to make `decreaseLiquidity` over-release exposure → pro-rata math bounds `nativeFreed <= lpNftDeployedNative[tokenId]`; assert `openLpExposure0G` never underflows (revert on underflow). (e) Adapter that returns fake `(liquidity, amount0, amount1)` and transfers nothing on `zapInMintLp` → `LpBadDelta`. (f) `MaliciousZiaLpAdapterV4` on `sweepToken` (native-out) returns fake large `amountOut`, transfers nothing → `LpBadDelta` (tokenIn delta vs native delta). (g) on `collectFees` returns fake `(amount0, amount1)`, transfers nothing → `LpBadDelta`. (h) on `burnLp` returns owed amounts but does not burn / NFPM balance-of-vault delta != 1 → `LpBadDelta`. (i) on `zapOut` returns fake `nativeOut`, sends nothing → `LpBadDelta`. (j) on `zapInIncreaseLiquidity` returns fake `liquidity` and transfers nothing → `LpBadDelta`. (k) `DrainingAdapter`-style on `sell` (huge `amountOut`, sends nothing) → `BadDelta`. Every case asserts the vault never credits more than the actual balance delta. **GAP 37 (per-entrypoint coverage):** each of (a)-(k) names the entrypoint it runs against so the delta-check defense is proven on ALL entrypoints across all three thirds, not just `buy`. |
| 10 | Admin cannot move user funds | §B.10 | (a) Deployer (not owner, not depositor) calls `withdrawNative` on any third → `NotOwner`. (b) Deployer calls `rescueToken` on a vault-held asset → `NotOwner`. (c) Deployer calls `unstakeLpOwner`/`rescueNft`/`importLpNft` → `NotOwner`. (d) Deployer calls `tightenPolicy` to set `perTradeCap=0` (effectively freezing) → allowed (admin may tighten), but assert deployer STILL cannot withdraw the frozen funds. (e) Deployer calls `setPaused(true)` + `revokeExecutor` (allowed — admin may pause/revoke) but assert deployer cannot move funds while paused/revoked. (f) Registry has no admin role — `registerSwap`/`registerLpEntry`/`registerLpExit` are permissionless self-serve keyed by `msg.sender`. (g) Assert no admin-named function in any V4 ABI can move native/ERC20/NFT out of the vault to any address other than the owner. |
| 11 | Mock adapter rejected in prod config (GAP 14) | §B.11 | deploy V4 Swap with `allowMockAdapter=false` → buy via `MockDexAdapter` → `AdapterBlocked`. deploy V4 LpEntry/LpExit with `allowMockLpAdapter=false` → LpEntry-side `zapInMintLp`/`zapInIncreaseLiquidity`/`stakeLp` AND LpExit-side `unstakeLp`/`zapOut`/`decreaseLiquidity`/`collectFees`/`burnLp`/`sweepToken` (SIZE-2: sweep lives on LpExit) via `MockZiaLpAdapterV4` → `AdapterBlocked`. Deploy with `allowMockAdapter=true` AND `block.chainid != 16661` → all pass (test-only). Deploy with `allowMockAdapter=true` AND `block.chainid == 16661` (mainnet) → `AdapterBlocked` (contract-level rejection regardless of flag — byte-identical to V3:327-343). **(GAP-T7 — evm_setChainId mechanism):** Set chainid via `await network.provider.request({method:'evm_setChainId', params:['0x40e5']})` (16661) on a NON-forked `hardhatMainnet` EDR instance (if `MAINNET_FORK_RPC_URL` is set, chainid is already 16661 — assert `chainid==16661` before the call, step is a no-op); deploy V4 Swap with `allowMockAdapter=true`; assert `buy` via `MockDexAdapter` reverts `AdapterBlocked` (contract-level `chainId==16661` check, independent of `ENABLE_MOCK_DEX_ADAPTER` flag). |
| 12 | V4 new LP functions cannot bypass LP caps/cooldown/exposure | §B.12 | (a) `zapInIncreaseLiquidity` over `perLpActionCap` → `LpCapExceeded`. (b) `zapInIncreaseLiquidity` over `lpDailyCap` → `LpDailyCapExceeded`. (c) `zapInIncreaseLiquidity` over `maxLpExposure` → `LpExposureExceeded`. (d) `zapInIncreaseLiquidity` within cooldown → `LpCooldownActive` (GAP 1). (e) `decreaseLiquidity` cannot release more than `lpNftDeployedNative[tokenId]` (pro-rata bounded; assert `openLpExposure0G` never underflows). (f) `sweepToken` does NOT count against LP daily cap (stray tokens, not deploy) — assert `lpDailySpent0G` unchanged. (g) `collectFees` does NOT count against exposure or daily cap (yield, not capital). (h) `burnLp` after partial `decreaseLiquidity` does NOT double-release exposure (already reconciled at decrease). (i) `importLpNft` consumes `lpDailyCap0G` ONCE at import (GAP 13/18) and enforces `perLpActionCap`/`maxLpExposure` — assert a too-large `deployedNative0G` import reverts `LpCapExceeded`/`LpExposureExceeded`. (l) partial-decrease roster preservation (G-01 core invariant): after `decreaseLiquidity` with liquidity < totalLiq, assert tokenId is STILL present in `lpEntry.agentLpNfts(agentKey, poolId)` AND `lpEntry.lpNftOwner(tokenId)==agentKey` AND `lpNftDeployedNative[tokenId] == original - nativeFreed` (reduceLpDeployment keeps slots); then a subsequent `zapInIncreaseLiquidity` on the same tokenId succeeds, and a subsequent full `zapOut` redeems the residual and purges (G-01-B12-noorphan, GAP-T9). |
| 13 | Shared-executor cross-user blast radius (R8 — backs the R8 mitigation, GAP 41) | §B.13 | Deploy 3 independent V4 vault trios (3 distinct owners) sharing the SAME immutable `executor` (the shared `VAULT_EXECUTOR_PRIVATE_KEY`); each Swap vault seeded with 1 0G and `perTradeCap=0.05, dailyCap=0.1, cooldown=30s`. Compromise the executor key; fire `buy` at `perTradeCap` on all 3 Swap vaults within the same block. Assert: (a) each buy is bounded by its OWN vault's `perTradeCap`/`dailyCap`/`cooldown` — no cross-vault accounting leakage; (b) the cooldown blocks a second buy on each vault within 30s; (c) each owner's user-signed `revokeExecutor` blocks subsequent buys on THEIR vault only (other users unaffected); (d) aggregate loss == sum of per-vault caps, NOT a full drain; (e) each owner's `withdrawNative` recovery path works after their own revoke. This proves the per-vault isolation under a shared compromised executor. **(LP-entry isolation — G-04-B13-lp-entry, GAP-T6):** fire `zapInMintLp` at `perLpActionCap` on all 3 LpEntry vaults within the same block; assert (a) each LpEntry vault's `lpDailySpent0G`/`openLpExposure0G`/`agentLpNotionalDeployed[agentKey]` reflects ONLY its own `zapInMintLp` — no cross-vault state leakage; (b) the LP cooldown blocks a second `zapInMintLp` on each LpEntry within `cooldownSecondsLp`; (c) each owner's `revokeExecutor` blocks subsequent LP entries on their LpEntry only. |

---

## C. Adapter tests — `D:\4lpha-0G\test\zia-lp-adapter-v4.ts`

Standalone test of the real `ZiaLpAdapterV4.sol` against `MockNfpm` + `MockWrappedNative` + `MockSwapRouter` + `MockUniswapV3Pool` so the real adapter bodies run.

### C.1 The 5 new functions (happy + fail)

| # | Function | Happy-path | Failure variant |
|---|---|---|---|
| C.1.1 | `zapInIncreaseLiquidity` | pulls W0G, single `exactInputSingle` W0G→paired, `NFPM.increaseLiquidity` on existing tokenId, returns `(liquidity, amount0, amount1)`, refunds unused W0G, approvals revoked | tokenId not owned by caller (vault) → revert; pool mismatch → revert; `amount0G == 0` → revert; deadline expired → revert; swap returns < amount0Min → revert |
| C.1.2 | `decreaseLiquidity` (GAP 12) | `NFPM.decreaseLiquidity` then `NFPM.collect(CollectParams{recipient: msg.sender, MAX, MAX})` → transfers principal + accrued fees to vault; returns `(amount0, amount1)`; no swap/unwrap/burn | `liquidity == 0` → revert; `liquidity > position liquidity` → revert; recipient hard-pinned to `msg.sender` (no recipient arg exists) |
| C.1.3 | `collectFees` (GAP 9/13/30) | `NFPM.collect(recipient=msg.sender, MAX, MAX)` only; MUST NOT swap, wrap, or unwrap; returns `(amount0, amount1)` | tokenId not owned by msg.sender → revert; recipient hard-pinned, no arg; assert adapter does NOT call SwapRouter/W0G in this path |
| C.1.4 | `burnLp` | reverts if `liquidityOf != 0`; then `NFPM.collect(MAX, MAX)` then `NFPM.burn(tokenId)`; returns owed amounts | position not drained → revert; burn of tokenId not owned → revert |
| C.1.5 | `sweepToken` (GAP 14) | native-out: `forceApprove(tokenIn, SWAP_ROUTER)`, `exactInputSingle(tokenIn→W0G, recipient=adapter)`, `W0G.withdraw(w0gTotal)`, `safeTransferNative(msg.sender, amountOut)`; enforces `amountOutMin` on final native delta; if `amountOut < amountOutMin` → `SlippageExceeded`. token-out: `exactInputSingle(tokenIn→tokenOut, recipient=msg.sender)`. | tokenIn/tokenOut not allowlisted → revert; `amountOutMin` not met → `SlippageExceeded`; deadline expired → revert |

### C.2 Invariant tests (no arbitrary call/delegatecall/multicall — GAP 35)

| # | Test |
|---|---|
| C.2.1 | `grep -E 'delegatecall|\.call\(|assembly|multicall|staticcall' contracts/ZiaLpAdapterV4.sol` returns nothing (only typed external CALLs to NFPM/SwapRouter/W0G) |
| C.2.2 | Every token/native recipient in the adapter is hard-pinned to `msg.sender` (the vault). Assert via source read + a test that deploys the adapter behind a mock vault and checks `msg.sender` is the recipient in every path (5 new functions + the 2 shipped ones). |
| C.2.3 | Adapter never holds residual tokens post-call: after each of the 5 new functions + the 2 shipped ones, assert adapter W0G/paired/native balance == 0 (refunds swept). |
| C.2.4 | `lpAdapterKind()` returns `keccak256("4LPHA_0G_ZIA_LP_ADAPTER")`; `wrappedNative()`/`nfpm()`/`poolTokens()`/`liquidityOf()`/`positionTicks()`/`ownerOf()` all return configured values. |
| C.2.5 | `increaseLiquidity` is present in the inline `INonfungiblePositionManager` interface (V3 defect — closed). |

---

## D. Registry/factory tests — `D:\4lpha-0G\test\vault-registry-v4.ts`

`VaultRegistryV4` replaces the `new`-factory (the V3 factory deployed bytecode is 28766B / 28.77KB — over the 24576B cap by ~4.2KB — GAP 24). Gate the whole suite on `network.name === "hardhatMainnet"` (the V3 factory exceeds EIP-170; V4 registry does not, but keep the gate for parity with the V3 test harness — GAP 29).

| # | Test | Expected |
|---|---|---|
| D.1 | `registerSwap(vault)` called by the vault's owner (`msg.sender == Ownable(vault).owner()`) | `swapVaultOf[msg.sender] == vault`; emits `SwapVaultRegistered(msg.sender, vault, 4)`; `VERSION()==4` (Codex R7-REG: owner-called, NOT self-registration) |
| D.2 | `registerLpEntry`/`registerLpExit` symmetric | `lpEntryVaultOf[owner]`/`lpExitVaultOf[owner]` set; events emitted |
| D.3 | `vaultOf(owner)` | returns `(swap, lpEntry, lpExit)` tuple; `address(0)` for unregistered thirds |
| D.4 | one-vault-per-owner: second `registerSwap` from a real vault whose `owner()==owner` | revert `AlreadyRegistered(owner, existing)` |
| D.5 | **GAP 10 spoof/grief vector (Codex R7-REG owner-called):** attacker deploys `FakeVault` whose `owner()` returns `victim`; calls `registerSwap(fakeVault)` from the attacker EOA → reverts `NotVaultOwner(attacker, fakeVault)` (`msg.sender == attacker != IOwnable(fakeVault).owner() == victim`). `swapVaultOf[victim]` stays `address(0)` — `vaultOf(victim)` returns `(0,0,0)`. Victim deploys real `PolicyVaultV4Swap` then calls `registerSwap(swapVault)` (owner-called, `msg.sender == victim`) → `swapVaultOf[victim] == swapVault`. Assert the victim's real vault resolves and the fake never registered. |
| D.6 | **GAP 10 read-time re-verification:** `vaultOf(victim)` re-verifies `IOwnable(storedVault).owner()==victim` on read; if a stored vault's owner has changed (e.g. ownership transferred away), the entry is silently treated as `address(0)`. Assert: transfer ownership of a registered vault away from `owner` → `vaultOf(owner)` returns `address(0)` for that third. |
| D.7 | `registerSwap(fakeVault)` from an attacker (`msg.sender != Ownable(fakeVault).owner()`) | revert `NotVaultOwner(msg.sender, fakeVault)` — spoof blocked at registration (Codex R7-REG) |
| D.8 | permissionless self-serve: user deploys all three thirds via wagmi `deployContract` (EOA = `initialOwner`), then calls `registry.register*(vault)` for each (owner-called) | no deployer role required; no admin setter on the registry; registration is owner-authorized (Codex R7-REG) |
| D.9 | reentrancy grief guard + fake-pre-registration spoof: `FakeVault` whose `owner()` returns the victim — attacker calls `registerSwap(fakeVault)` | reverts `NotVaultOwner(attacker, fakeVault)` (msg.sender == attacker != victim); `vaultOf(victim)` returns `(0,0,0)` until the victim registers their own real vault — spoof + grief both impossible (Codex R7-REG BLOCKER closed) |
| D.10 | V1/V2/V3 vaults cannot be registered as V4 in practice (V4 registry auth is `IOwnable(vault).owner()==msg.sender` owner-called — Codex R7-REG; a V1/V2/V3 vault's `owner()` is the user, so the user COULD register a V3 vault, but the registry does NOT enforce version — the resolver only consults the V4 registry for V4 routing, so a V3 vault registered as V4 would be a no-op for V3 ops). Documented: registry is version-blind; version routing is the resolver's job. |
| D.11 | `swapVaultOf`/`lpEntryVaultOf`/`lpExitVaultOf` public getters return the raw stored address (NOT re-verified — the re-verification is only on `vaultOf`); assert the raw getter returns the stored address even if ownership changed. Documented intentional: the tuple `vaultOf` is the source of truth. |
| D.12 | **onlyLpExit access-control gate (GAP 22/38 — replaces every `D.x` placeholder):** for each `onlyLpExit`-gated member on LpEntry (`reduceLpDeployment(uint256 tokenId, uint256 nativeFreed)`, `purgeLpNft(uint256 tokenId)`, `markUnstaked(bytes32 agentKey, uint256 tokenId, address stakeVault)`, and any onlyLpExit-gated view (`lpNftOwnerOf`/`lpNftPoolOf`/`lpNftTicksOf`/`lpNftDeployedNativeOf`/`isStaked`)), call it from (a) the owner → revert `NotLpEntry`/`LpEntryMismatch`; (b) the executor → revert; (c) a random non-LpExit address → revert; (d) the configured `lpExitVault` immutable → succeeds. Assert the 4-case matrix for every gated member. This proves the access control (A.3.2/A.3.4 only exercise the happy-path callback from the legitimate LpExit, NOT the rejection). |

---

## E. Migration tests — `D:\4lpha-0G\test\vault-migrate-v4.ts`

Three migration paths (V1→V4, V2→V4, V3→V4), each with pre-state snapshot, post-state asserts, idempotent re-run, partial-resume (kill after step N), and lossless postcondition. Uses the proven idempotent pattern from `vault-migrate.ts:395-504`.

### E.1 Common fixture

Deploy a V4 vault trio (`PolicyVaultV4LpEntry` + `PolicyVaultV4LpExit` + `PolicyVaultV4Swap`, `setLpExitVault` one-time) + a "donor" vault (V1, V2, or V3) funded with native + (for V3) an LP NFT + staked NFT. Snapshot: donor native balance, donor token balances, donor LP NFT `ownerOf`/`lpNftOwner`/`lpNftPool`/`lpNftTickLower`/`lpNftTickUpper`/`lpNftDeployedNative`, `agentLpNotionalDeployed[agentKey]`, `openLpExposure0G`, agentKey enabled state, registry entry pointing at donor. The orchestrator state file records per-step completion.

### E.2 V1 → V4

| # | Step | Assertion |
|---|---|---|
| E.2.1 | pre-snapshot | donor.vault.balance == 1 0G; `Ownable(donor).owner()` resolved (deployer-owned-source vs user-owned-source dispatch); `agentKeyEnabled[donor][agentKey]` state recorded |
| E.2.2 | **GAP 12 inventory gate** (if deployer-owned-source) | assert every `positionUnits[token]` maps to a deployer-owned agent; if any non-deployer agent has a position → HALT, require user-signed exit. Record the gate result in the state file. |
| E.2.3 | rescue-sell token positions (V1-specific; DROP "re-enable agentKey on V1" — V1 has no such function) | DEPLOYER `acceptProof` + EXECUTOR `sell` via `executeCuratedTrade`; postcondition `positionUnits[token]==0 && ERC20(token).balanceOf(vault)==0`. **GAP 19:** if rescue-sell fails (pool disabled, cooldown active, token delisted), surface `rescueToken(X, balance)` manual fallback. |
| E.2.4 | `assertLegacyVaultIsNativeOnly` gate | donor vault holds only native + 0 token balances |
| E.2.5 | source owner action: `withdrawNative(v1Balance)` on V1 | DEPLOYER signs if deployer-owned-source (and GAP 12 gate passed); USER signs if user-owned. Record `withdrawnAmount0G` + `withdrawTxHash`. |
| E.2.6 | deploy V4 trio (USER wagmi `deployContract`) + register each | LpEntry → LpExit(passing `lpEntry`) → Swap; `setLpExitVault` one-time; USER calls `registry.registerLpEntry/registerLpExit/registerSwap(vault)` for each (owner-called — Codex R7-REG, NOT self-registration) |
| E.2.7 | native hop (idempotent — GAP 15) | if deployer==V4 owner, DEPLOYER `depositNative{value: v1Balance}` on V4 Swap; else deployer transfers raw native to user EOA and USER signs `depositNative`. On resume, skip if V4 Swap balance >= `withdrawnAmount0G - reserve`; re-deposit any EOA residual. Record `depositTxHash`. |
| E.2.8 | enable agent keys on ALL THREE V4 vaults (USER, per agent) | `setAgentKeyEnabled(agentKey, true)` on Swap + LpEntry + LpExit. **GAP 17:** on resume, read `agentKeyEnabled` on-chain per vault third; if true, skip broadcast. |
| E.2.9 | server re-points `mainnet-agents.json` idempotently | `swapVault`/`lpEntryVault`/`lpExitVault` from registry; `migratedFromVault` stamped; `vaultVersion=4`; on-chain-verified `agentKeyEnabled:true` per agent per vault third. **GAP 27:** record `identityAddress` per agent. JSON re-point is a no-op if `vaultVersion==4` and addresses already match. |
| E.2.10 | retire V1: `setPaused(true)` + `revokeExecutor()` | **GAP 19:** record `v1Retired:true` as a hard postcondition gate. |
| E.2.11 | post-state asserts | donor.balance == 0 (within `WITHDRAW_RESIDUAL_TOLERANCE_0G`); v4 Swap.balance == 1 0G; `agentKeyEnabled` on all three V4 vaults == true; `registry.vaultOf(owner)` == (v4Swap, v4LpEntry, v4LpExit); `migratedFromVault` stamped; `v1Retired==true` |
| E.2.12 | idempotent re-run | second `migrateV1ToV4` no-op: no double-withdraw (donor.balance already 0), no double-deposit (v4 already funded), no double registry flip (already v4), no double agentKey enable (already true), no double retire (already retired) |
| E.2.13 | partial-resume | kill after `withdrawNative` (donor drained, v4 not yet funded); resume → fund v4, enable keys, flip registry, retire V1; reach same end state as E.2.11 |
| E.2.14 | lossless | total native preserved: donor.balance_before == v4.balance_after + gas (gas paid by DEPLOYER, not donor — assert donor never paid gas); no tokens lost |
| E.2.15 | failure: V1 vault with zero balance | skip-withdraw, skip-deposit, registry still flips (or skip entirely — assert documented behavior) |
| E.2.16 | failure: V1 vault with executor not revoked | migrate still works (executor has no withdraw power — owner-only); assert executor cannot intercept the migration |

### E.3 V2 → V4

Structurally identical to E.2 but V2 HAS `agentKey`/`setAgentKeyEnabled`/`agentPositionUnits`, so:

| # | Step | Assertion |
|---|---|---|
| E.3.1 | rescue-sell re-enables agentKey on V2 if disabled | owner-signed `setAgentKeyEnabled(true)` on V2 before DEPLOYER+EXECUTOR sell; postcondition `positionUnits[token]==0 && agentPositionUnits[agentKey][token]==0 && balance==0` |
| E.3.2 | agentKey preservation | V2 agentKey (`keccak256(identity, tokenId)`) is re-enabled on all three V4 vaults; `agentPositionUnits` NOT carried over (V2 had no real positions, only accounting) — assert zero open positions on V4 post-migrate, only agentKey enabled |
| E.3.3 | proof registry re-bind | existing V2 `usedActionHashes` remain on V2 (replay protection preserved on the old vault); V4 starts fresh with its own `usedActionHashes` (documented — V4 is a new contract) |
| E.3.4 | same idempotent re-run + partial-resume + lossless + GAP 12/15/17/19 as E.2 | (see E.2.12–E.2.14) |

### E.4 V3 → V4 (LP NFT preservation — the hard path)

| # | Step | Assertion |
|---|---|---|
| E.4.1 | pre-snapshot | donor V3 has: 1 0G native, 1 LP NFT (tokenId T) with `lpNftOwner[T]==agentKey`, `lpNftPool[T]==P`, `lpNftTickLower/Upper[T]`, `lpNftDeployedNative[T]==0.5 0G`; 1 staked NFT (tokenId S) in `MockZiaVault` with `depositorOf[S]==donor`; `agentLpNotionalDeployed[agentKey]==0.5`; `openLpExposure0G==0.5` |
| E.4.2 | GAP 12 inventory gate (if V3 deployer-owned) | assert all positions/NFTs/staked-NFTs map to deployer-owned agents; HALT if non-deployer agent has a position. Record gate result. |
| E.4.3 | cap-seed + GAP 18 fail-fast | seed V4 `perLpActionCap`/`lpDailyCap`/`maxLpExposure` from inventory; pre-compute total preservation notional (sum of `deployedNative0G` for NFTs marked "preserve"); if total > seeded caps (accounting for rolling-24h `lpDailyCap0G` window) → ABORT with "caps insufficient to honor preservation preference" (NOT a silent preserve→exit downgrade). `initialAllowedLpPools` seeded with union of (curated zappable pools ∪ every V3-NFT pool `lpNftPool[tokenId]`) with matching `stakeVaultForLpPool` (GAP 24). |
| E.4.4 | rescue-sell token positions (EXECUTOR sell; re-enable agentKey on V3 if disabled — owner-signed) | postcondition `positionUnits==0 && balance==0`; GAP 19 fallback if rescue-sell fails |
| E.4.5 | `assertLegacyVaultIsNativeOnly` gate | donor V3 holds only native + LP NFTs |
| E.4.6 | deploy V4 trio + `setLpExitVault` (USER wagmi) | **Codex 1.1 FIX:** deploy MUST precede the native hop (V4 Swap vault must exist before `depositNative` can target it) AND all NFT transfers (A.3.i pre-flight requires V4 LpEntry vault to exist + agentKey enabled + caps seeded) |
| E.4.7 | native hop #1 (idempotent — GAP 15) | `withdrawNative` on V3 → `depositNative` on V4 Swap vault (now ordered AFTER E.4.6 deploy — Codex 1.1; was incorrectly before deploy); record `withdrawTxHash`/`depositTxHash` |
| E.4.8 | enable agent keys on ALL THREE V4 vaults (USER, per agent) | precondition: A.3.i pre-flight requires `agentKeyEnabled[agentKey]==true` on V4. Deploy + enable keys MUST precede all NFT transfers. |
| E.4.9 | per-NFT loop (A.3.i preserve OR A.3.ii exit) — runs AFTER enable keys, BEFORE re-point | for each NFT: pre-flight (A.3.i step 3) → choose i/ii → execute. **GAP 41 per-NFT lossless postcondition:** after `importLpNft`, assert V4 `lpNftDeployedNative[tokenId] == V3 lpNftDeployedNative[tokenId]` (captured before rescueNft), `lpNftPool == V3 pool`, ticks read from adapter match V3 recorded ticks; for A.3.ii, assert native conserved per NFT (not just aggregate). |
| E.4.10 | A.3.i preserve path (happy): `unstakeLpOwner` (if staked) → `rescueNft` on V3 → SOURCE_OWNER `safeTransferFrom(sourceOwnerWallet, v4LpEntryVault, tokenId)` (Codex R7-LOF — deployer rescue wallet for deployer-owned V3, user wallet for user-owned V3) → `importLpNft` on V4 LpEntry (USER-owned V4 vault) → optional re-stake `stakeLp` on V4 | `lpNftOwner_v4[T]==agentKey`; `lpNftPool_v4[T]==P`; ticks preserved; `lpNftDeployedNative_v4[T]==0.5`; `agentLpNotionalDeployed_v4[agentKey]==0.5`; `openLpExposure0G_v4==0.5` — **no ghost notional, no double-count**. NFT custody on V4 LpEntry (NFPM `ownerOf(T) == v4LpEntryVault`). |
| E.4.11 | A.3.i GAP 16 transfer-stage resume (ownerOf-based branch) | (a) `ownerOf(T) == v4LpEntryVault` → skip `safeTransferFrom`, proceed to `importLpNft`. (b) `ownerOf(T) == sourceOwnerWallet` (userWallet OR deployerRescueWallet — Codex R7-LOF) → execute `safeTransferFrom(sourceOwnerWallet, v4LpEntryVault, tokenId)` then `import`. (c) `ownerOf(T)` is any other address → halt with "NFT in unexpected location" error. Record the `ownerOf`-verified state as the resume checkpoint. |
| E.4.12 | A.3.i loss-of-funds fallback | `importLpNft` reverts after NFT is inside V4 LpEntry vault → owner calls V4 (LpEntry) `rescueNft(tokenId, owner())` to pull NFT back to wallet, then retries or exits. Assert NFT returns to owner wallet. |
| E.4.13 | A.3.ii exit fallback (underwater / stale ticks / pre-flight fails / caps insufficient) | if staked: SOURCE_OWNER `unstakeLpOwner` on V3 (Codex 1.2 branch — DEPLOYER for deployer-owned V3). **GAP 23:** SOURCE_OWNER `setAgentKeyEnabled(agentKey, true)` on V3 (same branch — NOT user-signed for deployer-owned V3) if disabled — V3 `zapOut` requires it. EXECUTOR `zapOut` on V3 (DEPLOYER `acceptProof` + EXECUTOR). NFT burned, native → V3. **GAP 16 second withdraw+deposit cycle (idempotent):** SOURCE_OWNER `withdrawNative` on V3 (Codex 1.2 branch) → USER `depositNative` on V4 Swap vault. Each step postcondition-gated and idempotent (state file records `exitWithdrawTxHash`/`exitDepositTxHash` per NFT; on resume, skip per-NFT iff `exitDepositTxHash[NFT]` mined+confirmed AND `perNftDeposited0G[NFT]==expected` zapOut native for that NFT; aggregate-balance skip is FORBIDDEN (MIG-1). Cross-check `sum(perNftDeposited0G) <= V4 Swap native balance`). **V3 `zapOut` requires `executorActive` — pause+revoke V3 happens only AFTER ALL NFTs are resolved.** |
| E.4.14 | registry re-point (idempotent — GAP 17) | verify `agentKeyEnabled` on ALL THREE V4 vaults on-chain before JSON write; `registry.vaultOf(owner)` == (v4Swap, v4LpEntry, v4LpExit); `migratedFromVault` stamped |
| E.4.15 | retire V3: `setPaused(true)` + `revokeExecutor()` | **MIG-6 PRE-condition gate:** with any NFT still at stage==transfer → `setPaused(true)` reverts `NftsUnresolved`; only when ALL NFTs are at stage in {imported, exitDeposited} do `setPaused(true)`+`revokeExecutor()` succeed. **GAP 19:** record `v3Retired:true` as a hard postcondition gate. **GAP 20:** until `v3Retired==true`, V3 ghost notional for migrated NFTs is treated as "migration incomplete." |
| E.4.16 | post-state asserts | donor.native == 0; v4 Swap.native == 1; for each preserved NFT: `lpNftOwner_v4[T]==agentKey`, ticks/pool/deployedNative preserved; for each exited NFT: NFT burned, native conserved per NFT; `agentKeyEnabled` on all three V4 vaults == true; registry re-pointed; `migratedFromVault` stamped; `v3Retired==true` |
| E.4.17 | idempotent re-run | second migrate: native already moved (skip), NFT already imported (`lpNftOwner_v4[T]==agentKey` → `AlreadyRegistered` handled gracefully — skip, no re-transfer, no double-count of daily cap), stake already migrated (skip); no double-rescue, no double-deposit |
| E.4.18 | partial-resume after NFT rescue but before stake rescue | kill after E.4.10; resume → stake rescue E.4.10 (re-stake) + registry flip E.4.14 + retire V3 E.4.15; reach same end state |
| E.4.19 | lossless | total native + NFT ownership preserved: donor.native_before + donor.NFT_owner == v4.native_after + v4.NFT_owner; no token/NFT lost or duplicated |
| E.4.20 | failure: NFT stuck in a disabled stake vault | `unstakeLpOwner` on V3 still works (exit-lockup) → rescue succeeds; if stake vault contract is paused/destroyed → documented unrecoverable path, assert revert with clear error |
| E.4.21 | failure: V3 vault with active LP position (`liquidityOf > 0`) | migrate still works (NFT is an ERC721, transferable regardless of pool state); v4 inherits the position; `decreaseLiquidity`/`zapOut` on v4 post-migrate passes |
| E.4.22 | failure: V3 vault with `lpNftDeployedNative > 0` but NFT already burned (ghost notional) | detect pre-migrate and revert with `GhostNotionalDetected` (or document that V3 doesn't allow this state — assert invariant) |
| E.4.23 | failure: agentKey disabled on V3 donor | A.3.i migrate still re-enables on V4 (owner opt-in via migrate); A.3.ii requires re-enable on V3 first (GAP 23). Assert `agentKeyEnabled_v4[agentKey]==true` post-migrate regardless of donor state. |
| E.4.24 | **Mainnet-fork preservation dry-run (GAP 40 — backs R2, moves from aspirational to required):** fork chainId 16661 at the real deployed V3 singletons (`0xfd391E8FFC423E2b7493Ea64C517957688B60BF5` and `0x7a2ADB32053820F573BC2C917e4369940548Ecdc`) using `hardhatMainnet` with `MAINNET_FORK_RPC_URL` env; seed a real staked NFT on the forked V3 (or locate an existing one via `agentStakedNfts`); run the full A.3.i preserve path end-to-end including the GAP 16 ownerOf-based resume branch and the `rescueNft` fallback; assert per-NFT lossless postcondition (E.4.19) against the forked state. This catches storage-layout divergences (the deployed 0xfd39 predates `agentLpNfts`/`agentStakedNfts` getters per the lp-vault-v3-deploy-gaps memory) that the mock-donor E.4.10–E.4.12 cannot reproduce. Gate: `if (!process.env.MAINNET_FORK_RPC_URL) { console.log('skip: no fork rpc'); return; }`. |
| E.4.2b | inventory enumeration via NFPM `Transfer` event-scan from `NEXT_PUBLIC_NFPM_MAINNET_FROM_BLOCK` + `lpNftOwner[tokenId]` direct reads; assert full roster recovered; if NFPM event fetch reverts/swallows → revert `InventoryEnumerationUnavailable` (fail-closed, no swallow-on-revert) (MIG-2). |
| E.4.2c | a non-deployer agent (identity owner != DEPLOYER) whose agentKey is NOT resolvable to a verified mainnet AgenticID → halt `AgentKeyUnresolvable` (fail-closed, do NOT assume canonical `0x058c`) (MIG-4). |
| E.4.11b | mid-migration crash after NFT transferred to V4 LpEntry but before `depositNative` → resume re-enters at transfer stage, does NOT re-import, completes deposit (MIG-7). |
| E.4.12b | `importLpNft` reverts after NFT inside V4 LpEntry vault → owner calls V4 (LpEntry) `rescueNft(tokenId, owner())` → NFT returns to owner wallet; then re-attempt import or owner-only exit (GAP 24 / MIG-8). |
| E.4.13b | burned-NFT resume (GAP-VR4-1 tightened): NFPM `ownerOf(T)` reverts with the specific `ERC721InvalidTokenId` selector AND V3 `lpNftOwner[T]==0` (cross-check confirms burn) → treated as burned → zapOut succeeded → skip to withdraw+deposit; OR `ownerOf(T)` returns a live non-V3 address (transferred) AND `lpNftOwner[T]==0` → skip to withdraw+deposit; if `lpNftOwner[T]==agentKey AND ownerOf(T)==V3` → re-issue `zapOut` (MIG-5/GAP-VR3-6/GAP-VR4-1). |
| E.4.13c | GAP-VR4-1 fail-closed HALT cases: (a) simulate a NON-`ERC721InvalidTokenId` revert from `ownerOf(T)` (RPC transient / 429-retry-exhausted / non-invalid-token-ID contract revert) → assert orchestrator HALTs, does NOT skip `zapOut`, does NOT strand the live NFT in a V3 that will be revoked later; (b) `ownerOf(T)` reverts AND `lpNftOwner[T]!=0` (not actually burned) → HALT, do NOT skip; (c) `ownerOf(T)` reverts invalid-token-ID but `lpNftOwner[T]!=0` (V3 record disagrees with NFPM) → HALT for manual review. A regression re-introducing the over-broad try/catch (catch any revert → skip zapOut) MUST fail E.4.13c. |
| E.4.15b | PRE: with one NFT stage==transfer → `setPaused(true)` reverts `NftsUnresolved`; with all NFTs stage in {imported, exitDeposited} → `setPaused(true)`+`revokeExecutor()` succeed and `v3Retired:true` recorded (MIG-6). |
| E.4.17b | per-NFT idempotency: re-run migration for an NFT whose `exitDepositTxHash` is mined+confirmed AND `perNftDeposited0G[NFT]==expected` → skip that NFT; assert aggregate-balance-only skip is NOT used (MIG-1). |
| E.4.18b | shared-executor cross-user blast radius: 3 V4 trios sharing one executor, fire concurrent migrations; assert no cross-vault state leakage (GAP 41). |

---

## F. Mainnet smoke checklist — `D:\4lpha-0G\scripts\lp-mainnet-v4-smoke.ts`

Single orchestrated script (or `smoke:v4:*` npm scripts) following the `vault-migrate.ts` state-file + idempotent pattern. **Real money. DEPLOYER pays gas.**

| # | Smoke path | Network | Script section | Asserted |
|---|---|---|---|---|
| F.1 | One live 0G Compute call through a server route | Galileo (testnet key) | `smoke:v4:compute` → reuse `smoke-copilot-session.ts` against `OG_COMPUTE_TESTNET_*` env | LLM response non-empty; audit bundle stored |
| F.2 | One 0G Storage upload + verified retrieval/root | Galileo | `smoke:v4:storage` → reuse `smoke-storage.ts` | root returned; retrieval matches; indexer URL resolves |
| F.3 | One 0G Chain Galileo testnet tx anchoring proof | Galileo | `smoke:v4:galileo-proof` → reuse `smoke-galileo.ts` `--network ogGalileo` | proof tx mined; `ProofRegistry.isAccepted` returns true |
| F.4 | Vault deposit (user-signed) on V4 Swap vault | **Mainnet** | `smoke:v4:deposit-swap` → user wallet sends 0.1 0G to V4 Swap vault via `depositNative` | `Deposited` event; vault balance += 0.1 |
| F.5 | Policy update (user-signed, three-tx — GAP 4) | **Mainnet** | `smoke:v4:policy-swap` + `smoke:v4:policy-lp` → owner `tightenPolicy` on Swap (e.g. set `perTradeCap=0.05`) AND `tightenLpPolicy` on LpEntry (e.g. set `perLpActionCap=0.05`) | `PolicyTightened` + `LpPolicyTightened` events; on-chain policies match; subsequent buy over 0.05 reverts `CapExceeded`; subsequent `zapInMintLp` over 0.05 reverts `LpCapExceeded`. Documented non-atomic (three txs — GAP 4). |
| F.6 | Executor buy through mock adapter (test-only V4 Swap vault with `allowMockAdapter=true`) | **Galileo** (test-only vault) | `smoke:v4:buy` → executor `buy` 0.01 0G via MockDexAdapter on Galileo (chainId 16602, where `allowMockAdapter=true` is honored) | `TradeExecuted` + `TradeExecutedV2` events; token received; position units accrued to agentKey. **Note (GAP 36):** mock adapter CANNOT run on mainnet — §3.3/B.11 revert `AdapterBlocked()` when `block.chainid == 16661` regardless of flag, so the "test-only vault on mainnet with mock flag" branch is unreachable. AGENTS.md requires "buy through mock adapter", not "on mainnet"; Galileo satisfies it. |
| F.7 | Executor sell through mock adapter | **Galileo** (test-only vault) | `smoke:v4:sell` → executor `sell` tokens via MockDexAdapter on Galileo (same test-only vault as F.6) | `TradeExecuted` + `TradeExecutedV2` events; native returned; exposure released. Same GAP 36 note as F.6 — Galileo only. |
| F.8 | Pause (user-signed on all three thirds — GAP 2) | **Mainnet** | `smoke:v4:pause` → owner `setPaused(true)` on Swap + LpEntry + LpExit; attempt buy → revert `Paused`; attempt `zapInMintLp` → `Paused`; **assert an LP exit (`zapOut`/`decreaseLiquidity`) passes while LpExit is paused** (GAP 2 — pause does not freeze exits); `setPaused(false)` on all three; buy passes again | pause blocks new entries on Swap + LpEntry; exits still pass on LpExit (GAP 2 documented exception) |
| F.9 | Revoke executor (user-signed on all three thirds) | **Mainnet** | `smoke:v4:revoke` → owner `revokeExecutor` on Swap + LpEntry + LpExit; buy → `ExecutorIsRevoked`; `zapOut` on LpExit → `ExecutorIsRevoked` (hard kill — GAP 2); owner `withdrawNative` still passes (recovery path) | revocation blocks all executor actions on all three thirds; owner recovery still works |
| F.10 | Owner withdraw (user-signed on V4 Swap vault) | **Mainnet** | `smoke:v4:withdraw` → owner `withdrawNative` full balance on Swap vault | vault balance → 0; owner balance += amount; `NativeWithdrawn` event |
| F.11 | LP: mint → stake → unstake → zapOut on V4 (full lifecycle) | **Mainnet** (real `ZiaLpAdapterV4` + real NFPM + real ZiaVault + a W0G-legged mainnet pool from `ZIA_LP_VAULTS`) | `smoke:v4:lp-lifecycle` → (a) `zapInMintLp` 0.05 0G into a W0G-legged pool; (b) `stakeLp` into the pool's Zia vault; (c) `unstakeLp` (executor); (d) `zapOut` full exit | each step emits `LpActionExecutedV3`; final: NFT burned, exposure 0, no residual W0G, native returned to LpExit vault; owner `withdrawNative` on LpExit recovers native |
| F.12 | LP V4 new functions smoke (gas-costed) | **Mainnet** | `smoke:v4:lp-v4` → `zapInIncreaseLiquidity` then `decreaseLiquidity` then `collectFees` (post-decrease residual) then `burnLp` on a fresh position | each step succeeds; `collectFees` reverts `LpBadDelta` if either fee side is 0 (GAP 13 liveness constraint documented); final NFT burned; no lost funds |
| F.13 | Sweep stray tokens | **Mainnet** (test-only — send a stray allowlisted token to LpExit vault first) | `smoke:v4:sweep` → `sweepToken(tokenIn, NATIVE_TOKEN, amount)` on LpExit | native returned to LpExit vault; `LpActionExecutedV3` event; owner `withdrawNative` on LpExit recovers |
| F.14 | LP partial-decrease no orphan (G-01) | **Mainnet** | `smoke:v4:lp-partial` → `decreaseLiquidity` (partial) then `zapInIncreaseLiquidity` re-increase on V4 LpEntry; assert position not orphaned | after partial decrease, tokenId STILL present in `agentLpNfts(agentKey, poolId)` AND `lpNftOwner(tokenId)==agentKey` AND `lpNftDeployedNative[tokenId] == original - nativeFreed`; re-increase on same tokenId succeeds; full `zapOut` redeems residual and purges (G-01). Mainnet, user-signed owner actions for rescue, executor for LP. |

**Galileo vs mainnet split:** F.1–F.3 and **F.6–F.7** on Galileo (testnet key, cheap; F.6–F.7 use a test-only V4 vault with `allowMockAdapter=true`, which the contract honors only off-mainnet per §3.3/B.11 — GAP 36). F.4, F.5, F.8–F.14 on mainnet (real 0G, real adapter, real pools — required because V4/AgenticID/ZiaLpAdapter are mainnet-only per AGENTS.md). Mark each script section with a `network:` header and a `gasPayer: DEPLOYER` note.

---

## G. Regression matrix — every V2/V3 feature → V4 test that proves it still works

| V2/V3 feature | V4 test that proves it still works | Status |
|---|---|---|
| V1 native deposit | A.1.1 | ✓ |
| V1 owner-only withdraw (executor rejected) | A.1.2 + B.1 | ✓ |
| V1 `rescueToken` | A.1.3 | ✓ |
| V1 pause blocks buy | A.1.4 + F.8 | ✓ |
| V1 revokeExecutor blocks buy | A.1.5 + F.9 | ✓ |
| V1 token allowlist / `disableToken` | A.1.7 | ✓ |
| V1 pool allowlist / `disablePool` | A.1.8 | ✓ |
| V1 `tightenPairMinOutBps` (only-tighten) | A.1.9 | ✓ |
| V1 `tightenPolicy` (only-tighten, all fields) | A.1.10 + F.5 | ✓ (GAP 4: split into 3 txs on V4 — documented non-atomic) |
| V1 buy via mock adapter (all policy gates) | A.1.11 + F.6 | ✓ |
| V1 sell via mock adapter (all policy gates) | A.1.12 + F.7 | ✓ |
| V1 `poolAddressOf` view (V3 line 1128 — GAP 4) | A.1.13 / A.2.7 view-parity | ✓ |
| V1 per-trade cap / daily cap / cooldown / max exposure | B.5 + B.6 | ✓ |
| V1 deadline window enforced | A.1.11 (`DeadlineExpired` + `DeadlineTooFar`) | ✓ |
| V1 zero amountOutMin rejected | B.4 | ✓ |
| V1 low floor (owner-approved) rejected | A.1.11 | ✓ |
| V1 replay protection (action hash) | A.1.11 + A.2.1 + A.3.x (`Replay` on every entrypoint) | ✓ |
| V1 cross-vault proof binding | A.1.11 (cross-vault proof → `InvalidProof`) | ✓ |
| V1 malicious adapter (no balance delta) rejected | B.9(a) | ✓ |
| V1 mock adapter rejected when `allowMockAdapter=false` | B.11 | ✓ |
| V1 reentrancy via `ReenteringAdapter` blocked | B.7 (extended to all V4 entrypoints) | ✓ |
| V1 arbitrary execute/multicall/delegatecall/recipient ABI deny-list | B.2 + B.3 + C.2.1 | ✓ |
| V1 incomplete proof metadata rejected | A.1.11 (bad proof variants) | ✓ |
| V2 per-agent-key position isolation | A.1.11 (position units accrue to agentKey) + new V4 test asserting different agentKey → different position units | ✓ |
| V2 agentKey enable/disable gating (buy blocked while disabled; sell allowed after disable — INTENTIONAL DIVERGENCE: V2:366/V3:571 DO gate sell via `_validateAgentKey`, V4 drops the gate to extend GAP 3/11 swap exit-lockup symmetry with LP exits; sell cooldown still enforced V2:370/V3:575 byte-identical) | A.1.6 + A.4.3 | ✓ (V4 intentional divergence, NOT V2/V3 parity) |
| V2 proof/actionHash bound to agentKey | A.1.11 (cross-agentKey proof → `InvalidProof`) | ✓ |
| V2 `keccak256(identity, tokenId)` agentKey helper | A.1.11 (agentKey computed correctly) | ✓ |
| V3 V2 swap surface port (buy/sell roundtrip on V3) | A.1.11 + A.1.12 + F.6 + F.7 | ✓ |
| V3 agentKey enable gating before every LP action | A.2.1 + A.3.x (agentKey enabled required on ENTRIES; exits skip — GAP 3/11) | ✓ |
| V3 zap-in mint LP (exposure + notional + nfpm balance) | A.2.1 + F.11(a) | ✓ |
| V3 non-W0G pool rejected (`LpPoolNotZappable`) | A.2.1 (failure variant) | ✓ |
| V3 `stakeLp` / `unstakeLp` (depositorOf tracking) | A.2.2 + A.2.3 + F.11(b)(c) | ✓ |
| V3 exit-lockup guard: unstake + zapOut survive `disableStakeVault`/`disableLpPool`; new entries blocked | A.4.1 + A.4.2 + A.2.5 | ✓ |
| V3 `allowStaking=false` blocks new stake but unstake still proceeds | A.2.2 (failure) + A.2.3 (passes) | ✓ |
| V3 zapOut fully burns NFT, zeros exposure, no ghost notional | A.2.5 + F.11(d) | ✓ |
| V3 claimRewards reverts `RewardsNotConfigured` | A.2.6 | ✓ |
| V3 LP replay protection (action hash) | A.2.1–A.2.5 + A.3.x (`Replay`) | ✓ |
| V3 zero amount0Min rejected | B.4 | ✓ |
| V3 paired token leftover: oversized → W0G refund credited; sub-bound dust swept as paired | A.2.1 (assert refund accounting in happy path) | ✓ |
| V3 unused W0G refund accounted net against deployed exposure | A.2.1 (`lpNftDeployedNative = amountIn0G − w0gRefund`) | ✓ |
| V3 `onERC721Received` returns `0x150b7a02` | A.2.8 + E.4.10 (safeTransferFrom NFT to LpEntry vault → accepted) | ✓ |
| V3 LP daily cap / cooldown (V3 only tested indirectly via exposure) | B.5 + B.6 + B.12 (now DEDICATED tests) | ✓ improved |
| V3 malicious adapter / reentrancy / admin-cannot-move-funds (not covered in V3) | B.7 + B.9 + B.10 (now covered in V4) | ✓ new |
| V3 `vaultActionHashForLp` encoding (GAP 7 — V4 drops `address(adapter)`) | A.1.13 (V4-own reference golden vector) | ✓ documented divergence |
| V3 `policyHash` 13-field combined (GAP 7 — V4 per-vault 6 + 7) | A.1.13 (per-vault golden vectors) | ✓ documented divergence |
| V3 global `lpDailySpent0G` singleton lockout (memory hazard) | B.5 (V4 per-user — corrected) | ✓ corrected |
| V3 `increaseLiquidity` missing from inline NFPM interface | C.2.5 (added) | ✓ corrected |
| V4 new: `zapInIncreaseLiquidity` | A.3.1 + B.12 + F.12 | ✓ new |
| V4 new: `decreaseLiquidity` | A.3.2 + B.12 + F.12 | ✓ new |
| V4 new: `collectFees` (GAP 9/13 — >=1 wei floor, post-decrease residual only) | A.3.3 + B.4 + F.12 | ✓ new |
| V4 new: `burnLp` | A.3.4 + F.12 | ✓ new |
| V4 new: `sweepToken` (GAP 14 — `allowedSweepPools`) | A.3.5 + B.12 + F.13 | ✓ new |
| V4 new: `importLpNft` (migration ingest — GAP 13/18 daily cap at import) | A.3.x + E.4.10 + B.12(i) | ✓ new |
| V4 new: `rescueNft` on LpEntry (primary — GAP 24 loss-of-funds recovery) / LpExit (secondary — NFT sent to LpExit) | A.5.3 + E.4.12 | ✓ new |
| V4 new: `depositNative`/`withdrawNative`/`rescueToken` on LpEntry + LpExit (GAP 6/8/33) | A.5.1 + A.5.2 + F.11 | ✓ new |
| V4 new: `onlyLpExit` accounting callbacks on LpEntry (GAP 22) | A.3.2/A.3.4 (`reduceLpDeployment`/`purgeLpNft` happy path) + D.12 (onlyLpExit 4-case access-control gate) | ✓ new |
| V4 new: `VaultRegistryV4` (GAP 10/24) | D.1–D.11 | ✓ new |
| AgenticID mint + authorizeUsage | existing `test/AgenticID.ts` (unchanged — AgenticID not versioned; GAP 25 pinning verified on-chain) | ✓ |
| AgenticID iTransfer/iClone/delegateAccess (transfer path disabled) | existing `test/AgenticID.ts` | ✓ |
| AgenticID ERC-165 interfaceId claims | existing `test/AgenticID.ts` | ✓ |
| ZiaLpAdapter real (no dedicated test before) | C.1 + C.2 (NEW dedicated test) | ✓ new |

**Coverage gaps closed by V4 plan** (vs. the existing-test gap report):
- Malicious ERC20 (#8) → B.8 + new `MaliciousERC20.sol` mock.
- Admin cannot move user funds (#10) → B.10 (explicit, all admin surfaces across all three thirds).
- Smoke scripts for policy update / pause / revoke / owner withdraw (#5,8,9,10) → F.5, F.8, F.9, F.10.
- Dedicated `ZiaLpAdapterV4` real-adapter test → C.
- V2/V3 deny-list / reentrancy / malicious-adapter / mock-rejected-in-prod re-asserted on V4 → B.2, B.7, B.9, B.11.
- V4 new LP functions cap/cooldown/exposure bypass → B.12.
- V3→V4 LP-NFT preservation loss-of-funds → E.4 + GAP 24 `rescueNft` + GAP 16 ownerOf-based resume + GAP 18 fail-fast.
- 24KB size gate (GAP 21) → A.0 + `scripts/check-contract-size.ts` as the FIRST implementation task.

---

## H. Commands

Run in this order. All from `D:\4lpha-0G`.

```powershell
# 0. SIZE GATE (GAP 21 — FIRST V4 task; fails fast if any V4 contract >= 24576B)
node scripts/check-contract-size.ts
# Wired as: npm run contracts:size   (chained in contracts:compile)

# 1. Compile (Solidity 0.8.24 / cancun / viaIR / optimizer runs=200)
npx hardhat compile
# CI gate: npm run contracts:compile   (== hardhat compile && node scripts/check-contract-size.ts)

# 2. Unit + security + adapter + registry + migration tests
npx hardhat test                                # default hardhat (V1/V2/V3 + AgenticID + adapter)
npx hardhat test --network hardhatMainnet       # V4 suites — REQUIRED for full V4 coverage
#   (V4 suites gate on network.name === "hardhatMainnet" — GAP 29: reuses the EXISTING
#    hardhatMainnet edr-simulated network with allowUnlimitedContractSize:true for V1/V2/V3
#    factory tests; V4 itself must pass the <24576B size gate)

# 3. TypeScript + app typecheck (after wiring V4 into lib/ + routes/)
npm run build
npx tsc --noEmit

# 4. Mainnet smoke (real money, DEPLOYER gas) — run individually, state-file idempotent:
npm run smoke:v4:compute            # Galileo
npm run smoke:v4:storage            # Galileo
npm run smoke:v4:galileo-proof      # Galileo
npm run smoke:v4:deposit-swap       # Mainnet
npm run smoke:v4:policy-swap        # Mainnet (user-signed, three-tx tighten — GAP 4)
npm run smoke:v4:policy-lp          # Mainnet (user-signed)
npm run smoke:v4:buy                # Galileo (test-only vault, mock adapter — GAP 36: mock impossible on mainnet)
npm run smoke:v4:sell               # Galileo (test-only vault, mock adapter)
npm run smoke:v4:pause              # Mainnet (three-thirds pause — GAP 2)
npm run smoke:v4:revoke             # Mainnet (three-thirds revoke)
npm run smoke:v4:withdraw           # Mainnet
npm run smoke:v4:lp-lifecycle       # Mainnet (real adapter + real pool)
npm run smoke:v4:lp-v4              # Mainnet (5 new functions)
npm run smoke:v4:lp-partial         # Mainnet (F.14 LP partial-decrease no orphan — G-01)
npm run smoke:v4:deposit-lp         # Mainnet (LP deposit — F.14 alternative mapping)
npm run smoke:v4:sweep              # Mainnet
```

Hardhat test runner is `node:test` (not mocha) — matches `test/PolicyVaultV3.ts:31` `describe`/`it` from `node:test`, `assert` from `node:assert/strict`, `network.create()` → `{ viem, networkHelpers }`, `networkHelpers.loadFixture` / `networkHelpers.time.{latest,increase}`.

---

## 10. Mainnet Deploy Steps (ordered)

**Pre-deploy gate (GAP 21):** `node scripts/check-contract-size.ts` MUST pass (every V4 contract < 24576B) BEFORE any mainnet deploy. This is the FIRST V4 task implemented and the LAST gate before mainnet deploy.

**Pre-deploy gate (GAP 25 — AgenticID pinning):** read `owner()` of `0x058c5f4c72810d7d4fc0bef3875a8f779de7e59c` AND `0xa6c5723f024f207311060f4d0976f85a6a069064` on-chain (chainId 16661) (`0x7a968138` EXCLUDED unless rediscovered via chainscan — lacks `supportsInterface`, not a V4 mint candidate); verify `supportsInterface(IERC7857_INTERFACE_ID)` AND `supportsInterface(IERC7857_METADATA_INTERFACE_ID)` AND `supportsInterface(IERC7857_DATA_VERIFIER_INTERFACE_ID)` (the three canonical ERC-7857 interface IDs — NOT the generic ERC-165 `0x01ffc9a7`, per AGENTS.md Agent Identity + memory `agentic-id-erc7857`: AgenticID must expose IERC7857/IERC7857Metadata/IERC7857DataVerifier, not just ERC-165); additionally read the canonical selectors (`iTransfer`/`iClone`/`intelligentDataOf`/`authorizeUsage`/`revokeAuthorization`/`delegateAccess`) directly and reconcile the existing roster via `ownerOf`; verify which has minted the existing roster; pin `AGENT_IDENTITY_MAINNET_ADDRESS` in `.env.local` to the verified canonical address. Reconcile `.data/deployments/mainnet-agentic-id.json`. Record `identityAddress` per agent in `mainnet-agents.json` (do not assume `0x058c`).

Ordered steps:

1. **Deploy `ZiaLpAdapterV4`** — `npm run deploy:vault:mainnet:zia-lp-adapter:v4` (DEPLOYER signs; reads `MAINNET_DEPLOY_ZIA_LP_ADAPTER_V4=true` + `NFPM`/`SWAP_ROUTER`/`W0G` env; verifies NFPM/SwapRouter/W0G bytecode against on-chain; readback: `lpAdapterKind()`/`nfpm()`/`wrappedNative()`). Write `.data/deployments/mainnet-zia-lp-adapter-v4.json`. Print `NEXT_PUBLIC_POLICY_VAULT_ZIA_LP_ADAPTER_V4_MAINNET_ADDRESS`.
2. **Deploy `VaultRegistryV4`** — `npm run deploy:vault:mainnet:registry:v4` (DEPLOYER signs; readback: `VERSION()==4`, all three `*VaultOf(deployer)==address(0)`). Write `.data/deployments/mainnet-vault-registry-v4.json`. Print `NEXT_PUBLIC_POLICY_VAULT_V4_REGISTRY_MAINNET_ADDRESS` + `NEXT_PUBLIC_VAULT_REGISTRY_V4_MAINNET_FROM_BLOCK`.
3. **User deploys 3 vault thirds via UI** (`createVaultV4` in `useWalletPolicyVault.ts` — wagmi `deployContract`, USER signs each):
   - (a) `deployContract(PolicyVaultV4LpEntry, [initialOwner=user, executor, lpAdapter=ZiaLpAdapterV4, proofRegistry, mockLpAdapterAllowed=false, vaultRegistry, initialLpPolicy, initialAllowedLpPools, initialAllowedStakeVaults, stakeVaultForLpPool])` → `lpEntryVault`; constructor does NOT self-register (Codex R7-REG). (**SIZE-2: `initialAllowedSweepPools` is NOT a LpEntry arg — `allowedSweepPools` lives on LpExit; passed to step (b) instead.**)
   - (b) `deployContract(PolicyVaultV4LpExit, [initialOwner=user, executor, lpAdapter, proofRegistry, mockLpAdapterAllowed=false, vaultRegistry, lpEntry=lpEntryVault, initialAllowedSweepPools, initialAllowedSweepTokens])` → `lpExitVault`; constructor does NOT self-register (Codex R7-REG) and seeds `allowedSweepPools` + `allowedSweepTokens` (SIZE-2 + Codex 2.1 — LpExit-local token allowlist).
   - (c) `deployContract(PolicyVaultV4Swap, [initialOwner=user, executor, swapAdapter=existing 0xfaa8, proofRegistry, initialPolicy, initialAllowedTokens, initialAllowedPools, allowMockAdapter=false, vaultRegistry])` → `swapVault`; constructor does NOT self-register (Codex R7-REG).
   - (d) USER calls `registry.registerLpEntry(lpEntryVault)` + `registry.registerLpExit(lpExitVault)` + `registry.registerSwap(swapVault)` (owner-called, 3 txs — Codex R7-REG FIX: unspoofable registration; the constructor self-registration was spoofable by a fake contract whose `owner()` returns the victim). Then USER calls `lpEntry.setLpExitVault(lpExitVault)` (one-time, onlyOwner, immutable-once-set).
4. **Owner enables agentKey on ALL THREE vaults** — USER signs `setAgentKeyEnabled(agentKey, true)` on Swap + LpEntry + LpExit per agent (via `useAgentOwnerControls.setAgentKeyEnabledOnAllV4Vaults` — three user-signed txs). Resolver activates V4 only when all three are on-chain-verified (GAP 17/35).
5. **Owner deposits native into Swap vault** — USER signs `depositNative{value: X}` on Swap vault.
6. **Smoke** — run F.1–F.14 (Galileo for F.1–F.3 and F.6–F.7 [mock adapter, test-only vault — GAP 36]; mainnet for F.4, F.5, F.8–F.14) against the deployed V4 trio.

**Env var changes:**
- **UNSET** `NEXT_PUBLIC_POLICY_VAULT_V3_MAINNET_ADDRESS` (no longer the resolver source).
- **ADD** `NEXT_PUBLIC_POLICY_VAULT_V4_REGISTRY_MAINNET_ADDRESS` (the `VaultRegistryV4` address — single source of truth for `vaultOf(owner)`).
- **ADD** `NEXT_PUBLIC_POLICY_VAULT_ZIA_LP_ADAPTER_V4_MAINNET_ADDRESS` (the `ZiaLpAdapterV4` address — canonical name, matches §7.13/§10 step 1/§11.2/§11.3).
- **ADD** `NEXT_PUBLIC_VAULT_REGISTRY_V4_MAINNET_FROM_BLOCK` (for event log indexing).
- **PIN** `AGENT_IDENTITY_MAINNET_ADDRESS` to the single resolved canonical address from the GAP 25 on-chain verification step.
- **KEEP** `POLICY_VAULT_ADDRESS` / `PROOF_REGISTRY_ADDRESS` / `VAULT_EXECUTOR_PRIVATE_KEY` / `DEPLOYER_PRIVATE_KEY` unchanged.
- **DROP** any `NEXT_PUBLIC_POLICY_VAULT_V3_*` deploy script wiring from `package.json` (V3 hardhat deploy scripts remain for legacy source-vault migration only, not new deploys).

**hardhat deploy scripts DROPPED for the per-user path:** `deploy:vault:mainnet:swap:v4`, `:lp-entry:v4`, `:lp-exit:v4` do NOT exist. Per-user vaults deploy exclusively via UI `createVaultV4` (wagmi `deployContract` with the user's connector). The only hardhat deploy scripts are `deploy:vault:mainnet:registry:v4` and `deploy:vault:mainnet:zia-lp-adapter:v4` (shared infrastructure). This is documented in §7.14.

---

## 11. Docs / README / .env.example updates

### 11.1 Docs to update

- **`docs/vault-v4-plan.md`** — the finalized V4 plan-of-record (this document). Written to disk before execution begins. Tagged with the GAP-25 AgenticID pinning result once verified.
- **`docs/integrations/zia-tradegpt-partner-api.md`** — add a note that V4 LP agent routing resolves via `VaultRegistryV4.vaultOf(owner)` → `lpEntryVault`/`lpExitVault`, not the V3 singleton.
- **`README.md`** sections to update:
  - "Policy Vault" section — replace V3 singleton description with the V4 three-way per-user split (`PolicyVaultV4Swap` + `PolicyVaultV4LpEntry` + `PolicyVaultV4LpExit`) + `VaultRegistryV4` + `ZiaLpAdapterV4`. Document the deployed mainnet addresses once live.
  - "Migration" section — add V1→V4, V2→V4, V3→V4 paths with the GAP 12 deployer-owned-source gate, GAP 18 fail-fast, GAP 24 LP-NFT preservation via `rescueNft` + `importLpNft`.
  - "Deploy" section — document the per-user UI `createVaultV4` path (three wagmi `deployContract` txs + `setLpExitVault`); document that hardhat `deploy:vault:mainnet:*:v4` scripts are DROPPED for the per-user path.
  - "Size gate" subsection — document `scripts/check-contract-size.ts` as the EIP-170 24576B gate (GAP 21) and that `hardhat-contract-sizer` is NOT used (does not exist for Hardhat 3).
  - "GAP 4 documented exception" — tighten is three non-atomic user-signed txs (one per vault third).
  - "GAP 2 documented exception" — pause does NOT freeze LP exits; only `revokeExecutor` is the hard kill.
  - "GAP 13 liveness constraint" — `collectFees` is post-decrease residual only; `decreaseLiquidity` is the PRIMARY fee-collection path.
  - "AgenticID" section — document the resolved canonical address (GAP 25) and that `iTransfer`/`iClone` stay disabled.
- **`AGENTS.md`** — no changes (source of truth; V4 inherits all rules).
- **`CLAUDE.md`** — auto-imports `AGENTS.md`, no changes.

### 11.2 `.env.example` placeholders to add (redacted — placeholders only, no real values)

```
# V4 — VaultRegistryV4 (single source of truth for vaultOf(owner))
NEXT_PUBLIC_POLICY_VAULT_V4_REGISTRY_MAINNET_ADDRESS=0x0000000000000000000000000000000000000000
NEXT_PUBLIC_VAULT_REGISTRY_V4_MAINNET_FROM_BLOCK=0

# V4 — ZiaLpAdapterV4 (shared LP adapter)
NEXT_PUBLIC_POLICY_VAULT_ZIA_LP_ADAPTER_V4_MAINNET_ADDRESS=0x0000000000000000000000000000000000000000

# V4 — ZiaLpAdapterV4 deploy verification (bytecode hash inputs)
NFPM=0x0000000000000000000000000000000000000000
SWAP_ROUTER=0x0000000000000000000000000000000000000000
W0G=0x0000000000000000000000000000000000000000
# V4 — mainnet-fork preservation dry-run (E.4.24, optional)
MAINNET_FORK_RPC_URL=

# V4 — AgenticID (pinned to the GAP 25 on-chain-verified canonical address; do NOT assume 0x058c)
AGENT_IDENTITY_MAINNET_ADDRESS=0x0000000000000000000000000000000000000000
AGENT_IDENTITY_MAINNET_FROM_BLOCK=0  # for totalSupply + Transfer event-scan enumeration (G-EXEC-4)

# V4 — migration inventory event-scan from-blocks (GAP-VR3-4 — pin to the legacy V3 source deploy block; never scan from block 0)
POLICY_VAULT_V3_MAINNET_FROM_BLOCK=
NEXT_PUBLIC_POLICY_VAULT_V3_MAINNET_FROM_BLOCK=

# V4 — size gate (Hardhat-3-native node script, NOT hardhat-contract-sizer — GAP 21)
# Run: npm run contracts:size   (chained in contracts:compile)
```

**Remove from `.env.example`:**
- `NEXT_PUBLIC_POLICY_VAULT_V3_MAINNET_ADDRESS` (unset — no longer resolver source).

**Keep unchanged in `.env.example`:**
- `OG_CHAIN_ID`, `OG_RPC_URL`, `OG_EXPLORER_URL`, `OG_COMPUTE_*`, `OG_STORAGE_*`, `DEPLOYER_PRIVATE_KEY`, `VAULT_EXECUTOR_PRIVATE_KEY`, `POLICY_VAULT_ADDRESS` (legacy V1/V2/V3 still referenced for migration source detection), `PROOF_REGISTRY_ADDRESS`, `ENABLE_REAL_DEX_ADAPTER`, `ENABLE_MOCK_DEX_ADAPTER`.

### 11.3 `.env.local` updates (real values — NOT committed)

- Set `NEXT_PUBLIC_POLICY_VAULT_V4_REGISTRY_MAINNET_ADDRESS` to the deployed registry address.
- Set `NEXT_PUBLIC_POLICY_VAULT_ZIA_LP_ADAPTER_V4_MAINNET_ADDRESS` to the deployed adapter address.
- Pin `AGENT_IDENTITY_MAINNET_ADDRESS` to the GAP 25 on-chain-verified canonical address.
- Unset `NEXT_PUBLIC_POLICY_VAULT_V3_MAINNET_ADDRESS` (or keep for migration source detection only — document).
- Keep `ZIA_TRADEGPT_API_BASE_URL` in `.env.local` (partner-only, never committed).

---

## 12. Risk Register + Confidence Assessment

| # | Risk | Severity | Mitigation | Residual Risk |
|---|---|---|---|---|
| R1 | **24KB size blocker (GAP 21/22/24)** — a V4 vault third empirically exceeds 24576B deployed bytecode. The 3-way split projects each third to ~10-12KB but the probe (§3.9.5) must confirm. | **BLOCKER** | `scripts/check-contract-size.ts` is the FIRST V4 task implemented (GAP 21). The size probe runs with wrapper bodies PRESENT against `MockZiaLpAdapterV4` (GAP 23 — not empty bodies). If any third exceeds, shed further: `sweepToken` already on LpExit (SIZE-2) — remaining shed option is splitting `importLpNft` accounting or migrating LpEntry views to `onlyLpExit` read-through callbacks. The `VaultRegistryV4` 3-mapping shape already supports the split. | Low — the split has ~12-14KB headroom per third; only a gross miscount would fail. But UNVERIFIED until the probe runs. |
| R2 | **V3→V4 LP-NFT preservation loss-of-funds (GAP 24)** — `safeTransferFrom` mined but `importLpNft` reverts → NFT stranded in V4 LpEntry vault; or `rescueNft` from old V3 → `importLpNft` into new V4 fails mid-sequence. | **HIGH (loss-of-funds)** | V4 (LpEntry) `rescueNft(tokenId, owner())` recovers stranded NFTs (GAP 24 — primary; NFTs are custodied on LpEntry where `importLpNft` lands; LpExit `rescueNft(uint256)` is secondary, only for the rare case an NFT actually lands on LpExit — G-03). GAP 16 ownerOf-based resume branch detects `ownerOf == v4LpEntryVault` and proceeds to import without re-transfer. GAP 28 pre-flight before `rescueNft` asserts all 4 cap/allowlist/key/registry preconditions; if any fails → A.3.ii before any transfer. GAP 18 fail-fast aborts if caps insufficient. E.4.10–E.4.12 test the full preserve + fallback path. | Medium — the recovery path exists and is tested, but the orchestrator must execute it correctly under resume; a bug in the ownerOf branch could strand an NFT temporarily (recoverable via `rescueNft`). |
| R3 | **Dual AgenticID address discrepancy (GAP 25)** — `0x058c` (live per README/code) vs `0xa6c5` (artifact in `.data/deployments/mainnet-agentic-id.json`) vs `0x7a968138` (legacy, EXCLUDED — not a V4 mint candidate unless rediscovered via chainscan). Minting on the wrong contract breaks `agentKey` derivation. | **HIGH** | On-chain verification (chainId 16661) of `owner()`/`supportsInterface`/minted roster across `0x058c` and `0xa6c5` BEFORE any V4 work (`0x7a968138` EXCLUDED — lacks `supportsInterface`). Pin `AGENT_IDENTITY_MAINNET_ADDRESS` to the verified canonical. Record `identityAddress` per agent in `mainnet-agents.json` (do not assume `0x058c`). | Low once pinned — but the verification step itself could surface a fourth address or a roster mismatch requiring manual reconciliation. |
| R4 | **`tightenPolicy` split into 3 non-atomic txs (GAP 4)** — mid-sequence the vault trio is partially tightened; a compromised executor could exploit the window. | **MEDIUM** | Documented exception. All tighten ops are tighten-ONLY (each field ≤ existing); the tighter of old/new always binds mid-sequence, so a compromised executor cannot exceed either cap. UI issues all three txs back-to-back. Test A.4.6 asserts the partially-tightened state is safe. | Low — tighten-only semantics make the window safe; the risk is a UI bug that issues only 1 of 3 txs and the operator doesn't notice. |
| R5 | **Pause does NOT freeze LP exits (GAP 2)** — `setPaused(true)` on LpExit does not block `decreaseLiquidity`/`collectFees`/`burnLp`/`zapOut`/`unstakeLp`; only `revokeExecutor` is the hard kill. | **MEDIUM (documented exception)** | Documented in contract + README + UI. Exits use `onlyExecutorNotRevoked` (not `executorActive`). This is intentional (capital-returning actions should not be locked by pause). Operator must understand pause is NOT a full kill; `revokeExecutor` is. | Low — documented and tested (A.4.4, F.8); risk is operator confusion, not a fund-loss path. |
| R6 | **`collectFees` enforces `amount0Min > 0 && amount1Min > 0` (GAP 9/13)** — the >=1 wei floor means `collectFees` reverts `LpBadDelta` when either fee side has 0 accrued; unusable on active/asymmetric positions. | **LOW (liveness constraint, not loss-of-funds)** | Documented in contract + README + adapter doc. `decreaseLiquidity` (which calls `NFPM.collect` MAX,MAX) is the PRIMARY fee-collection path; `collectFees` is post-decrease residual only. Test A.3.3 asserts the revert on zero-accrued side. | Very low — operators may be surprised, but no fund loss; fees are recoverable via `decreaseLiquidity`. |
| R7 | **Source-side deployer-owner-action GAP 12 gate** — DEPLOYER signs `withdrawNative`/`unstakeLpOwner`/`rescueNft` on deployer-owned V1/V3 singletons; if the inventory gate is wrong, non-deployer funds could be swept. | **HIGH (loss-of-funds)** | Hard on-chain precondition gate: inventory EVERY position/NFT/staked-NFT in the source vault; assert each maps to a deployer-owned agent (`identity owner == DEPLOYER`); if any non-deployer agent has a position → HALT, require user-signed exit for those positions. Gate result recorded in state file. E.2.2/E.4.2 test the gate. | Medium — the gate logic is the single point of failure; a bug in the inventory enumeration (e.g. missing a staked-NFT mapping) could misclassify. Mitigated by the idempotent state file + explicit HALT. |
| R8 | **Shared-executor compromise blast radius** — `VAULT_EXECUTOR_PRIVATE_KEY` is the immutable `executor` on all three V4 vault thirds across ALL users; a single key compromise affects every per-user vault. | **HIGH (cross-user)** | Per-vault isolation: the executor can only call typed `buy`/`sell`/LP entry/exit on each vault; no arbitrary call, no recipient selection, no withdrawal. Per-trade/daily/cooldown/max-exposure caps bound each action. `revokeExecutor` (user-signed per vault) is the hard kill. Owner recovery paths (`withdrawNative`/`rescueToken`/`rescueNft`) work after revoke. | Medium — the blast radius is "executor steals up to per-trade/daily cap across all vaults before each user revokes"; bounded by caps + cooldown + the user's revoke. NOT a full-drain risk. |
| R9 | **`hardhatMainnet` network config (GAP 29)** — reusing the existing `hardhatMainnet` with `allowUnlimitedContractSize:true` could mask a V4 size overflow in tests. | **LOW** | `scripts/check-contract-size.ts` is the authoritative <24576 gate (run as `contracts:size`, chained in `contracts:compile`). A.0 unit test asserts the same. `allowUnlimitedContractSize` is only for V1/V2/V3 factory tests (28766B). | Very low — two independent gates. |
| R10 | **LpExit→LpEntry accounting callback trust (GAP 22)** — `onlyLpExit` gate on LpEntry setters; if the `lpExitVault` is set wrong, LpExit could corrupt LpEntry accounting. | **MEDIUM** | `lpExitVault` is plain storage (G-EXEC-1), set via one-time `setLpExitVault` onlyOwner, guarded by `_lpExitVaultSet` (reverts if already set), immutable-once-set, not executor-controlled. Typed interface (not arbitrary call). Test D.12 (4-case access-control) + A.3.2 (happy-path callback) assert the gate. | Low — the only risk is a deploy-order bug (LpExit deployed before LpEntry and `setLpExitVault` never called); mitigated by the deploy order in §10. |

### Confidence Assessment

**Honest confidence that the implementation passes the full test matrix (sections A–H) AND the 10 required mainnet smoke paths (F.1–F.14) on first integration, conditional on the size-gate (R1) passing: ~96%** — raised from 82% → 86% (verify round 1: GAP 36-41) → 90% (verify round 2 closed 8 blockers + ~28 high/medium gaps across 5 lenses) → ~93% (verify round 3 propagated 42 fix-induced inconsistencies + 9 blockers) → ~95% (verify round 4 — strict verbatim-quote protocol; 4 critics, avg 90%, 0 blockers, 3 real gaps all closed) → **~96% (verify round 5 — 2-critic confirmatory pass; avg 92%, 0 blockers, 0 highs, 2 mediums/lows all closed)**. Round-3 critics over-reported ~20 hallucinated gaps by paraphrasing stale text; rounds 4-5 used a strict verbatim-quote protocol (every gap MUST quote verbatim current line text + line number) and surfaced only genuine fix-induced propagation residuals (3 + 2), all closed. **Spec-level confidence is at its ceiling (~96%): the only blocker-class residual is R1 (the empirical 24KB EIP-170 size gate on LpEntry), which is closeable ONLY at Phase-3 execution when `PolicyVaultV4LpEntry.sol` compiles and the `<23000B` probe runs. R3 (AgenticID mainnet pinning) closes to 97% once `0x058c`/`0xa6c5` are verified on-chain at execution.** Further spec-level verify rounds cannot push past ~96% because R1/R3 are fundamentally execution-closable, not spec-closable. Expected confidence ≥99% after Phase-3 compile + size probe + on-chain AgenticID verify.

**Verify round 3 — newly CLOSED gap ids (propagation of round-2 fix-induced inconsistencies + 9 blockers):**
- **VR3-1 / VR3-2** (REG-5 relabel — sell agentKey gating is INTENTIONAL V4 divergence, NOT V2/V3 parity; §3.7.1 sell row + §G agentKey-gating row (line 1117) + A.1.6 + A.4.3 assert the divergence).
- **FI-1..FI-10** (finalizeExit split propagation, sweepToken-LpExit propagation, rescueNft-LpEntry propagation, receive() load-bearing notes, sweep smoke retarget, SIZE-3 premise rewrite, shed-fallback rewrite, lpExitVault plain-storage wording, claimRewards-on-LpExit relabel, A.0 split size assertion).
- **GAP-T1..T9** (sweepToken storage move compile blocker; sweep cooldown/test reclassification; onlyLpExit 4-case gate spec; finalizeExit→reduceLpDeployment/purgeLpNft rename; shed-fallback; B.13 LP-entry isolation; B.11 chainid; B.2 grep fidelity + bytecode selector scan; LpEntry size re-estimate).
- **GAP-VR3-1..VR3-8** (missing E.4 changelog rows actually added; E.4.13 MIG-1-forbidden aggregate-skip rewritten per-NFT; E.4.15 MIG-6 PRE-condition; §6.4 branch (d) ownerOf-keyed [F1]; MIG-5 NFPM ownerOf try/catch [F2]; MIG-6 on-chain assertion + exitDeposited stage name [F3]; NFPM/V3 from-block pinning [E4]; 0x7a968138 excluded [E5]).
- **VR3-SIZE-A..I** (sweepToken-LpExit test/owner-action/smoke/size-shed propagation + SIZE-3 premise rewrite + LpEntry ~19-21KB re-estimate).
- **G-R3-1..R3-10** (rescueNft-LpEntry primary; sweepToken-LpExit smoke; F.14 + smoke:v4 scripts; §10 env name POLICY_ prefix [E1]; §11.2 NFPM/SWAP_ROUTER/W0G/MAINNET_FORK_RPC_URL [E2]; AGENT_IDENTITY_MAINNET_FROM_BLOCK [E3]; 0x7a968138 excluded [E5]; §7.1.1 v3.ts subsection [E6]; LpActionRequest struct [E7]; lpExitVault plain storage [E8]).
- **N-2** (purgeLpNft accounting fully specified — deletes slots + reduces openLpExposure0G/agentLpNotionalDeployed, revert on underflow, only when liquidityOf==0).
- **G-02-zapOut-purge-gate** (zapOut asserts liquidityOf==0 before purgeLpNft, mirroring burnLp).
- **G-01-B12-noorphan** (B.12 case (l) — partial-decrease roster preservation asserted).
- **G-04-B13-lp-entry** (B.13 second scenario — 3 LpEntry vaults concurrent zapIn isolation).
- **G-03b-toArg** (LpEntry rescueNft(uint256,address) `to` arg carved out from no-recipient-arg rule, hard-pinned to owner()).
- **G-06-B4-positive** (burnLp `_burnSideOk` quoted==0 + minOut==0 positive case).
- **B2-grep-fidelity** (B.2 grep broadened to `.call{value:}(` + deployed-bytecode selector scan).
- **F1/F2/F3** (§6.4 ownerOf-keyed rescueNft branch; NFPM ownerOf try/catch on burned NFT; MIG-6 per-NFT on-chain assertion + exitDeposited terminal stage name).

**Verify round 4 — newly CLOSED gap ids (strict verbatim-quote protocol; 4 critics, avg 90%, 0 blockers, 3 real gaps):**
- **GAP-VR4-1** (HIGH, fix-induced — MIG-5 ownerOf try/catch was over-broad: any revert was treated as "burned → skip zapOut", which could strand a live NFT in a later-revoked V3 on a transient RPC/429/non-invalid-token-ID revert. §6.4 line 634 tightened to fail-closed: treat as burned ONLY on the specific `ERC721InvalidTokenId` selector AND V3 `lpNftOwner[T]==0` cross-check; any other revert → HALT, do NOT skip zapOut).
- **R4-G1** (MEDIUM, fix-induced — §10 env-var-changes bullet used non-canonical adapter env name `NEXT_PUBLIC_POLICY_VAULT_V4_ADAPTER_MAINNET_ADDRESS`; retargeted to canonical `NEXT_PUBLIC_POLICY_VAULT_ZIA_LP_ADAPTER_V4_MAINNET_ADDRESS` matching §7.13/§10 step 1/§11.2/§11.3).
- **R4-G2** (LOW — §12 round-3 changelog cited stale "§9.G row 1080" for the REG-5 relabel; corrected to "§G agentKey-gating row (line 1117)").
- **Stragglers flagged by the round-3 fix agents and closed before round-4:** `allowedSweepPools` constructor seed moved from LpEntry §3.3b to LpExit §3.3c (it lives on LpExit storage; LpEntry deploys before LpExit so cannot seed it); §10 step 3(a) `initialAllowedSweepPools` arg moved from the LpEntry deploy to the LpExit deploy (step 3(b)); `_reduceLpExposure` dropped from the §3.7.5 scaffolding list (exposure reduction now happens inside `purgeLpNft` per N-2); intro line 17 rescueNft reconciled to LpEntry-primary + LpExit-secondary (G-03).

**Verify round 4 — critic verdicts:** regression-security 92% (ship_with_caveats, 10/10 assigned fixes confirmed closed, 0 gaps); test-completeness 92% (ship, 16/16 confirmed closed, 0 gaps); migration-lof 88% (ship_with_caveats, 8/8 confirmed closed, 1 gap → GAP-VR4-1 now closed); fix-regression 88% (ship_with_caveats, 23 confirmed closed, 2 gaps → R4-G1/R4-G2 now closed). No critic returned `block`. The two 88% verdicts were driven solely by the 3 gaps they found (now closed) + the acknowledged R1/R3 execution residuals.

**Verify round 5 — newly CLOSED gap ids (2-critic confirmatory pass; avg 92%, 0 blockers, 0 highs, 2 mediums/lows):**
- **R5-G1** (MEDIUM, fix-induced — E.4.13b test case at line 1056 still described the OLD over-broad burned-NFT behavior and did NOT assert the GAP-VR4-1 fail-closed tightening; §6.4 line 634 cross-referenced "match the E.4.13b wording" but E.4.13b had no fail-closed language. FIXED: E.4.13b rewritten to assert the tightened burned path (`ERC721InvalidTokenId` selector AND `lpNftOwner[T]==0` cross-check) + transferred-NFT branch + re-issue-zapOut branch; added E.4.13c asserting HALT fail-closed on non-`ERC721InvalidTokenId` reverts, `lpNftOwner[T]!=0`-while-ownerOf-reverted, and NFPM/V3 disagreement — so a regression re-introducing the over-broad try/catch FAILS E.4.13c. The §6.4→E.4.13b cross-reference is now valid.)
- **R5-G2** (LOW, fix-induced — the R4-G1 edit cited "§10 step 9" but §10 only has steps 1-6; the actual site is §11.3 `.env.local` updates. Corrected both the §10 env bullet (line 1236) and this changelog entry to "§11.3".)

**Verify round 5 — critic verdicts:** migration-lof 91% (ship_with_caveats, GAP-VR4-1 + R4-G1/R4-G2 + 4 stragglers confirmed closed, 1 new gap → R5-G1 now closed); fix-regression 92% (ship_with_caveats, all 3 round-4 gaps + 4 stragglers + §12 update confirmed consistent, 1 new gap → R5-G2 now closed). No `block`, no `high`. The spec is at its ceiling — see Confidence Assessment above.

**Spec-ceiling declaration:** Six verify rounds have converged the spec. Round-3 over-reported (hallucinated ~20 gaps via paraphrased text); rounds 4-6 used a strict verbatim-quote protocol (every gap MUST quote verbatim current line text + line number) and surfaced only genuine fix-induced propagation residuals (3 + 2 + 1), all closed. **Round-6 final sign-off: 2 critics (fix-regression + spec-ceiling-honesty), avg 95%, both `ship`, `ceilingHonest=true`, 0 blockers, 0 highs, 1 LOW cosmetic citation nit (R6-G1 — off-by-one "line 1116"→"line 1117", now fixed).** No remaining spec-level blocker or high. The ONLY residuals are R1 (empirical 24KB EIP-170 size gate on `PolicyVaultV4LpEntry`) and R3 (AgenticID `0x058c`/`0xa6c5` on-chain pinning) — both fundamentally execution-closable at Phase-3, not spec-closable. **Spec-level confidence: ~96%. Expected ≥99% after Phase-3 compile + `<23000B` size probe passes + on-chain AgenticID verify.** The plan is ready for Phase 2 (codex audit review) and Phase 3 (codex execution).

**Verify round 7 — codex INDEPENDENT audit (Phase 2):** codex (gpt-5.5 xhigh, read-only, 4m 23s, session `019f3d7f-35d1-71e3-bdf6-bb4254257046`) returned `block` at 88% independent confidence with 9 findings Claude's 6 self-verify rounds missed — all 9 verified against verbatim plan text before fixing (codex can misquote too; each citation was read back). This is genuine new feedback: Claude self-verification had structural blind spots (migration step ORDERING across §6↔E.4, and arity drift between calls and interface declarations). All 9 fixed:

- **Codex 1.1 BLOCKER (migration ordering)** — §6 step 6 "native hop #1: `depositNative` on V4 Swap vault" was ordered BEFORE step 7 "Deploy V4 LpEntry + LpExit + Swap". Native was deposited into a non-existent V4 Swap vault. FIXED: §6 reordered to deploy (step 6) → native hop (step 7) → enable keys (step 8); mirrored in E.4.6/E.4.7 (deploy now E.4.6, native hop now E.4.7). Loss-of-funds closed (the original order would have reverted `depositNative` to a not-yet-deployed address, or worse, sent native to a wrong address if the user mis-transcribed).
- **Codex 4.1 BLOCKER (registerSwap arity drift)** — §3.3a line 235 called `registerSwap(initialOwner, address(this))` (2-arg) and the §7.1 interface line 782 declared `(address owner, address vault) external` (2-arg), but the impl (lines 496/502/508/531), §10 deploy (1225-1227), and tests (D.1) all use 1-arg `(address owner)` keyed by `msg.sender`. 1-arg is canonical. FIXED: line 235 → `registerSwap(initialOwner)`; line 242 `registerLpEntry` + line 246 `registerLpExit` calls → 1-arg (same drift); line 782 interface → `(address owner) external`. Compile blocker closed.
- **Codex 1.2 HIGH (USER vs DEPLOYER signer on V3 source rescue)** — A.3.i steps 1-2 said "USER `unstakeLpOwner`/`rescueNft` on V3" but §6.6/line 864 establishes `0xfd39`/`0x7a2A` are deployer-owned singletons → a USER signature reverts `OwnableUnauthorizedAccount`. FIXED: A.3.i steps 1-2 replaced with `SOURCE_OWNER` branched — DEPLOYER signs iff `Ownable(V3).owner()==DEPLOYER` AND GAP 12 gate passed, else USER signs (user-owned V3).
- **Codex 1.3 HIGH (purgeLpNft gate only on caller side)** — the `liquidityOf(tokenId)==0` purge gate was enforced only on the "LpExit asserts before invoking" side (§3.7.3 zapOut + A.3.4 burnLp), NOT inside `LpEntry.purgeLpNft` itself. A future code path that calls `purgeLpNft` without the caller-side assert could delete slots on a non-empty position (loss-of-funds). FIXED: gate enforced INSIDE `purgeLpNft` (`require liquidityOf==0 else LpPositionNotEmpty`) AND on the caller side (defense-in-depth); fail-closed on any other revert. Additionally `setLpExitVault` now verifies `candidate == registry.lpExitVaultOf(owner())` AND `IPolicyVaultV4LpExit(candidate).lpEntry() == address(this)` — prevents wiring LpExit to a foreign LpEntry.
- **Codex 2.1 HIGH (sweepToken `allowedTokens` on LpExit — missing storage)** — `sweepToken` (now on LpExit per SIZE-2) referenced `allowedTokens[tokenIn]`/`allowedTokens[tokenOut]`, but `allowedTokens` is the Swap vault's storage (line 117) — LpExit is a separate contract and cannot read it. Either won't compile or silently drops token allowlisting (AGENTS.md "allowlisted input/output tokens" violation — executor could sweep-convert an arbitrary/malicious token). FIXED: added LpExit-local `allowedSweepTokens` mapping + `addSweepToken`/`disableSweepToken` admin + `SweepTokenAllowed` event + constructor seed (§3.2b line 198, §3.3c line 246, §3.7.3 admin line 350, §3.7.5 wrapper line 414, §3.8 line 427, §7.1 ABI signer table line 853, §10 deploy line 1226, A.3.5 test line 891). LpExit-local because LpExit cannot read Swap's `allowedTokens`.
- **Codex 3.1 MEDIUM (size-shed option (c) broke state-ownership)** — §3.9.5 size-shed fallback option (c) "migrate LpEntry views to read-through `onlyLpExit` callbacks backed by LpExit-held state" would move NFT-accounting state to LpExit, breaking the LpEntry-owns-NFT-accounting invariant (§3.7.3b / GAP 22) and reversing the state-ownership model. FIXED: option (c) replaced with a state-ownership-preserving shed — extract view *bodies* into `LpEntryViewLib` (`internal` library fns inlined at compile, no runtime CALL/delegatecall) keeping the canonical state ON LpEntry; or inline-compress.
- **Codex 4.2 MEDIUM (invalid alternative deploy-order)** — §3.3b offered an alternative "deploy LpExit first, then `lpExit.setLpEntry(lpEntry)`" but `lpEntry` is declared `immutable` in LpExit (§3.2b line 205) — cannot be set after construction. FIXED: alternative deleted; only valid order documented (LpEntry → LpExit(passing lpEntry) → Swap → setLpExitVault).
- **Codex 5.1 MEDIUM (AgenticID `supportsInterface(0x01ffc9a7)` — wrong interface ID)** — §10 GAP 25 pre-deploy gate verified `supportsInterface(0x01ffc9a7)` (the generic ERC-165 ID), not the ERC-7857 interface IDs. Per AGENTS.md Agent Identity + memory `agentic-id-erc7857`, AgenticID must expose IERC7857/IERC7857Metadata/IERC7857DataVerifier. FIXED: gate now requires the three canonical ERC-7857 interface IDs AND direct selector reads (`iTransfer`/`iClone`/`intelligentDataOf`/`authorizeUsage`/`revokeAuthorization`/`delegateAccess`) + roster `ownerOf` reconciliation.

**Verify round 7 — codex verdict:** `block` → all 9 findings fixed (2 blockers + 4 highs + 3 mediums). Codex independently confirmed sound: MIG-5 burned-NFT fail-closed (§6.4 line 634), deny-by-default else-everything, LpEntry size plausibility, agentKey→identity fail-closed (`AgentKeyUnresolvable` §6.6.1 lines 593/639). **Post-fix spec-level confidence: ~97%** (up from ~96% — codex closed 2 blockers + 4 highs Claude's 6 rounds missed, demonstrating the value of the independent audit). R1 (24KB size gate) and R3 (AgenticID on-chain pinning) remain the only execution-closable residuals. The plan is re-audited with codex for a ship verdict before Phase 3.

**Verify round 7b — codex SECOND re-audit (Phase 2 closeout):** codex (read-only, 90% independent confidence) returned `block` with 2 NEW BLOCKERS + 2 HIGHs + residuals Claude's round-7 fixes introduced or missed. All verified against verbatim plan text, all fixed:

- **Codex R7-LOF BLOCKER (deployer-owned V3 preserve-path custody):** A.3.i step 4 said "USER `safeTransferFrom(userWallet, v4LpEntryVault, tokenId)`" but for a deployer-owned V3 (`0xfd39`/`0x7a2A`), step 2 `rescueNft` sends the NFT to the DEPLOYER rescue wallet — the USER cannot transfer an NFT they do not own (`ERC721InsufficientApproval`), and the resume branch (b) `ownerOf == userWallet` would see the DEPLOYER wallet as "unexpected location" → halt, stranding migration custody. FIXED: step 4 → SOURCE_OWNER `safeTransferFrom(sourceOwnerWallet, ...)` (DEPLOYER rescue wallet for deployer-owned V3, user wallet for user-owned); resume branch (b) → `ownerOf == sourceOwnerWallet`; mirrored in E.4.10/E.4.11.
- **Codex R7-REG BLOCKER (registry fake pre-registration spoof):** the 4.1 self-registration model (`register*(owner)` keyed by `IOwnable(msg.sender).owner()`) was SPOOFABLE — a fake contract whose `owner()` returns the victim registers under the victim and survives `vaultOf` re-verification (the fake can keep `owner()==victim` forever), so the executor routes the victim's trades/native to the attacker-controlled fake → fund-loss/drain. The overwrite-on-stale variant only overwrites when the fake's `owner()` changes (never). FIXED: switched to OWNER-CALLED `register*(address vault)` (`msg.sender == IOwnable(vault).owner()`) — unspoofable (attacker can't sign as victim); vault constructors DROP self-registration; USER calls `register*(vault)` after each deploy (§6 steps 7-9, §10 step 3d, E.2.6, deployFixture, signer table, D.1/D.7/D.8/D.9). This supersedes the Codex 4.1 1-arg self-register fix (arity was right, auth model was wrong).
- **Codex R7-1.2 HIGH (A.3.ii signer):** the 1.2 SOURCE_OWNER branch was applied only to A.3.i, not A.3.ii. A.3.ii steps 1/2/4 (`unstakeLpOwner`/`setAgentKeyEnabled`/`withdrawNative` on V3) still said USER → revert on deployer-owned V3, blocking exits after cap/preflight failure. FIXED: A.3.ii steps 1/2/4 + E.4.13 all branched to SOURCE_OWNER.
- **Codex R7-PRE HIGH (late A.3.i preflight fallback to V3 zapOut):** A.3.i step 3 "re-checked before step 4 ... If any fails → route to A.3.ii" was invalid post-rescue — if the re-check fails AFTER step 2 moved the NFT out of V3, A.3.ii (which uses V3 `zapOut`) is no longer valid (V3 `lpNftOwner` cleared). FIXED: split fallback — pre-step-2 failure → A.3.ii (NFT still in V3); post-rescue failure → HALT, fix V4 precondition OR exit via direct NFPM manual path (MIG-8), NOT V3 `zapOut`.
- **Codex R7-2.1 MEDIUM (allowedSweepTokens deploy args/ABI):** the constructor seed was specified but `initialAllowedSweepTokens` was NOT in the §10 deploy args (line 1232) and `addSweepToken`/`disableSweepToken`/`allowedSweepTokens`/`SweepTokenAllowed` were NOT in `policyVaultV4LpExitAbi` (§7.1). FIXED: `initialAllowedSweepTokens` added to LpExit deploy args (§10 step 3b); ABI entries added (§7.1).
- **Codex R7-4.2 LOW (stale phrase):** §3.3b still had "the user deploys LpExit first OR passes `address(0)`..." contradicting the immutable `lpEntry` order. FIXED: deleted.
- **Codex R7-EVT LOW (event names):** §7.1 interface said `VaultRegistered`/`VaultLpEntryRegistered`/`VaultLpExitRegistered` but the impl (§7.13 lines 501-503) says `SwapVaultRegistered`/`LpEntryVaultRegistered`/`LpExitVaultRegistered`. FIXED: §7.1 interface aligned to impl names.
- **Codex R7-5.1 LOW (§6.6.1/R3 ERC-165):** §6.6.1 still said "supports ERC-165 `supportsInterface`" (generic) instead of the three ERC-7857 interface IDs. FIXED: §6.6.1 mirrored to §10 ERC-7857 wording.

**Verify round 7b — codex verdict:** `block` → all 8 findings fixed (2 blockers + 2 highs + 1 medium + 3 lows). Codex confirmed the original 9 round-7 fixes all closed (1.1, 1.3, 2.1 contract-level, 3.1, 4.1 arity, 4.2 mostly, 5.1, MIG-5). **Post-fix spec-level confidence: ~98%** — the two new blockers (deployer-owned custody + registry spoof) were genuine loss-of-funds paths Claude's self-verify missed; both now closed with the owner-called-registration + SOURCE_OWNER-custody models. R1 (24KB size gate) and R3 (AgenticID on-chain pinning) remain the only execution-closable residuals. The plan is re-audited with codex (round 8) for the final ship verdict before Phase 3.

**Verify round 8 — codex THIRD audit (Phase 2 closeout):** codex (read-only, 91% confidence) returned `block` but with only stale-reference residuals — 6/8 round-7b findings CLOSED (R7-1.2, R7-PRE, R7-2.1, R7-4.2, R7-EVT, R7-5.1); the 2 "PARTIAL" blockers were one-line stale references, not design gaps. All fixed:
- **R7-LOF residual (BLOCKER, line 632):** the resume rescue-stage branch `(d)` still hard-coded `ownerOf(T) == userWallet` — for a deployer-owned V3 the NFT is in `deployerRescueWallet` → resume at `stage==rescueNft` halted as "unexpected location". FIXED: `ownerOf(T) == sourceOwnerWallet` (userWallet OR deployerRescueWallet).
- **R7-REG residual (MEDIUM, line 979 D.5):** D.5 still described the old overwrite-on-stale spoof model. FIXED: D.5 rewritten to owner-called (`registerSwap(fakeVault)` from attacker → `NotVaultOwner`; victim registers real vault owner-called).
- **B.7 residual (LOW, line 933):** reentrancy rationale still said `single-slot overwrite semantics + Ownable(msg.sender).owner()==owner`. FIXED: owner-called auth, no overwrite semantics.
- **D.10 residual (LOW, line 984):** auth reference stale (`Ownable(msg.sender).owner()==owner`). FIXED: `IOwnable(vault).owner()==msg.sender` (owner-called).
- **Duplicate step (LOW, line 1234-1235):** step (d) duplicated with `setLpExitVault` in both. FIXED: merged into one step (d).

**Post-fix spec-level confidence: ~98.5%** — all codex findings across 3 audit passes (9 + 8 + 5 = 22) are closed; the only remaining residuals are R1 (24KB EIP-170 size gate) and R3 (AgenticID on-chain pinning), both execution-closable at Phase 3. The plan is re-audited with codex (round 9) for the final ship verdict.

**Verify round 2 — blockers CLOSED (8):**
- **REG-1** `actionHashFor` added to LpEntry Views (§3.7.2) + ABI (§7.1) — LP action-hash preflight no longer reverts.
- **REG-2** `claimRewards` stub added to LpExit (§3.7.3) + ABI — A.2.6 `RewardsNotConfigured` regression now satisfiable.
- **G-01** `finalizeExit` split into `reduceLpDeployment` (decreaseLiquidity — keeps slots) + `purgeLpNft` (zapOut/burnLp — deletes only when `liquidityOf==0`) — partial decrease no longer orphans the position (loss-of-funds closed). B.12 case added.
- **G-02** `zapOut` nonzero `amountOutMin` floor enforced in §3.7.3/§3.7.5 + added to §3.8 nonzero list — zero-native adapter call can no longer delete a position with no return (loss-of-funds closed). B.9(zapOut) case added.
- **MIG-1** A.3.ii native hop #2 idempotency switched from aggregate-V4-balance to per-NFT `exitDepositTxHash` + `perNftDeposited0G` map — multi-NFT resume no longer strands a skipped exit deposit (loss-of-funds closed). E.4.17b added.
- **MIG-2** GAP 12 inventory enumeration now NFPM `Transfer` event-scan + `lpNftOwner[tokenId]` direct reads, fail-closed `InventoryEnumerationUnavailable` (no swallow-on-revert) — deployer can no longer sweep non-deployer funds on 0xfd39 (loss-of-funds closed). E.4.2b added.
- **G-EXEC-1** `lpExitVault` changed from `immutable` to plain storage + `_lpExitVaultSet` one-time setter — Solidity now compiles.
- **G-EXEC-2** canonical env name `NEXT_PUBLIC_POLICY_VAULT_V4_REGISTRY_MAINNET_ADDRESS` across §7.1/§7.13/§10/§11.2 — resolver/deploy/.env aligned.

**Verify round 2 — highs CLOSED (11):** REG-3 (`policyHash` public on LpEntry), REG-4 (`poolAddressOf` on LpEntry+LpExit), REG-5 (sell agentKey gating explicit — exit-lockup preserved), G-03 (`rescueNft` on LpEntry+LpExit, B.1 retargeted), G-EXEC-3 (truncated AgenticID address → read from deployment json), G-EXEC-4 (enumeration via `totalSupply`+event filter+`AGENT_IDENTITY_MAINNET_FROM_BLOCK`), G-EXEC-5 (NFPM/SWAP_ROUTER/W0G/`MAINNET_FORK_RPC_URL` env added to §11.2), G-EXEC-6 (`IVaultRegistryV4.sol` added to §7.13 create-list), MIG-3 (GAP 16 stage-dispatch + branch (d) re-issue rescueNft), MIG-4 (agentKey→identity fail-closed `AgentKeyUnresolvable`), SIZE-1 (LpEntry re-estimated ~21-23KB + probe threshold `< 23000B`).

**Verify round 2 — mediums/lows CLOSED (17):** REG-6 (lp-exec.ts:225 / single-agent-server.ts:1060 retargeted), REG-7 (off-chain `vaultActionHashForLp` mirror version-gated + A.1.13 sub-case), G-04 (B.13 LP-entry isolation scenario), G-05 (B.11 `evm_setChainId(16661)` setup), G-06 (`_burnSideOk` quoted==0 exception documented + B.4 case), G-07 (B.10 non-owner actor + B.2 bytecode selector check), MIG-5 (zapOutTxHash + E.4.13b), MIG-6 (`allNftsResolved` PRE-condition + E.4.15b), MIG-7 (E.4.18b mid-loop resume), MIG-8 (GAP 24 post-rescue exit path + E.4.12b), SIZE-2 (sweepToken moved LpEntry→LpExit, exit-style no-cooldown), SIZE-3 (probe against real ZiaLpAdapterV4 delta), SIZE-4 (ZiaLpAdapterV4 ~8.2KB documented), G-EXEC-7 (policy-vault-v3.ts shared-shapes import), G-EXEC-8 (migrateToV4 `depositNative` wiring + §8 row), G-EXEC-9 (F.1–F.14 reconciled), G-EXEC-10 (LpActionRequest struct + adapter signatures noted).

**Justification:**
- The 3-way split is architecturally sound; LpEntry is the binding size constraint (~21-23KB) but the probe threshold is now `< 23000B` (forces preemptive shed) and sweepToken has been moved to LpExit to give LpEntry ~1.5-2KB headroom. The size-gate is the FIRST task and gates everything else.
- The test matrix is comprehensive: A.1–A.5 (regression + new functions + exit-lockup + owner recovery), B.1–B.13 (all 12 AGENTS.md security tests + cross-user blast-radius drill, now with zapOut-floor + partial-decrease + LP-entry-isolation cases), C.1–C.2 (adapter), D.1–D.12 (registry + onlyLpExit access-control), E.2–E.4 (migration with per-NFT idempotency + event-scan inventory + fail-closed agentKey + mid-loop resume + mainnet-fork dry-run E.4.24), F.1–F.14 (smoke, F.6/F.7 on Galileo per GAP 36), G (regression matrix), H (commands).
- The residual risks are concentrated in: (a) the unverified empirical LpEntry size headroom (R1) — the probe threshold is conservative but the actual bytecode is unmeasured until §3.9.5 runs; (b) AgenticID pinning (R3) — requires on-chain verification before any V4 work (procedure now concrete: `totalSupply`+event filter+roster reconcile); (c) the V3→V4 LP-NFT preservation orchestrator (R2) — the recovery path exists, is mainnet-fork-tested (E.4.24), per-NFT idempotent (MIG-1), and fail-closed (MIG-2/MIG-4), but the resume logic is complex; (d) the shared-executor blast radius (R8) — bounded, cross-user, drill-tested (B.13 swap + LP).

**What would raise confidence to 99% (post-round-3 — only execution-closable items remain):**
1. **R1 size-gate empirically confirmed (the ONLY blocker-class residual)** — at Phase-3, compile `PolicyVaultV4LpEntry.sol` and run `scripts/check-contract-size.ts` on the probe skeleton with wrapper bodies present (§3.9.5, `< 23000B` threshold + real-adapter delta per SIZE-3 revised) and observe each third pass. **This is closeable ONLY at Phase-3 execution — not by more spec.** With R1 confirmed, confidence reaches ~95%.
2. ~~R2 LP-NFT preservation dry-run on mainnet fork~~ — **CLOSED: E.4.24 + MIG-1/MIG-2/MIG-3/MIG-4/MIG-5/MIG-6/MIG-7/MIG-8 + round-3 F1/F2/F3 (ownerOf-keyed branch, NFPM ownerOf try/catch, MIG-6 on-chain assertion + exitDeposited stage name).**
3. **R3 AgenticID pinning verified on-chain** — at Phase-3 execution, verify `0x058c`/`0xa6c5` on-chain (chainId 16661) via `totalSupply` + event filter + roster reconcile (`0x7a968138` EXCLUDED unless rediscovered via chainscan) and pin `AGENT_IDENTITY_MAINNET_ADDRESS`. **Closes to 97% once on-chain verified.**
4. ~~R7 GAP 12 inventory gate~~ — **largely CLOSED: MIG-2 (event-scan + fail-closed) + MIG-4 (AgentKeyUnresolvable) + E.4.2b/E.4.2c + round-3 GAP-VR3-4 (from-block pinned to `min(NFPM_DEPLOY_BLOCK, V3_DEPLOY_BLOCK)` with `require(fromBlock <= NFPM_DEPLOY_BLOCK)`).** A second reviewer should still confirm the event-scan from-block covers the full 0xfd39 NFT roster.
5. ~~R8 shared-executor blast-radius drill~~ — **CLOSED: B.13 (swap + LP-entry scenarios + round-3 G-04-B13-lp-entry second scenario).**

After this round-3 pass, the only remaining 99%-raisers are execution-closable: R1 (empirical size-gate — the one blocker-class residual, Phase-3 compile + `<23000B` probe) and R3 (AgenticID on-chain pinning, Phase-3 on-chain verify → 97%). Spec-confidence after this pass = **~93%**; with R1 confirmed, **~95%**; with R1 + R3, **~97%**; expected **≥99%** after Phase-3 compile + size probe + on-chain AgenticID verify. The final 2-4% is irreducible residual on the migration orchestrator's resume complexity (R2) and the second-reviewer inventory audit (R7) — these are closed by execution + review, not by more spec.
