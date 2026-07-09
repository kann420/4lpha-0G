// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IVaultRegistryV4 {
    event SwapVaultRegistered(address indexed owner, address indexed vault, uint256 version);
    event LpEntryVaultRegistered(address indexed owner, address indexed vault, uint256 version);
    event LpExitVaultRegistered(address indexed owner, address indexed vault, uint256 version);

    function VERSION() external view returns (uint256);
    function swapVaultOf(address owner) external view returns (address);
    function lpEntryVaultOf(address owner) external view returns (address);
    function lpExitVaultOf(address owner) external view returns (address);
    function registerSwap(address vault) external;
    function registerLpEntry(address vault) external;
    function registerLpExit(address vault) external;
    function vaultOf(address owner) external view returns (address swapVault, address lpEntryVault, address lpExitVault);
}
