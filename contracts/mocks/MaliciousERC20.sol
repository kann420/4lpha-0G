// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract MaliciousERC20 {
    string public name = "Malicious ERC20";
    string public symbol = "MAL";
    uint8 public decimals = 18;
    uint256 public totalSupply;
    bool public lieOnBalance;
    bool public feeOnTransfer;
    bool public reenterOnTransfer;
    address public reenterTarget;
    bytes public reenterData;

    mapping(address account => uint256 balance) private _balances;
    mapping(address owner => mapping(address spender => uint256 amount)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function setModes(bool lieOnBalance_, bool feeOnTransfer_, bool reenterOnTransfer_, address reenterTarget_, bytes calldata reenterData_)
        external
    {
        lieOnBalance = lieOnBalance_;
        feeOnTransfer = feeOnTransfer_;
        reenterOnTransfer = reenterOnTransfer_;
        reenterTarget = reenterTarget_;
        reenterData = reenterData_;
    }

    function mint(address to, uint256 amount) external {
        _balances[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function balanceOf(address account) external view returns (uint256) {
        uint256 bal = _balances[account];
        return lieOnBalance ? bal + 1 : bal;
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
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "allowance");
        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) private {
        require(_balances[from] >= amount, "balance");
        uint256 received = feeOnTransfer ? amount / 2 : amount;
        _balances[from] -= amount;
        _balances[to] += received;
        emit Transfer(from, to, received);
        if (reenterOnTransfer && reenterTarget != address(0)) {
            (bool ok,) = reenterTarget.call(reenterData);
            ok;
        }
    }
}
