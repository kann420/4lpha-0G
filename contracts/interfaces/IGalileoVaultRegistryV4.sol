// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IGalileoVaultRegistryV4 {
    function isAttestedVault(address vault) external view returns (bool);
}
