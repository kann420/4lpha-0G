// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {IERC20} from "../interfaces/IERC20.sol";
import {Ownable} from "../utils/Ownable.sol";

contract MockAssetToken is IERC20, Ownable {
    error NotMinter();
    error TransferAmountExceeded();
    error ZeroMinter();

    string public constant name = "4lpha Mock 0G Asset";
    string public constant symbol = "m0GA";
    uint8 public constant decimals = 18;

    address public minter;
    uint256 public totalSupply;

    mapping(address account => uint256 balance) public balanceOf;
    mapping(address owner => mapping(address spender => uint256 amount)) public allowance;

    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Transfer(address indexed from, address indexed to, uint256 value);

    constructor(address initialOwner) Ownable(initialOwner) {}

    function setMinter(address nextMinter) external onlyOwner {
        if (nextMinter == address(0)) {
            revert ZeroMinter();
        }
        minter = nextMinter;
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != minter) {
            revert NotMinter();
        }
        _mint(to, amount);
    }

    function burnFrom(address account, uint256 amount) external {
        if (msg.sender != minter) {
            revert NotMinter();
        }
        _burn(account, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 currentAllowance = allowance[from][msg.sender];
        if (currentAllowance != type(uint256).max) {
            if (currentAllowance < amount) {
                revert TransferAmountExceeded();
            }
            allowance[from][msg.sender] = currentAllowance - amount;
            emit Approval(from, msg.sender, allowance[from][msg.sender]);
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) private {
        if (balanceOf[from] < amount) {
            revert TransferAmountExceeded();
        }
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }

    function _mint(address to, uint256 amount) internal {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function _burn(address account, uint256 amount) internal {
        if (balanceOf[account] < amount) {
            revert TransferAmountExceeded();
        }
        balanceOf[account] -= amount;
        totalSupply -= amount;
        emit Transfer(account, address(0), amount);
    }
}
