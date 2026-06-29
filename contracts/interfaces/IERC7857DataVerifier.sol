// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/// @title IERC7857DataVerifier
/// @notice Canonical ERC-7857 verifier interface. Produces TransferValidityProof
///         outputs that the AgenticID contract consumes during iTransfer/iClone.
///         The proof structs and OracleType enum are defined here so the main
///         IERC7857 interface and the AgenticID contract can import them without
///         circular dependencies.
enum OracleType {
    TEE,
    ZKP
}

struct AccessProof {
    bytes32 oldDataHash;
    bytes32 newDataHash;
    bytes nonce;
    bytes encryptedPubKey;
    bytes proof;
}

struct OwnershipProof {
    OracleType oracleType;
    bytes32 oldDataHash;
    bytes32 newDataHash;
    bytes sealedKey;
    bytes encryptedPubKey;
    bytes nonce;
    bytes proof;
}

struct TransferValidityProof {
    AccessProof accessProof;
    OwnershipProof ownershipProof;
}

struct TransferValidityProofOutput {
    bytes32 oldDataHash;
    bytes32 newDataHash;
    bytes sealedKey;
    bytes encryptedPubKey;
    bytes wantedKey;
    address accessAssistant;
    bytes accessProofNonce;
    bytes ownershipProofNonce;
}

interface IERC7857DataVerifier {
    function verifyTransferValidity(TransferValidityProof[] calldata proofs)
        external
        returns (TransferValidityProofOutput[] memory);
}