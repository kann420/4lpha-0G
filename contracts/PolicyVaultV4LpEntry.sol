// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";
import {IProofRegistry} from "./interfaces/IProofRegistry.sol";
import {IPolicyVaultLpAdapter} from "./interfaces/IPolicyVaultLpAdapter.sol";
import {IVaultRegistryV4} from "./interfaces/IVaultRegistryV4.sol";
import {Ownable} from "./utils/Ownable.sol";
import {ReentrancyGuard} from "./utils/ReentrancyGuard.sol";
import {SafeTransferLib} from "./utils/SafeTransferLib.sol";

interface IPolicyVaultV4LpExitView {
    function lpEntry() external view returns (address);
}

contract PolicyVaultV4LpEntry is Ownable, ReentrancyGuard {
    address public constant NATIVE_TOKEN = address(0);
    uint16 public constant BPS = 10_000;
    bytes32 public constant MOCK_LP_ADAPTER_KIND = keccak256("4LPHA_0G_MOCK_LP_ADAPTER");
    uint256 private constant MAINNET_CHAIN_ID = 16661;

    struct LpPolicy {
        uint256 perLpActionCap0G;
        uint256 lpDailyCap0G;
        uint256 maxLpExposure0G;
        uint256 cooldownSecondsLp;
        uint16 lpMinOutBps;
        uint256 minLiquidityFloor;
        bool allowStaking;
    }

    enum LpActionType {
        SWAP_BUY,
        SWAP_SELL,
        ZAP_IN_MINT_LP,
        ZAP_IN_INCREASE_LIQUIDITY,
        DECREASE_LIQUIDITY,
        COLLECT_FEES,
        BURN_LP,
        STAKE_LP,
        UNSTAKE_LP,
        SWEEP_TOKEN,
        ZAP_OUT,
        CLAIM_REWARDS
    }

    struct LpActionRequest {
        uint8 actionType;
        bytes32 agentKey;
        bytes32 poolId;
        address stakeVault;
        address tokenIn;
        address tokenOut;
        uint256 tokenId;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint128 liquidity;
        uint256 amount0Min;
        uint256 amount1Min;
        uint128 quotedLiquidity;
        uint256 quotedAmount0;
        uint256 quotedAmount1;
        uint256 quotedAmountOut;
        uint256 deadline;
        uint256 nonce;
        bytes32 vaultActionHash;
        bytes32 actionHash;
        bytes32 policySnapshotHash;
        bytes32 auditRoot;
    }

    error AdapterBlocked();
    error BadPolicy();
    error DeadlineExpired();
    error DeadlineTooFar();
    error ExecutorIsRevoked();
    error InvalidAdapter();
    error InvalidAgentKey();
    error InvalidProof();
    error NotAllowed();
    error NotExecutor();
    error Paused();
    error Replay(bytes32 actionHash);
    error UnexpectedValue();
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
    error NotStakedNft();
    error PoolMismatch();
    error LpLiquidityFloor();
    error LpPoolNotZappable();
    error BadParams();
    error LpTickMismatch();
    error LpPositionNotEmpty();
    error NotVaultNft();
    error AlreadyRegistered();
    error LpEntryMismatch();

    address public immutable executor;
    IPolicyVaultLpAdapter public immutable lpAdapter;
    IProofRegistry public immutable proofRegistry;
    bool public immutable mockLpAdapterAllowed;
    IVaultRegistryV4 public immutable vaultRegistry;

    LpPolicy public policy;
    bool public paused;
    bool public executorRevoked;
    mapping(bytes32 actionHash => bool used) public usedActionHashes;
    mapping(bytes32 agentKey => bool enabled) public agentKeyEnabled;
    mapping(bytes32 poolId => bool allowed) public allowedLpPools;
    mapping(bytes32 poolId => address stakeVault) public stakeVaultForLpPool;
    mapping(address stakeVault => bool allowed) public allowedStakeVaults;
    mapping(uint256 tokenId => bytes32 agentKey) public lpNftOwner;
    mapping(uint256 tokenId => bytes32 poolId) public lpNftPool;
    mapping(uint256 tokenId => int24 tickLower) public lpNftTickLower;
    mapping(uint256 tokenId => int24 tickUpper) public lpNftTickUpper;
    mapping(uint256 tokenId => uint256 deployedNative) public lpNftDeployedNative;
    mapping(bytes32 agentKey => mapping(bytes32 poolId => uint256[] tokenIds)) public agentLpNfts;
    mapping(bytes32 agentKey => mapping(address stakeVault => uint256[] tokenIds)) public agentStakedNfts;
    mapping(bytes32 agentKey => mapping(uint256 tokenId => bool staked)) private _isStaked;
    mapping(bytes32 agentKey => uint256 deployedNative) public agentLpNotionalDeployed;
    uint256 public openLpExposure0G;
    uint256 public lpDailySpent0G;
    uint256 public lpDailyWindowStart;
    uint256 public lastLpActionAt;
    address public lpExitVault;
    bool internal _lpExitVaultSet;

    event Deposited(address indexed owner, uint256 amount);
    event ExecutorRevoked(address indexed executor);
    event NativeWithdrawn(address indexed owner, uint256 amount);
    event PausedSet(bool paused);
    event TokenRescued(address indexed token, uint256 amount);
    event AgentKeyEnabledSet(bytes32 indexed agentKey, bool enabled);
    event LpPoolAllowed(bytes32 indexed poolId);
    event LpPoolDisabled(bytes32 indexed poolId);
    event StakeVaultAllowed(address indexed stakeVault);
    event StakeVaultDisabled(address indexed stakeVault);
    event LpPolicyTightened(LpPolicy lp);
    event LpExitVaultSet(address indexed lpExitVault);
    event LpNftImported(uint256 indexed tokenId, bytes32 indexed agentKey, bytes32 indexed poolId, uint256 deployedNative0G);
    event NftRescued(address indexed nft, uint256 indexed tokenId, address indexed to);
    event Staked(bytes32 indexed agentKey, uint256 indexed tokenId, address indexed stakeVault, bytes32 poolId);
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

    modifier onlyLpExit() {
        if (msg.sender != lpExitVault) {
            revert LpEntryMismatch();
        }
        _;
    }

    constructor(
        address initialOwner,
        address executor_,
        address lpAdapter_,
        address proofRegistry_,
        bool allowMockLpAdapter,
        address vaultRegistry_,
        LpPolicy memory initialPolicy,
        bytes32[] memory initialAllowedLpPools,
        address[] memory initialAllowedStakeVaults,
        address[] memory initialStakeVaultForLpPool
    ) Ownable(initialOwner) {
        if (initialOwner != msg.sender) {
            revert NotAllowed();
        }
        if (
            executor_ == address(0) || lpAdapter_ == address(0) || proofRegistry_ == address(0)
                || vaultRegistry_ == address(0) || lpAdapter_.code.length == 0 || proofRegistry_.code.length == 0
                || vaultRegistry_.code.length == 0
        ) {
            revert InvalidAdapter();
        }
        _validateLpPolicy(initialPolicy);
        if (initialStakeVaultForLpPool.length != initialAllowedLpPools.length) {
            revert BadPolicy();
        }

        bytes32 lpKind = IPolicyVaultLpAdapter(lpAdapter_).lpAdapterKind();
        if (lpKind == MOCK_LP_ADAPTER_KIND && (!allowMockLpAdapter || block.chainid == MAINNET_CHAIN_ID)) {
            revert AdapterBlocked();
        }

        executor = executor_;
        lpAdapter = IPolicyVaultLpAdapter(lpAdapter_);
        proofRegistry = IProofRegistry(proofRegistry_);
        mockLpAdapterAllowed = allowMockLpAdapter;
        vaultRegistry = IVaultRegistryV4(vaultRegistry_);
        policy = initialPolicy;

        for (uint256 i = 0; i < initialAllowedStakeVaults.length; i++) {
            if (initialAllowedStakeVaults[i] == address(0)) {
                revert NotAllowed();
            }
            allowedStakeVaults[initialAllowedStakeVaults[i]] = true;
            emit StakeVaultAllowed(initialAllowedStakeVaults[i]);
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
    }

    receive() external payable {
        if (msg.sender != owner() && msg.sender != address(lpAdapter)) {
            revert NotAllowed();
        }
        emit Deposited(msg.sender, msg.value);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return 0x150b7a02;
    }

    function depositNative() external payable onlyOwner {
        if (msg.value == 0) {
            revert InvalidLpAmount();
        }
        emit Deposited(msg.sender, msg.value);
    }

    function withdrawNative(uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0 || amount > address(this).balance) {
            revert InvalidLpAmount();
        }
        SafeTransferLib.safeTransferNative(owner(), amount);
        emit NativeWithdrawn(owner(), amount);
    }

    function rescueToken(address token, uint256 amount) external onlyOwner nonReentrant {
        if (token == address(0) || amount == 0) {
            revert InvalidLpAmount();
        }
        SafeTransferLib.safeTransfer(IERC20(token), owner(), amount);
        emit TokenRescued(token, amount);
    }

    function rescueNft(uint256 tokenId, address) external onlyOwner nonReentrant {
        address nfpm = lpAdapter.nfpm();
        IERC721(nfpm).transferFrom(address(this), owner(), tokenId);
        emit NftRescued(nfpm, tokenId, owner());
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

    function disableLpPool(bytes32 poolId) external onlyOwner {
        if (!allowedLpPools[poolId]) {
            revert NotAllowed();
        }
        allowedLpPools[poolId] = false;
        emit LpPoolDisabled(poolId);
    }

    function disableStakeVault(address stakeVault) external onlyOwner {
        if (!allowedStakeVaults[stakeVault]) {
            revert NotAllowed();
        }
        allowedStakeVaults[stakeVault] = false;
        emit StakeVaultDisabled(stakeVault);
    }

    function tightenLpPolicy(LpPolicy calldata nextPolicy) external onlyOwner {
        _validateLpPolicy(nextPolicy);
        LpPolicy memory current = policy;
        if (
            nextPolicy.perLpActionCap0G > current.perLpActionCap0G
                || nextPolicy.lpDailyCap0G > current.lpDailyCap0G
                || nextPolicy.maxLpExposure0G > current.maxLpExposure0G
                || nextPolicy.cooldownSecondsLp < current.cooldownSecondsLp
                || nextPolicy.lpMinOutBps < current.lpMinOutBps
                || nextPolicy.minLiquidityFloor < current.minLiquidityFloor
                || (nextPolicy.allowStaking && !current.allowStaking)
        ) {
            revert BadPolicy();
        }
        policy = nextPolicy;
        emit LpPolicyTightened(nextPolicy);
    }

    function setLpExitVault(address candidate) external onlyOwner {
        if (_lpExitVaultSet || candidate == address(0)) {
            revert NotAllowed();
        }
        if (vaultRegistry.lpExitVaultOf(owner()) != candidate) {
            revert NotAllowed();
        }
        if (IPolicyVaultV4LpExitView(candidate).lpEntry() != address(this)) {
            revert NotAllowed();
        }
        lpExitVault = candidate;
        _lpExitVaultSet = true;
        emit LpExitVaultSet(candidate);
    }

    function zapInMintLp(LpActionRequest calldata request)
        external
        payable
        onlyExecutor
        executorActive
        lpAdapterConfigured
        nonReentrant
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        if (msg.value != 0 || request.actionType != uint8(LpActionType.ZAP_IN_MINT_LP)) {
            revert InvalidActionType();
        }
        if (!allowedLpPools[request.poolId] || request.tokenId != 0 || request.amount0Desired == 0 || request.amount1Desired != 0) {
            revert InvalidLpPool();
        }
        if (
            request.amount0Min == 0 || request.amount1Min == 0 || request.quotedLiquidity == 0
                || request.amount0Min < minLpOutFor(request.quotedAmount0)
                || request.amount1Min < minLpOutFor(request.quotedAmount1)
        ) {
            revert LpInvalidMinOut();
        }
        if (request.quotedLiquidity < policy.minLiquidityFloor) {
            revert LpLiquidityFloor();
        }

        LpPolicy memory currentPolicy = policy;
        _validateLpRequest(request, currentPolicy, true);
        _validateLpSpendPolicy(request.amount0Desired, currentPolicy);
        _validateLpCooldown(currentPolicy);
        _markLpAction(request.actionHash);

        address wnative = lpAdapter.wrappedNative();
        (address token0, address token1, uint24 fee) = lpAdapter.poolTokens(request.poolId);
        if (token0 != wnative && token1 != wnative) {
            revert LpPoolNotZappable();
        }
        uint256 nativeBefore = address(this).balance;
        uint256 w0gBefore = IERC20(wnative).balanceOf(address(this));
        if (nativeBefore < request.amount0Desired) {
            revert InvalidLpAmount();
        }
        IWrappedNative(wnative).deposit{value: request.amount0Desired}();
        SafeTransferLib.forceApprove(IERC20(wnative), address(lpAdapter), request.amount0Desired);
        (tokenId, liquidity, amount0, amount1) = lpAdapter.zapInMintLp(
            IPolicyVaultLpAdapter.ZapInMintParams({
                poolId: request.poolId,
                vaultAddress: address(this),
                token0: token0,
                token1: token1,
                fee: fee,
                tickLower: request.tickLower,
                tickUpper: request.tickUpper,
                amount0G: request.amount0Desired,
                amount0Min: request.amount0Min,
                amount1Min: request.amount1Min,
                deadline: request.deadline
            })
        );
        SafeTransferLib.forceApprove(IERC20(wnative), address(lpAdapter), 0);

        uint256 w0gRefund = IERC20(wnative).balanceOf(address(this)) - w0gBefore;
        if (
            liquidity < request.quotedLiquidity || liquidity < policy.minLiquidityFloor || amount0 < request.amount0Min
                || amount1 < request.amount1Min || w0gRefund >= request.amount0Desired
        ) {
            revert LpBadDelta();
        }
        uint256 deployedNative = request.amount0Desired - w0gRefund;
        lpNftOwner[tokenId] = request.agentKey;
        lpNftPool[tokenId] = request.poolId;
        lpNftTickLower[tokenId] = request.tickLower;
        lpNftTickUpper[tokenId] = request.tickUpper;
        lpNftDeployedNative[tokenId] = deployedNative;
        _pushAgentLpNft(request.agentKey, request.poolId, tokenId);
        _recordLpBuySpend(deployedNative);
        _bumpAgentLpNotional(request.agentKey, deployedNative);
        _recordLpActionTimestamp();

        emit LpActionExecutedV3(
            request.actionHash,
            request.agentKey,
            request.actionType,
            request.poolId,
            tokenId,
            request.amount0Desired,
            0,
            int256(uint256(liquidity)),
            request.auditRoot,
            request.policySnapshotHash
        );
    }

    function zapInIncreaseLiquidity(LpActionRequest calldata request)
        external
        payable
        onlyExecutor
        executorActive
        lpAdapterConfigured
        nonReentrant
        returns (uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        if (msg.value != 0 || request.actionType != uint8(LpActionType.ZAP_IN_INCREASE_LIQUIDITY)) {
            revert InvalidActionType();
        }
        _requireAgentNft(request.agentKey, request.poolId, request.tokenId);
        if (request.amount0Desired == 0 || request.amount1Desired != 0 || request.liquidity == 0) {
            revert InvalidLpAmount();
        }
        if (request.liquidity < policy.minLiquidityFloor) {
            revert LpLiquidityFloor();
        }
        if (
            request.amount0Min == 0 || request.amount1Min == 0 || request.quotedAmount0 == 0
                || request.quotedAmount1 == 0 || request.amount0Min < minLpOutFor(request.quotedAmount0)
                || request.amount1Min < minLpOutFor(request.quotedAmount1)
        ) {
            revert LpInvalidMinOut();
        }
        if (lpNftTickLower[request.tokenId] != request.tickLower || lpNftTickUpper[request.tokenId] != request.tickUpper) {
            revert LpTickMismatch();
        }

        LpPolicy memory currentPolicy = policy;
        _validateLpRequest(request, currentPolicy, true);
        _validateLpSpendPolicy(request.amount0Desired, currentPolicy);
        _validateLpCooldown(currentPolicy);
        _markLpAction(request.actionHash);

        address wnative = lpAdapter.wrappedNative();
        (address token0, address token1,) = lpAdapter.poolTokens(request.poolId);
        if (token0 != wnative && token1 != wnative) {
            revert LpPoolNotZappable();
        }
        uint256 w0gBefore = IERC20(wnative).balanceOf(address(this));
        IWrappedNative(wnative).deposit{value: request.amount0Desired}();
        SafeTransferLib.forceApprove(IERC20(wnative), address(lpAdapter), request.amount0Desired);
        (liquidity, amount0, amount1) = lpAdapter.zapInIncreaseLiquidity(
            IPolicyVaultLpAdapter.ZapIncreaseParams({
                tokenId: request.tokenId,
                poolId: request.poolId,
                amount0G: request.amount0Desired,
                amount0Min: request.amount0Min,
                amount1Min: request.amount1Min,
                deadline: request.deadline
            })
        );
        SafeTransferLib.forceApprove(IERC20(wnative), address(lpAdapter), 0);

        uint256 w0gRefund = IERC20(wnative).balanceOf(address(this)) - w0gBefore;
        if (w0gRefund >= request.amount0Desired || liquidity < request.liquidity || amount0 < request.amount0Min || amount1 < request.amount1Min) {
            revert LpBadDelta();
        }
        uint256 deployedNative = request.amount0Desired - w0gRefund;
        lpNftDeployedNative[request.tokenId] += deployedNative;
        _recordLpBuySpend(deployedNative);
        _bumpAgentLpNotional(request.agentKey, deployedNative);
        _recordLpActionTimestamp();

        emit LpActionExecutedV3(
            request.actionHash,
            request.agentKey,
            request.actionType,
            request.poolId,
            request.tokenId,
            request.amount0Desired,
            0,
            int256(uint256(liquidity)),
            request.auditRoot,
            request.policySnapshotHash
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
        if (msg.value != 0 || request.actionType != uint8(LpActionType.STAKE_LP) || request.stakeVault == address(0)) {
            revert InvalidActionType();
        }
        if (!policy.allowStaking) {
            revert StakingDisabled();
        }
        _requireAgentNft(request.agentKey, request.poolId, request.tokenId);
        if (!allowedStakeVaults[request.stakeVault] || stakeVaultForLpPool[request.poolId] != request.stakeVault) {
            revert InvalidStakeVault();
        }
        LpPolicy memory currentPolicy = policy;
        _validateLpRequest(request, currentPolicy, true);
        _validateLpCooldown(currentPolicy);
        _markLpAction(request.actionHash);

        IERC721(lpAdapter.nfpm()).approve(request.stakeVault, request.tokenId);
        IZiaVault(request.stakeVault).deposit(request.tokenId);
        _pushAgentStakedNft(request.agentKey, request.stakeVault, request.tokenId);
        _isStaked[request.agentKey][request.tokenId] = true;
        _recordLpActionTimestamp();

        emit Staked(request.agentKey, request.tokenId, request.stakeVault, request.poolId);
        emit LpActionExecutedV3(
            request.actionHash,
            request.agentKey,
            request.actionType,
            request.poolId,
            request.tokenId,
            0,
            0,
            0,
            request.auditRoot,
            request.policySnapshotHash
        );
    }

    function importLpNft(
        uint256 tokenId,
        bytes32 agentKey,
        bytes32 poolId,
        int24 tickLower,
        int24 tickUpper,
        uint256 deployedNative0G
    ) external onlyOwner nonReentrant lpAdapterConfigured {
        if (IERC721(lpAdapter.nfpm()).ownerOf(tokenId) != address(this)) {
            revert NotVaultNft();
        }
        if (lpNftOwner[tokenId] != bytes32(0)) {
            revert AlreadyRegistered();
        }
        if (!agentKeyEnabled[agentKey]) {
            revert NotAllowed();
        }
        if (!allowedLpPools[poolId]) {
            revert InvalidLpPool();
        }
        (int24 tl, int24 tu) = lpAdapter.positionTicks(tokenId);
        if (tl != tickLower || tu != tickUpper) {
            revert LpTickMismatch();
        }
        _validateLpSpendPolicy(deployedNative0G, policy);
        lpNftOwner[tokenId] = agentKey;
        lpNftPool[tokenId] = poolId;
        lpNftTickLower[tokenId] = tl;
        lpNftTickUpper[tokenId] = tu;
        lpNftDeployedNative[tokenId] = deployedNative0G;
        _pushAgentLpNft(agentKey, poolId, tokenId);
        _recordLpBuySpend(deployedNative0G);
        _bumpAgentLpNotional(agentKey, deployedNative0G);
        emit LpNftImported(tokenId, agentKey, poolId, deployedNative0G);
    }

    function lpNftOwnerOf(uint256 tokenId) external view onlyLpExit returns (bytes32) {
        return lpNftOwner[tokenId];
    }

    function lpNftPoolOf(uint256 tokenId) external view onlyLpExit returns (bytes32) {
        return lpNftPool[tokenId];
    }

    function lpNftTicksOf(uint256 tokenId) external view onlyLpExit returns (int24, int24) {
        return (lpNftTickLower[tokenId], lpNftTickUpper[tokenId]);
    }

    function lpNftDeployedNativeOf(uint256 tokenId) external view onlyLpExit returns (uint256) {
        return lpNftDeployedNative[tokenId];
    }

    function isStaked(bytes32 agentKey, uint256 tokenId) external view onlyLpExit returns (bool) {
        return _isStaked[agentKey][tokenId];
    }

    function markUnstaked(bytes32 agentKey, uint256 tokenId, address stakeVault) external onlyLpExit {
        if (!_removeAgentStakedNft(agentKey, stakeVault, tokenId)) {
            revert NotStakedNft();
        }
        _isStaked[agentKey][tokenId] = false;
    }

    function withdrawStakedNftToEntry(bytes32 agentKey, uint256 tokenId, address stakeVault) external onlyLpExit {
        if (!_isStaked[agentKey][tokenId]) {
            revert NotStakedNft();
        }
        // Defense-in-depth: even though LpExit.unstakeLp validates the stakeVault against the
        // allowlist + stakeVaultForLpPool before calling here, the actual IZiaVault.withdraw
        // call happens in LpEntry, so LpEntry must independently reject any un-allowlisted
        // target. This blocks an arbitrary-target call by a compromised executor at the
        // contract that actually makes the external call (deny-by-default, no arbitrary target).
        if (!allowedStakeVaults[stakeVault]) {
            revert InvalidStakeVault();
        }
        IZiaVault(stakeVault).withdraw(tokenId);
    }

    function ownerWithdrawStakedNftToEntry(uint256 tokenId, address stakeVault) external onlyLpExit {
        bytes32 agentKey = lpNftOwner[tokenId];
        if (agentKey == bytes32(0)) {
            revert NotAgentLpNft();
        }
        IZiaVault(stakeVault).withdraw(tokenId);
        if (!_removeAgentStakedNft(agentKey, stakeVault, tokenId)) {
            revert NotStakedNft();
        }
        _isStaked[agentKey][tokenId] = false;
    }

    function moveNftToExit(uint256 tokenId) external onlyLpExit {
        IERC721(lpAdapter.nfpm()).transferFrom(address(this), lpExitVault, tokenId);
    }

    function reduceLpDeployment(uint256 tokenId, uint256 nativeFreed) external onlyLpExit {
        bytes32 agentKey = lpNftOwner[tokenId];
        if (agentKey == bytes32(0)) {
            revert NotAgentLpNft();
        }
        _reduceLpExposure(agentKey, tokenId, nativeFreed);
    }

    function purgeLpNft(uint256 tokenId) external onlyLpExit {
        if (lpAdapter.liquidityOf(tokenId) != 0) {
            revert LpPositionNotEmpty();
        }
        bytes32 agentKey = lpNftOwner[tokenId];
        bytes32 poolId = lpNftPool[tokenId];
        if (agentKey == bytes32(0)) {
            revert NotAgentLpNft();
        }
        uint256 deployed = lpNftDeployedNative[tokenId];
        _reduceLpExposure(agentKey, tokenId, deployed);
        _removeAgentLpNft(agentKey, poolId, tokenId);
        delete lpNftOwner[tokenId];
        delete lpNftPool[tokenId];
        delete lpNftTickLower[tokenId];
        delete lpNftTickUpper[tokenId];
        delete lpNftDeployedNative[tokenId];
    }

    function isLpNftStaked(bytes32 agentKey, uint256 tokenId) external view returns (bool) {
        return _isStaked[agentKey][tokenId];
    }

    function minLpOutFor(uint256 quote) public view returns (uint256) {
        return (quote * policy.lpMinOutBps + (BPS - 1)) / BPS;
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

    function vaultActionHashForLp(LpActionRequest calldata request) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                "4LPHA_0G_POLICY_VAULT_ACTION_LP",
                block.chainid,
                address(this),
                owner(),
                executor,
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

    function poolAddressOf(bytes32 poolId) public pure returns (address) {
        return address(uint160(uint256(poolId)));
    }

    function _validateLpRequest(LpActionRequest calldata request, LpPolicy memory currentPolicy, bool validateAgent)
        private
        view
    {
        if (request.actionType < uint8(LpActionType.ZAP_IN_MINT_LP)) {
            revert InvalidActionType();
        }
        if (request.deadline < block.timestamp) {
            revert DeadlineExpired();
        }
        if (request.deadline > block.timestamp + 1 days) {
            revert DeadlineTooFar();
        }
        if (
            request.actionHash == bytes32(0) || request.vaultActionHash == bytes32(0) || request.auditRoot == bytes32(0)
                || request.policySnapshotHash == bytes32(0) || request.policySnapshotHash != _policyHash(currentPolicy)
        ) {
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
        if (validateAgent) {
            _validateAgentKey(request.agentKey);
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

    function _setAgentKeyEnabled(bytes32 agentKey, bool enabled) private {
        if (agentKey == bytes32(0)) {
            revert InvalidAgentKey();
        }
        agentKeyEnabled[agentKey] = enabled;
        emit AgentKeyEnabledSet(agentKey, enabled);
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

    function _requireAgentNft(bytes32 agentKey, bytes32 poolId, uint256 tokenId) private view {
        if (lpNftOwner[tokenId] != agentKey) {
            revert NotAgentLpNft();
        }
        if (lpNftPool[tokenId] != poolId) {
            revert PoolMismatch();
        }
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

    function _validateLpPolicy(LpPolicy memory lp) private pure {
        if (lp.lpMinOutBps == 0 || lp.lpMinOutBps > BPS) {
            revert BadPolicy();
        }
    }

    function _policyHash(LpPolicy memory candidate) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                candidate.perLpActionCap0G,
                candidate.lpDailyCap0G,
                candidate.maxLpExposure0G,
                candidate.cooldownSecondsLp,
                candidate.lpMinOutBps,
                candidate.minLiquidityFloor,
                candidate.allowStaking
            )
        );
    }
}

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
