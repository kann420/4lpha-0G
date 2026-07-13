// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";
import {Ownable} from "./utils/Ownable.sol";
import {ReentrancyGuard} from "./utils/ReentrancyGuard.sol";
import {SafeTransferLib} from "./utils/SafeTransferLib.sol";

contract GalileoSandboxPool is Ownable, ReentrancyGuard {
    uint16 public constant FEE_BPS = 30;
    uint16 public constant BPS = 10_000;
    address public constant NATIVE_TOKEN = address(0);
    IERC20 public immutable token;
    address public adapter;
    uint256 public nativeReserve;
    uint256 public tokenReserve;

    error AdapterAlreadySet(); error NotAdapter(); error InvalidPair(); error InvalidAmount(); error LowMinOut(); error BadInput(); error BadDelta(); error RatioRequired();
    event AdapterSet(address indexed adapter); event LiquidityAdded(uint256 nativeAmount, uint256 tokenAmount); event Swap(address indexed tokenIn, uint256 amountIn, uint256 amountOut);
    constructor(address initialOwner, address token_) Ownable(initialOwner) { if (token_ == address(0) || token_.code.length == 0) revert InvalidPair(); token = IERC20(token_); }
    receive() external payable { revert NotAdapter(); }
    function setAdapter(address value) external onlyOwner { if (adapter != address(0) || value == address(0) || value.code.length == 0) revert AdapterAlreadySet(); adapter = value; emit AdapterSet(value); }
    function addLiquidity(uint256 tokenAmount) external payable onlyOwner nonReentrant {
        if (msg.value == 0 || tokenAmount == 0) revert InvalidAmount();
        if (nativeReserve != 0 && (tokenAmount * nativeReserve != msg.value * tokenReserve)) revert RatioRequired();
        uint256 beforeBal = token.balanceOf(address(this)); SafeTransferLib.safeTransferFrom(token, msg.sender, address(this), tokenAmount);
        if (token.balanceOf(address(this)) - beforeBal != tokenAmount) revert BadInput();
        nativeReserve += msg.value; tokenReserve += tokenAmount; emit LiquidityAdded(msg.value, tokenAmount);
    }
    function quoteExactIn(address tokenIn, uint256 amountIn) public view returns (uint256 amountOut) {
        if (amountIn == 0 || (tokenIn != NATIVE_TOKEN && tokenIn != address(token))) revert InvalidPair();
        uint256 inReserve = tokenIn == NATIVE_TOKEN ? nativeReserve : tokenReserve;
        uint256 outReserve = tokenIn == NATIVE_TOKEN ? tokenReserve : nativeReserve;
        if (inReserve == 0 || outReserve == 0) revert InvalidAmount();
        uint256 feeAdjusted = amountIn * (BPS - FEE_BPS);
        amountOut = (outReserve * feeAdjusted) / (inReserve * BPS + feeAdjusted);
    }
    function swapExactIn(address tokenIn, uint256 amountIn, uint256 amountOutMin) external payable nonReentrant returns (uint256 amountOut) {
        if (msg.sender != adapter) revert NotAdapter();
        amountOut = quoteExactIn(tokenIn, amountIn);
        if (amountOut == 0 || amountOut < amountOutMin) revert LowMinOut();
        if (tokenIn == NATIVE_TOKEN) {
            if (msg.value != amountIn || amountOut > tokenReserve) revert BadInput();
            uint256 beforeOut = token.balanceOf(msg.sender); SafeTransferLib.safeTransfer(token, msg.sender, amountOut);
            if (beforeOut + amountOut != token.balanceOf(msg.sender)) revert BadDelta();
            nativeReserve += amountIn; tokenReserve -= amountOut;
        } else {
            if (msg.value != 0 || amountOut > nativeReserve) revert BadInput();
            uint256 beforeIn = token.balanceOf(address(this)); SafeTransferLib.safeTransferFrom(token, msg.sender, address(this), amountIn);
            if (token.balanceOf(address(this)) - beforeIn != amountIn) revert BadInput();
            uint256 beforeOut = msg.sender.balance; SafeTransferLib.safeTransferNative(msg.sender, amountOut);
            if (msg.sender.balance != beforeOut + amountOut) revert BadDelta();
            tokenReserve += amountIn; nativeReserve -= amountOut;
        }
        emit Swap(tokenIn, amountIn, amountOut);
    }
}
