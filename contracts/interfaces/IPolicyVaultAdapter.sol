// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

interface IPolicyVaultAdapter {
    function adapterKind() external view returns (bytes32);

    function swapExactIn(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        bytes32 poolId
    ) external payable returns (uint256 amountOut);
}
