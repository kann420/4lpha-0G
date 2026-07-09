// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";
import {IProofRegistry} from "./interfaces/IProofRegistry.sol";
import {IPolicyVaultLpAdapter} from "./interfaces/IPolicyVaultLpAdapter.sol";
import {IPolicyVaultV4LpEntry} from "./interfaces/IPolicyVaultV4LpEntry.sol";
import {IVaultRegistryV4} from "./interfaces/IVaultRegistryV4.sol";
import {Ownable} from "./utils/Ownable.sol";
import {ReentrancyGuard} from "./utils/ReentrancyGuard.sol";
import {SafeTransferLib} from "./utils/SafeTransferLib.sol";

contract PolicyVaultV4LpExit is Ownable, ReentrancyGuard {
    address public constant NATIVE_TOKEN = address(0);
    uint16 public constant BPS = 10_000;
    bytes32 public constant MOCK_LP_ADAPTER_KIND = keccak256("4LPHA_0G_MOCK_LP_ADAPTER");
    uint256 private constant MAINNET_CHAIN_ID = 16661;
    uint128 private constant MAX_UINT128 = type(uint128).max;

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

    error AdapterBlocked();
    error DeadlineExpired();
    error DeadlineTooFar();
    error ExecutorIsRevoked();
    error InvalidAdapter();
    error InvalidAgentKey();
    error InvalidProof();
    error NotAllowed();
    error NotExecutor();
    error Replay(bytes32 actionHash);
    error UnexpectedValue();
    error LpAdapterNotConfigured();
    error LpBadDelta();
    error InvalidActionType();
    error InvalidLpPool();
    error InvalidStakeVault();
    error InvalidLpAmount();
    error LpInvalidMinOut();
    error NotAgentLpNft();
    error NotStakedNft();
    error PoolMismatch();
    error RewardsNotConfigured();
    error LpPositionNotEmpty();
    error LpEntryMismatch();
    error Paused();

    address public immutable executor;
    IPolicyVaultLpAdapter public immutable lpAdapter;
    IProofRegistry public immutable proofRegistry;
    bool public immutable mockLpAdapterAllowed;
    IVaultRegistryV4 public immutable vaultRegistry;
    IPolicyVaultV4LpEntry public immutable lpEntry;

    bool public paused;
    bool public executorRevoked;
    mapping(bytes32 sweepPoolId => bool allowed) public allowedSweepPools;
    mapping(address token => bool allowed) public allowedSweepTokens;
    mapping(bytes32 actionHash => bool used) public usedActionHashes;
    mapping(bytes32 agentKey => bool enabled) public agentKeyEnabled;

    event ExecutorRevoked(address indexed executor);
    event NativeWithdrawn(address indexed owner, uint256 amount);
    event PausedSet(bool paused);
    event TokenRescued(address indexed token, uint256 amount);
    event AgentKeyEnabledSet(bytes32 indexed agentKey, bool enabled);
    event SweepPoolAllowed(bytes32 indexed poolId);
    event SweepPoolDisabled(bytes32 indexed poolId);
    event SweepTokenAllowed(address indexed token);
    event SweepTokenDisabled(address indexed token);
    event NftRescued(address indexed nft, uint256 indexed tokenId, address indexed to);
    event Unstaked(bytes32 indexed agentKey, uint256 indexed tokenId, address indexed stakeVault, bytes32 poolId);
    event OwnerUnstaked(uint256 indexed tokenId, address indexed stakeVault);
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

    // B4 FIX (GAP 2 / spec §3.4): exits must NOT be blocked by pause — only revokeExecutor is the
    // hard kill switch. Applied to unstakeLp/zapOut/decreaseLiquidity/collectFees/burnLp/sweepToken
    // so a paused vault can still de-risk and unwind positions.
    modifier onlyExecutorNotRevoked() {
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

    constructor(
        address initialOwner,
        address executor_,
        address lpAdapter_,
        address proofRegistry_,
        bool allowMockLpAdapter,
        address vaultRegistry_,
        address lpEntry_,
        bytes32[] memory initialAllowedSweepPools,
        address[] memory initialAllowedSweepTokens
    ) Ownable(initialOwner) {
        if (initialOwner != msg.sender) {
            revert NotAllowed();
        }
        if (
            executor_ == address(0) || lpAdapter_ == address(0) || proofRegistry_ == address(0)
                || vaultRegistry_ == address(0) || lpEntry_ == address(0) || lpAdapter_.code.length == 0
                || proofRegistry_.code.length == 0 || vaultRegistry_.code.length == 0 || lpEntry_.code.length == 0
        ) {
            revert InvalidAdapter();
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
        lpEntry = IPolicyVaultV4LpEntry(lpEntry_);

        for (uint256 i = 0; i < initialAllowedSweepPools.length; i++) {
            if (initialAllowedSweepPools[i] == bytes32(0)) {
                revert NotAllowed();
            }
            allowedSweepPools[initialAllowedSweepPools[i]] = true;
            emit SweepPoolAllowed(initialAllowedSweepPools[i]);
        }
        for (uint256 i = 0; i < initialAllowedSweepTokens.length; i++) {
            if (initialAllowedSweepTokens[i] == address(0)) {
                revert NotAllowed();
            }
            allowedSweepTokens[initialAllowedSweepTokens[i]] = true;
            emit SweepTokenAllowed(initialAllowedSweepTokens[i]);
        }
    }

    receive() external payable {
        if (msg.sender != owner() && msg.sender != address(lpAdapter)) {
            revert NotAllowed();
        }
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return 0x150b7a02;
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

    function rescueNft(uint256 tokenId) external onlyOwner nonReentrant {
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

    function addSweepPool(bytes32 poolId) external onlyOwner {
        if (poolId == bytes32(0)) {
            revert InvalidLpPool();
        }
        allowedSweepPools[poolId] = true;
        emit SweepPoolAllowed(poolId);
    }

    function disableSweepPool(bytes32 poolId) external onlyOwner {
        if (!allowedSweepPools[poolId]) {
            revert NotAllowed();
        }
        allowedSweepPools[poolId] = false;
        emit SweepPoolDisabled(poolId);
    }

    function addSweepToken(address token) external onlyOwner {
        if (token == address(0)) {
            revert InvalidLpAmount();
        }
        allowedSweepTokens[token] = true;
        emit SweepTokenAllowed(token);
    }

    function disableSweepToken(address token) external onlyOwner {
        if (!allowedSweepTokens[token]) {
            revert NotAllowed();
        }
        allowedSweepTokens[token] = false;
        emit SweepTokenDisabled(token);
    }

    function unstakeLp(IPolicyVaultV4LpEntry.LpActionRequest calldata request)
        external
        payable
        onlyExecutor
        onlyExecutorNotRevoked
        lpAdapterConfigured
        nonReentrant
    {
        if (msg.value != 0 || request.actionType != uint8(LpActionType.UNSTAKE_LP) || request.stakeVault == address(0)) {
            revert InvalidActionType();
        }
        _requireAgentNft(request.agentKey, request.poolId, request.tokenId);
        if (!lpEntry.isStaked(request.agentKey, request.tokenId)) {
            revert NotStakedNft();
        }
        // Deny-by-default: the executor must not choose an arbitrary stake-vault target.
        // The stakeVault must be allowlisted AND match the canonical stake vault for this
        // pool (stakeVaultForLpPool), exactly as enforced on the stake side (LpEntry.stakeLp).
        // Without this, a compromised executor could point withdrawStakedNftToEntry at an
        // arbitrary contract and trigger an un-allowlisted IZiaVault.withdraw call.
        if (!lpEntry.allowedStakeVaults(request.stakeVault) || lpEntry.stakeVaultForLpPool(request.poolId) != request.stakeVault) {
            revert InvalidStakeVault();
        }
        _validateLpExitRequest(request);
        _markLpAction(request.actionHash);
        lpEntry.withdrawStakedNftToEntry(request.agentKey, request.tokenId, request.stakeVault);
        lpEntry.markUnstaked(request.agentKey, request.tokenId, request.stakeVault);

        emit Unstaked(request.agentKey, request.tokenId, request.stakeVault, request.poolId);
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

    function unstakeLpOwner(uint256 tokenId, address stakeVault) external onlyOwner nonReentrant {
        lpEntry.ownerWithdrawStakedNftToEntry(tokenId, stakeVault);
        emit OwnerUnstaked(tokenId, stakeVault);
    }

    function zapOut(IPolicyVaultV4LpEntry.LpActionRequest calldata request)
        external
        payable
        onlyExecutor
        onlyExecutorNotRevoked
        lpAdapterConfigured
        nonReentrant
        returns (uint256 amountOut)
    {
        if (msg.value != 0 || request.actionType != uint8(LpActionType.ZAP_OUT)) {
            revert InvalidActionType();
        }
        _requireAgentNft(request.agentKey, request.poolId, request.tokenId);
        // M2 FIX: a zero quote collapses the min-out floor to 1 wei (minLpOutFor(0)==0), letting a
        // compromised executor unwind at ~any price. Require a real non-zero quote.
        if (
            request.quotedAmountOut == 0 || request.amount0Min == 0
                || request.amount0Min < lpEntry.minLpOutFor(request.quotedAmountOut)
        ) {
            revert LpInvalidMinOut();
        }
        uint128 totalLiq = lpAdapter.liquidityOf(request.tokenId);
        if (request.liquidity == 0 || request.liquidity != totalLiq) {
            revert InvalidLpAmount();
        }
        _validateLpExitRequest(request);
        _markLpAction(request.actionHash);

        lpEntry.moveNftToExit(request.tokenId);
        _approveLpAdapterForNft(request.tokenId);
        uint256 nativeBefore = address(this).balance;
        amountOut = lpAdapter.zapOut(
            IPolicyVaultLpAdapter.ZapOutParams({
                tokenId: request.tokenId,
                poolId: request.poolId,
                liquidity: request.liquidity,
                amountOutMin: request.amount0Min,
                deadline: request.deadline
            })
        );
        uint256 nativeDelta = address(this).balance - nativeBefore;
        if (nativeDelta < request.amount0Min || nativeDelta < amountOut || lpAdapter.liquidityOf(request.tokenId) != 0) {
            revert LpBadDelta();
        }
        lpEntry.purgeLpNft(request.tokenId);

        emit LpActionExecutedV3(
            request.actionHash,
            request.agentKey,
            request.actionType,
            request.poolId,
            request.tokenId,
            0,
            nativeDelta,
            -int256(uint256(request.liquidity)),
            request.auditRoot,
            request.policySnapshotHash
        );
    }

    function decreaseLiquidity(IPolicyVaultV4LpEntry.LpActionRequest calldata request)
        external
        payable
        onlyExecutor
        onlyExecutorNotRevoked
        lpAdapterConfigured
        nonReentrant
        returns (uint256 amount0, uint256 amount1)
    {
        if (msg.value != 0 || request.actionType != uint8(LpActionType.DECREASE_LIQUIDITY) || request.stakeVault != address(0)) {
            revert InvalidActionType();
        }
        _requireAgentNft(request.agentKey, request.poolId, request.tokenId);
        uint128 totalLiq = lpAdapter.liquidityOf(request.tokenId);
        if (request.liquidity == 0 || request.liquidity > totalLiq) {
            revert InvalidLpAmount();
        }
        if (
            request.amount0Min == 0 || request.amount1Min == 0 || request.quotedAmount0 == 0
                || request.quotedAmount1 == 0 || request.amount0Min < lpEntry.minLpOutFor(request.quotedAmount0)
                || request.amount1Min < lpEntry.minLpOutFor(request.quotedAmount1)
        ) {
            revert LpInvalidMinOut();
        }
        _validateLpExitRequest(request);
        _markLpAction(request.actionHash);

        lpEntry.moveNftToExit(request.tokenId);
        (address token0, address token1,) = lpAdapter.poolTokens(request.poolId);
        uint256 token0Before = IERC20(token0).balanceOf(address(this));
        uint256 token1Before = IERC20(token1).balanceOf(address(this));
        _approveLpAdapterForNft(request.tokenId);
        (amount0, amount1) = lpAdapter.decreaseLiquidity(
            IPolicyVaultLpAdapter.DecreaseParams({
                tokenId: request.tokenId,
                liquidity: request.liquidity,
                amount0Min: request.amount0Min,
                amount1Min: request.amount1Min,
                deadline: request.deadline
            })
        );
        _clearLpAdapterNftApproval(request.tokenId);
        uint256 delta0 = IERC20(token0).balanceOf(address(this)) - token0Before;
        uint256 delta1 = IERC20(token1).balanceOf(address(this)) - token1Before;
        if (delta0 < request.amount0Min || delta1 < request.amount1Min || delta0 < amount0 || delta1 < amount1) {
            revert LpBadDelta();
        }
        uint256 nativeFreed = lpEntry.lpNftDeployedNativeOf(request.tokenId) * uint256(request.liquidity) / uint256(totalLiq);
        lpEntry.reduceLpDeployment(request.tokenId, nativeFreed);
        IERC721(lpAdapter.nfpm()).transferFrom(address(this), address(lpEntry), request.tokenId);

        emit LpActionExecutedV3(
            request.actionHash,
            request.agentKey,
            request.actionType,
            request.poolId,
            request.tokenId,
            0,
            amount0 + amount1,
            -int256(uint256(request.liquidity)),
            request.auditRoot,
            request.policySnapshotHash
        );
    }

    function collectFees(IPolicyVaultV4LpEntry.LpActionRequest calldata request)
        external
        payable
        onlyExecutor
        onlyExecutorNotRevoked
        lpAdapterConfigured
        nonReentrant
        returns (uint256 amount0, uint256 amount1)
    {
        if (msg.value != 0 || request.actionType != uint8(LpActionType.COLLECT_FEES) || request.stakeVault != address(0) || request.liquidity != 0) {
            revert InvalidActionType();
        }
        _requireAgentNft(request.agentKey, request.poolId, request.tokenId);
        if (request.amount0Min == 0 || request.amount1Min == 0) {
            revert LpInvalidMinOut();
        }
        _validateLpExitRequest(request);
        _markLpAction(request.actionHash);

        lpEntry.moveNftToExit(request.tokenId);
        (address token0, address token1,) = lpAdapter.poolTokens(request.poolId);
        uint256 token0Before = IERC20(token0).balanceOf(address(this));
        uint256 token1Before = IERC20(token1).balanceOf(address(this));
        _approveLpAdapterForNft(request.tokenId);
        (amount0, amount1) = lpAdapter.collectFees(
            IPolicyVaultLpAdapter.CollectParams({
                tokenId: request.tokenId,
                vaultAddress: address(this),
                amount0Max: MAX_UINT128,
                amount1Max: MAX_UINT128
            })
        );
        _clearLpAdapterNftApproval(request.tokenId);
        uint256 delta0 = IERC20(token0).balanceOf(address(this)) - token0Before;
        uint256 delta1 = IERC20(token1).balanceOf(address(this)) - token1Before;
        if (delta0 < request.amount0Min || delta1 < request.amount1Min || delta0 < amount0 || delta1 < amount1) {
            revert LpBadDelta();
        }
        IERC721(lpAdapter.nfpm()).transferFrom(address(this), address(lpEntry), request.tokenId);

        emit LpActionExecutedV3(
            request.actionHash,
            request.agentKey,
            request.actionType,
            request.poolId,
            request.tokenId,
            0,
            amount0 + amount1,
            0,
            request.auditRoot,
            request.policySnapshotHash
        );
    }

    function burnLp(IPolicyVaultV4LpEntry.LpActionRequest calldata request)
        external
        payable
        onlyExecutor
        onlyExecutorNotRevoked
        lpAdapterConfigured
        nonReentrant
        returns (uint256 amount0, uint256 amount1)
    {
        if (msg.value != 0 || request.actionType != uint8(LpActionType.BURN_LP) || request.stakeVault != address(0) || request.liquidity != 0) {
            revert InvalidActionType();
        }
        _requireAgentNft(request.agentKey, request.poolId, request.tokenId);
        if (lpAdapter.liquidityOf(request.tokenId) != 0 || lpEntry.lpNftDeployedNativeOf(request.tokenId) != 0) {
            revert LpPositionNotEmpty();
        }
        if (!_burnSideOk(request.quotedAmount0, request.amount0Min) || !_burnSideOk(request.quotedAmount1, request.amount1Min)) {
            revert LpInvalidMinOut();
        }
        _validateLpExitRequest(request);
        _markLpAction(request.actionHash);

        lpEntry.moveNftToExit(request.tokenId);
        (address token0, address token1,) = lpAdapter.poolTokens(request.poolId);
        uint256 token0Before = IERC20(token0).balanceOf(address(this));
        uint256 token1Before = IERC20(token1).balanceOf(address(this));
        uint256 nftBefore = IERC721(lpAdapter.nfpm()).balanceOf(address(this));
        _approveLpAdapterForNft(request.tokenId);
        (amount0, amount1) = lpAdapter.burnLp(request.tokenId);
        uint256 delta0 = IERC20(token0).balanceOf(address(this)) - token0Before;
        uint256 delta1 = IERC20(token1).balanceOf(address(this)) - token1Before;
        if (delta0 < amount0 || delta1 < amount1 || nftBefore - IERC721(lpAdapter.nfpm()).balanceOf(address(this)) != 1) {
            revert LpBadDelta();
        }
        lpEntry.purgeLpNft(request.tokenId);

        emit LpActionExecutedV3(
            request.actionHash,
            request.agentKey,
            request.actionType,
            request.poolId,
            request.tokenId,
            0,
            amount0 + amount1,
            0,
            request.auditRoot,
            request.policySnapshotHash
        );
    }

    function sweepToken(IPolicyVaultV4LpEntry.LpActionRequest calldata request)
        external
        payable
        onlyExecutor
        onlyExecutorNotRevoked
        lpAdapterConfigured
        nonReentrant
        returns (uint256 amountOut)
    {
        if (
            msg.value != 0 || request.actionType != uint8(LpActionType.SWEEP_TOKEN) || request.tokenId != 0
                || request.stakeVault != address(0) || request.tokenIn == address(0) || request.amount0Desired == 0
        ) {
            revert InvalidActionType();
        }
        if (!allowedSweepPools[request.poolId] || !allowedSweepTokens[request.tokenIn]) {
            revert NotAllowed();
        }
        if (request.tokenOut != address(0) && !allowedSweepTokens[request.tokenOut]) {
            revert NotAllowed();
        }
        // M2 FIX: reject a zero quote so the min-out floor cannot collapse to 1 wei (see zapOut).
        if (
            request.quotedAmountOut == 0 || request.amount1Min == 0
                || request.amount1Min < lpEntry.minLpOutFor(request.quotedAmountOut)
        ) {
            revert LpInvalidMinOut();
        }
        _validateLpExitRequest(request);
        _markLpAction(request.actionHash);

        uint256 tokenBefore = IERC20(request.tokenIn).balanceOf(address(this));
        uint256 outBefore = request.tokenOut == address(0) ? address(this).balance : IERC20(request.tokenOut).balanceOf(address(this));
        SafeTransferLib.forceApprove(IERC20(request.tokenIn), address(lpAdapter), request.amount0Desired);
        amountOut = lpAdapter.sweepToken(
            IPolicyVaultLpAdapter.SweepParams({
                tokenIn: request.tokenIn,
                tokenOut: request.tokenOut,
                amountIn: request.amount0Desired,
                amountOutMin: request.amount1Min,
                poolId: request.poolId,
                deadline: request.deadline
            })
        );
        SafeTransferLib.forceApprove(IERC20(request.tokenIn), address(lpAdapter), 0);
        uint256 tokenDelta = tokenBefore - IERC20(request.tokenIn).balanceOf(address(this));
        uint256 outDelta =
            request.tokenOut == address(0) ? address(this).balance - outBefore : IERC20(request.tokenOut).balanceOf(address(this)) - outBefore;
        if (tokenDelta != request.amount0Desired || outDelta < request.amount1Min || outDelta < amountOut) {
            revert LpBadDelta();
        }

        emit LpActionExecutedV3(
            request.actionHash,
            request.agentKey,
            request.actionType,
            request.poolId,
            0,
            request.amount0Desired,
            outDelta,
            0,
            request.auditRoot,
            request.policySnapshotHash
        );
    }

    function claimRewards(IPolicyVaultV4LpEntry.LpActionRequest calldata) external payable {
        revert RewardsNotConfigured();
    }

    function vaultActionHashForLp(IPolicyVaultV4LpEntry.LpActionRequest calldata request) public view returns (bytes32) {
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

    function actionHashFor(bytes32 vaultActionHash, bytes32 auditRoot, bytes32 policySnapshotHash)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode("4LPHA_0G_POLICY_VAULT_PROOF", vaultActionHash, auditRoot, policySnapshotHash));
    }

    function poolAddressOf(bytes32 poolId) public pure returns (address) {
        return address(uint160(uint256(poolId)));
    }

    function _validateLpExitRequest(IPolicyVaultV4LpEntry.LpActionRequest calldata request) private view {
        if (request.deadline < block.timestamp) {
            revert DeadlineExpired();
        }
        if (request.deadline > block.timestamp + 1 days) {
            revert DeadlineTooFar();
        }
        if (
            request.actionHash == bytes32(0) || request.vaultActionHash == bytes32(0) || request.auditRoot == bytes32(0)
                || request.policySnapshotHash == bytes32(0) || request.policySnapshotHash != lpEntry.policyHash()
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
    }

    function _requireAgentNft(bytes32 agentKey, bytes32 poolId, uint256 tokenId) private view {
        if (lpEntry.lpNftOwnerOf(tokenId) != agentKey) {
            revert NotAgentLpNft();
        }
        if (lpEntry.lpNftPoolOf(tokenId) != poolId) {
            revert PoolMismatch();
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

    function _approveLpAdapterForNft(uint256 tokenId) private {
        IERC721(lpAdapter.nfpm()).approve(address(lpAdapter), tokenId);
    }

    function _clearLpAdapterNftApproval(uint256 tokenId) private {
        IERC721(lpAdapter.nfpm()).approve(address(0), tokenId);
    }

    function _burnSideOk(uint256 quoted, uint256 minOut) private view returns (bool) {
        if (quoted == 0) {
            return minOut == 0;
        }
        return minOut > 0 && minOut >= lpEntry.minLpOutFor(quoted);
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
