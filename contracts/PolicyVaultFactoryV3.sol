// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {PolicyVaultV3} from "./PolicyVaultV3.sol";

/// @title PolicyVaultFactoryV3
/// @notice Per-user isolated PolicyVaultV3 deployer. VERSION=3. Same sentinel pattern as V2
///         (VAULT_CREATION_SENTINEL guards against reentrant vault-of-owner lookups during create).
/// @dev A user may hold both a V2 vault and a V3 vault (separate namespaces). Migration is a
///      server-side flow that re-binds the agentKey on V3 — see docs/vault-v3-plan.md §migrate.
contract PolicyVaultFactoryV3 {
    uint256 public constant VERSION = 3;
    address private constant VAULT_CREATION_SENTINEL = address(1);

    error NotVaultOwner(address caller, address owner);
    error VaultAlreadyExists(address owner, address vault);

    mapping(address owner => address vault) public vaultOf;

    event VaultCreated(
        address indexed owner,
        address indexed executor,
        address indexed vault,
        address adapter,
        address lpAdapter,
        address proofRegistry,
        bool mockAdapterAllowed,
        bool mockLpAdapterAllowed
    );
    event VaultCreatedV3(
        address indexed owner,
        address indexed executor,
        address indexed vault,
        uint256 version,
        address adapter,
        address lpAdapter,
        address proofRegistry,
        bool mockAdapterAllowed,
        bool mockLpAdapterAllowed
    );

    function createVault(
        address owner,
        address executor,
        address adapter,
        address lpAdapter, // address(0) allowed = swap-only vault
        address proofRegistry,
        PolicyVaultV3.Policy calldata policy,
        address[] calldata allowedTokens,
        bytes32[] calldata allowedPools,
        bytes32[] calldata allowedLpPools,
        address[] calldata allowedStakeVaults,
        address[] calldata stakeVaultForLpPool, // parallel to allowedLpPools
        bool allowMockAdapter,
        bool allowMockLpAdapter
    ) external returns (address vault) {
        if (msg.sender != owner) {
            revert NotVaultOwner(msg.sender, owner);
        }
        address existingVault = vaultOf[owner];
        if (existingVault != address(0)) {
            revert VaultAlreadyExists(owner, existingVault);
        }
        vaultOf[owner] = VAULT_CREATION_SENTINEL;
        vault = address(
            new PolicyVaultV3(
                owner,
                executor,
                adapter,
                lpAdapter,
                proofRegistry,
                policy,
                allowedTokens,
                allowedPools,
                allowedLpPools,
                allowedStakeVaults,
                stakeVaultForLpPool,
                allowMockAdapter,
                allowMockLpAdapter
            )
        );
        vaultOf[owner] = vault;
        emit VaultCreated(owner, executor, vault, adapter, lpAdapter, proofRegistry, allowMockAdapter, allowMockLpAdapter);
        emit VaultCreatedV3(
            owner, executor, vault, VERSION, adapter, lpAdapter, proofRegistry, allowMockAdapter, allowMockLpAdapter
        );
    }
}