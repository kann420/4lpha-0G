// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/// @title IPolicyVaultLpAdapter
/// @notice Narrow, deny-by-default LP primitive surface the PolicyVaultV3 calls into.
/// @dev No stakeLp/unstakeLp/claimRewards here — staking is vault-direct (the vault calls
///      NFPM.approve(stakeVault, tokenId) + IZiaVault(stakeVault).deposit/withdraw itself).
///      claimRewards is unimplemented on V3 (the vault entrypoint reverts RewardsNotConfigured).
///      Recipient of every token/native return is hard-pinned to msg.sender (the vault).
interface IPolicyVaultLpAdapter {
    /// @notice Non-mock kind tag. Mock adapters return a different constant and are rejected on mainnet.
    function lpAdapterKind() external view returns (bytes32);

    /// @notice Wrapped native (W0G) address the adapter wraps/unwraps on the single-sided zap path.
    function wrappedNative() external view returns (address);

    /// @notice NonfungiblePositionManager address (the ERC721 that minted LP NFTs). The vault calls
    ///         NFPM.approve/transferFrom directly for vault-direct staking and NFT rescue.
    function nfpm() external view returns (address);

    // --- Zap-in mint (single-sided 0G -> wrap -> ONE balancing swap -> mint in ONE tx). Charges LP caps. ---
    struct ZapInMintParams {
        bytes32 poolId;
        address vaultAddress;
        address token0; // W0G side
        address token1; // paired side (acquired by internal swap)
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0G; // native 0G input
        uint256 amount0Min; // slippage floor (W0G side after wrap)
        uint256 amount1Min; // slippage floor (paired side after swap)
        uint256 deadline;
    }

    function zapInMintLp(ZapInMintParams calldata p)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);

    // --- Zap-in increase (single-sided 0G -> wrap -> ONE balancing swap -> add to existing position). ---
    struct ZapIncreaseParams {
        uint256 tokenId;
        bytes32 poolId;
        uint256 amount0G; // native 0G input
        uint256 amount0Min; // slippage floor (W0G side)
        uint256 amount1Min; // slippage floor (paired side)
        uint256 deadline;
    }

    // -----------------------------------------------------------------------
    // v4-reserved primitives below. The v3 shipping vault does NOT call these;
    // they remain in the interface as the v4 surface (auto-compound / auto-rebalance
    // / fee collection / partial decrease / sweep). Mocks implement them for tests.
    // -----------------------------------------------------------------------

    function zapInIncreaseLiquidity(ZapIncreaseParams calldata p)
        external
        payable
        returns (uint128 liquidity, uint256 amount0, uint256 amount1);

    struct DecreaseParams {
        uint256 tokenId;
        uint128 liquidity; // Codex round-4 BLOCKER 1: matches LpActionRequest.liquidity (uint128), passed straight through
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    function decreaseLiquidity(DecreaseParams calldata p) external payable returns (uint256 amount0, uint256 amount1);

    struct CollectParams {
        uint256 tokenId;
        address vaultAddress;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    function collectFees(CollectParams calldata p) external payable returns (uint256 amount0, uint256 amount1);

    /// @notice collect-then-burn: adapter collects owed fees to vault, then burns the NFT. Reverts if liquidity != 0.
    function burnLp(uint256 tokenId) external payable returns (uint256 amount0, uint256 amount1);

    struct ZapOutParams {
        uint256 tokenId;
        bytes32 poolId;
        uint128 liquidity; // full or partial to burn; passed straight through (no cast)
        uint256 amountOutMin; // native-out floor
        uint256 deadline;
    }

    function zapOut(ZapOutParams calldata p) external payable returns (uint256 amountOut);

    /// @notice Sweep a custodied allowlisted ERC20 -> another allowlisted token/native, recipient = vault.
    /// @dev Native-out normalization (Codex round-4 major 4): when tokenOut == address(0), the adapter
    ///      validates the pool pair against {tokenIn, wrappedNative}, swaps to W0G, then unwraps.
    struct SweepParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 amountOutMin;
        bytes32 poolId;
        uint256 deadline;
    }

    function sweepToken(SweepParams calldata p) external payable returns (uint256 amountOut);

    // --- view helpers used by the vault for pre/post-flight verification ---
    function ownerOf(uint256 tokenId) external view returns (address);
    function liquidityOf(uint256 tokenId) external view returns (uint128);
    function positionTicks(uint256 tokenId) external view returns (int24 tickLower, int24 tickUpper);
    function poolTokens(bytes32 poolId) external view returns (address token0, address token1, uint24 fee);
}