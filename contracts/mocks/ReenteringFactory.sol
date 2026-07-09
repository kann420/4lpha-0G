// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IRegistryV4Reenter {
    function registerSwap(address vault) external;
    function registerLpEntry(address vault) external;
    function registerLpExit(address vault) external;
}

contract ReenteringFactory {
    address public owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function reenterSwap(address registry, address vault) external {
        IRegistryV4Reenter(registry).registerSwap(vault);
    }

    function reenterLpEntry(address registry, address vault) external {
        IRegistryV4Reenter(registry).registerLpEntry(vault);
    }

    function reenterLpExit(address registry, address vault) external {
        IRegistryV4Reenter(registry).registerLpExit(vault);
    }
}
