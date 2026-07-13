// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "./utils/Ownable.sol";

interface IGalileoVaultConfig {
    function owner() external view returns (address);
    function executor() external view returns (address);
    function swapAdapter() external view returns (address);
    function proofRegistry() external view returns (address);
    function allowedTokens(address) external view returns (bool);
    function allowedPools(bytes32) external view returns (bool);
    function mockAdapterAllowed() external view returns (bool);
}

contract GalileoVaultRegistryV4 is Ownable {
    uint256 public constant VERSION = 4;
    /// @dev Runtime code is immutable-parameterized, so its hash is captured per attested vault.
    /// The dedicated attestor approves it off-chain against the deployment artifact before this call.
    bytes32 public immutable vaultImplementationCodeHash;
    address public immutable expectedExecutor;
    address public expectedAdapter;
    address public immutable expectedProofRegistry;
    address public immutable expectedToken;
    bytes32 public immutable expectedPoolId;
    mapping(address => address) public vaultOf;
    mapping(address => bool) private _attested;
    mapping(address => bytes32) public attestedRuntimeCodeHash;
    bool public adapterConfigured;
    error AlreadyRegistered(); error InvalidVault();
    event VaultAttested(address indexed owner, address indexed vault, bytes32 codeHash);
    constructor(address initialOwner, bytes32 codeHash, address executor_, address adapter_, address proofRegistry_, address token_, bytes32 poolId_) Ownable(initialOwner) {
        if (codeHash == bytes32(0) || executor_ == address(0) || proofRegistry_ == address(0) || token_ == address(0) || poolId_ == bytes32(0)) revert InvalidVault();
        vaultImplementationCodeHash=codeHash; expectedExecutor=executor_; expectedAdapter=adapter_; expectedProofRegistry=proofRegistry_; expectedToken=token_; expectedPoolId=poolId_;
    }
    function configureAdapter(address adapter_) external onlyOwner {
        if (adapterConfigured || adapter_ == address(0) || adapter_.code.length == 0) revert InvalidVault();
        expectedAdapter = adapter_;
        adapterConfigured = true;
    }
    function attestVault(address vault) external onlyOwner {
        IGalileoVaultConfig v = IGalileoVaultConfig(vault);
        // The immutable constructor arguments are not enough to identify an
        // implementation. Reject a look-alike contract before making it an
        // adapter-authorized vault.
        if (!adapterConfigured || vault.code.length == 0 || vault.codehash != vaultImplementationCodeHash || v.owner() == address(0) || v.executor() != expectedExecutor || v.swapAdapter() != expectedAdapter || v.proofRegistry() != expectedProofRegistry || !v.allowedTokens(expectedToken) || !v.allowedPools(expectedPoolId) || v.mockAdapterAllowed()) revert InvalidVault();
        address vaultOwner = v.owner(); if (vaultOf[vaultOwner] != address(0)) revert AlreadyRegistered();
        vaultOf[vaultOwner] = vault; _attested[vault] = true; attestedRuntimeCodeHash[vault] = vault.codehash; emit VaultAttested(vaultOwner, vault, vault.codehash);
    }
    function isAttestedVault(address vault) external view returns (bool) { return _attested[vault]; }
}
