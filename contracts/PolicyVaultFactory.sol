// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {PolicyVault} from "./PolicyVault.sol";

contract PolicyVaultFactory {
    address private constant VAULT_CREATION_SENTINEL = address(1);

    error NotVaultOwner(address caller, address owner);
    error VaultAlreadyExists(address owner, address vault);

    mapping(address owner => address vault) public vaultOf;

    event VaultCreated(
        address indexed owner,
        address indexed executor,
        address indexed vault,
        address adapter,
        address proofRegistry,
        bool mockAdapterAllowed
    );

    function createVault(
        address owner,
        address executor,
        address adapter,
        address proofRegistry,
        PolicyVault.Policy calldata policy,
        address[] calldata allowedTokens,
        bytes32[] calldata allowedPools,
        bool allowMockAdapter
    ) external returns (address vault) {
        if (msg.sender != owner) {
            revert NotVaultOwner(msg.sender, owner);
        }
        address existingVault = vaultOf[owner];
        if (existingVault != address(0)) {
            revert VaultAlreadyExists(owner, existingVault);
        }
        vaultOf[owner] = VAULT_CREATION_SENTINEL;
        vault = address(new PolicyVault(owner, executor, adapter, proofRegistry, policy, allowedTokens, allowedPools, allowMockAdapter));
        vaultOf[owner] = vault;
        emit VaultCreated(owner, executor, vault, adapter, proofRegistry, allowMockAdapter);
    }
}
