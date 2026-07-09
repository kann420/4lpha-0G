// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IOwnableV4 {
    function owner() external view returns (address);
}

contract VaultRegistryV4 {
    uint256 public constant VERSION = 4;

    mapping(address owner => address swapVault) public swapVaultOf;
    mapping(address owner => address lpEntryVault) public lpEntryVaultOf;
    mapping(address owner => address lpExitVault) public lpExitVaultOf;

    error AlreadyRegistered(address owner, address existing);
    error NotVaultOwner(address caller, address vault);

    event SwapVaultRegistered(address indexed owner, address indexed vault, uint256 version);
    event LpEntryVaultRegistered(address indexed owner, address indexed vault, uint256 version);
    event LpExitVaultRegistered(address indexed owner, address indexed vault, uint256 version);

    function registerSwap(address vault) external {
        _requireVaultOwner(vault);
        address existing = swapVaultOf[msg.sender];
        if (existing != address(0)) {
            revert AlreadyRegistered(msg.sender, existing);
        }
        swapVaultOf[msg.sender] = vault;
        emit SwapVaultRegistered(msg.sender, vault, VERSION);
    }

    function registerLpEntry(address vault) external {
        _requireVaultOwner(vault);
        address existing = lpEntryVaultOf[msg.sender];
        if (existing != address(0)) {
            revert AlreadyRegistered(msg.sender, existing);
        }
        lpEntryVaultOf[msg.sender] = vault;
        emit LpEntryVaultRegistered(msg.sender, vault, VERSION);
    }

    function registerLpExit(address vault) external {
        _requireVaultOwner(vault);
        address existing = lpExitVaultOf[msg.sender];
        if (existing != address(0)) {
            revert AlreadyRegistered(msg.sender, existing);
        }
        lpExitVaultOf[msg.sender] = vault;
        emit LpExitVaultRegistered(msg.sender, vault, VERSION);
    }

    function vaultOf(address owner) external view returns (address swapVault, address lpEntryVault, address lpExitVault) {
        swapVault = _ownedOrZero(owner, swapVaultOf[owner]);
        lpEntryVault = _ownedOrZero(owner, lpEntryVaultOf[owner]);
        lpExitVault = _ownedOrZero(owner, lpExitVaultOf[owner]);
    }

    function _requireVaultOwner(address vault) private view {
        if (vault == address(0) || vault.code.length == 0 || IOwnableV4(vault).owner() != msg.sender) {
            revert NotVaultOwner(msg.sender, vault);
        }
    }

    function _ownedOrZero(address expectedOwner, address vault) private view returns (address) {
        if (vault == address(0)) {
            return address(0);
        }
        try IOwnableV4(vault).owner() returns (address actualOwner) {
            return actualOwner == expectedOwner ? vault : address(0);
        } catch {
            return address(0);
        }
    }
}
