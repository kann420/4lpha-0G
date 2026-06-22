// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {MockAssetToken} from "./MockAssetToken.sol";
import {IPolicyVaultAdapter} from "../interfaces/IPolicyVaultAdapter.sol";
import {Ownable} from "../utils/Ownable.sol";
import {ReentrancyGuard} from "../utils/ReentrancyGuard.sol";
import {SafeTransferLib} from "../utils/SafeTransferLib.sol";

contract MockDexAdapter is Ownable, ReentrancyGuard, IPolicyVaultAdapter {
    bytes32 public constant ADAPTER_KIND = keccak256("4LPHA_0G_MOCK_ADAPTER");
    bytes32 public constant DEFAULT_POOL_ID = keccak256("4LPHA_0G_MOCK_POOL");
    uint256 private constant MAINNET_CHAIN_ID = 16661;
    uint256 private constant RATE_SCALE = 1e18;

    error BadPool();
    error BadValue();
    error MainnetBlocked();
    error UnsupportedPair();

    MockAssetToken public immutable assetToken;
    uint256 public buyRate;
    uint256 public sellRate;

    constructor(address initialOwner, address assetToken_, uint256 buyRate_, uint256 sellRate_) Ownable(initialOwner) {
        if (block.chainid == MAINNET_CHAIN_ID) {
            revert MainnetBlocked();
        }
        assetToken = MockAssetToken(assetToken_);
        buyRate = buyRate_;
        sellRate = sellRate_;
    }

    receive() external payable {}

    function adapterKind() external pure returns (bytes32) {
        return ADAPTER_KIND;
    }

    function setRates(uint256 nextBuyRate, uint256 nextSellRate) external onlyOwner {
        buyRate = nextBuyRate;
        sellRate = nextSellRate;
    }

    function swapExactIn(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        bytes32 poolId
    ) external payable nonReentrant returns (uint256 amountOut) {
        if (poolId != DEFAULT_POOL_ID) {
            revert BadPool();
        }

        if (tokenIn == address(0) && tokenOut == address(assetToken)) {
            if (msg.value != amountIn) {
                revert BadValue();
            }
            amountOut = (amountIn * buyRate) / RATE_SCALE;
            if (amountOut < amountOutMin) {
                revert BadValue();
            }
            assetToken.mint(msg.sender, amountOut);
            return amountOut;
        }

        if (tokenIn == address(assetToken) && tokenOut == address(0)) {
            if (msg.value != 0) {
                revert BadValue();
            }
            amountOut = (amountIn * sellRate) / RATE_SCALE;
            if (amountOut < amountOutMin) {
                revert BadValue();
            }
            assetToken.burnFrom(msg.sender, amountIn);
            SafeTransferLib.safeTransferNative(msg.sender, amountOut);
            return amountOut;
        }

        revert UnsupportedPair();
    }
}
