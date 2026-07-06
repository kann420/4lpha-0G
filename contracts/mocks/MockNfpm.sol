// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {Ownable} from "../utils/Ownable.sol";

/// @notice Minimal ERC721 stand-in for the Zia/Uniswap V3 NonfungiblePositionManager used by tests.
/// @dev Only the owner (the mock LP adapter) may mint/burn. transferFrom checks approval. Used by
///      PolicyVaultV3 via IERC721(lpAdapter.nfpm()) for ownerOf/balanceOf/approve/transferFrom.
contract MockNfpm is Ownable {
    error NotApprovedOrOwner();
    error NonexistentToken();
    error WrongFrom();

    uint256 public nextTokenId = 1;
    mapping(uint256 tokenId => address owner) private _owners;
    mapping(address owner => uint256 balance) public balanceOf;
    mapping(uint256 tokenId => address approved) private _tokenApprovals;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);

    constructor(address initialOwner) Ownable(initialOwner) {}

    function mint(address to) external onlyOwner returns (uint256 tokenId) {
        tokenId = nextTokenId++;
        _owners[tokenId] = to;
        balanceOf[to] += 1;
        emit Transfer(address(0), to, tokenId);
    }

    function burn(uint256 tokenId) external onlyOwner {
        address owner = _owners[tokenId];
        if (owner == address(0)) {
            revert NonexistentToken();
        }
        _owners[tokenId] = address(0);
        balanceOf[owner] -= 1;
        delete _tokenApprovals[tokenId];
        emit Transfer(owner, address(0), tokenId);
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        address o = _owners[tokenId];
        if (o == address(0)) {
            revert NonexistentToken();
        }
        return o;
    }

    function getApproved(uint256 tokenId) external view returns (address) {
        return _tokenApprovals[tokenId];
    }

    function approve(address to, uint256 tokenId) external {
        address owner = _owners[tokenId];
        if (msg.sender != owner) {
            revert NotApprovedOrOwner();
        }
        _tokenApprovals[tokenId] = to;
        emit Approval(owner, to, tokenId);
    }

    function transferFrom(address from, address to, uint256 tokenId) external {
        address owner = _owners[tokenId];
        if (owner == address(0)) {
            revert NonexistentToken();
        }
        if (from != owner) {
            revert WrongFrom();
        }
        if (msg.sender != owner && _tokenApprovals[tokenId] != msg.sender) {
            revert NotApprovedOrOwner();
        }
        _tokenApprovals[tokenId] = address(0);
        _owners[tokenId] = to;
        balanceOf[from] -= 1;
        balanceOf[to] += 1;
        emit Transfer(from, to, tokenId);
    }
}