// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/// @title IERC7857Metadata
/// @notice Canonical ERC-7857 metadata interface. IntelligentData carries only
///         a description and a content hash; the plaintext agent data lives
///         off-chain (on 0G Storage) and is never stored on-chain.
struct IntelligentData {
    string dataDescription;
    bytes32 dataHash;
}

interface IERC7857Metadata {
    function name() external view returns (string memory);

    function symbol() external view returns (string memory);

    function intelligentDataOf(uint256 tokenId) external view returns (IntelligentData[] memory);
}