// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {IERC7857DataVerifier, TransferValidityProof} from "./IERC7857DataVerifier.sol";

/// @title IERC7857
/// @notice Canonical ERC-7857 main interface for AI-agent NFTs with private
///         metadata. The re-key transfer/clone paths take TransferValidityProof
///         arrays that a real TEE/ZKP verifier (IERC7857DataVerifier) must back.
interface IERC7857 {
    event Approval(address indexed _from, address indexed _to, uint256 indexed _tokenId);
    event ApprovalForAll(address indexed _owner, address indexed _operator, bool _approved);
    event Authorization(address indexed _from, address indexed _to, uint256 indexed _tokenId);
    event AuthorizationRevoked(address indexed _from, address indexed _to, uint256 indexed _tokenId);
    event Transferred(uint256 _tokenId, address indexed _from, address indexed _to);
    event Cloned(uint256 indexed _tokenId, uint256 indexed _newTokenId, address _from, address _to);
    event PublishedSealedKey(address indexed _to, uint256 indexed _tokenId, bytes[] _sealedKeys);
    event DelegateAccess(address indexed _user, address indexed _assistant);

    function verifier() external view returns (IERC7857DataVerifier);

    function iTransfer(address to, uint256 tokenId, TransferValidityProof[] calldata proofs) external;

    function iClone(address to, uint256 tokenId, TransferValidityProof[] calldata proofs)
        external
        returns (uint256 newTokenId);

    function authorizeUsage(uint256 tokenId, address user) external;

    function revokeAuthorization(uint256 tokenId, address user) external;

    function approve(address to, uint256 tokenId) external;

    function setApprovalForAll(address operator, bool approved) external;

    function delegateAccess(address assistant) external;

    function ownerOf(uint256 tokenId) external view returns (address);

    function authorizedUsersOf(uint256 tokenId) external view returns (address[] memory);

    function getApproved(uint256 tokenId) external view returns (address);

    function isApprovedForAll(address tokenOwner, address operator) external view returns (bool);

    function getDelegateAccess(address user) external view returns (address);
}