// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {IERC20} from "./interfaces/IERC20.sol";
import {IProofRegistry} from "./interfaces/IProofRegistry.sol";
import {IPolicyVaultAdapter} from "./interfaces/IPolicyVaultAdapter.sol";
import {IPolicyVaultLpAdapter} from "./interfaces/IPolicyVaultLpAdapter.sol";
import {Ownable} from "./utils/Ownable.sol";
import {ReentrancyGuard} from "./utils/ReentrancyGuard.sol";
import {SafeTransferLib} from "./utils/SafeTransferLib.sol";

/// @title PolicyVaultV3
/// @notice 0G Policy Vault V3 = V2 swap surface (byte-for-byte on buy/sell) + a trimmed LP primitive
///         layer shipped under EIP-170's 24KB cap: zapInMintLp, stakeLp, unstakeLp, zapOut, and a
///         reserved claimRewards slot (reverts RewardsNotConfigured). The full LP set
///         (zapInIncreaseLiquidity, decreaseLiquidity, collectFees, burnLp, sweepToken) is deferred
///         to v4; their LpActionType enum values are reserved (not renumbered) and the
///         IPolicyVaultLpAdapter interface still declares them as the v4 surface.
/// @dev Deny-by-default: no executor arbitrary call/delegatecall/multicall/raw calldata/arbitrary
///      target/recipient; never approve the executor; exact-tokenId ERC721 approvals; mock adapter
///      rejected on mainnet. LP pool / stake-vault allowlists gate ENTRY actions only (zapInMintLp,
///      stakeLp); EXIT actions (unstakeLp, unstakeLpOwner, zapOut) are authorized by the recorded
///      position so one-way disables cannot lock exits. See docs/vault-v3-plan.md section 0.
contract PolicyVaultV3 is Ownable, ReentrancyGuard {
    address public constant NATIVE_TOKEN = address(0);
    uint16 public constant BPS = 10_000;
    bytes32 public constant MOCK_ADAPTER_KIND = keccak256("4LPHA_0G_MOCK_ADAPTER");
    bytes32 public constant MOCK_LP_ADAPTER_KIND = keccak256("4LPHA_0G_MOCK_LP_ADAPTER");
    uint256 private constant MAINNET_CHAIN_ID = 16661;

    // =====================================================================
    // Structs
    // =====================================================================

    struct LpPolicy {
        uint256 perLpActionCap0G; // per-action native input cap (MINT/INCREASE)
        uint256 lpDailyCap0G; // separate daily cap for LP capital deployment
        uint256 maxLpExposure0G; // max total LP-deployed native (type(uint256).max = unbounded)
        uint256 cooldownSecondsLp; // LP-action cooldown
        uint16 lpMinOutBps; // slippage bps for LP amount0Min/amount1Min floors
        uint256 minLiquidityFloor; // absolute liquidity floor (supplements bps)
        bool allowStaking; // gates ENTRY to staking (STAKE_LP) only; exits (UNSTAKE_LP) and claimRewards are not gated by this flag (exit-lockup guard)
    }

    struct Policy {
        uint256 perTradeCap0G;
        uint256 dailyCap0G;
        uint256 maxExposure0G;
        uint256 cooldownSeconds;
        uint256 maxDeadlineWindowSeconds;
        uint16 defaultMinOutBps;
        LpPolicy lp; // V3 new
    }

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

    enum LpActionType {
        SWAP_BUY, // 0 — reserved (not accepted in LpActionRequest)
        SWAP_SELL, // 1 — reserved (not accepted in LpActionRequest)
        ZAP_IN_MINT_LP, // 2 — shipped
        ZAP_IN_INCREASE_LIQUIDITY, // 3 — v4-deferred (enum value reserved)
        DECREASE_LIQUIDITY, // 4 — v4-deferred (enum value reserved)
        COLLECT_FEES, // 5 — v4-deferred (enum value reserved)
        BURN_LP, // 6 — v4-deferred (enum value reserved)
        STAKE_LP, // 7 — shipped
        UNSTAKE_LP, // 8 — shipped
        SWEEP_TOKEN, // 9 — v4-deferred (enum value reserved)
        ZAP_OUT, // 10 — shipped
        CLAIM_REWARDS // 11 — shipped (stub, reverts RewardsNotConfigured)
    }

    struct LpActionRequest {
        uint8 actionType; // LpActionType, must be >= ZAP_IN_MINT_LP (2)
        bytes32 agentKey; // V2 carry-over
        bytes32 poolId; // LP pool allowlist key (allowedLpPools, pool-address-encoded); entry actions require it allowlisted, exits use it for position match
        address stakeVault; // STAKE/UNSTAKE only; address(0) otherwise
        address tokenIn; // SWEEP_TOKEN only; address(0) otherwise
        address tokenOut; // SWEEP_TOKEN only; address(0) otherwise (NATIVE_TOKEN allowed for native-out)
        uint256 tokenId; // 0 for ZAP_IN_MINT_LP; > 0 for tokenId actions
        int24 tickLower; // ZAP_IN_MINT / ZAP_IN_INCREASE (must match stored ticks for INCREASE)
        int24 tickUpper;
        uint256 amount0Desired; // ZAP: native 0G input (= amountIn0G); SWEEP: amount of tokenIn to swap
        uint256 amount1Desired; // unused on V3; 0
        uint128 liquidity; // uint128 (Codex round-4 BLOCKER 1) — no truncation gap vs adapter uint128
        uint256 amount0Min; // > 0 for MINT/INCREASE/DECREASE/ZAP_OUT (native/token0 floor)
        uint256 amount1Min; // > 0 for MINT/INCREASE/DECREASE/BURN; SWEEP: amountOutMin floor
        uint128 quotedLiquidity; // expected liquidity for MINT/INCREASE; 0 otherwise
        uint256 quotedAmount0; // expected token0 for DECREASE; 0 otherwise
        uint256 quotedAmount1; // expected token1 for DECREASE/BURN; 0 otherwise
        uint256 quotedAmountOut; // expected native out for ZAP_OUT; expected tokenOut for SWEEP; 0 otherwise
        uint256 deadline;
        uint256 nonce;
        bytes32 vaultActionHash;
        bytes32 actionHash;
        bytes32 policySnapshotHash;
        bytes32 auditRoot;
    }

    // =====================================================================
    // Errors (V2 verbatim + V3 LP)
    // =====================================================================

    error AdapterBlocked();
    error BadDelta();
    error BadPolicy();
    error CooldownActive();
    error DailyCapExceeded();
    error DeadlineExpired();
    error DeadlineTooFar();
    error ExecutorIsRevoked();
    error InvalidAdapter();
    error InvalidAmount();
    error InvalidAgentKey();
    error InvalidProof();
    error InvalidTradePair();
    error NotAllowed();
    error LowMinOut();
    error MaxExposureExceeded();
    error NotExecutor();
    error Paused();
    error Replay(bytes32 actionHash);
    error TradeCapExceeded();
    error UnexpectedValue();

    // V3 LP errors
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
    error LpInvalidMinOut();
    error NotAgentLpNft();
    error StakingDisabled();
    error RewardsNotConfigured();
    error NotStakedNft();
    error PoolMismatch();
    error LpLiquidityFloor();
    error LpPoolNotZappable();

    // =====================================================================
    // Immutables (V2 verbatim + LP adapter)
    // =====================================================================

    address public immutable executor;
    IPolicyVaultAdapter public immutable adapter;
    IPolicyVaultLpAdapter public immutable lpAdapter; // address(0) allowed = swap-only vault
    IProofRegistry public immutable proofRegistry;
    bool public immutable mockAdapterAllowed;
    bool public immutable mockLpAdapterAllowed;

    // =====================================================================
    // Storage — V2 port (verbatim) + V3 LP additions
    // =====================================================================

    Policy public policy;
    bool public paused;
    bool public executorRevoked;

    mapping(bytes32 actionHash => bool used) public usedActionHashes;
    mapping(address token => bool allowed) public allowedTokens;
    mapping(bytes32 poolId => bool allowed) public allowedPools; // swap pools (curated route IDs)
    mapping(bytes32 agentKey => bool enabled) public agentKeyEnabled;
    mapping(bytes32 agentKey => mapping(address token => uint256 units)) public agentPositionUnits;
    mapping(bytes32 agentKey => uint256 count) public agentOpenPositionCount;
    mapping(address token => uint256 units) public positionUnits;
    mapping(address tokenIn => mapping(address tokenOut => uint16 minOutBps)) private _minOutBpsByPair;
    uint256 public dailySpent0G;
    uint256 public dailyWindowStart;
    uint256 public lastTradeAt;
    uint256 public openExposure0G;

    // V3 LP allowlists
    mapping(bytes32 lpPoolId => bool allowed) public allowedLpPools; // LP pools, pool-address-encoded
    mapping(address stakeVault => bool allowed) public allowedStakeVaults;
    mapping(bytes32 lpPoolId => address stakeVault) public stakeVaultForLpPool; // pool -> Zia vault binding

    // V3 LP accounting
    mapping(bytes32 agentKey => mapping(bytes32 poolId => uint256[] tokenIds)) public agentLpNfts;
    mapping(uint256 tokenId => bytes32 ownerAgentKey) public lpNftOwner;
    mapping(uint256 tokenId => bytes32 poolId) public lpNftPool;
    mapping(bytes32 agentKey => mapping(address stakeVault => uint256[] tokenIds)) public agentStakedNfts;
    uint256 public lpDailySpent0G;
    uint256 public lpDailyWindowStart;
    uint256 public lastLpActionAt;
    uint256 public openLpExposure0G;
    mapping(bytes32 agentKey => uint256) public agentLpNotionalDeployed;
    mapping(uint256 tokenId => uint256) public lpNftDeployedNative;
    mapping(uint256 tokenId => int24) public lpNftTickLower;
    mapping(uint256 tokenId => int24) public lpNftTickUpper;

    // =====================================================================
    // Events (V2 verbatim + V3 LP)
    // =====================================================================

    event Deposited(address indexed owner, uint256 amount);
    event ExecutorRevoked(address indexed executor);
    event NativeWithdrawn(address indexed owner, uint256 amount);
    event PoolDisabled(bytes32 indexed poolId);
    event PoolAllowed(bytes32 indexed poolId);
    event PairMinOutBpsTightened(address indexed tokenIn, address indexed tokenOut, uint16 minOutBps);
    event PausedSet(bool paused);
    event PolicyTightened(Policy policy);
    event TokenAllowed(address indexed token);
    event TokenDisabled(address indexed token);
    event TokenRescued(address indexed token, uint256 amount);
    event AgentKeyEnabledSet(bytes32 indexed agentKey, bool enabled);
    event TradeExecuted(
        bytes32 indexed actionHash,
        bool indexed isBuy,
        address indexed token,
        uint256 amountIn,
        uint256 amountOut,
        bytes32 auditRoot,
        bytes32 policySnapshotHash
    );
    event TradeExecutedV2(
        bytes32 indexed actionHash,
        bytes32 indexed agentKey,
        bool indexed isBuy,
        address token,
        uint256 amountIn,
        uint256 amountOut,
        bytes32 auditRoot,
        bytes32 policySnapshotHash
    );

    // V3 LP events
    event LpPoolAllowed(bytes32 indexed poolId);
    event LpPoolDisabled(bytes32 indexed poolId);
    event StakeVaultAllowed(address indexed stakeVault);
    event StakeVaultDisabled(address indexed stakeVault);
    event LpPolicyTightened(LpPolicy lp);
    event LpActionExecutedV3(
        bytes32 indexed actionHash,
        bytes32 indexed agentKey,
        uint8 indexed actionType,
        bytes32 poolId,
        uint256 tokenId,
        uint256 amountIn0G,
        uint256 amountOut,
        int256 liquidityDelta,
        bytes32 auditRoot,
        bytes32 policySnapshotHash
    );
    event Staked(bytes32 indexed agentKey, uint256 indexed tokenId, address indexed stakeVault, bytes32 poolId);
    event Unstaked(bytes32 indexed agentKey, uint256 indexed tokenId, address indexed stakeVault, bytes32 poolId);
    event NftRescued(address indexed nft, uint256 indexed tokenId, address indexed to);
    event OwnerUnstaked(uint256 indexed tokenId, address indexed stakeVault);

    // =====================================================================
    // Modifiers (V2 verbatim + LP)
    // =====================================================================

    modifier onlyExecutor() {
        if (msg.sender != executor) {
            revert NotExecutor();
        }
        _;
    }

    modifier executorActive() {
        if (paused) {
            revert Paused();
        }
        if (executorRevoked) {
            revert ExecutorIsRevoked();
        }
        _;
    }

    modifier lpAdapterConfigured() {
        if (address(lpAdapter) == address(0)) {
            revert LpAdapterNotConfigured();
        }
        _;
    }

    // =====================================================================
    // Constructor
    // =====================================================================

    constructor(
        address initialOwner,
        address executor_,
        address adapter_,
        address lpAdapter_, // address(0) allowed (swap-only vault)
        address proofRegistry_,
        Policy memory initialPolicy,
        address[] memory initialAllowedTokens,
        bytes32[] memory initialAllowedPools,
        bytes32[] memory initialAllowedLpPools,
        address[] memory initialAllowedStakeVaults,
        address[] memory initialStakeVaultForLpPool, // parallel to initialAllowedLpPools
        bool allowMockAdapter,
        bool allowMockLpAdapter
    ) Ownable(initialOwner) {
        if (
            initialOwner == address(0) || executor_ == address(0) || adapter_ == address(0)
                || proofRegistry_ == address(0) || adapter_.code.length == 0 || proofRegistry_.code.length == 0
        ) {
            revert InvalidAdapter();
        }
        _validatePolicy(initialPolicy);
        if (initialAllowedTokens.length == 0 || initialAllowedPools.length == 0) {
            revert NotAllowed();
        }

        bytes32 adapterKind = IPolicyVaultAdapter(adapter_).adapterKind();
        if (adapterKind == MOCK_ADAPTER_KIND && (!allowMockAdapter || block.chainid == MAINNET_CHAIN_ID)) {
            revert AdapterBlocked();
        }

        // V3: LP adapter validation
        if (lpAdapter_ != address(0)) {
            if (lpAdapter_.code.length == 0) {
                revert InvalidAdapter();
            }
            bytes32 lpKind = IPolicyVaultLpAdapter(lpAdapter_).lpAdapterKind();
            if (lpKind == bytes32(0)) {
                revert InvalidAdapter();
            }
            if (lpKind == MOCK_LP_ADAPTER_KIND && (!allowMockLpAdapter || block.chainid == MAINNET_CHAIN_ID)) {
                revert AdapterBlocked();
            }
        }

        // Seed stake vault allowlist FIRST so the pool->vault binding can validate against it.
        for (uint256 i = 0; i < initialAllowedStakeVaults.length; i++) {
            if (initialAllowedStakeVaults[i] == address(0)) {
                revert NotAllowed();
            }
            allowedStakeVaults[initialAllowedStakeVaults[i]] = true;
            emit StakeVaultAllowed(initialAllowedStakeVaults[i]);
        }

        // Seed LP pools + pool->vault binding (parallel arrays).
        if (initialStakeVaultForLpPool.length != initialAllowedLpPools.length) {
            revert BadPolicy();
        }
        for (uint256 i = 0; i < initialAllowedLpPools.length; i++) {
            bytes32 lpPoolId = initialAllowedLpPools[i];
            if (lpPoolId == bytes32(0)) {
                revert NotAllowed();
            }
            allowedLpPools[lpPoolId] = true;
            emit LpPoolAllowed(lpPoolId);
            address sv = initialStakeVaultForLpPool[i];
            if (sv != address(0)) {
                if (!allowedStakeVaults[sv]) {
                    revert NotAllowed();
                }
                stakeVaultForLpPool[lpPoolId] = sv;
            }
        }

        executor = executor_;
        adapter = IPolicyVaultAdapter(adapter_);
        lpAdapter = IPolicyVaultLpAdapter(lpAdapter_);
        proofRegistry = IProofRegistry(proofRegistry_);
        policy = initialPolicy;
        mockAdapterAllowed = allowMockAdapter;
        mockLpAdapterAllowed = allowMockLpAdapter;

        for (uint256 i = 0; i < initialAllowedTokens.length; i++) {
            if (initialAllowedTokens[i] == address(0)) {
                revert NotAllowed();
            }
            allowedTokens[initialAllowedTokens[i]] = true;
            emit TokenAllowed(initialAllowedTokens[i]);
        }
        for (uint256 i = 0; i < initialAllowedPools.length; i++) {
            if (initialAllowedPools[i] == bytes32(0)) {
                revert NotAllowed();
            }
            allowedPools[initialAllowedPools[i]] = true;
            emit PoolAllowed(initialAllowedPools[i]);
        }
    }

    // =====================================================================
    // receive() — extended to accept native from the LP adapter (W0G.unwrap returns)
    // =====================================================================

    receive() external payable {
        if (msg.sender != owner() && msg.sender != address(adapter) && msg.sender != address(lpAdapter)) {
            revert NotAllowed();
        }
        emit Deposited(msg.sender, msg.value);
    }

    /// @notice Accept Zia NFPM NFTs returned by staking vault withdraw().
    /// @dev The vault records ownership before staking/unstaking; this hook only
    ///      allows ERC721 safe transfers to complete and does not authorize exits.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return 0x150b7a02;
    }

    // =====================================================================
    // Swap path — V2 VERBATIM (depositNative, withdrawNative, rescueToken,
    // setPaused, revokeExecutor, setAgentKeyEnabled, setAgentKeysEnabled,
    // disableToken, disablePool, tightenPairMinOutBps, buy, sell)
    // =====================================================================

    function depositNative() external payable onlyOwner {
        if (msg.value == 0) {
            revert InvalidAmount();
        }
        emit Deposited(msg.sender, msg.value);
    }

    function withdrawNative(uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0 || amount > address(this).balance) {
            revert InvalidAmount();
        }
        SafeTransferLib.safeTransferNative(owner(), amount);
        emit NativeWithdrawn(owner(), amount);
    }

    function rescueToken(address token, uint256 amount) external onlyOwner nonReentrant {
        if (token == address(0) || amount == 0) {
            revert InvalidAmount();
        }
        SafeTransferLib.safeTransfer(IERC20(token), owner(), amount);
        emit TokenRescued(token, amount);
    }

    function setPaused(bool value) external onlyOwner {
        paused = value;
        emit PausedSet(value);
    }

    function revokeExecutor() external onlyOwner {
        executorRevoked = true;
        emit ExecutorRevoked(executor);
    }

    function setAgentKeyEnabled(bytes32 agentKey, bool enabled) external onlyOwner {
        _setAgentKeyEnabled(agentKey, enabled);
    }

    function setAgentKeysEnabled(bytes32[] calldata agentKeys, bool enabled) external onlyOwner {
        for (uint256 i = 0; i < agentKeys.length; i++) {
            _setAgentKeyEnabled(agentKeys[i], enabled);
        }
    }

    function disableToken(address token) external onlyOwner {
        if (!allowedTokens[token]) {
            revert NotAllowed();
        }
        allowedTokens[token] = false;
        emit TokenDisabled(token);
    }

    function disablePool(bytes32 poolId) external onlyOwner {
        if (!allowedPools[poolId]) {
            revert NotAllowed();
        }
        allowedPools[poolId] = false;
        emit PoolDisabled(poolId);
    }

    function tightenPairMinOutBps(address tokenIn, address tokenOut, uint16 minOutBps) external onlyOwner {
        if (tokenIn == tokenOut || minOutBps > BPS || minOutBps < policy.defaultMinOutBps) {
            revert BadPolicy();
        }
        uint16 current = _minOutBpsByPair[tokenIn][tokenOut];
        if (current != 0 && minOutBps < current) {
            revert BadPolicy();
        }
        _minOutBpsByPair[tokenIn][tokenOut] = minOutBps;
        emit PairMinOutBpsTightened(tokenIn, tokenOut, minOutBps);
    }

    function buy(TradeRequest calldata request)
        external
        payable
        onlyExecutor
        executorActive
        nonReentrant
        returns (uint256 amountOut)
    {
        if (msg.value != 0) {
            revert UnexpectedValue();
        }
        if (request.tokenIn != NATIVE_TOKEN || request.tokenOut == NATIVE_TOKEN) {
            revert InvalidTradePair();
        }
        if (!allowedTokens[request.tokenOut] || !allowedPools[request.poolId]) {
            revert NotAllowed();
        }
        _validateAgentKey(request.agentKey);

        Policy memory currentPolicy = policy;
        _validateRequest(request, currentPolicy);
        _validateCooldown(currentPolicy);
        _validateBuySpendPolicy(request.amountIn, currentPolicy);
        _markAction(request.actionHash);

        uint256 nativeBefore = address(this).balance;
        uint256 tokenBefore = IERC20(request.tokenOut).balanceOf(address(this));
        if (nativeBefore < request.amountIn) {
            revert InvalidAmount();
        }

        amountOut = adapter.swapExactIn{value: request.amountIn}(
            request.tokenIn,
            request.tokenOut,
            request.amountIn,
            request.amountOutMin,
            request.poolId
        );

        uint256 nativeAfter = address(this).balance;
        uint256 tokenDelta = IERC20(request.tokenOut).balanceOf(address(this)) - tokenBefore;
        if (nativeBefore - nativeAfter != request.amountIn || tokenDelta < request.amountOutMin || tokenDelta < amountOut) {
            revert BadDelta();
        }

        positionUnits[request.tokenOut] += tokenDelta;
        _increaseAgentPosition(request.agentKey, request.tokenOut, tokenDelta);
        _recordBuySpend(request.amountIn);
        _recordTradeTimestamp();

        emit TradeExecuted(
            request.actionHash, true, request.tokenOut, request.amountIn, tokenDelta, request.auditRoot,
            request.policySnapshotHash
        );
        emit TradeExecutedV2(
            request.actionHash, request.agentKey, true, request.tokenOut, request.amountIn, tokenDelta,
            request.auditRoot, request.policySnapshotHash
        );
    }

    function sell(TradeRequest calldata request)
        external
        payable
        onlyExecutor
        executorActive
        nonReentrant
        returns (uint256 amountOut)
    {
        if (msg.value != 0) {
            revert UnexpectedValue();
        }
        if (request.tokenIn == NATIVE_TOKEN || request.tokenOut != NATIVE_TOKEN) {
            revert InvalidTradePair();
        }
        if (!allowedTokens[request.tokenIn] || !allowedPools[request.poolId]) {
            revert NotAllowed();
        }
        _validateAgentKey(request.agentKey);

        Policy memory currentPolicy = policy;
        _validateRequest(request, currentPolicy);
        _validateCooldown(currentPolicy);

        uint256 unitsBefore = positionUnits[request.tokenIn];
        uint256 agentUnitsBefore = agentPositionUnits[request.agentKey][request.tokenIn];
        if (request.amountIn == 0 || unitsBefore < request.amountIn || agentUnitsBefore < request.amountIn) {
            revert InvalidAmount();
        }

        _markAction(request.actionHash);

        IERC20 tokenIn = IERC20(request.tokenIn);
        uint256 tokenBefore = tokenIn.balanceOf(address(this));
        uint256 nativeBefore = address(this).balance;

        SafeTransferLib.forceApprove(tokenIn, address(adapter), request.amountIn);
        amountOut = adapter.swapExactIn(
            request.tokenIn, request.tokenOut, request.amountIn, request.amountOutMin, request.poolId
        );
        SafeTransferLib.forceApprove(tokenIn, address(adapter), 0);

        uint256 tokenDelta = tokenBefore - tokenIn.balanceOf(address(this));
        uint256 nativeDelta = address(this).balance - nativeBefore;
        if (tokenDelta != request.amountIn || nativeDelta < request.amountOutMin || nativeDelta < amountOut) {
            revert BadDelta();
        }

        positionUnits[request.tokenIn] = unitsBefore - request.amountIn;
        _decreaseAgentPosition(request.agentKey, request.tokenIn, agentUnitsBefore, request.amountIn);
        _reduceOpenExposure(nativeDelta);
        _recordTradeTimestamp();

        emit TradeExecuted(
            request.actionHash, false, request.tokenIn, request.amountIn, nativeDelta, request.auditRoot,
            request.policySnapshotHash
        );
        emit TradeExecutedV2(
            request.actionHash, request.agentKey, false, request.tokenIn, request.amountIn, nativeDelta,
            request.auditRoot, request.policySnapshotHash
        );
    }

    // =====================================================================
    // V3 owner-only rescue paths (Critique finding 1)
    // =====================================================================

    function rescueNft(address nft, uint256 tokenId) external onlyOwner nonReentrant {
        IERC721(nft).transferFrom(address(this), owner(), tokenId);
        emit NftRescued(nft, tokenId, owner());
    }

    function unstakeLpOwner(uint256 tokenId, address stakeVault) external onlyOwner nonReentrant {
        // EXIT — owner override authorized by staked-membership, not current allowlist, so
        // disableStakeVault cannot lock the owner out of rescuing a staked NFT (Codex exit-lockup fix).
        bytes32 ownerAgent = lpNftOwner[tokenId];
        if (!_removeAgentStakedNft(ownerAgent, stakeVault, tokenId)) {
            revert NotStakedNft();
        }
        IZiaVault(stakeVault).withdraw(tokenId);
        if (IERC721(lpAdapter.nfpm()).ownerOf(tokenId) != address(this)) {
            revert LpBadDelta();
        }
        _pushAgentLpNft(ownerAgent, lpNftPool[tokenId], tokenId);
        emit Unstaked(ownerAgent, tokenId, stakeVault, lpNftPool[tokenId]);
        emit OwnerUnstaked(tokenId, stakeVault);
    }

    // =====================================================================
    // V3 LP allowlist management (one-way disable)
    // =====================================================================

    function disableLpPool(bytes32 lpPoolId) external onlyOwner {
        if (!allowedLpPools[lpPoolId]) {
            revert NotAllowed();
        }
        allowedLpPools[lpPoolId] = false;
        emit LpPoolDisabled(lpPoolId);
    }

    function disableStakeVault(address stakeVault) external onlyOwner {
        if (!allowedStakeVaults[stakeVault]) {
            revert NotAllowed();
        }
        allowedStakeVaults[stakeVault] = false;
        emit StakeVaultDisabled(stakeVault);
    }

    // =====================================================================
    // tightenPolicy — extended tightening rules (V2 swap fields + LpPolicy)
    // =====================================================================

    function tightenPolicy(Policy calldata nextPolicy) external onlyOwner {
        _validatePolicy(nextPolicy);
        Policy memory current = policy;
        if (
            nextPolicy.perTradeCap0G > current.perTradeCap0G || nextPolicy.dailyCap0G > current.dailyCap0G
                || nextPolicy.maxExposure0G > current.maxExposure0G || nextPolicy.cooldownSeconds < current.cooldownSeconds
                || nextPolicy.maxDeadlineWindowSeconds > current.maxDeadlineWindowSeconds
                || nextPolicy.defaultMinOutBps < current.defaultMinOutBps
        ) {
            revert BadPolicy();
        }
        LpPolicy memory n = nextPolicy.lp;
        LpPolicy memory c = current.lp;
        if (
            n.perLpActionCap0G > c.perLpActionCap0G || n.lpDailyCap0G > c.lpDailyCap0G
                || n.maxLpExposure0G > c.maxLpExposure0G || n.cooldownSecondsLp < c.cooldownSecondsLp
                || n.lpMinOutBps < c.lpMinOutBps || (n.allowStaking && !c.allowStaking)
        ) {
            revert BadPolicy();
        }
        if (n.minLiquidityFloor < c.minLiquidityFloor) {
            revert BadPolicy();
        }
        policy = nextPolicy;
        emit PolicyTightened(nextPolicy);
        emit LpPolicyTightened(nextPolicy.lp);
    }

    // =====================================================================
    // LP entrypoints
    // =====================================================================

    function zapInMintLp(LpActionRequest calldata request)
        external
        payable
        onlyExecutor
        executorActive
        lpAdapterConfigured
        nonReentrant
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        if (msg.value != 0) {
            revert UnexpectedValue();
        }
        if (request.actionType != uint8(LpActionType.ZAP_IN_MINT_LP)) {
            revert InvalidActionType();
        }
        Policy memory currentPolicy = policy;
        _validateLpRequest(request, currentPolicy);
        // ENTRY allowlist check — new positions require the pool to still be allowlisted.
        if (!allowedLpPools[request.poolId]) {
            revert InvalidLpPool();
        }
        // Per-action validation
        if (
            request.tokenId != 0 || request.tickLower >= request.tickUpper || request.amount0Desired == 0
                || request.amount1Desired != 0 || request.liquidity == 0
        ) {
            revert InvalidLpAmount();
        }
        if (request.liquidity < currentPolicy.lp.minLiquidityFloor) {
            revert LpLiquidityFloor();
        }
        if (
            request.quotedLiquidity == 0 || request.amount0Min == 0 || request.amount1Min == 0
                || request.liquidity < minLpOutFor(request.quotedLiquidity)
                || request.amount0Min < minLpOutFor(request.quotedAmount0)
                || request.amount1Min < minLpOutFor(request.quotedAmount1)
        ) {
            revert LpInvalidMinOut();
        }
        if (request.stakeVault != address(0)) {
            revert InvalidActionType();
        }
        // W0G-leg requirement (Codex round-3 major fix)
        address wnative = lpAdapter.wrappedNative();
        (address t0, address t1,) = lpAdapter.poolTokens(request.poolId);
        if (t0 != wnative && t1 != wnative) {
            revert LpPoolNotZappable();
        }
        // LP spend policy + cooldown (deploying)
        uint256 amountIn0G = request.amount0Desired;
        _validateLpSpendPolicy(amountIn0G, currentPolicy.lp);
        _validateLpCooldown(currentPolicy.lp);

        _markLpAction(request.actionHash);

        // Adapter call: vault wraps 0G -> W0G, forceApprove adapter, zap-mint, clear approval.
        IERC20 wnativeToken = IERC20(wnative);
        uint256 nativeBefore = address(this).balance;
        uint256 w0gBefore = wnativeToken.balanceOf(address(this));
        uint256 nfpmBefore = IERC721(lpAdapter.nfpm()).balanceOf(address(this));

        IWrappedNative(wnative).deposit{value: amountIn0G}();
        SafeTransferLib.forceApprove(wnativeToken, address(lpAdapter), amountIn0G);
        (tokenId, liquidity, amount0, amount1) = lpAdapter.zapInMintLp(
            IPolicyVaultLpAdapter.ZapInMintParams({
                poolId: request.poolId,
                vaultAddress: address(this),
                token0: t0,
                token1: t1,
                fee: _poolFeeOf(request.poolId),
                tickLower: request.tickLower,
                tickUpper: request.tickUpper,
                amount0G: amountIn0G,
                amount0Min: request.amount0Min,
                amount1Min: request.amount1Min,
                deadline: request.deadline
            })
        );
        SafeTransferLib.forceApprove(wnativeToken, address(lpAdapter), 0);

        // Delta checks
        uint256 w0gAfter = wnativeToken.balanceOf(address(this));
        uint256 w0gRefund = w0gAfter >= w0gBefore ? w0gAfter - w0gBefore : type(uint256).max;
        if (
            nativeBefore - address(this).balance != amountIn0G
                || w0gAfter < w0gBefore
                || w0gRefund >= amountIn0G
                || IERC721(lpAdapter.nfpm()).balanceOf(address(this)) - nfpmBefore != 1
                || liquidity < request.liquidity || amount0 < request.amount0Min || amount1 < request.amount1Min
        ) {
            revert LpBadDelta();
        }
        uint256 deployedNative = amountIn0G - w0gRefund;

        // Accounting
        bytes32 poolId = request.poolId;
        lpNftOwner[tokenId] = request.agentKey;
        lpNftPool[tokenId] = poolId;
        lpNftDeployedNative[tokenId] = deployedNative;
        lpNftTickLower[tokenId] = request.tickLower;
        lpNftTickUpper[tokenId] = request.tickUpper;
        _pushAgentLpNft(request.agentKey, poolId, tokenId);
        _recordLpBuySpend(deployedNative);
        _bumpAgentLpNotional(request.agentKey, deployedNative);
        _recordLpActionTimestamp();

        emit LpActionExecutedV3(
            request.actionHash, request.agentKey, uint8(LpActionType.ZAP_IN_MINT_LP), poolId, tokenId, deployedNative, 0,
            int256(uint256(liquidity)), request.auditRoot, request.policySnapshotHash
        );
    }

    function stakeLp(LpActionRequest calldata request)
        external
        payable
        onlyExecutor
        executorActive
        lpAdapterConfigured
        nonReentrant
    {
        if (msg.value != 0) {
            revert UnexpectedValue();
        }
        if (request.actionType != uint8(LpActionType.STAKE_LP)) {
            revert InvalidActionType();
        }
        Policy memory currentPolicy = policy;
        _validateLpRequest(request, currentPolicy);
        if (request.tokenId == 0 || lpNftOwner[request.tokenId] != request.agentKey) {
            revert NotAgentLpNft();
        }
        if (request.poolId != lpNftPool[request.tokenId]) {
            revert PoolMismatch();
        }
        // ENTRY allowlist check — new stake commitments require pool + stake vault still allowlisted.
        if (!allowedLpPools[request.poolId]) {
            revert InvalidLpPool();
        }
        if (!currentPolicy.lp.allowStaking) {
            revert StakingDisabled();
        }
        if (request.stakeVault != stakeVaultForLpPool[lpNftPool[request.tokenId]]) {
            revert InvalidStakeVault();
        }
        if (!allowedStakeVaults[request.stakeVault] || request.stakeVault == address(0)) {
            revert NotAllowed();
        }
        if (
            request.amount0Desired != 0 || request.amount1Desired != 0 || request.liquidity != 0
                || request.amount0Min != 0 || request.amount1Min != 0
        ) {
            revert InvalidActionType();
        }
        _validateLpCooldown(currentPolicy.lp); // deploying

        _markLpAction(request.actionHash);

        address nfpm = lpAdapter.nfpm();
        if (IERC721(nfpm).ownerOf(request.tokenId) != address(this)) {
            revert LpBadDelta();
        }

        // Vault-direct stake: vault approves the Zia vault, then calls deposit directly.
        IERC721(nfpm).approve(request.stakeVault, request.tokenId);
        IZiaVault(request.stakeVault).deposit(request.tokenId);
        // DO NOT clear approval after deposit — ERC721 auto-clears on transfer; vault is no longer owner.

        if (IERC721(nfpm).ownerOf(request.tokenId) != request.stakeVault) {
            revert LpBadDelta();
        }
        if (IZiaVault(request.stakeVault).depositorOf(request.tokenId) != address(this)) {
            revert LpBadDelta();
        }

        _removeAgentLpNft(request.agentKey, request.poolId, request.tokenId);
        _pushAgentStakedNft(request.agentKey, request.stakeVault, request.tokenId);
        _recordLpActionTimestamp();

        emit Staked(request.agentKey, request.tokenId, request.stakeVault, request.poolId);
        emit LpActionExecutedV3(
            request.actionHash, request.agentKey, uint8(LpActionType.STAKE_LP), request.poolId, request.tokenId, 0, 0, 0,
            request.auditRoot, request.policySnapshotHash
        );
    }

    function unstakeLp(LpActionRequest calldata request)
        external
        payable
        onlyExecutor
        executorActive
        lpAdapterConfigured
        nonReentrant
    {
        if (msg.value != 0) {
            revert UnexpectedValue();
        }
        if (request.actionType != uint8(LpActionType.UNSTAKE_LP)) {
            revert InvalidActionType();
        }
        Policy memory currentPolicy = policy;
        _validateLpRequest(request, currentPolicy);
        if (request.tokenId == 0 || lpNftOwner[request.tokenId] != request.agentKey) {
            revert NotAgentLpNft();
        }
        if (request.poolId != lpNftPool[request.tokenId]) {
            revert PoolMismatch();
        }
        // EXIT — authorized by the recorded position, NOT by current allowlists. The canonical
        // pool->vault mapping + staked-membership confirm the NFT is actually staked there, so
        // disableStakeVault / allowStaking=false tighten new stakes without locking unstake.
        if (request.stakeVault == address(0) || request.stakeVault != stakeVaultForLpPool[lpNftPool[request.tokenId]]) {
            revert InvalidStakeVault();
        }
        if (!_isAgentStakedNft(request.agentKey, request.stakeVault, request.tokenId)) {
            revert NotStakedNft();
        }
        // NO cooldown (capital-returning, exempt)

        _markLpAction(request.actionHash);

        IZiaVault(request.stakeVault).withdraw(request.tokenId);
        address nfpm = lpAdapter.nfpm();
        if (IERC721(nfpm).ownerOf(request.tokenId) != address(this)) {
            revert LpBadDelta();
        }
        if (IZiaVault(request.stakeVault).depositorOf(request.tokenId) != address(0)) {
            revert LpBadDelta();
        }

        _removeAgentStakedNft(request.agentKey, request.stakeVault, request.tokenId);
        _pushAgentLpNft(request.agentKey, request.poolId, request.tokenId);

        emit Unstaked(request.agentKey, request.tokenId, request.stakeVault, request.poolId);
        emit LpActionExecutedV3(
            request.actionHash, request.agentKey, uint8(LpActionType.UNSTAKE_LP), request.poolId, request.tokenId, 0, 0, 0,
            request.auditRoot, request.policySnapshotHash
        );
    }

    function zapOut(LpActionRequest calldata request)
        external
        payable
        onlyExecutor
        executorActive
        lpAdapterConfigured
        nonReentrant
        returns (uint256 amountOut)
    {
        if (msg.value != 0) {
            revert UnexpectedValue();
        }
        if (request.actionType != uint8(LpActionType.ZAP_OUT)) {
            revert InvalidActionType();
        }
        Policy memory currentPolicy = policy;
        _validateLpRequest(request, currentPolicy);
        if (request.tokenId == 0 || lpNftOwner[request.tokenId] != request.agentKey) {
            revert NotAgentLpNft();
        }
        if (request.poolId != lpNftPool[request.tokenId]) {
            revert PoolMismatch();
        }
        if (
            request.liquidity == 0 || request.liquidity > lpAdapter.liquidityOf(request.tokenId) || request.amount0Min == 0
                || request.quotedAmountOut == 0 || request.amount0Min < minLpOutFor(request.quotedAmountOut)
        ) {
            revert InvalidLpAmount();
        }
        if (request.stakeVault != address(0)) {
            revert InvalidActionType();
        }
        if (!_isAgentLpNft(request.agentKey, request.poolId, request.tokenId)) {
            revert NotAgentLpNft();
        }
        // NO cooldown (capital-returning, exempt)

        _markLpAction(request.actionHash);

        address nfpm = lpAdapter.nfpm();
        uint256 nfpmBefore = IERC721(nfpm).balanceOf(address(this));
        uint256 nativeBefore = address(this).balance;
        uint128 totalLiq = lpAdapter.liquidityOf(request.tokenId);

        _approveLpAdapterForNft(request.tokenId);
        amountOut = lpAdapter.zapOut(
            IPolicyVaultLpAdapter.ZapOutParams({
                tokenId: request.tokenId,
                poolId: request.poolId,
                liquidity: request.liquidity,
                amountOutMin: request.amount0Min,
                deadline: request.deadline
            })
        );
        bool fullBurn = request.liquidity == totalLiq;
        if (fullBurn) {
            // NFT burned — DO NOT clear approval (vault no longer owner, would revert).
            if (nfpmBefore - IERC721(nfpm).balanceOf(address(this)) != 1) {
                revert LpBadDelta();
            }
        } else {
            _clearLpAdapterNftApproval(request.tokenId);
        }

        uint256 nativeDelta = address(this).balance - nativeBefore;
        if (nativeDelta < request.amount0Min || nativeDelta < amountOut) {
            revert LpBadDelta();
        }

        // Accounting — no ghost exposure (subtract STORED deployed, not nativeDelta)
        uint256 deployed = lpNftDeployedNative[request.tokenId];
        if (fullBurn) {
            _reduceLpExposure(request.agentKey, request.tokenId, deployed);
            _removeAgentLpNft(request.agentKey, request.poolId, request.tokenId);
            delete lpNftOwner[request.tokenId];
            delete lpNftPool[request.tokenId];
            delete lpNftDeployedNative[request.tokenId];
            delete lpNftTickLower[request.tokenId];
            delete lpNftTickUpper[request.tokenId];
        } else {
            uint256 nativeFreed = deployed * uint256(request.liquidity) / uint256(totalLiq);
            _reduceLpExposure(request.agentKey, request.tokenId, nativeFreed);
        }

        emit LpActionExecutedV3(
            request.actionHash, request.agentKey, uint8(LpActionType.ZAP_OUT), request.poolId, request.tokenId, 0,
            nativeDelta, -int256(uint256(request.liquidity)), request.auditRoot, request.policySnapshotHash
        );
    }

    /// @notice Reserved slot — reverts unconditionally. Standalone no-modifier entrypoint
    ///         (Codex round-5 major 1 fix): NO onlyExecutor/executorActive/lpAdapterConfigured/nonReentrant,
    ///         carved out of _validateLpRequest so no other error can mask RewardsNotConfigured.
    function claimRewards(LpActionRequest calldata) external payable {
        revert RewardsNotConfigured();
    }

    // =====================================================================
    // Views
    // =====================================================================

    function minOutBpsFor(address tokenIn, address tokenOut) public view returns (uint16) {
        uint16 pairBps = _minOutBpsByPair[tokenIn][tokenOut];
        return pairBps == 0 ? policy.defaultMinOutBps : pairBps;
    }

    function minOutFor(address tokenIn, address tokenOut, uint256 quotedAmountOut) public view returns (uint256) {
        return (quotedAmountOut * minOutBpsFor(tokenIn, tokenOut)) / BPS;
    }

    /// @dev ceilDiv(quote * lpMinOutBps, BPS) — Codex round-4 major 3 + round-5 minor 1 fix.
    function minLpOutFor(uint256 quote) internal view returns (uint256) {
        uint16 bps = policy.lp.lpMinOutBps;
        return (quote * bps + (BPS - 1)) / BPS;
    }

    function policyHash() public view returns (bytes32) {
        return _policyHash(policy);
    }

    function actionHashFor(
        bytes32 vaultActionHash,
        bytes32 auditRoot,
        bytes32 policySnapshotHash
    ) public pure returns (bytes32) {
        return keccak256(abi.encode("4LPHA_0G_POLICY_VAULT_PROOF", vaultActionHash, auditRoot, policySnapshotHash));
    }

    function vaultActionHashFor(bool isBuy, TradeRequest calldata request) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                "4LPHA_0G_POLICY_VAULT_ACTION",
                block.chainid,
                address(this),
                owner(),
                executor,
                address(adapter),
                address(proofRegistry),
                isBuy,
                request.tokenIn,
                request.tokenOut,
                request.amountIn,
                request.quotedAmountOut,
                request.amountOutMin,
                request.deadline,
                request.nonce,
                request.agentKey,
                request.poolId,
                request.policySnapshotHash,
                request.auditRoot
            )
        );
    }

    function vaultActionHashForLp(LpActionRequest calldata request) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                "4LPHA_0G_POLICY_VAULT_ACTION_LP",
                block.chainid,
                address(this),
                owner(),
                executor,
                address(adapter),
                address(lpAdapter),
                address(proofRegistry),
                request.actionType,
                request.agentKey,
                request.poolId,
                request.stakeVault,
                request.tokenIn,
                request.tokenOut,
                request.tokenId,
                request.tickLower,
                request.tickUpper,
                request.amount0Desired,
                request.amount1Desired,
                request.liquidity,
                request.amount0Min,
                request.amount1Min,
                request.quotedLiquidity,
                request.quotedAmount0,
                request.quotedAmount1,
                request.quotedAmountOut,
                request.deadline,
                request.nonce,
                request.policySnapshotHash,
                request.auditRoot
            )
        );
    }

    /// @dev Recover the pool address from a pool-address-encoded poolId.
    function poolAddressOf(bytes32 poolId) public pure returns (address) {
        return address(uint160(uint256(poolId)));
    }

    // =====================================================================
    // Swap-path helpers (V2 verbatim)
    // =====================================================================

    function _validateRequest(TradeRequest calldata request, Policy memory currentPolicy) private view {
        if (request.amountIn == 0 || request.quotedAmountOut == 0 || request.amountOutMin == 0) {
            revert InvalidAmount();
        }
        if (request.deadline < block.timestamp) {
            revert DeadlineExpired();
        }
        if (request.deadline > block.timestamp + currentPolicy.maxDeadlineWindowSeconds) {
            revert DeadlineTooFar();
        }
        if (request.amountOutMin < minOutFor(request.tokenIn, request.tokenOut, request.quotedAmountOut)) {
            revert LowMinOut();
        }
        if (
            request.actionHash == bytes32(0) || request.vaultActionHash == bytes32(0) || request.auditRoot == bytes32(0)
                || request.policySnapshotHash == bytes32(0) || request.policySnapshotHash != _policyHash(currentPolicy)
        ) {
            revert InvalidProof();
        }
        bool isBuy = request.tokenIn == NATIVE_TOKEN;
        if (request.vaultActionHash != vaultActionHashFor(isBuy, request)) {
            revert InvalidProof();
        }
        if (request.actionHash != actionHashFor(request.vaultActionHash, request.auditRoot, request.policySnapshotHash)) {
            revert InvalidProof();
        }
        if (!proofRegistry.isAccepted(request.actionHash, request.auditRoot, request.policySnapshotHash, request.vaultActionHash)) {
            revert InvalidProof();
        }
        if (usedActionHashes[request.actionHash]) {
            revert Replay(request.actionHash);
        }
    }

    function _validateAgentKey(bytes32 agentKey) private view {
        if (agentKey == bytes32(0)) {
            revert InvalidAgentKey();
        }
        if (!agentKeyEnabled[agentKey]) {
            revert NotAllowed();
        }
    }

    function _validateBuySpendPolicy(uint256 amountIn, Policy memory currentPolicy) private view {
        if (amountIn > currentPolicy.perTradeCap0G) {
            revert TradeCapExceeded();
        }
        if (openExposure0G + amountIn > currentPolicy.maxExposure0G) {
            revert MaxExposureExceeded();
        }
        uint256 currentWindowStart = dailyWindowStart;
        uint256 currentDailySpent = dailySpent0G;
        if (currentWindowStart == 0 || block.timestamp >= currentWindowStart + 1 days) {
            currentDailySpent = 0;
        }
        if (currentDailySpent + amountIn > currentPolicy.dailyCap0G) {
            revert DailyCapExceeded();
        }
    }

    function _validateCooldown(Policy memory currentPolicy) private view {
        if (currentPolicy.cooldownSeconds != 0 && lastTradeAt != 0 && block.timestamp < lastTradeAt + currentPolicy.cooldownSeconds) {
            revert CooldownActive();
        }
    }

    function _markAction(bytes32 actionHash) private {
        usedActionHashes[actionHash] = true;
    }

    function _setAgentKeyEnabled(bytes32 agentKey, bool enabled) private {
        if (agentKey == bytes32(0)) {
            revert InvalidAgentKey();
        }
        agentKeyEnabled[agentKey] = enabled;
        emit AgentKeyEnabledSet(agentKey, enabled);
    }

    function _increaseAgentPosition(bytes32 agentKey, address token, uint256 amount) private {
        uint256 previous = agentPositionUnits[agentKey][token];
        if (previous == 0) {
            agentOpenPositionCount[agentKey] += 1;
        }
        agentPositionUnits[agentKey][token] = previous + amount;
    }

    function _decreaseAgentPosition(bytes32 agentKey, address token, uint256 previous, uint256 amount) private {
        uint256 next = previous - amount;
        agentPositionUnits[agentKey][token] = next;
        if (next == 0) {
            agentOpenPositionCount[agentKey] -= 1;
        }
    }

    function _recordBuySpend(uint256 amountIn) private {
        if (dailyWindowStart == 0 || block.timestamp >= dailyWindowStart + 1 days) {
            dailyWindowStart = block.timestamp;
            dailySpent0G = amountIn;
        } else {
            dailySpent0G += amountIn;
        }
        openExposure0G += amountIn;
    }

    function _reduceOpenExposure(uint256 nativeReturned) private {
        uint256 currentExposure = openExposure0G;
        openExposure0G = nativeReturned >= currentExposure ? 0 : currentExposure - nativeReturned;
    }

    function _recordTradeTimestamp() private {
        lastTradeAt = block.timestamp;
    }

    function _validatePolicy(Policy memory candidate) private pure {
        if (
            candidate.maxDeadlineWindowSeconds == 0 || candidate.maxDeadlineWindowSeconds > 1 days
                || candidate.defaultMinOutBps == 0 || candidate.defaultMinOutBps > BPS
        ) {
            revert BadPolicy();
        }
        _validateLpPolicy(candidate.lp);
    }

    function _validateLpPolicy(LpPolicy memory lp) private pure {
        if (lp.lpMinOutBps == 0 || lp.lpMinOutBps > BPS) {
            revert BadPolicy();
        }
    }

    function _policyHash(Policy memory candidate) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
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
            )
        );
    }

    // =====================================================================
    // LP helpers
    // =====================================================================

    function _validateLpRequest(LpActionRequest calldata request, Policy memory currentPolicy) private view {
        if (request.actionType < uint8(LpActionType.ZAP_IN_MINT_LP)) {
            revert InvalidActionType();
        }
        if (request.deadline < block.timestamp) {
            revert DeadlineExpired();
        }
        if (request.deadline > block.timestamp + currentPolicy.maxDeadlineWindowSeconds) {
            revert DeadlineTooFar();
        }
        // tokenIn/tokenOut must be zero for all retained LP entrypoints (sweep deferred to v4).
        if (request.tokenIn != address(0) || request.tokenOut != address(0)) {
            revert InvalidActionType();
        }
        if (request.policySnapshotHash != _policyHash(currentPolicy)) {
            revert InvalidProof();
        }
        if (request.vaultActionHash != vaultActionHashForLp(request)) {
            revert InvalidProof();
        }
        if (request.actionHash != actionHashFor(request.vaultActionHash, request.auditRoot, request.policySnapshotHash)) {
            revert InvalidProof();
        }
        if (!proofRegistry.isAccepted(request.actionHash, request.auditRoot, request.policySnapshotHash, request.vaultActionHash)) {
            revert InvalidProof();
        }
        if (usedActionHashes[request.actionHash]) {
            revert Replay(request.actionHash);
        }
        _validateAgentKey(request.agentKey);
        // LP pool / stake-vault allowlists are enforced on ENTRY actions only (zapInMintLp,
        // stakeLp). EXIT actions (unstakeLp, unstakeLpOwner, zapOut) are authorized by the
        // recorded position (lpNftPool[tokenId] / staked-membership), so that one-way disables
        // (disableLpPool / disableStakeVault) tighten new deployments without locking exits —
        // Codex high-severity exit-lockup fix.
    }

    function _validateLpSpendPolicy(uint256 amountIn0G, LpPolicy memory lpPolicy) private view {
        if (amountIn0G > lpPolicy.perLpActionCap0G) {
            revert LpCapExceeded();
        }
        if (openLpExposure0G + amountIn0G > lpPolicy.maxLpExposure0G) {
            revert LpExposureExceeded();
        }
        uint256 windowStart = lpDailyWindowStart;
        uint256 spent = lpDailySpent0G;
        if (windowStart == 0 || block.timestamp >= windowStart + 1 days) {
            spent = 0;
        }
        if (spent + amountIn0G > lpPolicy.lpDailyCap0G) {
            revert LpDailyCapExceeded();
        }
    }

    function _validateLpCooldown(LpPolicy memory lpPolicy) private view {
        if (
            lpPolicy.cooldownSecondsLp != 0 && lastLpActionAt != 0
                && block.timestamp < lastLpActionAt + lpPolicy.cooldownSecondsLp
        ) {
            revert LpCooldownActive();
        }
    }

    function _markLpAction(bytes32 actionHash) private {
        usedActionHashes[actionHash] = true;
    }

    function _recordLpBuySpend(uint256 amountIn0G) private {
        if (lpDailyWindowStart == 0 || block.timestamp >= lpDailyWindowStart + 1 days) {
            lpDailyWindowStart = block.timestamp;
            lpDailySpent0G = amountIn0G;
        } else {
            lpDailySpent0G += amountIn0G;
        }
        openLpExposure0G += amountIn0G;
    }

    function _bumpAgentLpNotional(bytes32 agentKey, uint256 amountIn0G) private {
        agentLpNotionalDeployed[agentKey] += amountIn0G;
    }

    function _recordLpActionTimestamp() private {
        lastLpActionAt = block.timestamp;
    }

    function _reduceLpExposure(bytes32 agentKey, uint256 tokenId, uint256 nativeFreed) private {
        uint256 currentExposure = openLpExposure0G;
        openLpExposure0G = nativeFreed >= currentExposure ? 0 : currentExposure - nativeFreed;
        uint256 deployed = lpNftDeployedNative[tokenId];
        lpNftDeployedNative[tokenId] = nativeFreed >= deployed ? 0 : deployed - nativeFreed;
        uint256 agentNotional = agentLpNotionalDeployed[agentKey];
        agentLpNotionalDeployed[agentKey] = nativeFreed >= agentNotional ? 0 : agentNotional - nativeFreed;
    }

    function _approveLpAdapterForNft(uint256 tokenId) private {
        IERC721(lpAdapter.nfpm()).approve(address(lpAdapter), tokenId);
    }

    function _clearLpAdapterNftApproval(uint256 tokenId) private {
        IERC721(lpAdapter.nfpm()).approve(address(0), tokenId);
    }

    function _poolFeeOf(bytes32 poolId) private view returns (uint24) {
        (, , uint24 fee) = lpAdapter.poolTokens(poolId);
        return fee;
    }

    function _pushAgentLpNft(bytes32 agentKey, bytes32 poolId, uint256 tokenId) private {
        agentLpNfts[agentKey][poolId].push(tokenId);
    }

    function _removeAgentLpNft(bytes32 agentKey, bytes32 poolId, uint256 tokenId) private {
        uint256[] storage arr = agentLpNfts[agentKey][poolId];
        uint256 len = arr.length;
        for (uint256 i = 0; i < len; i++) {
            if (arr[i] == tokenId) {
                if (i != len - 1) {
                    arr[i] = arr[len - 1];
                }
                arr.pop();
                return;
            }
        }
    }

    function _isAgentLpNft(bytes32 agentKey, bytes32 poolId, uint256 tokenId) private view returns (bool) {
        uint256[] storage arr = agentLpNfts[agentKey][poolId];
        uint256 len = arr.length;
        for (uint256 i = 0; i < len; i++) {
            if (arr[i] == tokenId) {
                return true;
            }
        }
        return false;
    }

    function _pushAgentStakedNft(bytes32 agentKey, address stakeVault, uint256 tokenId) private {
        agentStakedNfts[agentKey][stakeVault].push(tokenId);
    }

    function _removeAgentStakedNft(bytes32 agentKey, address stakeVault, uint256 tokenId) private returns (bool) {
        uint256[] storage arr = agentStakedNfts[agentKey][stakeVault];
        uint256 len = arr.length;
        for (uint256 i = 0; i < len; i++) {
            if (arr[i] == tokenId) {
                if (i != len - 1) {
                    arr[i] = arr[len - 1];
                }
                arr.pop();
                return true;
            }
        }
        return false;
    }

    function _isAgentStakedNft(bytes32 agentKey, address stakeVault, uint256 tokenId) private view returns (bool) {
        uint256[] storage arr = agentStakedNfts[agentKey][stakeVault];
        uint256 len = arr.length;
        for (uint256 i = 0; i < len; i++) {
            if (arr[i] == tokenId) {
                return true;
            }
        }
        return false;
    }
}

// =====================================================================
// Minimal inline interfaces (vault-direct staking + NFT rescue + W0G wrap)
// =====================================================================

interface IERC721 {
    function ownerOf(uint256 tokenId) external view returns (address);
    function balanceOf(address owner) external view returns (uint256);
    function transferFrom(address from, address to, uint256 tokenId) external;
    function approve(address to, uint256 tokenId) external;
    function getApproved(uint256 tokenId) external view returns (address);
}

interface IZiaVault {
    function deposit(uint256 tokenId) external;
    function withdraw(uint256 tokenId) external;
    function depositorOf(uint256 tokenId) external view returns (address);
}

interface IWrappedNative {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}
