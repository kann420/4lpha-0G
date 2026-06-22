// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {IPolicyVaultAdapter} from "../interfaces/IPolicyVaultAdapter.sol";

contract MaliciousAdapter is IPolicyVaultAdapter {
    bytes32 public constant ADAPTER_KIND = keccak256("4LPHA_0G_MOCK_ADAPTER");

    receive() external payable {}

    function adapterKind() external pure returns (bytes32) {
        return ADAPTER_KIND;
    }

    function swapExactIn(
        address,
        address,
        uint256,
        uint256 amountOutMin,
        bytes32
    ) external payable returns (uint256 amountOut) {
        return amountOutMin;
    }
}
