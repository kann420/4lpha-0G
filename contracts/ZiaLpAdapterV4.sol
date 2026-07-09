// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IPolicyVaultLpAdapter} from "./interfaces/IPolicyVaultLpAdapter.sol";
import {IERC20} from "./interfaces/IERC20.sol";
import {SafeTransferLib} from "./utils/SafeTransferLib.sol";

interface INonfungiblePositionManagerV4 {
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
    struct IncreaseLiquidityParams {
        uint256 tokenId;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
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
    function increaseLiquidity(IncreaseLiquidityParams calldata params)
        external
        payable
        returns (uint128 liquidity, uint256 amount0, uint256 amount1);
    function decreaseLiquidity(DecreaseLiquidityParams calldata params) external returns (uint256 amount0, uint256 amount1);
    function collect(CollectParams calldata params) external payable returns (uint256 amount0, uint256 amount1);
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

interface ISwapRouterV4 {
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

interface IWrappedNativeV4 {
    function withdraw(uint256 amount) external;
}

interface IUniswapV3PoolV4 {
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

contract ZiaLpAdapterV4 {
    error BadParams();
    error BadPool();
    error InsufficientLiquidity();
    error SlippageExceeded();
    error NotVaultNft();
    error W0GNotConsumed();
    error ExcessPairedDust();
    error WrongChain();

    address public constant NFPM = 0x5143ba6007C197b4cF66c20601b9dB97E0F98c6A;
    address public constant SWAP_ROUTER = 0x18cCa38E51c4C339A6BD6e174025f08360FEEf30;
    address public constant W0G = 0x1Cd0690fF9a693f5EF2dD976660a8dAFc81A109c;

    bytes32 private constant ADAPTER_KIND = keccak256("4LPHA_0G_ZIA_LP_ADAPTER");
    uint128 private constant MAX_UINT128 = type(uint128).max;
    uint16 private constant BPS = 10_000;
    uint16 private constant MAX_DUST_BPS = 50;

    // The real adapter is hardcoded to 0G mainnet NFPM / SWAP_ROUTER / W0G
    // addresses. Refuse to deploy on any other chain so a misconfigured deploy
    // fails fast at construction instead of silently calling non-existent
    // mainnet contracts from testnet. The vault constructors already block the
    // MOCK adapter kind on mainnet; this is the symmetric guard on the real
    // adapter. Tests use MockZiaLpAdapterV4, so this constructor never runs in CI.
    constructor() {
        if (block.chainid != 16661) revert WrongChain();
    }

    receive() external payable {}

    function lpAdapterKind() external pure returns (bytes32) {
        return ADAPTER_KIND;
    }

    function wrappedNative() external pure returns (address) {
        return W0G;
    }

    function nfpm() external pure returns (address) {
        return NFPM;
    }

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
        _validatePool(p.poolId, p.token0, p.token1, p.fee);
        bool w0gIsToken0 = p.token0 == W0G;
        address paired = w0gIsToken0 ? p.token1 : p.token0;
        IERC20 wnative = IERC20(W0G);

        SafeTransferLib.safeTransferFrom(wnative, msg.sender, address(this), p.amount0G);
        (, int24 currentTick,,,,,) = IUniswapV3PoolV4(address(uint160(uint256(p.poolId)))).slot0();
        uint256 swapAmount = _computeSwapAmount(p.amount0G, currentTick, p.tickLower, p.tickUpper, w0gIsToken0);
        _swapExact(W0G, paired, p.fee, address(this), swapAmount, 0, p.deadline);

        uint256 w0gHeld = wnative.balanceOf(address(this));
        uint256 pairedHeld = IERC20(paired).balanceOf(address(this));
        _approveIfNeeded(wnative, NFPM, w0gHeld);
        _approveIfNeeded(IERC20(paired), NFPM, pairedHeld);
        (tokenId, liquidity, amount0, amount1) = INonfungiblePositionManagerV4(NFPM).mint(
            INonfungiblePositionManagerV4.MintParams({
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
        SafeTransferLib.forceApprove(wnative, NFPM, 0);
        SafeTransferLib.forceApprove(IERC20(paired), NFPM, 0);
        _sweepMintResiduals(wnative, IERC20(paired), p.fee, p.deadline, p.amount0G, w0gIsToken0 ? amount1 : amount0);
    }

    function zapInIncreaseLiquidity(IPolicyVaultLpAdapter.ZapIncreaseParams calldata p)
        external
        payable
        returns (uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        if (msg.value != 0 || p.amount0G == 0) {
            revert BadParams();
        }
        (, , address t0, address t1, uint24 fee, int24 tl, int24 tu, uint128 posLiq, , , , ) =
            INonfungiblePositionManagerV4(NFPM).positions(p.tokenId);
        if (posLiq == 0 || INonfungiblePositionManagerV4(NFPM).ownerOf(p.tokenId) != msg.sender) {
            revert NotVaultNft();
        }
        _validatePool(p.poolId, t0, t1, fee);
        if (t0 != W0G && t1 != W0G) {
            revert BadPool();
        }
        bool w0gIsToken0 = t0 == W0G;
        address paired = w0gIsToken0 ? t1 : t0;
        IERC20 wnative = IERC20(W0G);
        SafeTransferLib.safeTransferFrom(wnative, msg.sender, address(this), p.amount0G);
        (, int24 currentTick,,,,,) = IUniswapV3PoolV4(address(uint160(uint256(p.poolId)))).slot0();
        uint256 swapAmount = _computeSwapAmount(p.amount0G, currentTick, tl, tu, w0gIsToken0);
        _swapExact(W0G, paired, fee, address(this), swapAmount, 0, p.deadline);
        uint256 w0gHeld = wnative.balanceOf(address(this));
        uint256 pairedHeld = IERC20(paired).balanceOf(address(this));
        _approveIfNeeded(wnative, NFPM, w0gHeld);
        _approveIfNeeded(IERC20(paired), NFPM, pairedHeld);
        (liquidity, amount0, amount1) = INonfungiblePositionManagerV4(NFPM).increaseLiquidity(
            INonfungiblePositionManagerV4.IncreaseLiquidityParams({
                tokenId: p.tokenId,
                amount0Desired: w0gIsToken0 ? w0gHeld : pairedHeld,
                amount1Desired: w0gIsToken0 ? pairedHeld : w0gHeld,
                amount0Min: p.amount0Min,
                amount1Min: p.amount1Min,
                deadline: p.deadline
            })
        );
        SafeTransferLib.forceApprove(wnative, NFPM, 0);
        SafeTransferLib.forceApprove(IERC20(paired), NFPM, 0);
        _sweepMintResiduals(wnative, IERC20(paired), fee, p.deadline, p.amount0G, w0gIsToken0 ? amount1 : amount0);
    }

    function decreaseLiquidity(IPolicyVaultLpAdapter.DecreaseParams calldata p)
        external
        payable
        returns (uint256 amount0, uint256 amount1)
    {
        if (msg.value != 0 || p.liquidity == 0 || INonfungiblePositionManagerV4(NFPM).ownerOf(p.tokenId) != msg.sender) {
            revert BadParams();
        }
        (, , , , , , , uint128 posLiq, , , , ) = INonfungiblePositionManagerV4(NFPM).positions(p.tokenId);
        if (p.liquidity > posLiq) {
            revert InsufficientLiquidity();
        }
        INonfungiblePositionManagerV4(NFPM).decreaseLiquidity(
            INonfungiblePositionManagerV4.DecreaseLiquidityParams({
                tokenId: p.tokenId,
                liquidity: p.liquidity,
                amount0Min: p.amount0Min,
                amount1Min: p.amount1Min,
                deadline: p.deadline
            })
        );
        (amount0, amount1) = INonfungiblePositionManagerV4(NFPM).collect(
            INonfungiblePositionManagerV4.CollectParams({
                tokenId: p.tokenId,
                recipient: msg.sender,
                amount0Max: MAX_UINT128,
                amount1Max: MAX_UINT128
            })
        );
    }

    function collectFees(IPolicyVaultLpAdapter.CollectParams calldata p)
        external
        payable
        returns (uint256 amount0, uint256 amount1)
    {
        if (msg.value != 0 || p.vaultAddress != msg.sender || INonfungiblePositionManagerV4(NFPM).ownerOf(p.tokenId) != msg.sender) {
            revert BadParams();
        }
        (amount0, amount1) = INonfungiblePositionManagerV4(NFPM).collect(
            INonfungiblePositionManagerV4.CollectParams({
                tokenId: p.tokenId,
                recipient: msg.sender,
                amount0Max: p.amount0Max,
                amount1Max: p.amount1Max
            })
        );
    }

    function burnLp(uint256 tokenId) external payable returns (uint256 amount0, uint256 amount1) {
        if (msg.value != 0 || INonfungiblePositionManagerV4(NFPM).ownerOf(tokenId) != msg.sender) {
            revert BadParams();
        }
        (, , , , , , , uint128 posLiq, , , , ) = INonfungiblePositionManagerV4(NFPM).positions(tokenId);
        if (posLiq != 0) {
            revert InsufficientLiquidity();
        }
        (amount0, amount1) = INonfungiblePositionManagerV4(NFPM).collect(
            INonfungiblePositionManagerV4.CollectParams({
                tokenId: tokenId,
                recipient: msg.sender,
                amount0Max: MAX_UINT128,
                amount1Max: MAX_UINT128
            })
        );
        INonfungiblePositionManagerV4(NFPM).burn(tokenId);
    }

    function zapOut(IPolicyVaultLpAdapter.ZapOutParams calldata p) external payable returns (uint256 amountOut) {
        if (msg.value != 0) {
            revert BadParams();
        }
        (, , address t0, address t1, uint24 fee, , , uint128 posLiq, , , , ) =
            INonfungiblePositionManagerV4(NFPM).positions(p.tokenId);
        if (p.liquidity == 0 || posLiq < p.liquidity) {
            revert InsufficientLiquidity();
        }
        if (t0 != W0G && t1 != W0G) {
            revert BadPool();
        }
        if (INonfungiblePositionManagerV4(NFPM).ownerOf(p.tokenId) != msg.sender) {
            revert NotVaultNft();
        }
        address paired = t0 == W0G ? t1 : t0;
        INonfungiblePositionManagerV4(NFPM).decreaseLiquidity(
            INonfungiblePositionManagerV4.DecreaseLiquidityParams({
                tokenId: p.tokenId,
                liquidity: p.liquidity,
                amount0Min: 0,
                amount1Min: 0,
                deadline: p.deadline
            })
        );
        INonfungiblePositionManagerV4(NFPM).collect(
            INonfungiblePositionManagerV4.CollectParams({
                tokenId: p.tokenId,
                recipient: address(this),
                amount0Max: MAX_UINT128,
                amount1Max: MAX_UINT128
            })
        );
        if (p.liquidity == posLiq) {
            INonfungiblePositionManagerV4(NFPM).burn(p.tokenId);
        }
        _swapExact(paired, W0G, fee, address(this), IERC20(paired).balanceOf(address(this)), 0, p.deadline);
        amountOut = _unwrapAllToSender();
        if (amountOut < p.amountOutMin) {
            revert SlippageExceeded();
        }
    }

    function sweepToken(IPolicyVaultLpAdapter.SweepParams calldata p) external payable returns (uint256 amountOut) {
        if (msg.value != 0 || p.amountIn == 0 || p.tokenIn == address(0) || p.tokenIn == p.tokenOut) {
            revert BadParams();
        }
        (address token0, address token1, uint24 fee) = poolTokens(p.poolId);
        address expectedOut = p.tokenOut == address(0) ? W0G : p.tokenOut;
        if (!((token0 == p.tokenIn && token1 == expectedOut) || (token1 == p.tokenIn && token0 == expectedOut))) {
            revert BadPool();
        }
        SafeTransferLib.safeTransferFrom(IERC20(p.tokenIn), msg.sender, address(this), p.amountIn);
        _swapExact(p.tokenIn, expectedOut, fee, p.tokenOut == address(0) ? address(this) : msg.sender, p.amountIn, p.amountOutMin, p.deadline);
        if (p.tokenOut == address(0)) {
            amountOut = _unwrapAllToSender();
            if (amountOut < p.amountOutMin) {
                revert SlippageExceeded();
            }
        } else {
            amountOut = p.amountOutMin;
        }
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        return INonfungiblePositionManagerV4(NFPM).ownerOf(tokenId);
    }

    function liquidityOf(uint256 tokenId) external view returns (uint128) {
        // B3 FIX: canonical UniV3 NFPM.positions() reverts 'Invalid token ID' on a burned token.
        // Exit post-checks (LpExit.zapOut/burnLp, LpEntry.purgeLpNft) read liquidityOf AFTER the
        // adapter burns the NFT; without this guard they revert and brick the exit path on mainnet.
        try INonfungiblePositionManagerV4(NFPM).positions(tokenId) returns (
            uint96, address, address, address, uint24, int24, int24, uint128 liq,
            uint256, uint256, uint128, uint128
        ) {
            return liq;
        } catch {
            return 0;
        }
    }

    function positionTicks(uint256 tokenId) external view returns (int24 tickLower, int24 tickUpper) {
        (, , , , , int24 tl, int24 tu, , , , , ) = INonfungiblePositionManagerV4(NFPM).positions(tokenId);
        return (tl, tu);
    }

    function poolTokens(bytes32 poolId) public view returns (address token0, address token1, uint24 fee) {
        address pool = address(uint160(uint256(poolId)));
        if (pool == address(0)) {
            revert BadPool();
        }
        IUniswapV3PoolV4 p = IUniswapV3PoolV4(pool);
        return (p.token0(), p.token1(), p.fee());
    }

    function _validatePool(bytes32 poolId, address token0, address token1, uint24 fee) private view {
        (address p0, address p1, uint24 pf) = poolTokens(poolId);
        if (p0 != token0 || p1 != token1 || pf != fee) {
            revert BadPool();
        }
    }

    function _swapExact(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        address recipient,
        uint256 amountIn,
        uint256 amountOutMinimum,
        uint256 deadline
    ) private returns (uint256 amountOut) {
        if (amountIn == 0) {
            return 0;
        }
        SafeTransferLib.forceApprove(IERC20(tokenIn), SWAP_ROUTER, amountIn);
        amountOut = ISwapRouterV4(SWAP_ROUTER).exactInputSingle(
            ISwapRouterV4.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: fee,
                recipient: recipient,
                deadline: deadline,
                amountIn: amountIn,
                amountOutMinimum: amountOutMinimum,
                sqrtPriceLimitX96: 0
            })
        );
        SafeTransferLib.forceApprove(IERC20(tokenIn), SWAP_ROUTER, 0);
    }

    function _unwrapAllToSender() private returns (uint256 amountOut) {
        uint256 w0gTotal = IERC20(W0G).balanceOf(address(this));
        uint256 nativeBefore = address(this).balance;
        if (w0gTotal > 0) {
            IWrappedNativeV4(W0G).withdraw(w0gTotal);
        }
        amountOut = address(this).balance - nativeBefore;
        SafeTransferLib.safeTransferNative(msg.sender, amountOut);
    }

    function _approveIfNeeded(IERC20 token, address spender, uint256 amount) private {
        if (amount > 0) {
            SafeTransferLib.forceApprove(token, spender, amount);
        }
    }

    function _sweepMintResiduals(
        IERC20 wnative,
        IERC20 paired,
        uint24 fee,
        uint256 deadline,
        uint256 amount0G,
        uint256 pairedConsumed
    ) private {
        uint256 pairedLeft = paired.balanceOf(address(this));
        if (pairedLeft > 0) {
            uint256 pairedDustLimit = (pairedConsumed * MAX_DUST_BPS) / BPS;
            if (pairedLeft > pairedDustLimit) {
                _swapExact(address(paired), W0G, fee, address(this), pairedLeft, 0, deadline);
            } else {
                SafeTransferLib.safeTransfer(paired, msg.sender, pairedLeft);
            }
        }
        uint256 w0gLeft = wnative.balanceOf(address(this));
        if (w0gLeft > 0) {
            if (w0gLeft >= amount0G) {
                revert W0GNotConsumed();
            }
            SafeTransferLib.safeTransfer(wnative, msg.sender, w0gLeft);
        }
    }

    function _computeSwapAmount(uint256 amount0G, int24 currentTick, int24 tickLower, int24 tickUpper, bool w0gIsToken0)
        private
        pure
        returns (uint256)
    {
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
        return (uint256(int256(numerator)) * amount0G + uint256(int256(range)) - 1) / uint256(int256(range));
    }
}
