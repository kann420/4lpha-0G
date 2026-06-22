// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

contract MockUniswapV3Factory {
    mapping(bytes32 key => address pool) public pools;

    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool) {
        return pools[_poolKey(tokenA, tokenB, fee)];
    }

    function setPool(address tokenA, address tokenB, uint24 fee, address pool) external {
        pools[_poolKey(tokenA, tokenB, fee)] = pool;
    }

    function _poolKey(address tokenA, address tokenB, uint24 fee) private pure returns (bytes32) {
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        return keccak256(abi.encode(token0, token1, fee));
    }
}
