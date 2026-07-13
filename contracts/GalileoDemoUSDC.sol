// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "./utils/Ownable.sol";

/// @notice Deliberately non-production demo asset for the Galileo sandbox only.
contract GalileoDemoUSDC is Ownable {
    string public constant name = "Galileo Demo USD Coin";
    string public constant symbol = "mUSDC";
    uint8 public constant decimals = 6;
    uint256 public constant MAX_SUPPLY = 1_000_000 * 10 ** 6;
    uint256 public constant FAUCET_AMOUNT = 10 * 10 ** 6;
    uint256 public constant FAUCET_COOLDOWN = 1 days;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => uint256) public lastFaucetAt;

    error FaucetCooldown();
    error MaxSupplyExceeded();
    error InvalidAddress();
    error InsufficientBalance();
    error InsufficientAllowance();

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);
    event FaucetClaimed(address indexed recipient, uint256 amount);

    constructor(address initialOwner) Ownable(initialOwner) {}

    function claimFaucet() external {
        if (lastFaucetAt[msg.sender] != 0 && block.timestamp < lastFaucetAt[msg.sender] + FAUCET_COOLDOWN) revert FaucetCooldown();
        lastFaucetAt[msg.sender] = block.timestamp;
        _mint(msg.sender, FAUCET_AMOUNT);
        emit FaucetClaimed(msg.sender, FAUCET_AMOUNT);
    }

    function mintForPool(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) { _transfer(msg.sender, to, amount); return true; }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 permitted = allowance[from][msg.sender];
        if (permitted != type(uint256).max) {
            if (permitted < amount) revert InsufficientAllowance();
            allowance[from][msg.sender] = permitted - amount;
            emit Approval(from, msg.sender, allowance[from][msg.sender]);
        }
        _transfer(from, to, amount);
        return true;
    }

    function _mint(address to, uint256 amount) private {
        if (to == address(0)) revert InvalidAddress();
        if (totalSupply + amount > MAX_SUPPLY) revert MaxSupplyExceeded();
        totalSupply += amount; balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }
    function _transfer(address from, address to, uint256 amount) private {
        if (to == address(0)) revert InvalidAddress();
        if (balanceOf[from] < amount) revert InsufficientBalance();
        balanceOf[from] -= amount; balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
