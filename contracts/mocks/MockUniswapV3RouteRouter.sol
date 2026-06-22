// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {IERC20} from "../interfaces/IERC20.sol";
import {MockAssetToken} from "./MockAssetToken.sol";
import {MockWrappedNative} from "./MockWrappedNative.sol";
import {SafeTransferLib} from "../utils/SafeTransferLib.sol";

contract MockUniswapV3RouteRouter {
    struct DeadlineParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    struct NoDeadlineParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
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

    function exactInput(DeadlineParams calldata params) external payable returns (uint256 amountOut) {
        require(params.deadline >= block.timestamp, "deadline");
        return _exactInput(params.path, params.recipient, params.amountIn, params.amountOutMinimum);
    }

    function exactInput(NoDeadlineParams calldata params) external payable returns (uint256 amountOut) {
        return _exactInput(params.path, params.recipient, params.amountIn, params.amountOutMinimum);
    }

    function _exactInput(
        bytes calldata path,
        address recipient,
        uint256 amountIn,
        uint256 amountOutMinimum
    ) private returns (uint256 amountOut) {
        address firstToken = _readToken(path, 0);
        address lastToken = _readToken(path, path.length - 20);

        if (firstToken == address(WETH9) && msg.value == amountIn) {
            amountOut = (amountIn * buyRate) / RATE_SCALE;
            require(amountOut >= amountOutMinimum, "too little out");
            MockAssetToken(lastToken).mint(recipient, amountOut);
            return amountOut;
        }

        if (lastToken == address(WETH9) && msg.value == 0) {
            SafeTransferLib.safeTransferFrom(IERC20(firstToken), msg.sender, address(this), amountIn);
            amountOut = (amountIn * sellRate) / RATE_SCALE;
            require(amountOut >= amountOutMinimum, "too little out");
            WETH9.deposit{value: amountOut}();
            SafeTransferLib.safeTransfer(IERC20(address(WETH9)), recipient, amountOut);
            return amountOut;
        }

        revert("unsupported route");
    }

    function _readToken(bytes calldata path, uint256 offset) private pure returns (address token) {
        require(path.length >= offset + 20, "path short");
        assembly {
            token := shr(96, calldataload(add(path.offset, offset)))
        }
    }
}
