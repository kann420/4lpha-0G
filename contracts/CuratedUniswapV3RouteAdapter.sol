// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {IERC20} from "./interfaces/IERC20.sol";
import {IPolicyVaultAdapter} from "./interfaces/IPolicyVaultAdapter.sol";
import {ReentrancyGuard} from "./utils/ReentrancyGuard.sol";
import {SafeTransferLib} from "./utils/SafeTransferLib.sol";

interface IRouteWrappedNative is IERC20 {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

interface IRouteV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
}

interface IRouteV3Pool {
    function fee() external view returns (uint24);
    function token0() external view returns (address);
    function token1() external view returns (address);
}

interface IRouteSwapRouter {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

interface IRouteSwapRouter02 {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

contract CuratedUniswapV3RouteAdapter is ReentrancyGuard, IPolicyVaultAdapter {
    bytes32 public constant ADAPTER_KIND = keccak256("4LPHA_0G_CURATED_UNISWAP_V3_ROUTE_ADAPTER");
    uint8 private constant ROUTER_KIND_DEADLINE = 1;
    uint8 private constant ROUTER_KIND_NO_DEADLINE = 2;

    struct RouteConfig {
        bytes32 routeId;
        address router;
        address factory;
        uint8 routerKind;
        address[] path;
        uint24[] fees;
        address[] pools;
    }

    struct Route {
        address router;
        address factory;
        uint8 routerKind;
        address tokenIn;
        address tokenOut;
        bytes encodedPath;
        bytes encodedReversePath;
        address[] tokens;
        address[] pools;
    }

    error BadAmount();
    error BadPool();
    error BadRoute();
    error BadValue();
    error DuplicateRoute();
    error InvalidAddress();
    error UnsupportedPair();

    IRouteWrappedNative public immutable wrappedNative;
    mapping(bytes32 routeId => Route route) private _routes;
    mapping(bytes32 routeId => bool configured) public routeConfigured;
    bytes32[] private _routeIds;

    constructor(address wrappedNative_, RouteConfig[] memory routeConfigs) {
        if (wrappedNative_ == address(0) || wrappedNative_.code.length == 0 || routeConfigs.length == 0) {
            revert InvalidAddress();
        }
        wrappedNative = IRouteWrappedNative(wrappedNative_);

        for (uint256 i = 0; i < routeConfigs.length; i++) {
            _addRoute(routeConfigs[i]);
        }
    }

    receive() external payable {
        if (msg.sender != address(wrappedNative)) {
            revert BadValue();
        }
    }

    function adapterKind() external pure returns (bytes32) {
        return ADAPTER_KIND;
    }

    function routeCount() external view returns (uint256) {
        return _routeIds.length;
    }

    function routeIdAt(uint256 index) external view returns (bytes32) {
        return _routeIds[index];
    }

    function routeInfo(bytes32 routeId)
        external
        view
        returns (
            address router,
            address factory,
            uint8 routerKind,
            address tokenIn,
            address tokenOut,
            bytes memory encodedPath,
            bytes memory encodedReversePath
        )
    {
        Route storage route = _requireRoute(routeId);
        return (
            route.router,
            route.factory,
            route.routerKind,
            route.tokenIn,
            route.tokenOut,
            route.encodedPath,
            route.encodedReversePath
        );
    }

    function routeTokens(bytes32 routeId) external view returns (address[] memory) {
        return _requireRoute(routeId).tokens;
    }

    function routePools(bytes32 routeId) external view returns (address[] memory) {
        return _requireRoute(routeId).pools;
    }

    function swapExactIn(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        bytes32 routeId
    ) external payable nonReentrant returns (uint256 amountOut) {
        if (amountIn == 0 || amountOutMin == 0) {
            revert BadAmount();
        }

        Route storage route = _requireRoute(routeId);
        bool forward = tokenIn == address(0) && tokenOut == route.tokenOut;
        bool reverse = tokenIn == route.tokenOut && tokenOut == address(0);
        if (!forward && !reverse) {
            revert UnsupportedPair();
        }

        if (forward) {
            if (msg.value != amountIn) {
                revert BadValue();
            }
            return _swapNativeForToken(route, amountIn, amountOutMin);
        }

        if (msg.value != 0) {
            revert BadValue();
        }
        return _swapTokenForNative(route, amountIn, amountOutMin);
    }

    function _swapNativeForToken(
        Route storage route,
        uint256 amountIn,
        uint256 amountOutMin
    ) private returns (uint256 amountOut) {
        amountOut = _exactInput(route, route.encodedPath, msg.sender, amountIn, amountOutMin, amountIn);
    }

    function _swapTokenForNative(
        Route storage route,
        uint256 amountIn,
        uint256 amountOutMin
    ) private returns (uint256 amountOut) {
        IERC20 inputToken = IERC20(route.tokenOut);
        SafeTransferLib.safeTransferFrom(inputToken, msg.sender, address(this), amountIn);
        SafeTransferLib.forceApprove(inputToken, route.router, amountIn);
        uint256 wrappedBefore = IERC20(address(wrappedNative)).balanceOf(address(this));

        uint256 wrappedOut = _exactInput(route, route.encodedReversePath, address(this), amountIn, amountOutMin, 0);
        SafeTransferLib.forceApprove(inputToken, route.router, 0);

        uint256 wrappedDelta = IERC20(address(wrappedNative)).balanceOf(address(this)) - wrappedBefore;
        if (wrappedDelta < amountOutMin || wrappedDelta < wrappedOut) {
            revert BadAmount();
        }

        wrappedNative.withdraw(wrappedDelta);
        SafeTransferLib.safeTransferNative(msg.sender, wrappedDelta);
        amountOut = wrappedDelta;
    }

    function _exactInput(
        Route storage route,
        bytes memory path,
        address recipient,
        uint256 amountIn,
        uint256 amountOutMin,
        uint256 value
    ) private returns (uint256 amountOut) {
        if (route.routerKind == ROUTER_KIND_DEADLINE) {
            return IRouteSwapRouter(route.router).exactInput{value: value}(
                IRouteSwapRouter.ExactInputParams({
                    path: path,
                    recipient: recipient,
                    deadline: block.timestamp + 20 minutes,
                    amountIn: amountIn,
                    amountOutMinimum: amountOutMin
                })
            );
        }

        if (route.routerKind == ROUTER_KIND_NO_DEADLINE) {
            return IRouteSwapRouter02(route.router).exactInput{value: value}(
                IRouteSwapRouter02.ExactInputParams({
                    path: path,
                    recipient: recipient,
                    amountIn: amountIn,
                    amountOutMinimum: amountOutMin
                })
            );
        }

        revert BadRoute();
    }

    function _addRoute(RouteConfig memory config) private {
        if (
            config.routeId == bytes32(0) || routeConfigured[config.routeId] || config.router == address(0)
                || config.factory == address(0) || config.router.code.length == 0 || config.factory.code.length == 0
                || config.path.length < 2 || config.fees.length != config.path.length - 1
                || config.pools.length != config.fees.length
        ) {
            if (routeConfigured[config.routeId]) {
                revert DuplicateRoute();
            }
            revert BadRoute();
        }
        if (config.routerKind != ROUTER_KIND_DEADLINE && config.routerKind != ROUTER_KIND_NO_DEADLINE) {
            revert BadRoute();
        }
        if (config.path[0] != address(wrappedNative)) {
            revert BadRoute();
        }

        bytes memory encodedPath = abi.encodePacked(config.path[0]);
        bytes memory encodedReversePath = abi.encodePacked(config.path[config.path.length - 1]);
        for (uint256 i = 0; i < config.fees.length; i++) {
            address tokenA = config.path[i];
            address tokenB = config.path[i + 1];
            if (tokenA == address(0) || tokenB == address(0) || tokenA == tokenB || config.pools[i] == address(0)) {
                revert BadRoute();
            }
            _validatePool(config.factory, config.pools[i], tokenA, tokenB, config.fees[i]);
            encodedPath = bytes.concat(encodedPath, bytes3(config.fees[i]), abi.encodePacked(tokenB));
            encodedReversePath =
                bytes.concat(encodedReversePath, bytes3(config.fees[config.fees.length - 1 - i]), abi.encodePacked(config.path[config.path.length - 2 - i]));
        }

        Route storage route = _routes[config.routeId];
        route.router = config.router;
        route.factory = config.factory;
        route.routerKind = config.routerKind;
        route.tokenIn = address(wrappedNative);
        route.tokenOut = config.path[config.path.length - 1];
        route.encodedPath = encodedPath;
        route.encodedReversePath = encodedReversePath;
        for (uint256 i = 0; i < config.path.length; i++) {
            route.tokens.push(config.path[i]);
        }
        for (uint256 i = 0; i < config.pools.length; i++) {
            route.pools.push(config.pools[i]);
        }
        routeConfigured[config.routeId] = true;
        _routeIds.push(config.routeId);
    }

    function _requireRoute(bytes32 routeId) private view returns (Route storage route) {
        if (!routeConfigured[routeId]) {
            revert BadRoute();
        }
        return _routes[routeId];
    }

    function _validatePool(
        address factory,
        address pool,
        address tokenA,
        address tokenB,
        uint24 fee
    ) private view {
        if (pool.code.length == 0) {
            revert BadPool();
        }

        IRouteV3Pool v3Pool = IRouteV3Pool(pool);
        address poolToken0 = v3Pool.token0();
        address poolToken1 = v3Pool.token1();
        bool tokenPairMatches =
            (poolToken0 == tokenA && poolToken1 == tokenB) || (poolToken0 == tokenB && poolToken1 == tokenA);
        if (!tokenPairMatches || v3Pool.fee() != fee || IRouteV3Factory(factory).getPool(tokenA, tokenB, fee) != pool) {
            revert BadPool();
        }
    }
}
