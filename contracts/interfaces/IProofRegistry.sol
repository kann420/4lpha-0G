// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

interface IProofRegistry {
    function isAccepted(
        bytes32 actionHash,
        bytes32 auditRoot,
        bytes32 policySnapshotHash,
        bytes32 vaultActionHash
    ) external view returns (bool);
}
