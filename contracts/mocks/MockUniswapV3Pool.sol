// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

contract MockUniswapV3Pool {
    uint24 public immutable fee;
    address public immutable token0;
    address public immutable token1;

    constructor(address token0_, address token1_, uint24 fee_) {
        token0 = token0_;
        token1 = token1_;
        fee = fee_;
    }
}
