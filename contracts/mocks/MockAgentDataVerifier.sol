// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {
    IERC7857DataVerifier,
    TransferValidityProof,
    TransferValidityProofOutput
} from "../AgenticID.sol";

contract MockAgentDataVerifier is IERC7857DataVerifier {
    function verifyTransferValidity(TransferValidityProof[] calldata proofs)
        external
        pure
        returns (TransferValidityProofOutput[] memory outputs)
    {
        outputs = new TransferValidityProofOutput[](proofs.length);
        for (uint256 i = 0; i < proofs.length; i++) {
            outputs[i] = TransferValidityProofOutput({
                oldDataHash: proofs[i].accessProof.oldDataHash,
                newDataHash: proofs[i].accessProof.newDataHash,
                sealedKey: proofs[i].ownershipProof.sealedKey,
                encryptedPubKey: proofs[i].ownershipProof.encryptedPubKey,
                wantedKey: proofs[i].accessProof.encryptedPubKey,
                accessAssistant: address(0xA11CE),
                accessProofNonce: proofs[i].accessProof.nonce,
                ownershipProofNonce: proofs[i].ownershipProof.nonce
            });
        }
    }
}
