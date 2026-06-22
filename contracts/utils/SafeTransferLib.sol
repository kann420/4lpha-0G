// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {IERC20} from "../interfaces/IERC20.sol";

library SafeTransferLib {
    error NativeTransferFailed();
    error TokenTransferFailed();

    function safeTransferNative(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) {
            revert NativeTransferFailed();
        }
    }

    function safeTransfer(IERC20 token, address to, uint256 amount) internal {
        _callOptionalReturn(address(token), abi.encodeCall(token.transfer, (to, amount)));
    }

    function safeTransferFrom(IERC20 token, address from, address to, uint256 amount) internal {
        _callOptionalReturn(address(token), abi.encodeCall(token.transferFrom, (from, to, amount)));
    }

    function safeApprove(IERC20 token, address spender, uint256 amount) internal {
        _callOptionalReturn(address(token), abi.encodeCall(token.approve, (spender, amount)));
    }

    function forceApprove(IERC20 token, address spender, uint256 amount) internal {
        bytes memory approvalCall = abi.encodeCall(token.approve, (spender, amount));
        if (!_callOptionalReturnBool(address(token), approvalCall)) {
            _callOptionalReturn(address(token), abi.encodeCall(token.approve, (spender, 0)));
            _callOptionalReturn(address(token), approvalCall);
        }
    }

    function _callOptionalReturn(address token, bytes memory data) private {
        if (!_callOptionalReturnBool(token, data)) {
            revert TokenTransferFailed();
        }
    }

    function _callOptionalReturnBool(address token, bytes memory data) private returns (bool) {
        (bool success, bytes memory returndata) = token.call(data);
        return success && (returndata.length == 0 || abi.decode(returndata, (bool)));
    }
}
