// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IGalileoSandboxQuote {
    function quoteExactIn(address tokenIn, uint256 amountIn) external view returns (uint256 amountOut);
}
