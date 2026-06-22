// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {IERC20} from "../interfaces/IERC20.sol";
import {MockAssetToken} from "./MockAssetToken.sol";
import {MockWrappedNative} from "./MockWrappedNative.sol";
import {SafeTransferLib} from "../utils/SafeTransferLib.sol";

contract MockUniswapV3SwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    uint256 private constant RATE_SCALE = 1e18;

    MockWrappedNative public immutable WETH9;
    uint256 public buyRate;
    uint256 public sellRate;

    constructor(address wrappedNative_, uint256 buyRate_, uint256 sellRate_) {
        WETH9 = MockWrappedNative(payable(wrappedNative_));
        buyRate = buyRate_;
        sellRate = sellRate_;
    }

    receive() external payable {}

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut) {
        if (params.tokenIn == address(WETH9) && msg.value == params.amountIn) {
            amountOut = (params.amountIn * buyRate) / RATE_SCALE;
            if (amountOut < params.amountOutMinimum) {
                revert("too little out");
            }
            MockAssetToken(params.tokenOut).mint(params.recipient, amountOut);
            return amountOut;
        }

        if (params.tokenOut == address(WETH9) && msg.value == 0) {
            SafeTransferLib.safeTransferFrom(IERC20(params.tokenIn), msg.sender, address(this), params.amountIn);
            amountOut = (params.amountIn * sellRate) / RATE_SCALE;
            if (amountOut < params.amountOutMinimum) {
                revert("too little out");
            }
            WETH9.deposit{value: amountOut}();
            SafeTransferLib.safeTransfer(IERC20(address(WETH9)), params.recipient, amountOut);
            return amountOut;
        }

        revert("unsupported pair");
    }
}
