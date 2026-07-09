// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPolicyVaultLpAdapter} from "../interfaces/IPolicyVaultLpAdapter.sol";
import {IERC20} from "../interfaces/IERC20.sol";
import {SafeTransferLib} from "../utils/SafeTransferLib.sol";

contract MaliciousZiaLpAdapterV4 {
    bytes32 private constant ADAPTER_KIND = keccak256("4LPHA_0G_MALICIOUS_LP_ADAPTER");

    address public immutable wrappedNative;
    address public immutable nfpm;
    address public token0;
    address public token1;
    uint24 public fee = 3000;
    uint128 public reportedLiquidity;
    bool public payNothing = true;
    bool public reenter;
    bytes public reenterCalldata;

    constructor(address wrappedNative_, address nfpm_, address token0_, address token1_) {
        wrappedNative = wrappedNative_;
        nfpm = nfpm_;
        token0 = token0_;
        token1 = token1_;
        reportedLiquidity = 1 ether;
    }

    receive() external payable {}

    function lpAdapterKind() external pure returns (bytes32) {
        return ADAPTER_KIND;
    }

    function setMode(bool payNothing_, bool reenter_, bytes calldata reenterCalldata_) external {
        payNothing = payNothing_;
        reenter = reenter_;
        reenterCalldata = reenterCalldata_;
    }

    function setReportedLiquidity(uint128 value) external {
        reportedLiquidity = value;
    }

    function zapInMintLp(IPolicyVaultLpAdapter.ZapInMintParams calldata p)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        _maybeReenter();
        if (!payNothing) {
            SafeTransferLib.safeTransferFrom(IERC20(wrappedNative), msg.sender, address(this), p.amount0G);
        }
        return (1, reportedLiquidity, p.amount0Min, p.amount1Min);
    }

    function zapInIncreaseLiquidity(IPolicyVaultLpAdapter.ZapIncreaseParams calldata p)
        external
        payable
        returns (uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        _maybeReenter();
        if (!payNothing) {
            SafeTransferLib.safeTransferFrom(IERC20(wrappedNative), msg.sender, address(this), p.amount0G);
        }
        return (reportedLiquidity, p.amount0Min, p.amount1Min);
    }

    function decreaseLiquidity(IPolicyVaultLpAdapter.DecreaseParams calldata p)
        external
        payable
        returns (uint256 amount0, uint256 amount1)
    {
        _maybeReenter();
        return (p.amount0Min, p.amount1Min);
    }

    function collectFees(IPolicyVaultLpAdapter.CollectParams calldata) external payable returns (uint256 amount0, uint256 amount1) {
        _maybeReenter();
        return (1, 1);
    }

    function burnLp(uint256) external payable returns (uint256 amount0, uint256 amount1) {
        _maybeReenter();
        return (1, 1);
    }

    function zapOut(IPolicyVaultLpAdapter.ZapOutParams calldata p) external payable returns (uint256 amountOut) {
        _maybeReenter();
        return p.amountOutMin;
    }

    function sweepToken(IPolicyVaultLpAdapter.SweepParams calldata p) external payable returns (uint256 amountOut) {
        _maybeReenter();
        if (!payNothing) {
            SafeTransferLib.safeTransferFrom(IERC20(p.tokenIn), msg.sender, address(this), p.amountIn);
        }
        return p.amountOutMin;
    }

    function ownerOf(uint256) external view returns (address) {
        return msg.sender;
    }

    function liquidityOf(uint256) external view returns (uint128) {
        return reportedLiquidity;
    }

    function positionTicks(uint256) external pure returns (int24 tickLower, int24 tickUpper) {
        return (-120, 120);
    }

    function poolTokens(bytes32) external view returns (address, address, uint24) {
        return (token0, token1, fee);
    }

    function _maybeReenter() private {
        if (reenter) {
            (bool ok,) = msg.sender.call(reenterCalldata);
            ok;
        }
    }
}
