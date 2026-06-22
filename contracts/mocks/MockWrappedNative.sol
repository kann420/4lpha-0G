// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {MockAssetToken} from "./MockAssetToken.sol";
import {SafeTransferLib} from "../utils/SafeTransferLib.sol";

contract MockWrappedNative is MockAssetToken {
    constructor(address initialOwner) MockAssetToken(initialOwner) {}

    receive() external payable {
        deposit();
    }

    function deposit() public payable {
        _mint(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        SafeTransferLib.safeTransferNative(msg.sender, amount);
    }
}
