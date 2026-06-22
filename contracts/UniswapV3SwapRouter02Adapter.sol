// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {IERC20} from "./interfaces/IERC20.sol";
import {IPolicyVaultAdapter} from "./interfaces/IPolicyVaultAdapter.sol";
import {ReentrancyGuard} from "./utils/ReentrancyGuard.sol";
import {SafeTransferLib} from "./utils/SafeTransferLib.sol";

interface IWETH9 is IERC20 {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

interface IUniswapV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
}

interface IUniswapV3Pool {
    function fee() external view returns (uint24);
    function token0() external view returns (address);
    function token1() external view returns (address);
}

interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

contract UniswapV3SwapRouter02Adapter is ReentrancyGuard, IPolicyVaultAdapter {
    bytes32 public constant ADAPTER_KIND = keccak256("4LPHA_0G_UNISWAP_V3_SWAP_ROUTER02_ADAPTER");

    error BadAmount();
    error BadPool();
    error BadValue();
    error InvalidAddress();
    error UnsupportedPair();

    ISwapRouter02 public immutable swapRouter02;
    IUniswapV3Factory public immutable v3Factory;
    IWETH9 public immutable wrappedNative;

    constructor(address swapRouter02_, address v3Factory_, address wrappedNative_) {
        if (
            swapRouter02_ == address(0) || v3Factory_ == address(0) || wrappedNative_ == address(0)
                || swapRouter02_.code.length == 0 || v3Factory_.code.length == 0 || wrappedNative_.code.length == 0
        ) {
            revert InvalidAddress();
        }

        swapRouter02 = ISwapRouter02(swapRouter02_);
        v3Factory = IUniswapV3Factory(v3Factory_);
        wrappedNative = IWETH9(wrappedNative_);
    }

    receive() external payable {
        if (msg.sender != address(wrappedNative)) {
            revert BadValue();
        }
    }

    function adapterKind() external pure returns (bytes32) {
        return ADAPTER_KIND;
    }

    function swapExactIn(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        bytes32 poolId
    ) external payable nonReentrant returns (uint256 amountOut) {
        if (amountIn == 0 || amountOutMin == 0) {
            revert BadAmount();
        }
        if (tokenIn == address(0) && tokenOut != address(0)) {
            if (msg.value != amountIn) {
                revert BadValue();
            }
            uint24 fee = _validatedPoolFee(poolId, address(wrappedNative), tokenOut);
            return _swapNativeForToken(tokenOut, fee, amountIn, amountOutMin);
        }
        if (tokenIn != address(0) && tokenOut == address(0)) {
            if (msg.value != 0) {
                revert BadValue();
            }
            uint24 fee = _validatedPoolFee(poolId, tokenIn, address(wrappedNative));
            return _swapTokenForNative(tokenIn, fee, amountIn, amountOutMin);
        }

        revert UnsupportedPair();
    }

    function _swapNativeForToken(
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint256 amountOutMin
    ) private returns (uint256 amountOut) {
        amountOut = swapRouter02.exactInputSingle{value: amountIn}(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: address(wrappedNative),
                tokenOut: tokenOut,
                fee: fee,
                recipient: msg.sender,
                amountIn: amountIn,
                amountOutMinimum: amountOutMin,
                sqrtPriceLimitX96: 0
            })
        );
    }

    function _swapTokenForNative(
        address tokenIn,
        uint24 fee,
        uint256 amountIn,
        uint256 amountOutMin
    ) private returns (uint256 amountOut) {
        IERC20 inputToken = IERC20(tokenIn);
        SafeTransferLib.safeTransferFrom(inputToken, msg.sender, address(this), amountIn);
        SafeTransferLib.forceApprove(inputToken, address(swapRouter02), amountIn);

        amountOut = swapRouter02.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: address(wrappedNative),
                fee: fee,
                recipient: address(this),
                amountIn: amountIn,
                amountOutMinimum: amountOutMin,
                sqrtPriceLimitX96: 0
            })
        );

        SafeTransferLib.forceApprove(inputToken, address(swapRouter02), 0);
        wrappedNative.withdraw(amountOut);
        SafeTransferLib.safeTransferNative(msg.sender, amountOut);
    }

    function _validatedPoolFee(bytes32 poolId, address tokenA, address tokenB) private view returns (uint24 fee) {
        address pool = address(uint160(uint256(poolId)));
        if (pool == address(0) || pool.code.length == 0 || tokenA == tokenB) {
            revert BadPool();
        }

        IUniswapV3Pool v3Pool = IUniswapV3Pool(pool);
        address poolToken0 = v3Pool.token0();
        address poolToken1 = v3Pool.token1();
        bool tokenPairMatches =
            (poolToken0 == tokenA && poolToken1 == tokenB) || (poolToken0 == tokenB && poolToken1 == tokenA);
        if (!tokenPairMatches) {
            revert BadPool();
        }

        fee = v3Pool.fee();
        if (v3Factory.getPool(tokenA, tokenB, fee) != pool) {
            revert BadPool();
        }
    }
}
