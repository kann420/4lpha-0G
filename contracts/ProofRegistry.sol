// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {Ownable} from "./utils/Ownable.sol";

contract ProofRegistry is Ownable {
    struct Proof {
        bytes32 auditRoot;
        bytes32 policySnapshotHash;
        bytes32 modelMetadataHash;
        bytes32 vaultActionHash;
        string storageRef;
        string agentRef;
        uint64 acceptedAt;
    }

    error InvalidProof();
    error ProofAlreadyAccepted(bytes32 actionHash);

    mapping(bytes32 actionHash => Proof proof) private _proofs;

    event ProofAccepted(
        bytes32 indexed actionHash,
        bytes32 indexed auditRoot,
        bytes32 indexed policySnapshotHash,
        bytes32 modelMetadataHash,
        bytes32 vaultActionHash,
        string storageRef,
        string agentRef
    );

    constructor(address initialOwner) Ownable(initialOwner) {}

    function acceptProof(
        bytes32 actionHash,
        bytes32 auditRoot,
        bytes32 policySnapshotHash,
        bytes32 modelMetadataHash,
        string calldata storageRef,
        bytes32 vaultActionHash,
        string calldata agentRef
    ) external onlyOwner {
        if (
            actionHash == bytes32(0) || auditRoot == bytes32(0) || policySnapshotHash == bytes32(0)
                || modelMetadataHash == bytes32(0) || vaultActionHash == bytes32(0)
                || bytes(storageRef).length == 0 || bytes(agentRef).length == 0
        ) {
            revert InvalidProof();
        }
        if (_proofs[actionHash].acceptedAt != 0) {
            revert ProofAlreadyAccepted(actionHash);
        }

        _proofs[actionHash] = Proof({
            auditRoot: auditRoot,
            policySnapshotHash: policySnapshotHash,
            modelMetadataHash: modelMetadataHash,
            vaultActionHash: vaultActionHash,
            storageRef: storageRef,
            agentRef: agentRef,
            acceptedAt: uint64(block.timestamp)
        });

        emit ProofAccepted(
            actionHash,
            auditRoot,
            policySnapshotHash,
            modelMetadataHash,
            vaultActionHash,
            storageRef,
            agentRef
        );
    }

    function proofFor(bytes32 actionHash) external view returns (Proof memory) {
        return _proofs[actionHash];
    }

    function isAccepted(
        bytes32 actionHash,
        bytes32 auditRoot,
        bytes32 policySnapshotHash,
        bytes32 vaultActionHash
    ) external view returns (bool) {
        Proof storage proof = _proofs[actionHash];
        return proof.acceptedAt != 0
            && proof.auditRoot == auditRoot
            && proof.policySnapshotHash == policySnapshotHash
            && proof.vaultActionHash == vaultActionHash;
    }
}
