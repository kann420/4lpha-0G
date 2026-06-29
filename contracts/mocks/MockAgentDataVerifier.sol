// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

// TEST ONLY — this verifier echoes input hashes back as "proofs" and must NEVER
// be deployed or wired as the live mainnet AgenticID verifier. It exists solely
// for unit tests in test/AgenticID.ts. A real TEE/ZKP verifier is required before
// the iTransfer/iClone server path may be enabled (see AGENTS.md).
import {
    IERC7857DataVerifier,
    TransferValidityProof,
    TransferValidityProofOutput
} from "../interfaces/IERC7857DataVerifier.sol";

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
