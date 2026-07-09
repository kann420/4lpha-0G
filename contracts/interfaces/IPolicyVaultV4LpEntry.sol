// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IPolicyVaultV4LpEntry {
    struct LpActionRequest {
        uint8 actionType;
        bytes32 agentKey;
        bytes32 poolId;
        address stakeVault;
        address tokenIn;
        address tokenOut;
        uint256 tokenId;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint128 liquidity;
        uint256 amount0Min;
        uint256 amount1Min;
        uint128 quotedLiquidity;
        uint256 quotedAmount0;
        uint256 quotedAmount1;
        uint256 quotedAmountOut;
        uint256 deadline;
        uint256 nonce;
        bytes32 vaultActionHash;
        bytes32 actionHash;
        bytes32 policySnapshotHash;
        bytes32 auditRoot;
    }

    function lpNftOwnerOf(uint256 tokenId) external view returns (bytes32);
    function lpNftPoolOf(uint256 tokenId) external view returns (bytes32);
    function lpNftTicksOf(uint256 tokenId) external view returns (int24, int24);
    function lpNftDeployedNativeOf(uint256 tokenId) external view returns (uint256);
    function isStaked(bytes32 agentKey, uint256 tokenId) external view returns (bool);
    function allowedStakeVaults(address stakeVault) external view returns (bool);
    function stakeVaultForLpPool(bytes32 poolId) external view returns (address);
    function markUnstaked(bytes32 agentKey, uint256 tokenId, address stakeVault) external;
    function ownerWithdrawStakedNftToEntry(uint256 tokenId, address stakeVault) external;
    function reduceLpDeployment(uint256 tokenId, uint256 nativeFreed) external;
    function purgeLpNft(uint256 tokenId) external;
    function moveNftToExit(uint256 tokenId) external;
    function withdrawStakedNftToEntry(bytes32 agentKey, uint256 tokenId, address stakeVault) external;
    function policyHash() external view returns (bytes32);
    function minLpOutFor(uint256 quote) external view returns (uint256);
    function actionHashFor(bytes32 vaultActionHash, bytes32 auditRoot, bytes32 policySnapshotHash)
        external
        pure
        returns (bytes32);
    function vaultActionHashForLp(LpActionRequest calldata request) external view returns (bytes32);
    function owner() external view returns (address);
    function executor() external view returns (address);
    function lpAdapter() external view returns (address);
    function proofRegistry() external view returns (address);
}
