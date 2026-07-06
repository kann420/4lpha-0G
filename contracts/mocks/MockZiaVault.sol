// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {MockNfpm} from "./MockNfpm.sol";
import {Ownable} from "../utils/Ownable.sol";

/// @notice Minimal Zia staking vault stand-in: deposit/withdraw an NFT, track depositor.
/// @dev Mirrors the IZiaVault surface PolicyVaultV3 calls directly (deposit/withdraw/depositorOf).
///      Only the registered NFPM may transfer on deposit/withdraw (the vault approves the NFT to
///      this vault, then calls deposit which pulls the NFT from the vault).
contract MockZiaVault is Ownable {
    error NotNfpm();
    error NotDepositor();
    error NotStaked();

    address public nfpm;
    mapping(uint256 tokenId => address depositor) public depositorOf;

    constructor(address initialOwner, address nfpm_) Ownable(initialOwner) {
        nfpm = nfpm_;
    }

    function deposit(uint256 tokenId) external {
        // Pull the NFT from msg.sender (the vault) via the registered NFPM.
        MockNfpm(nfpm).transferFrom(msg.sender, address(this), tokenId);
        depositorOf[tokenId] = msg.sender;
    }

    function withdraw(uint256 tokenId) external {
        address depositor = depositorOf[tokenId];
        if (depositor == address(0)) {
            revert NotStaked();
        }
        if (msg.sender != depositor) {
            revert NotDepositor();
        }
        depositorOf[tokenId] = address(0);
        MockNfpm(nfpm).transferFrom(address(this), depositor, tokenId);
    }
}