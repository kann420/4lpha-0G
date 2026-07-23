// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";
import {IPolicyVaultAdapter} from "./interfaces/IPolicyVaultAdapter.sol";
import {IGalileoSandboxQuote} from "./interfaces/IGalileoSandboxQuote.sol";
import {IGalileoVaultRegistryV4} from "./interfaces/IGalileoVaultRegistryV4.sol";
import {GalileoSandboxPool} from "./GalileoSandboxPool.sol";
import {ReentrancyGuard} from "./utils/ReentrancyGuard.sol";
import {SafeTransferLib} from "./utils/SafeTransferLib.sol";

contract GalileoSandboxSwapAdapter is IPolicyVaultAdapter, IGalileoSandboxQuote, ReentrancyGuard {
    uint256 public constant GALILEO_CHAIN_ID = 16602;
    bytes32 public constant POOL_ID = keccak256("4LPHA_GALILEO_0G_MUSDC_V1");
    bytes32 public constant ADAPTER_KIND = keccak256("4LPHA_GALILEO_SANDBOX_ADAPTER_V1");
    address public constant NATIVE_TOKEN = address(0);
    GalileoSandboxPool public immutable pool;
    IERC20 public immutable token;
    IGalileoVaultRegistryV4 public immutable registry;
    error WrongChain(); error NotAttestedVault(); error InvalidPair(); error InvalidPool(); error InvalidValue(); error BadDelta();
    constructor(address pool_, address token_, address registry_) { if (block.chainid != GALILEO_CHAIN_ID) revert WrongChain(); if (pool_ == address(0) || token_ == address(0) || registry_ == address(0)) revert InvalidPair(); pool=GalileoSandboxPool(payable(pool_)); token=IERC20(token_); registry=IGalileoVaultRegistryV4(registry_); }
    receive() external payable {}
    function adapterKind() external pure returns (bytes32) { return ADAPTER_KIND; }
    function quoteExactIn(address tokenIn, uint256 amountIn) public view returns (uint256) { _pair(tokenIn, tokenIn == NATIVE_TOKEN ? address(token) : NATIVE_TOKEN); return pool.quoteExactIn(tokenIn, amountIn); }
    function swapExactIn(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOutMin, bytes32 poolId) external payable nonReentrant returns (uint256 amountOut) {
        if (block.chainid != GALILEO_CHAIN_ID) revert WrongChain(); if (!registry.isAttestedVault(msg.sender)) revert NotAttestedVault(); if (poolId != POOL_ID) revert InvalidPool(); _pair(tokenIn, tokenOut);
        if (tokenIn == NATIVE_TOKEN) {
            if (msg.value != amountIn) revert InvalidValue(); uint256 beforeBal=token.balanceOf(address(this)); amountOut=pool.swapExactIn{value: amountIn}(tokenIn, amountIn, amountOutMin); if (token.balanceOf(address(this))-beforeBal != amountOut) revert BadDelta(); SafeTransferLib.safeTransfer(token,msg.sender,amountOut);
        } else {
            if (msg.value != 0) revert InvalidValue(); uint256 beforeBal=token.balanceOf(address(this)); SafeTransferLib.safeTransferFrom(token,msg.sender,address(this),amountIn); if (token.balanceOf(address(this))-beforeBal != amountIn) revert BadDelta(); SafeTransferLib.forceApprove(token,address(pool),amountIn); uint256 beforeNative=address(this).balance; amountOut=pool.swapExactIn(tokenIn,amountIn,amountOutMin); SafeTransferLib.forceApprove(token,address(pool),0); if (address(this).balance-beforeNative != amountOut) revert BadDelta(); SafeTransferLib.safeTransferNative(msg.sender,amountOut);
        }
    }
    function _pair(address tokenIn,address tokenOut) private view { if (!((tokenIn==NATIVE_TOKEN && tokenOut==address(token)) || (tokenIn==address(token) && tokenOut==NATIVE_TOKEN))) revert InvalidPair(); }
}
