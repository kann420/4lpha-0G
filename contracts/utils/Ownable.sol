// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

abstract contract Ownable {
    error NotOwner();
    error ZeroOwner();

    address private _owner;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        if (msg.sender != _owner) {
            revert NotOwner();
        }
        _;
    }

    constructor(address initialOwner) {
        if (initialOwner == address(0)) {
            revert ZeroOwner();
        }
        _owner = initialOwner;
        emit OwnershipTransferred(address(0), initialOwner);
    }

    function owner() public view returns (address) {
        return _owner;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) {
            revert ZeroOwner();
        }
        address previousOwner = _owner;
        _owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }
}
