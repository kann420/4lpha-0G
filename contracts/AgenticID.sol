// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {Ownable} from "./utils/Ownable.sol";

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

struct IntelligentData {
    string dataDescription;
    bytes32 dataHash;
}

interface IERC7857DataVerifier {
    function verifyTransferValidity(TransferValidityProof[] calldata proofs)
        external
        returns (TransferValidityProofOutput[] memory);
}

contract AgenticID is Ownable {
    struct TokenData {
        address owner;
        address approvedUser;
        address vault;
        address executor;
        string storageRef;
        string agentRef;
        uint64 mintedAt;
        IntelligentData[] iDatas;
        address[] authorizedUsers;
        mapping(address user => bool authorized) isAuthorized;
    }

    error AlreadyAuthorized();
    error BadProof();
    error InvalidAddress();
    error InvalidMetadata();
    error NotApprovedOrOwner();
    error NotAuthorized();
    error TokenNotFound();
    error VerifierNotConfigured();

    event Approval(address indexed _from, address indexed _to, uint256 indexed _tokenId);
    event ApprovalForAll(address indexed _owner, address indexed _operator, bool _approved);
    event Authorization(address indexed _from, address indexed _to, uint256 indexed _tokenId);
    event AuthorizationRevoked(address indexed _from, address indexed _to, uint256 indexed _tokenId);
    event Cloned(uint256 indexed _tokenId, uint256 indexed _newTokenId, address _from, address _to);
    event DelegateAccess(address indexed _user, address indexed _assistant);
    event PublishedSealedKey(address indexed _to, uint256 indexed _tokenId, bytes[] _sealedKeys);
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Transferred(uint256 _tokenId, address indexed _from, address indexed _to);

    event AgentMinted(
        uint256 indexed tokenId,
        address indexed creator,
        address indexed owner,
        address vault,
        address executor,
        string agentRef,
        string storageRef
    );
    event AgentDataUpdated(uint256 indexed tokenId, bytes32[] oldDataHashes, bytes32[] newDataHashes);
    event VerifierUpdated(address indexed verifier);

    string private _name;
    string private _symbol;
    uint256 private _nextTokenId = 1;
    IERC7857DataVerifier private _verifier;

    mapping(uint256 tokenId => TokenData tokenData) private _tokens;
    mapping(address owner => uint256 balance) private _balances;
    mapping(address owner => mapping(address operator => bool approved)) private _operatorApprovals;
    mapping(address user => address assistant) private _delegateAccess;

    constructor(
        address initialOwner,
        string memory name_,
        string memory symbol_,
        address verifier_
    ) Ownable(initialOwner) {
        if (bytes(name_).length == 0 || bytes(symbol_).length == 0) {
            revert InvalidMetadata();
        }
        _name = name_;
        _symbol = symbol_;
        _verifier = IERC7857DataVerifier(verifier_);
        emit VerifierUpdated(verifier_);
    }

    function name() external view returns (string memory) {
        return _name;
    }

    function symbol() external view returns (string memory) {
        return _symbol;
    }

    function verifier() external view returns (IERC7857DataVerifier) {
        return _verifier;
    }

    function setVerifier(address verifier_) external onlyOwner {
        _verifier = IERC7857DataVerifier(verifier_);
        emit VerifierUpdated(verifier_);
    }

    function nextTokenId() external view returns (uint256) {
        return _nextTokenId;
    }

    function mintAgent(
        address to,
        IntelligentData[] calldata iDatas,
        string calldata storageRef,
        string calldata agentRef,
        address vault,
        address executor
    ) external onlyOwner returns (uint256 tokenId) {
        if (to == address(0) || vault == address(0) || executor == address(0)) {
            revert InvalidAddress();
        }
        if (bytes(storageRef).length == 0 || bytes(agentRef).length == 0 || iDatas.length == 0) {
            revert InvalidMetadata();
        }

        tokenId = _nextTokenId++;
        TokenData storage token = _tokens[tokenId];
        token.owner = to;
        token.vault = vault;
        token.executor = executor;
        token.storageRef = storageRef;
        token.agentRef = agentRef;
        token.mintedAt = uint64(block.timestamp);
        for (uint256 i = 0; i < iDatas.length; i++) {
            if (bytes(iDatas[i].dataDescription).length == 0 || iDatas[i].dataHash == bytes32(0)) {
                revert InvalidMetadata();
            }
            token.iDatas.push(iDatas[i]);
        }

        _balances[to] += 1;
        _authorize(tokenId, executor);

        emit Transfer(address(0), to, tokenId);
        emit AgentMinted(tokenId, msg.sender, to, vault, executor, agentRef, storageRef);
    }

    function iTransfer(address to, uint256 tokenId, TransferValidityProof[] calldata proofs) external {
        if (to == address(0)) {
            revert InvalidAddress();
        }
        address from = ownerOf(tokenId);
        _requireApprovedOrOwner(msg.sender, tokenId);
        _applyProofedDataUpdate(tokenId, to, proofs);
        _clearAuthorizations(tokenId);
        _tokens[tokenId].owner = to;
        _tokens[tokenId].approvedUser = address(0);
        _balances[from] -= 1;
        _balances[to] += 1;

        emit Transfer(from, to, tokenId);
        emit Transferred(tokenId, from, to);
    }

    function iClone(address to, uint256 tokenId, TransferValidityProof[] calldata proofs)
        external
        returns (uint256 newTokenId)
    {
        if (to == address(0)) {
            revert InvalidAddress();
        }
        _requireApprovedOrOwner(msg.sender, tokenId);
        TokenData storage source = _requireToken(tokenId);
        TransferValidityProofOutput[] memory outputs = _verifyProofs(source, proofs);

        newTokenId = _nextTokenId++;
        TokenData storage clone = _tokens[newTokenId];
        clone.owner = to;
        clone.vault = source.vault;
        clone.executor = source.executor;
        clone.storageRef = source.storageRef;
        clone.agentRef = source.agentRef;
        clone.mintedAt = uint64(block.timestamp);
        for (uint256 i = 0; i < source.iDatas.length; i++) {
            clone.iDatas.push(IntelligentData({
                dataDescription: source.iDatas[i].dataDescription,
                dataHash: outputs[i].newDataHash
            }));
        }

        _balances[to] += 1;
        emit Transfer(address(0), to, newTokenId);
        emit Cloned(tokenId, newTokenId, msg.sender, to);
    }

    function authorizeUsage(uint256 tokenId, address user) external {
        _requireApprovedOrOwner(msg.sender, tokenId);
        _authorize(tokenId, user);
    }

    function revokeAuthorization(uint256 tokenId, address user) external {
        _requireApprovedOrOwner(msg.sender, tokenId);
        TokenData storage token = _requireToken(tokenId);
        if (!token.isAuthorized[user]) {
            revert NotAuthorized();
        }
        token.isAuthorized[user] = false;
        emit AuthorizationRevoked(msg.sender, user, tokenId);
    }

    function approve(address to, uint256 tokenId) external {
        address tokenOwner = ownerOf(tokenId);
        if (msg.sender != tokenOwner && !_operatorApprovals[tokenOwner][msg.sender]) {
            revert NotApprovedOrOwner();
        }
        _tokens[tokenId].approvedUser = to;
        emit Approval(tokenOwner, to, tokenId);
    }

    function setApprovalForAll(address operator, bool approved) external {
        if (operator == address(0) || operator == msg.sender) {
            revert InvalidAddress();
        }
        _operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function delegateAccess(address assistant) external {
        if (assistant == address(0)) {
            revert InvalidAddress();
        }
        _delegateAccess[msg.sender] = assistant;
        emit DelegateAccess(msg.sender, assistant);
    }

    function ownerOf(uint256 tokenId) public view returns (address) {
        return _requireToken(tokenId).owner;
    }

    function balanceOf(address account) external view returns (uint256) {
        if (account == address(0)) {
            revert InvalidAddress();
        }
        return _balances[account];
    }

    function intelligentDataOf(uint256 tokenId) external view returns (IntelligentData[] memory) {
        TokenData storage token = _requireToken(tokenId);
        IntelligentData[] memory result = new IntelligentData[](token.iDatas.length);
        for (uint256 i = 0; i < token.iDatas.length; i++) {
            result[i] = token.iDatas[i];
        }
        return result;
    }

    function authorizedUsersOf(uint256 tokenId) external view returns (address[] memory) {
        TokenData storage token = _requireToken(tokenId);
        uint256 count;
        for (uint256 i = 0; i < token.authorizedUsers.length; i++) {
            if (token.isAuthorized[token.authorizedUsers[i]]) {
                count++;
            }
        }
        address[] memory result = new address[](count);
        uint256 cursor;
        for (uint256 i = 0; i < token.authorizedUsers.length; i++) {
            address user = token.authorizedUsers[i];
            if (token.isAuthorized[user]) {
                result[cursor++] = user;
            }
        }
        return result;
    }

    function agentRecord(uint256 tokenId)
        external
        view
        returns (
            address tokenOwner,
            address vault,
            address executor,
            string memory storageRef,
            string memory agentRef,
            uint64 mintedAt
        )
    {
        TokenData storage token = _requireToken(tokenId);
        return (token.owner, token.vault, token.executor, token.storageRef, token.agentRef, token.mintedAt);
    }

    function getApproved(uint256 tokenId) external view returns (address) {
        return _requireToken(tokenId).approvedUser;
    }

    function isApprovedForAll(address tokenOwner, address operator) external view returns (bool) {
        return _operatorApprovals[tokenOwner][operator];
    }

    function getDelegateAccess(address user) external view returns (address) {
        return _delegateAccess[user];
    }

    function _applyProofedDataUpdate(
        uint256 tokenId,
        address to,
        TransferValidityProof[] calldata proofs
    ) private {
        TokenData storage token = _requireToken(tokenId);
        TransferValidityProofOutput[] memory outputs = _verifyProofs(token, proofs);
        bytes32[] memory oldHashes = new bytes32[](outputs.length);
        bytes32[] memory newHashes = new bytes32[](outputs.length);
        bytes[] memory sealedKeys = new bytes[](outputs.length);

        for (uint256 i = 0; i < outputs.length; i++) {
            oldHashes[i] = outputs[i].oldDataHash;
            newHashes[i] = outputs[i].newDataHash;
            sealedKeys[i] = outputs[i].sealedKey;
            token.iDatas[i].dataHash = outputs[i].newDataHash;
        }

        emit AgentDataUpdated(tokenId, oldHashes, newHashes);
        emit PublishedSealedKey(to, tokenId, sealedKeys);
    }

    function _verifyProofs(TokenData storage token, TransferValidityProof[] calldata proofs)
        private
        returns (TransferValidityProofOutput[] memory outputs)
    {
        if (address(_verifier) == address(0)) {
            revert VerifierNotConfigured();
        }
        if (proofs.length != token.iDatas.length) {
            revert BadProof();
        }
        outputs = _verifier.verifyTransferValidity(proofs);
        if (outputs.length != token.iDatas.length) {
            revert BadProof();
        }
        for (uint256 i = 0; i < outputs.length; i++) {
            if (
                outputs[i].oldDataHash != token.iDatas[i].dataHash
                    || outputs[i].newDataHash == bytes32(0)
                    || outputs[i].sealedKey.length == 0
            ) {
                revert BadProof();
            }
        }
    }

    function _requireApprovedOrOwner(address caller, uint256 tokenId) private view {
        TokenData storage token = _requireToken(tokenId);
        if (
            caller != token.owner
                && caller != token.approvedUser
                && !_operatorApprovals[token.owner][caller]
        ) {
            revert NotApprovedOrOwner();
        }
    }

    function _authorize(uint256 tokenId, address user) private {
        if (user == address(0)) {
            revert InvalidAddress();
        }
        TokenData storage token = _requireToken(tokenId);
        if (token.isAuthorized[user]) {
            revert AlreadyAuthorized();
        }
        token.isAuthorized[user] = true;
        token.authorizedUsers.push(user);
        emit Authorization(msg.sender, user, tokenId);
    }

    function _clearAuthorizations(uint256 tokenId) private {
        TokenData storage token = _requireToken(tokenId);
        for (uint256 i = 0; i < token.authorizedUsers.length; i++) {
            address user = token.authorizedUsers[i];
            if (token.isAuthorized[user]) {
                token.isAuthorized[user] = false;
                emit AuthorizationRevoked(msg.sender, user, tokenId);
            }
        }
        delete token.authorizedUsers;
    }

    function _requireToken(uint256 tokenId) private view returns (TokenData storage token) {
        token = _tokens[tokenId];
        if (token.owner == address(0)) {
            revert TokenNotFound();
        }
    }
}
