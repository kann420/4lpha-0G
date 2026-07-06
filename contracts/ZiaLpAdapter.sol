// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IPolicyVaultLpAdapter} from "./interfaces/IPolicyVaultLpAdapter.sol";
import {IERC20} from "./interfaces/IERC20.sol";
import {SafeTransferLib} from "./utils/SafeTransferLib.sol";

// =====================================================================
// Minimal inline interfaces — Zia is a Uniswap V3 fork. Only the selectors
// the adapter actually calls are listed; declaring an unused view function
// in an interface costs no deployed bytecode (its selector is only emitted
// when called).
// =====================================================================

interface INonfungiblePositionManager {
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    struct DecreaseLiquidityParams {
        uint256 tokenId;
        uint128 liquidity;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
    function decreaseLiquidity(DecreaseLiquidityParams calldata params)
        external
        returns (uint256 amount0, uint256 amount1);
    function collect(CollectParams calldata params)
        external
        payable
        returns (uint256 amount0, uint256 amount1);
    function burn(uint256 tokenId) external;
    function positions(uint256 tokenId)
        external
        view
        returns (
            uint96 nonce,
            address operator,
            address token0,
            address token1,
            uint24 fee,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        );
    function ownerOf(uint256 tokenId) external view returns (address);
}

interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

interface IWrappedNative {
    function withdraw(uint256 amount) external;
}

interface IUniswapV3Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );
}

/// @title ZiaLpAdapter — real 0G mainnet LP adapter for PolicyVaultV3.
/// @notice Implements single-sided zap-in mint and zap-out against the Zia Uniswap-V3 fork
///         (NonfungiblePositionManager + SwapRouter + W0G). Recipient of every token/native return
///         is hard-pinned to msg.sender (the vault). v4-deferred primitives revert NotImplementedV4.
/// @dev Deny-by-default: the adapter only ever calls W0G.withdraw, NFPM.mint/decreaseLiquidity/
///      collect/burn, and SwapRouter.exactInputSingle, plus SafeTransferLib.forceApprove for
///      exact-spend + revoke-after-use. No arbitrary call, delegatecall, multicall, raw calldata,
///      arbitrary target, or arbitrary recipient. The vault wraps 0G -> W0G and force-approves the
///      adapter before zapInMintLp; the vault force-approves the NFT to the adapter before zapOut.
///
///      Unused W0G is swept back to the vault; if none of the input was consumed, the mint reverts
///      W0GNotConsumed. Oversized paired leftovers are swapped back to W0G before refunding so the
///      vault does not accumulate non-W0G inventory from the zap heuristic.
contract ZiaLpAdapter {
    // --- Errors ---

    error NotImplementedV4();
    error BadParams();
    error BadPool();
    error InsufficientLiquidity();
    error SlippageExceeded();
    error NotVaultNft();
    error W0GNotConsumed();
    error ExcessPairedDust();

    // --- 0G mainnet Zia Uniswap-V3 fork constants ---

    address public constant NFPM = 0x5143ba6007C197b4cF66c20601b9dB97E0F98c6A;
    address public constant SWAP_ROUTER = 0x18cCa38E51c4C339A6BD6e174025f08360FEEf30;
    address public constant W0G = 0x1Cd0690fF9a693f5EF2dD976660a8dAFc81A109c;

    bytes32 private constant ADAPTER_KIND = keccak256("4LPHA_0G_ZIA_LP_ADAPTER");
    uint128 private constant MAX_UINT128 = type(uint128).max;
    uint16 private constant BPS = 10_000;
    uint16 private constant MAX_DUST_BPS = 50; // leftover paired token must be <= 0.5% of paired consumed

    /// @notice Accepts native returned by W0G.withdraw during zapOut (forwarded to the vault).
    receive() external payable {}

    // =====================================================================
    // Identity views
    // =====================================================================

    /// @notice Non-mock kind tag; the vault rejects MOCK_LP_ADAPTER_KIND on mainnet.
    function lpAdapterKind() external pure returns (bytes32) {
        return ADAPTER_KIND;
    }

    /// @notice Wrapped native (W0G) the adapter wraps/unwraps on the single-sided zap path.
    function wrappedNative() external pure returns (address) {
        return W0G;
    }

    /// @notice NonfungiblePositionManager address (ERC721 that minted LP NFTs).
    function nfpm() external pure returns (address) {
        return NFPM;
    }

    // =====================================================================
    // zapInMintLp — single-sided 0G -> wrap -> ONE balancing swap -> mint
    // =====================================================================

    /// @notice Mints a V3 LP position from a single-sided native 0G input. The vault has already
    ///         wrapped 0G -> W0G and force-approved the adapter for `amount0G` of W0G. The adapter
    ///         pulls the W0G, executes ONE balancing swap (W0G -> paired token) so both sides are
    ///         available, mints the NFT to the vault, then refunds unused W0G. Small paired dust is
    ///         swept to the vault; oversized paired leftovers are swapped back to W0G first.
    /// @dev The balancing swap amount is derived from a tick-distance heuristic: the value fraction
    ///      on each side of an in-range V3 position tracks (tickUpper - currentTick) vs
    ///      (currentTick - tickLower). This avoids embedding the full Uniswap V3 TickMath +
    ///      LiquidityAmounts + FullMath suite (~4KB) inside the 24KB-capped adapter. The server
    ///      MUST simulate the same heuristic off-chain to set amount0Min / amount1Min /
    ///      quotedLiquidity. Ceil-division biases the swap slightly upward so the W0G side is the
    ///      binding constraint (all W0G consumed, paired leftover absorbed by the sweep). The vault
    ///      enforces amount0Min > 0 and amount1Min > 0, so only in-range positions (both sides
    ///      used) are accepted; out-of-range requests revert at the vault's min validation before
    ///      reaching the adapter. NFPM.mint enforces amount0Min/amount1Min internally.
    function zapInMintLp(IPolicyVaultLpAdapter.ZapInMintParams calldata p)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        if (msg.value != 0 || p.amount0G == 0 || p.vaultAddress != msg.sender) {
            revert BadParams();
        }
        if (p.token0 == p.token1 || (p.token0 != W0G && p.token1 != W0G)) {
            revert BadPool();
        }
        // Validate the pool-address-encoded poolId resolves to a pool whose tokens match params.
        address pool = address(uint160(uint256(p.poolId)));
        if (pool == address(0)) {
            revert BadPool();
        }
        if (IUniswapV3Pool(pool).token0() != p.token0 || IUniswapV3Pool(pool).token1() != p.token1) {
            revert BadPool();
        }

        bool w0gIsToken0 = p.token0 == W0G;
        address paired = w0gIsToken0 ? p.token1 : p.token0;
        IERC20 wnative = IERC20(W0G);

        // (1) Pull W0G the vault wrapped + approved for amount0G.
        SafeTransferLib.safeTransferFrom(wnative, msg.sender, address(this), p.amount0G);

        // (2) Compute and execute the ONE balancing swap: W0G -> paired, recipient = adapter.
        (, int24 currentTick,,,,,) = IUniswapV3Pool(pool).slot0();
        uint256 swapAmount = _computeSwapAmount(p.amount0G, currentTick, p.tickLower, p.tickUpper, w0gIsToken0);
        if (swapAmount > 0) {
            SafeTransferLib.forceApprove(wnative, SWAP_ROUTER, swapAmount);
            ISwapRouter(SWAP_ROUTER).exactInputSingle(
                ISwapRouter.ExactInputSingleParams({
                    tokenIn: W0G,
                    tokenOut: paired,
                    fee: p.fee,
                    recipient: address(this),
                    deadline: p.deadline,
                    amountIn: swapAmount,
                    amountOutMinimum: 0,
                    sqrtPriceLimitX96: 0
                })
            );
            SafeTransferLib.forceApprove(wnative, SWAP_ROUTER, 0);
        }

        // (3) Approve NFPM for the exact balances the adapter holds, then mint NFT to vault.
        uint256 w0gHeld = wnative.balanceOf(address(this));
        uint256 pairedHeld = IERC20(paired).balanceOf(address(this));
        if (w0gHeld > 0) {
            SafeTransferLib.forceApprove(wnative, NFPM, w0gHeld);
        }
        if (pairedHeld > 0) {
            SafeTransferLib.forceApprove(IERC20(paired), NFPM, pairedHeld);
        }
        // NFPM.mint enforces amount0Min/amount1Min internally (reverts on insufficient used amounts).
        (tokenId, liquidity, amount0, amount1) = INonfungiblePositionManager(NFPM).mint(
            INonfungiblePositionManager.MintParams({
                token0: p.token0,
                token1: p.token1,
                fee: p.fee,
                tickLower: p.tickLower,
                tickUpper: p.tickUpper,
                amount0Desired: w0gIsToken0 ? w0gHeld : pairedHeld,
                amount1Desired: w0gIsToken0 ? pairedHeld : w0gHeld,
                amount0Min: p.amount0Min,
                amount1Min: p.amount1Min,
                recipient: msg.sender,
                deadline: p.deadline
            })
        );

        // (4) Revoke NFPM approvals (exact-spend + revoke-after-use).
        SafeTransferLib.forceApprove(wnative, NFPM, 0);
        SafeTransferLib.forceApprove(IERC20(paired), NFPM, 0);

        // (5) Handle paired-token leftovers from the heuristic. Tiny leftovers are harmless token
        //     dust, but larger leftovers are unused principal; swap them back to W0G so the vault
        //     can account net deployed native via its W0G refund delta.
        uint256 pairedLeft = IERC20(paired).balanceOf(address(this));
        uint256 pairedConsumed = w0gIsToken0 ? amount1 : amount0;
        if (pairedLeft > 0) {
            uint256 pairedDustLimit = (pairedConsumed * MAX_DUST_BPS) / BPS;
            if (pairedLeft > pairedDustLimit) {
                SafeTransferLib.forceApprove(IERC20(paired), SWAP_ROUTER, pairedLeft);
                ISwapRouter(SWAP_ROUTER).exactInputSingle(
                    ISwapRouter.ExactInputSingleParams({
                        tokenIn: paired,
                        tokenOut: W0G,
                        fee: p.fee,
                        recipient: address(this),
                        deadline: p.deadline,
                        amountIn: pairedLeft,
                        amountOutMinimum: 0,
                        sqrtPriceLimitX96: 0
                    })
                );
                SafeTransferLib.forceApprove(IERC20(paired), SWAP_ROUTER, 0);
            } else {
                SafeTransferLib.safeTransfer(IERC20(paired), msg.sender, pairedLeft);
            }
        }

        // (6) Sweep unused W0G back to the vault. If the adapter consumed no W0G at all, the quote
        //     or range is invalid and should be retried.
        uint256 w0gLeft = wnative.balanceOf(address(this));
        if (w0gLeft > 0) {
            if (w0gLeft >= p.amount0G) {
                revert W0GNotConsumed();
            }
            SafeTransferLib.safeTransfer(wnative, msg.sender, w0gLeft);
        }
    }

    /// @dev Tick-distance heuristic for the in-range balancing swap fraction. For a V3 position
    ///      spanning [tickLower, tickUpper] with the current tick in range, the value fraction on
    ///      the token0 side tracks ~(tickUpper - currentTick) / (tickUpper - tickLower) and the
    ///      token1 side tracks ~(currentTick - tickLower) / (tickUpper - tickLower). The true ratio
    ///      is sqrt-based (needs TickMath + LiquidityAmounts + FullMath); this linear approximation
    ///      is an MVP heuristic that is exact for symmetric ranges and directionally correct for
    ///      asymmetric ones. Ceil-division over-swaps by at most one unit, biasing toward the W0G
    ///      side being the binding constraint so all W0G is consumed. Out-of-range inputs
    ///      (numerator <= 0 or >= range) return 0 / amount0G; the vault's amount0Min/amount1Min > 0
    ///      requirement rejects those before they reach the adapter.
    function _computeSwapAmount(
        uint256 amount0G,
        int24 currentTick,
        int24 tickLower,
        int24 tickUpper,
        bool w0gIsToken0
    ) private pure returns (uint256) {
        int24 range = tickUpper - tickLower;
        if (range <= 0) {
            revert BadParams();
        }
        int24 numerator = w0gIsToken0 ? (currentTick - tickLower) : (tickUpper - currentTick);
        if (numerator <= 0) {
            return 0;
        }
        if (numerator >= range) {
            return amount0G;
        }
        // ceilDiv(amount0G * numerator, range) — over-swap by <1 unit to bias W0G binding.
        return (uint256(int256(numerator)) * amount0G + uint256(int256(range)) - 1) / uint256(int256(range));
    }

    // =====================================================================
    // zapOut — decrease + collect + (burn) + swap paired->W0G + unwrap to native
    // =====================================================================

    /// @notice Burns full or partial liquidity from a V3 position, swaps the paired side back to
    ///         W0G, unwraps the full W0G balance to native 0G, and sends native to the vault. The
    ///         vault has approved the NFT to the adapter via NFPM.approve. When the full position
    ///         liquidity is removed, the NFT is burned (ERC721 auto-clears the approval on burn).
    /// @dev The position (token0/token1/fee/liquidity) is read from NFPM.positions(tokenId) — the
    ///         source of truth — not from the poolId. decreaseLiquidity's internal amount0Min/
    ///         amount1Min are set to 0; the final native amountOutMin is the real slippage floor
    ///         (the vault enforces it on the native delta). posLiq is captured BEFORE the decrease
    ///         so the full-burn decision compares against the original position liquidity.
    function zapOut(IPolicyVaultLpAdapter.ZapOutParams calldata p)
        external
        payable
        returns (uint256 amountOut)
    {
        if (msg.value != 0) {
            revert BadParams();
        }
        // Read the position — source of truth for tokens, fee, and current liquidity.
        (, , address t0, address t1, uint24 fee, , , uint128 posLiq, , , , ) =
            INonfungiblePositionManager(NFPM).positions(p.tokenId);
        if (p.liquidity == 0 || posLiq < p.liquidity) {
            revert InsufficientLiquidity();
        }
        if (t0 != W0G && t1 != W0G) {
            revert BadPool();
        }
        if (INonfungiblePositionManager(NFPM).ownerOf(p.tokenId) != msg.sender) {
            revert NotVaultNft();
        }

        address paired = t0 == W0G ? t1 : t0;

        // (1) Decrease liquidity (internal mins = 0; final native amountOutMin enforces slippage).
        INonfungiblePositionManager(NFPM).decreaseLiquidity(
            INonfungiblePositionManager.DecreaseLiquidityParams({
                tokenId: p.tokenId,
                liquidity: p.liquidity,
                amount0Min: 0,
                amount1Min: 0,
                deadline: p.deadline
            })
        );

        // (2) Collect owed tokens to the adapter (W0G side stays as W0G; do NOT unwrap here yet).
        INonfungiblePositionManager(NFPM).collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: p.tokenId,
                recipient: address(this),
                amount0Max: MAX_UINT128,
                amount1Max: MAX_UINT128
            })
        );

        // (3) Full burn only when the entire original position liquidity was removed.
        if (p.liquidity == posLiq) {
            INonfungiblePositionManager(NFPM).burn(p.tokenId);
        }

        // (4) Swap the paired side back to W0G (recipient = adapter).
        uint256 pairedBal = IERC20(paired).balanceOf(address(this));
        if (pairedBal > 0) {
            SafeTransferLib.forceApprove(IERC20(paired), SWAP_ROUTER, pairedBal);
            ISwapRouter(SWAP_ROUTER).exactInputSingle(
                ISwapRouter.ExactInputSingleParams({
                    tokenIn: paired,
                    tokenOut: W0G,
                    fee: fee,
                    recipient: address(this),
                    deadline: p.deadline,
                    amountIn: pairedBal,
                    amountOutMinimum: 0,
                    sqrtPriceLimitX96: 0
                })
            );
            SafeTransferLib.forceApprove(IERC20(paired), SWAP_ROUTER, 0);
        }

        // (5) Unwrap the full W0G balance to native 0G and send to the vault.
        uint256 w0gTotal = IERC20(W0G).balanceOf(address(this));
        uint256 nativeBefore = address(this).balance;
        if (w0gTotal > 0) {
            IWrappedNative(W0G).withdraw(w0gTotal);
        }
        amountOut = address(this).balance - nativeBefore;
        if (amountOut < p.amountOutMin) {
            revert SlippageExceeded();
        }
        SafeTransferLib.safeTransferNative(msg.sender, amountOut);
    }

    // =====================================================================
    // View helpers — read from NFPM.positions / pool slot0
    // =====================================================================

    function ownerOf(uint256 tokenId) external view returns (address) {
        return INonfungiblePositionManager(NFPM).ownerOf(tokenId);
    }

    function liquidityOf(uint256 tokenId) external view returns (uint128) {
        (, , , , , , , uint128 liq, , , , ) = INonfungiblePositionManager(NFPM).positions(tokenId);
        return liq;
    }

    function positionTicks(uint256 tokenId) external view returns (int24 tickLower, int24 tickUpper) {
        (, , , , , int24 tl, int24 tu, , , , , ) = INonfungiblePositionManager(NFPM).positions(tokenId);
        return (tl, tu);
    }

    /// @notice Recovers token0/token1/fee from the pool-address-encoded poolId.
    /// @dev poolId = bytes32(uint256(uint160(poolAddress))) — see lib/contracts/zia-lp.ts
    ///      poolIdFromAddress. The adapter decodes the pool address and reads the V3 pool directly.
    function poolTokens(bytes32 poolId) external view returns (address token0, address token1, uint24 fee) {
        address pool = address(uint160(uint256(poolId)));
        if (pool == address(0)) {
            revert BadPool();
        }
        IUniswapV3Pool p = IUniswapV3Pool(pool);
        return (p.token0(), p.token1(), p.fee());
    }

    // =====================================================================
    // v4-deferred primitives — interface conformance only. The v3 shipping
    // vault never calls these; they revert explicitly so no caller can fake
    // an auto-compound / auto-rebalance / fee-collection / sweep path.
    // =====================================================================

    function zapInIncreaseLiquidity(IPolicyVaultLpAdapter.ZapIncreaseParams calldata)
        external
        payable
        returns (uint128, uint256, uint256)
    {
        revert NotImplementedV4();
    }

    function decreaseLiquidity(IPolicyVaultLpAdapter.DecreaseParams calldata)
        external
        payable
        returns (uint256, uint256)
    {
        revert NotImplementedV4();
    }

    function collectFees(IPolicyVaultLpAdapter.CollectParams calldata)
        external
        payable
        returns (uint256, uint256)
    {
        revert NotImplementedV4();
    }

    function burnLp(uint256) external payable returns (uint256, uint256) {
        revert NotImplementedV4();
    }

    function sweepToken(IPolicyVaultLpAdapter.SweepParams calldata)
        external
        payable
        returns (uint256)
    {
        revert NotImplementedV4();
    }
}
