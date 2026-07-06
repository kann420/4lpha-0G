// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {IPolicyVaultLpAdapter} from "../interfaces/IPolicyVaultLpAdapter.sol";
import {MockNfpm} from "./MockNfpm.sol";
import {MockAssetToken} from "./MockAssetToken.sol";
import {MockWrappedNative} from "./MockWrappedNative.sol";
import {Ownable} from "../utils/Ownable.sol";
import {SafeTransferLib} from "../utils/SafeTransferLib.sol";
import {IERC20} from "../interfaces/IERC20.sol";

/// @notice Test-only LP adapter implementing the full IPolicyVaultLpAdapter surface against mock
///         NFPM / W0G / paired token. Reverts on mainnet (chainId 16661). Recipient of every token
///         and native return is hard-pinned to msg.sender (the vault).
contract MockZiaLpAdapter is Ownable {
    bytes32 public constant MOCK_LP_ADAPTER_KIND = keccak256("4LPHA_0G_MOCK_LP_ADAPTER");
    uint256 private constant MAINNET_CHAIN_ID = 16661;
    uint16 private constant BPS = 10_000;
    uint16 private constant MAX_DUST_BPS = 50;

    error MainnetBlocked();
    error BadPool();
    error NotVaultNft();
    error InsufficientLiquidity();
    error BadParams();
    error ExcessPairedDust();
    error W0GNotConsumed();

    MockWrappedNative public immutable wrappedNative;
    MockNfpm public immutable nfpm;
    MockAssetToken public immutable pairedToken;

    struct Pool {
        address token0;
        address token1;
        uint24 fee;
        bool set;
    }
    struct Position {
        bytes32 poolId;
        uint128 liquidity;
        int24 tickLower;
        int24 tickUpper;
    }

    mapping(bytes32 poolId => Pool) public pools;
    mapping(uint256 tokenId => Position) public positions;
    uint256 public feeAmount0; // configurable collectFees payout
    uint256 public feeAmount1;
    uint256 public dustToVault; // M1 test hook: paired-token over-swap leftover swept to vault
    uint256 public w0gRefundToVault; // M1 test hook: unused W0G swept back to vault

    constructor(address initialOwner, MockWrappedNative wnative, MockNfpm nfpm_, MockAssetToken pairedToken_)
        Ownable(initialOwner) {
        if (block.chainid == MAINNET_CHAIN_ID) {
            revert MainnetBlocked();
        }
        wrappedNative = wnative;
        nfpm = nfpm_;
        pairedToken = pairedToken_;
    }

    receive() external payable {}

    function lpAdapterKind() external pure returns (bytes32) {
        return MOCK_LP_ADAPTER_KIND;
    }

    function registerPool(bytes32 poolId, address token0, address token1, uint24 fee) external onlyOwner {
        if (poolId == bytes32(0) || token0 == token1) {
            revert BadParams();
        }
        pools[poolId] = Pool({token0: token0, token1: token1, fee: fee, set: true});
    }

    function setFeePayout(uint256 a0, uint256 a1) external onlyOwner {
        feeAmount0 = a0;
        feeAmount1 = a1;
    }

    function setDustToVault(uint256 amount) external onlyOwner {
        dustToVault = amount;
    }

    function setW0GRefundToVault(uint256 amount) external onlyOwner {
        w0gRefundToVault = amount;
    }

    function poolTokens(bytes32 poolId) external view returns (address token0, address token1, uint24 fee) {
        Pool memory p = pools[poolId];
        if (!p.set) {
            revert BadPool();
        }
        return (p.token0, p.token1, p.fee);
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        return MockNfpm(address(nfpm)).ownerOf(tokenId);
    }

    function liquidityOf(uint256 tokenId) external view returns (uint128) {
        return positions[tokenId].liquidity;
    }

    function positionTicks(uint256 tokenId) external view returns (int24 tickLower, int24 tickUpper) {
        Position memory pos = positions[tokenId];
        return (pos.tickLower, pos.tickUpper);
    }

    // --- zap-in mint ---

    function zapInMintLp(IPolicyVaultLpAdapter.ZapInMintParams calldata p)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        if (msg.value != 0 || p.amount0G == 0) {
            revert BadParams();
        }
        Pool memory pool = pools[p.poolId];
        if (!pool.set) {
            revert BadPool();
        }
        // Pull W0G (vault wrapped + approved). Simulate 1:1 balancing swap by minting paired to self.
        SafeTransferLib.safeTransferFrom(IERC20(address(wrappedNative)), p.vaultAddress, address(this), p.amount0G);
        uint256 w0gRefund = w0gRefundToVault;
        if (w0gRefund > 0) {
            if (w0gRefund >= p.amount0G) {
                revert W0GNotConsumed();
            }
            SafeTransferLib.safeTransfer(IERC20(address(wrappedNative)), p.vaultAddress, w0gRefund);
        }
        uint256 usedW0G = p.amount0G - w0gRefund;
        pairedToken.mint(address(this), p.amount0G);
        // Mint NFT to vault.
        tokenId = MockNfpm(address(nfpm)).mint(p.vaultAddress);
        liquidity = uint128(usedW0G);
        positions[tokenId] = Position({poolId: p.poolId, liquidity: liquidity, tickLower: p.tickLower, tickUpper: p.tickUpper});
        bool w0gIsToken0 = pool.token0 == address(wrappedNative);
        amount0 = w0gIsToken0 ? usedW0G : p.amount0G;
        amount1 = w0gIsToken0 ? p.amount0G : usedW0G;
        // M1: mirror real ZiaLpAdapter leftover handling. dustToVault models the over-swap
        // leftover (paired token beyond what the mint consumed). Tiny leftovers are swept as
        // paired dust; oversized leftovers are converted back into a W0G refund.
        uint256 pairedLeft = dustToVault;
        if (pairedLeft > 0) {
            pairedToken.mint(address(this), pairedLeft);
            uint256 pairedConsumed = w0gIsToken0 ? amount1 : amount0;
            if (pairedLeft > (pairedConsumed * MAX_DUST_BPS) / BPS) {
                SafeTransferLib.safeTransfer(IERC20(address(pairedToken)), address(0x000000000000000000000000000000000000dEaD), pairedLeft);
                uint256 convertibleW0G = pairedLeft;
                uint256 w0gHeld = wrappedNative.balanceOf(address(this));
                if (convertibleW0G > w0gHeld) {
                    convertibleW0G = w0gHeld;
                }
                if (convertibleW0G > 0) {
                    SafeTransferLib.safeTransfer(IERC20(address(wrappedNative)), p.vaultAddress, convertibleW0G);
                }
            } else {
                SafeTransferLib.safeTransfer(IERC20(address(pairedToken)), p.vaultAddress, pairedLeft);
            }
        }
    }

    // --- zap-in increase ---

    function zapInIncreaseLiquidity(IPolicyVaultLpAdapter.ZapIncreaseParams calldata p)
        external
        payable
        returns (uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        if (msg.value != 0 || p.amount0G == 0) {
            revert BadParams();
        }
        Position storage pos = positions[p.tokenId];
        if (pos.liquidity == 0) {
            revert NotVaultNft();
        }
        SafeTransferLib.safeTransferFrom(IERC20(address(wrappedNative)), msg.sender, address(this), p.amount0G);
        pairedToken.mint(address(this), p.amount0G);
        pos.liquidity += uint128(p.amount0G);
        liquidity = uint128(p.amount0G);
        amount0 = p.amount0G;
        amount1 = p.amount0G;
    }

    // --- decrease ---

    function decreaseLiquidity(IPolicyVaultLpAdapter.DecreaseParams calldata p)
        external
        payable
        returns (uint256 amount0, uint256 amount1)
    {
        if (msg.value != 0) {
            revert BadParams();
        }
        Position storage pos = positions[p.tokenId];
        if (p.liquidity == 0 || p.liquidity > pos.liquidity) {
            revert InsufficientLiquidity();
        }
        pos.liquidity -= p.liquidity;
        amount0 = p.amount0Min;
        amount1 = p.amount1Min;
        // Return tokens to vault (mint both sides; tests use mock tokens the vault accepts).
        _payoutPoolTokens(pos.poolId, msg.sender, amount0, amount1);
    }

    // --- collect ---

    function collectFees(IPolicyVaultLpAdapter.CollectParams calldata p)
        external
        payable
        returns (uint256 amount0, uint256 amount1)
    {
        if (msg.value != 0) {
            revert BadParams();
        }
        Position memory pos = positions[p.tokenId];
        amount0 = feeAmount0;
        amount1 = feeAmount1;
        _payoutPoolTokens(pos.poolId, p.vaultAddress, amount0, amount1);
    }

    // --- burn ---

    function burnLp(uint256 tokenId) external payable returns (uint256 amount0, uint256 amount1) {
        if (msg.value != 0) {
            revert BadParams();
        }
        Position memory pos = positions[tokenId];
        if (pos.liquidity != 0) {
            revert InsufficientLiquidity();
        }
        delete positions[tokenId];
        MockNfpm(address(nfpm)).burn(tokenId);
        return (0, 0);
    }

    // --- zap out (return native to vault) ---

    function zapOut(IPolicyVaultLpAdapter.ZapOutParams calldata p) external payable returns (uint256 amountOut) {
        if (msg.value != 0) {
            revert BadParams();
        }
        Position storage pos = positions[p.tokenId];
        if (p.liquidity == 0 || p.liquidity > pos.liquidity) {
            revert InsufficientLiquidity();
        }
        pos.liquidity -= p.liquidity;
        amountOut = p.amountOutMin;
        // Full burn when no liquidity remains after this decrease.
        if (pos.liquidity == 0) {
            delete positions[p.tokenId];
            MockNfpm(address(nfpm)).burn(p.tokenId);
        }
        SafeTransferLib.safeTransferNative(msg.sender, amountOut);
    }

    // --- sweep ---

    function sweepToken(IPolicyVaultLpAdapter.SweepParams calldata p) external payable returns (uint256 amountOut) {
        if (msg.value != 0 || p.amountIn == 0) {
            revert BadParams();
        }
        SafeTransferLib.safeTransferFrom(IERC20(p.tokenIn), msg.sender, address(this), p.amountIn);
        amountOut = p.amountOutMin;
        if (p.tokenOut == address(0)) {
            SafeTransferLib.safeTransferNative(msg.sender, amountOut);
        } else {
            MockAssetToken(p.tokenOut).mint(msg.sender, amountOut);
        }
    }

    function _payoutPoolTokens(bytes32 poolId, address to, uint256 amount0, uint256 amount1) private {
        Pool memory pool = pools[poolId];
        if (!pool.set) {
            revert BadPool();
        }
        if (amount0 > 0) {
            _mintOrSend(pool.token0, to, amount0);
        }
        if (amount1 > 0) {
            _mintOrSend(pool.token1, to, amount1);
        }
    }

    function _mintOrSend(address token, address to, uint256 amount) private {
        if (token == address(wrappedNative)) {
            // Return W0G (the pool's token) to the vault — matches the real NFPM collect path,
            // which credits token0/token1 to the NFT owner. The vault's delta check reads
            // IERC20(wnative).balanceOf(vault), so the W0G side must arrive as W0G, not native.
            uint256 bal = IERC20(token).balanceOf(address(this));
            if (bal < amount) {
                MockAssetToken(token).mint(address(this), amount - bal);
            }
            SafeTransferLib.safeTransfer(IERC20(token), to, amount);
        } else {
            MockAssetToken(token).mint(to, amount);
        }
    }
}
