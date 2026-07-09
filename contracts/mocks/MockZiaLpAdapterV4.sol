// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockZiaLpAdapter} from "./MockZiaLpAdapter.sol";
import {MockNfpm} from "./MockNfpm.sol";
import {MockAssetToken} from "./MockAssetToken.sol";
import {MockWrappedNative} from "./MockWrappedNative.sol";

contract MockZiaLpAdapterV4 is MockZiaLpAdapter {
    constructor(address initialOwner, MockWrappedNative wnative, MockNfpm nfpm_, MockAssetToken pairedToken_)
        MockZiaLpAdapter(initialOwner, wnative, nfpm_, pairedToken_)
    {}
}
