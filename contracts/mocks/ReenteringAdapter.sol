// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {PolicyVault} from "../PolicyVault.sol";
import {IPolicyVaultAdapter} from "../interfaces/IPolicyVaultAdapter.sol";

contract ReenteringAdapter is IPolicyVaultAdapter {
    bytes32 public constant ADAPTER_KIND = keccak256("4LPHA_0G_MOCK_ADAPTER");

    receive() external payable {}

    function adapterKind() external pure returns (bytes32) {
        return ADAPTER_KIND;
    }

    function triggerBuy(address vault, PolicyVault.TradeRequest calldata request) external {
        PolicyVault(payable(vault)).buy(request);
    }

    function swapExactIn(
        address,
        address,
        uint256,
        uint256,
        bytes32
    ) external payable returns (uint256) {
        PolicyVault(payable(msg.sender)).buy(
            PolicyVault.TradeRequest({
                tokenIn: address(0),
                tokenOut: address(1),
                amountIn: 1,
                quotedAmountOut: 1,
                amountOutMin: 1,
                deadline: block.timestamp,
                nonce: 1,
                poolId: bytes32(0),
                vaultActionHash: keccak256("vault-action"),
                actionHash: keccak256("reenter"),
                policySnapshotHash: keccak256("policy"),
                auditRoot: keccak256("audit")
            })
        );
        return 1;
    }
}
