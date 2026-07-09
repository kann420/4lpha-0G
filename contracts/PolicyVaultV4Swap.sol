// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";
import {IProofRegistry} from "./interfaces/IProofRegistry.sol";
import {IPolicyVaultAdapter} from "./interfaces/IPolicyVaultAdapter.sol";
import {IVaultRegistryV4} from "./interfaces/IVaultRegistryV4.sol";
import {Ownable} from "./utils/Ownable.sol";
import {ReentrancyGuard} from "./utils/ReentrancyGuard.sol";
import {SafeTransferLib} from "./utils/SafeTransferLib.sol";

contract PolicyVaultV4Swap is Ownable, ReentrancyGuard {
    address public constant NATIVE_TOKEN = address(0);
    uint16 public constant BPS = 10_000;
    bytes32 public constant MOCK_ADAPTER_KIND = keccak256("4LPHA_0G_MOCK_ADAPTER");
    uint256 private constant MAINNET_CHAIN_ID = 16661;

    struct Policy {
        uint256 perTradeCap0G;
        uint256 dailyCap0G;
        uint256 maxExposure0G;
        uint256 cooldownSeconds;
        uint256 maxDeadlineWindowSeconds;
        uint16 defaultMinOutBps;
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
    error InvalidRecipient();
    error InvalidTradePair();
    error NotAllowed();
    error LowMinOut();
    error MaxExposureExceeded();
    error NotExecutor();
    error Paused();
    error Replay(bytes32 actionHash);
    error TradeCapExceeded();
    error UnexpectedValue();

    address public immutable executor;
    IPolicyVaultAdapter public immutable swapAdapter;
    IProofRegistry public immutable proofRegistry;
    bool public immutable mockAdapterAllowed;
    IVaultRegistryV4 public immutable vaultRegistry;

    Policy public policy;
    bool public paused;
    bool public executorRevoked;

    mapping(bytes32 actionHash => bool used) public usedActionHashes;
    mapping(address token => bool allowed) public allowedTokens;
    mapping(bytes32 poolId => bool allowed) public allowedPools;
    mapping(bytes32 agentKey => bool enabled) public agentKeyEnabled;
    mapping(bytes32 agentKey => mapping(address token => uint256 units)) public agentPositionUnits;
    mapping(bytes32 agentKey => uint256 count) public agentOpenPositionCount;
    mapping(address token => uint256 units) public positionUnits;
    mapping(address tokenIn => mapping(address tokenOut => uint16 minOutBps)) private _minOutBpsByPair;
    uint256 public dailySpent0G;
    uint256 public dailyWindowStart;
    uint256 public lastTradeAt;
    uint256 public openExposure0G;

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

    constructor(
        address initialOwner,
        address executor_,
        address swapAdapter_,
        address proofRegistry_,
        Policy memory initialPolicy,
        address[] memory initialAllowedTokens,
        bytes32[] memory initialAllowedPools,
        bool allowMockAdapter,
        address vaultRegistry_
    ) Ownable(initialOwner) {
        if (initialOwner != msg.sender) {
            revert NotAllowed();
        }
        if (
            executor_ == address(0) || swapAdapter_ == address(0) || proofRegistry_ == address(0)
                || vaultRegistry_ == address(0) || swapAdapter_.code.length == 0 || proofRegistry_.code.length == 0
                || vaultRegistry_.code.length == 0
        ) {
            revert InvalidAdapter();
        }
        _validatePolicy(initialPolicy);
        if (initialAllowedTokens.length == 0 || initialAllowedPools.length == 0) {
            revert NotAllowed();
        }

        bytes32 adapterKind = IPolicyVaultAdapter(swapAdapter_).adapterKind();
        if (adapterKind == MOCK_ADAPTER_KIND && (!allowMockAdapter || block.chainid == MAINNET_CHAIN_ID)) {
            revert AdapterBlocked();
        }

        executor = executor_;
        swapAdapter = IPolicyVaultAdapter(swapAdapter_);
        proofRegistry = IProofRegistry(proofRegistry_);
        policy = initialPolicy;
        mockAdapterAllowed = allowMockAdapter;
        vaultRegistry = IVaultRegistryV4(vaultRegistry_);

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

    receive() external payable {
        if (msg.sender != owner() && msg.sender != address(swapAdapter)) {
            revert NotAllowed();
        }
        emit Deposited(msg.sender, msg.value);
    }

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

    function tightenPolicy(Policy calldata nextPolicy) external onlyOwner {
        _validatePolicy(nextPolicy);
        Policy memory current = policy;
        if (
            nextPolicy.perTradeCap0G > current.perTradeCap0G || nextPolicy.dailyCap0G > current.dailyCap0G
                || nextPolicy.maxExposure0G > current.maxExposure0G
                || nextPolicy.cooldownSeconds < current.cooldownSeconds
                || nextPolicy.maxDeadlineWindowSeconds > current.maxDeadlineWindowSeconds
                || nextPolicy.defaultMinOutBps < current.defaultMinOutBps
        ) {
            revert BadPolicy();
        }
        policy = nextPolicy;
        emit PolicyTightened(nextPolicy);
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

        amountOut = swapAdapter.swapExactIn{value: request.amountIn}(
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
            request.actionHash,
            true,
            request.tokenOut,
            request.amountIn,
            tokenDelta,
            request.auditRoot,
            request.policySnapshotHash
        );
        emit TradeExecutedV2(
            request.actionHash,
            request.agentKey,
            true,
            request.tokenOut,
            request.amountIn,
            tokenDelta,
            request.auditRoot,
            request.policySnapshotHash
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

        SafeTransferLib.forceApprove(tokenIn, address(swapAdapter), request.amountIn);
        amountOut = swapAdapter.swapExactIn(
            request.tokenIn,
            request.tokenOut,
            request.amountIn,
            request.amountOutMin,
            request.poolId
        );
        SafeTransferLib.forceApprove(tokenIn, address(swapAdapter), 0);

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
            request.actionHash,
            false,
            request.tokenIn,
            request.amountIn,
            nativeDelta,
            request.auditRoot,
            request.policySnapshotHash
        );
        emit TradeExecutedV2(
            request.actionHash,
            request.agentKey,
            false,
            request.tokenIn,
            request.amountIn,
            nativeDelta,
            request.auditRoot,
            request.policySnapshotHash
        );
    }

    function minOutBpsFor(address tokenIn, address tokenOut) public view returns (uint16) {
        uint16 pairBps = _minOutBpsByPair[tokenIn][tokenOut];
        return pairBps == 0 ? policy.defaultMinOutBps : pairBps;
    }

    function minOutFor(address tokenIn, address tokenOut, uint256 quotedAmountOut) public view returns (uint256) {
        return (quotedAmountOut * minOutBpsFor(tokenIn, tokenOut)) / BPS;
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
                address(swapAdapter),
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

    function poolAddressOf(bytes32 poolId) public pure returns (address) {
        return address(uint160(uint256(poolId)));
    }

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
            request.actionHash == bytes32(0) || request.vaultActionHash == bytes32(0)
                || request.auditRoot == bytes32(0) || request.policySnapshotHash == bytes32(0)
                || request.policySnapshotHash != _policyHash(currentPolicy)
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
    }

    function _policyHash(Policy memory candidate) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                candidate.perTradeCap0G,
                candidate.dailyCap0G,
                candidate.maxExposure0G,
                candidate.cooldownSeconds,
                candidate.maxDeadlineWindowSeconds,
                candidate.defaultMinOutBps
            )
        );
    }
}
