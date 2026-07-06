import { getAddress, pad, type Address, type Hex, type PublicClient } from "viem";

export const ZIA_LP_MAINNET = {
  chainId: 16661,
  nonfungiblePositionManager: getAddress("0x5143ba6007C197b4cF66c20601b9dB97E0F98c6A"),
  nonfungibleTokenPositionDescriptor: getAddress("0xEaD94c93e7398B68e3DeDd639340A535dABBd7f2"),
  quoterV2: getAddress("0x23b55293b7F06F6c332a0dDA3D88d8921218425B"),
  swapRouter: getAddress("0x18cCa38E51c4C339A6BD6e174025f08360FEEf30"),
  tickLens: getAddress("0xAEA8Bfd12ec08622444E6112ec7089aC2ceFBba5"),
  uniswapV3Factory: getAddress("0x6F3945Ab27296D1D66D8EEb042ff1B4fb2E0CE70"),
  // Wrapped native (W0G) — the single-sided zap leg. The vault wraps 0G -> W0G
  // via W0G.deposit{value} before calling the LP adapter. Keep this aligned with
  // lib/contracts/curated-routes.ts W0G_MAINNET and NEXT_PUBLIC_POLICY_VAULT_WRAPPED_NATIVE_MAINNET_ADDRESS.
  wrappedNative: getAddress("0x1Cd0690fF9a693f5EF2dD976660a8dAFc81A109c"),
} as const;

// Public mainnet Zia contract addresses — display mirrors of ZIA_LP_MAINNET.
// Safe for .env.example / client display (address-only, no secrets).
export const NEXT_PUBLIC_ZIA_NFPM_MAINNET_ADDRESS = ZIA_LP_MAINNET.nonfungiblePositionManager;
export const NEXT_PUBLIC_ZIA_SWAP_ROUTER_MAINNET_ADDRESS = ZIA_LP_MAINNET.swapRouter;
export const NEXT_PUBLIC_ZIA_QUOTER_V2_MAINNET_ADDRESS = ZIA_LP_MAINNET.quoterV2;
export const NEXT_PUBLIC_ZIA_UNISWAP_V3_FACTORY_MAINNET_ADDRESS = ZIA_LP_MAINNET.uniswapV3Factory;

export const ziaVaultAbi = [
  {
    inputs: [{ internalType: "uint256", name: "tokenId", type: "uint256" }],
    name: "deposit",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "tokenId", type: "uint256" }],
    name: "withdraw",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "tokenId", type: "uint256" }],
    name: "depositorOf",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "depositor", type: "address" }],
    name: "getDepositedTokenIds",
    outputs: [{ internalType: "uint256[]", name: "", type: "uint256[]" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "depositor", type: "address" }],
    name: "depositedCountOf",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "tokenId", type: "uint256" }],
    name: "liquidityOf",
    outputs: [{ internalType: "uint128", name: "", type: "uint128" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export const ziaNonfungiblePositionManagerNftAbi = [
  {
    inputs: [
      { internalType: "address", name: "to", type: "address" },
      { internalType: "uint256", name: "tokenId", type: "uint256" },
    ],
    name: "approve",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "tokenId", type: "uint256" }],
    name: "ownerOf",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

// Full NonfungiblePositionManager ABI — the functions the real ZiaLpAdapter and
// the vault-direct staking path need. Mint params match Uniswap V3 NFPM.MintParams.
const mintParamsComponents = [
  { internalType: "address", name: "token0", type: "address" },
  { internalType: "address", name: "token1", type: "address" },
  { internalType: "uint24", name: "fee", type: "uint24" },
  { internalType: "int24", name: "tickLower", type: "int24" },
  { internalType: "int24", name: "tickUpper", type: "int24" },
  { internalType: "uint256", name: "amount0Desired", type: "uint256" },
  { internalType: "uint256", name: "amount1Desired", type: "uint256" },
  { internalType: "uint256", name: "amount0Min", type: "uint256" },
  { internalType: "uint256", name: "amount1Min", type: "uint256" },
  { internalType: "address", name: "recipient", type: "address" },
  { internalType: "uint256", name: "deadline", type: "uint256" },
] as const;

const increaseLiquidityParamsComponents = [
  { internalType: "uint256", name: "tokenId", type: "uint256" },
  { internalType: "uint256", name: "amount0Desired", type: "uint256" },
  { internalType: "uint256", name: "amount1Desired", type: "uint256" },
  { internalType: "uint256", name: "amount0Min", type: "uint256" },
  { internalType: "uint256", name: "amount1Min", type: "uint256" },
  { internalType: "uint256", name: "deadline", type: "uint256" },
] as const;

const decreaseLiquidityParamsComponents = [
  { internalType: "uint256", name: "tokenId", type: "uint256" },
  { internalType: "uint128", name: "liquidity", type: "uint128" },
  { internalType: "uint256", name: "amount0Min", type: "uint256" },
  { internalType: "uint256", name: "amount1Min", type: "uint256" },
  { internalType: "uint256", name: "deadline", type: "uint256" },
] as const;

const collectParamsComponents = [
  { internalType: "uint256", name: "tokenId", type: "uint256" },
  { internalType: "address", name: "recipient", type: "address" },
  { internalType: "uint128", name: "amount0Max", type: "uint128" },
  { internalType: "uint128", name: "amount1Max", type: "uint128" },
] as const;

export const ziaNonfungiblePositionManagerAbi = [
  {
    inputs: [
      { components: mintParamsComponents, internalType: "struct INonfungiblePositionManager.MintParams", name: "params", type: "tuple" },
    ],
    name: "mint",
    outputs: [
      { internalType: "uint256", name: "tokenId", type: "uint256" },
      { internalType: "uint128", name: "liquidity", type: "uint128" },
      { internalType: "uint256", name: "amount0", type: "uint256" },
      { internalType: "uint256", name: "amount1", type: "uint256" },
    ],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [
      { components: increaseLiquidityParamsComponents, internalType: "struct INonfungiblePositionManager.IncreaseLiquidityParams", name: "params", type: "tuple" },
    ],
    name: "increaseLiquidity",
    outputs: [
      { internalType: "uint128", name: "liquidity", type: "uint128" },
      { internalType: "uint256", name: "amount0", type: "uint256" },
      { internalType: "uint256", name: "amount1", type: "uint256" },
    ],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [
      { components: decreaseLiquidityParamsComponents, internalType: "struct INonfungiblePositionManager.DecreaseLiquidityParams", name: "params", type: "tuple" },
    ],
    name: "decreaseLiquidity",
    outputs: [
      { internalType: "uint256", name: "amount0", type: "uint256" },
      { internalType: "uint256", name: "amount1", type: "uint256" },
    ],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { components: collectParamsComponents, internalType: "struct INonfungiblePositionManager.CollectParams", name: "params", type: "tuple" },
    ],
    name: "collect",
    outputs: [
      { internalType: "uint256", name: "amount0", type: "uint256" },
      { internalType: "uint256", name: "amount1", type: "uint256" },
    ],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "tokenId", type: "uint256" }],
    name: "burn",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "tokenId", type: "uint256" }],
    name: "positions",
    outputs: [
      { internalType: "uint96", name: "nonce", type: "uint96" },
      { internalType: "address", name: "operator", type: "address" },
      { internalType: "address", name: "token0", type: "address" },
      { internalType: "address", name: "token1", type: "address" },
      { internalType: "uint24", name: "fee", type: "uint24" },
      { internalType: "int24", name: "tickLower", type: "int24" },
      { internalType: "int24", name: "tickUpper", type: "int24" },
      { internalType: "uint128", name: "liquidity", type: "uint128" },
      { internalType: "uint256", name: "feeGrowthInside0LastX128", type: "uint256" },
      { internalType: "uint256", name: "feeGrowthInside1LastX128", type: "uint256" },
      { internalType: "uint128", name: "tokensOwed0", type: "uint128" },
      { internalType: "uint128", name: "tokensOwed1", type: "uint128" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "to", type: "address" },
      { internalType: "uint256", name: "tokenId", type: "uint256" },
    ],
    name: "approve",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "from", type: "address" },
      { internalType: "address", name: "to", type: "address" },
      { internalType: "uint256", name: "tokenId", type: "uint256" },
    ],
    name: "transferFrom",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "tokenId", type: "uint256" }],
    name: "ownerOf",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "owner", type: "address" }],
    name: "balanceOf",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "tokenId", type: "uint256" }],
    name: "getApproved",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

// Zia SwapRouter ABI — the balancing-swap leg the real LP adapter uses.
// exactInputSingle swaps one side of W0G for the paired token before NFPM.mint;
// exactInput takes a packed path for multi-hop. unwrapWETH9 returns native 0G.
const exactInputSingleParamsComponents = [
  { internalType: "address", name: "tokenIn", type: "address" },
  { internalType: "address", name: "tokenOut", type: "address" },
  { internalType: "uint24", name: "fee", type: "uint24" },
  { internalType: "address", name: "recipient", type: "address" },
  { internalType: "uint256", name: "deadline", type: "uint256" },
  { internalType: "uint256", name: "amountIn", type: "uint256" },
  { internalType: "uint256", name: "amountOutMinimum", type: "uint256" },
  { internalType: "uint160", name: "sqrtPriceLimitX96", type: "uint160" },
] as const;

const exactInputParamsComponents = [
  { internalType: "address", name: "tokenIn", type: "address" },
  { internalType: "address", name: "tokenOut", type: "address" },
  { internalType: "uint24", name: "fee", type: "uint24" },
  { internalType: "address", name: "recipient", type: "address" },
  { internalType: "uint256", name: "deadline", type: "uint256" },
  { internalType: "uint256", name: "amountIn", type: "uint256" },
  { internalType: "uint256", name: "amountOutMinimum", type: "uint256" },
  { internalType: "bytes", name: "path", type: "bytes" },
] as const;

export const ziaSwapRouterAbi = [
  {
    inputs: [
      { components: exactInputSingleParamsComponents, internalType: "struct ISwapRouter.ExactInputSingleParams", name: "params", type: "tuple" },
    ],
    name: "exactInputSingle",
    outputs: [{ internalType: "uint256", name: "amountOut", type: "uint256" }],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [
      { components: exactInputParamsComponents, internalType: "struct ISwapRouter.ExactInputParams", name: "params", type: "tuple" },
    ],
    name: "exactInput",
    outputs: [{ internalType: "uint256", name: "amountOut", type: "uint256" }],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "uint256", name: "amountMinimum", type: "uint256" },
      { internalType: "address", name: "recipient", type: "address" },
    ],
    name: "unwrapWETH9",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "uint256", name: "amountMinimum", type: "uint256" },
      { internalType: "address", name: "recipient", type: "address" },
      { internalType: "uint256", name: "feeBps", type: "uint256" },
      { internalType: "address", name: "feeRecipient", type: "address" },
    ],
    name: "unwrapWETH9WithFee",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },
] as const;

// W0G (wrapped native) ABI — deposit/withdraw + ERC20 balanceOf/approve/transfer.
export const w0gAbi = [
  { inputs: [], name: "deposit", outputs: [], stateMutability: "payable", type: "function" },
  { inputs: [{ internalType: "uint256", name: "amount", type: "uint256" }], name: "withdraw", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ internalType: "address", name: "account", type: "address" }], name: "balanceOf", outputs: [{ internalType: "uint256", name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [{ internalType: "address", name: "spender", type: "address" }, { internalType: "uint256", name: "amount", type: "uint256" }], name: "approve", outputs: [{ internalType: "bool", name: "", type: "bool" }], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ internalType: "address", name: "to", type: "address" }, { internalType: "uint256", name: "amount", type: "uint256" }], name: "transfer", outputs: [{ internalType: "bool", name: "", type: "bool" }], stateMutability: "nonpayable", type: "function" },
  { inputs: [], name: "deposit0G", outputs: [], stateMutability: "payable", type: "function" },
] as const;

export interface ZiaLpVaultConfig {
  feeLabel: string;
  feeTier: number;
  label: string;
  poolAddress: Address;
  vaultAddress: Address;
}

// Uniswap V3 pool ABI — the read surface the LP quote/brain modules use to
// ground tick math and the zap split. `token0`/`token1` are required because
// ZiaLpAdapter validates pool token order (w0gIsToken0) via them
// (contracts/ZiaLpAdapter.sol:97-100, 211-213); a quote that does not mirror
// that ordering will diverge from the on-chain swap amount.
export const uniswapV3PoolAbi = [
  {
    inputs: [],
    name: "token0",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "token1",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "fee",
    outputs: [{ internalType: "uint24", name: "", type: "uint24" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "tickSpacing",
    outputs: [{ internalType: "int24", name: "", type: "int24" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "liquidity",
    outputs: [{ internalType: "uint128", name: "", type: "uint128" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "slot0",
    outputs: [
      { internalType: "uint160", name: "sqrtPriceX96", type: "uint160" },
      { internalType: "int24", name: "tick", type: "int24" },
      { internalType: "uint16", name: "observationIndex", type: "uint16" },
      { internalType: "uint16", name: "observationCardinality", type: "uint16" },
      { internalType: "uint16", name: "observationCardinalityNext", type: "uint16" },
      { internalType: "uint8", name: "feeProtocol", type: "uint8" },
      { internalType: "bool", name: "unlocked", type: "bool" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "int24", name: "tick", type: "int24" }],
    name: "ticks",
    outputs: [
      { internalType: "uint128", name: "liquidityGross", type: "uint128" },
      { internalType: "int128", name: "liquidityNet", type: "int128" },
      { internalType: "uint256", name: "feeGrowthOutside0X128", type: "uint256" },
      { internalType: "uint256", name: "feeGrowthOutside1X128", type: "uint256" },
      { internalType: "int56", name: "tickCumulativeOutside", type: "int56" },
      { internalType: "uint160", name: "secondsPerLiquidityOutsideX128", type: "uint160" },
      { internalType: "uint32", name: "secondsOutside", type: "uint32" },
      { internalType: "bool", name: "initialized", type: "bool" },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

export const ZIA_LP_VAULTS = [
  ziaLpVault("USDC/W0G", "1%", 10_000, "0x159fe1d57b464eD60E2bfbBCA0dF444999131673", "0x9585354Ff9778813eACD5850498185c932bB99E9"),
  ziaLpVault("W0G/WETH", "1%", 10_000, "0x8d3f4d8276f02c1deebc73348894e676026196cd", "0xEb7e8e43D81311d4667361186F6207F5225AC55c"),
  ziaLpVault("WBTC/W0G", "1%", 10_000, "0x0d227571872b8305afd53b9dbd384bdbcde15f82", "0x20d8E9163F2e8C00982250498D6728c229cE5fA9"),
  ziaLpVault("USDC/USDT", "0.01%", 100, "0x526df22afa26aca3af82ee24a114ea333c32851a", "0x55e036e6b57134b147b395c48e77b0c30d4c978d"),
  ziaLpVault("USDC/WETH", "0.3%", 3_000, "0x22b46cd7402773878b1d74a02037d83f58e942ec", "0xa5091727aA86eb031DA4CcD050CAD53321c18Bab"),
  ziaLpVault("USDC/LINK", "0.3%", 3_000, "0xBdb60e0C534Cd9db07Dd8560d74801f8fB5Cb2E3", "0x6e64cddc2d85cdd287002bf1c1eec649973f8595"),
  ziaLpVault("USDC/SOL", "0.3%", 3_000, "0x422b1fde29a7560ab3a35248B3a23AE675F5E10f", "0x6265A754bFd1F21408202D70d926CC3Fc094CF39"),
  ziaLpVault("W0G/USDC", "0.3%", 3_000, "0x23336572435ec92d25ef0dd2d468b2a1abf7bb4f", "0xBB4D91Ce1eA8434A419549319E4C0b08F3671225"),
  ziaLpVault("WBTC/USDC", "0.3%", 3_000, "0xd356377752c708621d23c8d886fe2f5ca5f9cec2", "0xb7ACB2Ed1F4Fb8f16846B7b3f2C8C608660aF1D3"),
  ziaLpVault("W0G/WBTC", "0.3%", 3_000, "0xf6c606f70bec81bc0c4e82c83ac16ca0e5331262", "0x1385512e094b29ea5984A8756339F4D92f9ec438"),
  ziaLpVault("W0G/WETH", "0.3%", 3_000, "0x20a96caf06e0ce4e9cb30f75999a6c21a484cd49", "0x95a20c19fE0DAf01bfB9195C3a36b43A9b59406f"),
] as const satisfies readonly ZiaLpVaultConfig[];

export function findZiaLpVaultByPool(poolAddress: Address | string): ZiaLpVaultConfig | undefined {
  const normalized = getAddress(poolAddress);
  return ZIA_LP_VAULTS.find((vault) => vault.poolAddress.toLowerCase() === normalized.toLowerCase());
}

/// poolId encoding used by PolicyVaultV3 — bytes32(uint256(uint160(poolAddress))),
/// recoverable on-chain via poolAddressOf(bytes32). NOT keccak256.
export function poolIdFromAddress(poolAddress: Address | string): Hex {
  return pad(getAddress(poolAddress), { size: 32 });
}

/// W0G-leg filter: zapInMintLp requires the pool to contain wrapped native, so the
/// vault can wrap 0G -> W0G and mint single-sided. Pools without a W0G leg are not
/// zappable from native and are excluded from the V3 constructor allowlist.
///
/// NOTE (codex audit): this is a label-based prefilter over the static ZIA_LP_VAULTS
/// list — it does NOT verify on-chain that the pool's token0/token1 actually is W0G.
/// The vault backstops this on-chain (PolicyVaultV3.sol:732-736). For the live LP
/// routes, pair this with `verifyZappablePool` to confirm by token address so API /
/// static drift cannot expose a pool the vault later rejects.
export function zappableZiaLpVaults(wrappedNative: Address = ZIA_LP_MAINNET.wrappedNative): readonly ZiaLpVaultConfig[] {
  void wrappedNative;
  return ZIA_LP_VAULTS.filter((v) => v.label.toLowerCase().includes("w0g"));
}

/// Async on-chain verification that a pool actually has a W0G leg — reads
/// `token0()`/`token1()` from the pool contract and checks one equals
/// `wrappedNative`. Returns `{ w0gIsToken0 }` so the quote module can mirror
/// `ZiaLpAdapter._computeSwapAmount` exactly. Returns `null` if the read fails
/// or the pool has no W0G leg (so the caller drops it from the candidate set).
export async function verifyZappablePool(
  poolAddress: Address,
  publicClient: PublicClient,
  wrappedNative: Address = ZIA_LP_MAINNET.wrappedNative,
): Promise<{ w0gIsToken0: boolean } | null> {
  try {
    const token0 = (await publicClient.readContract({
      address: poolAddress,
      abi: uniswapV3PoolAbi,
      functionName: "token0",
      args: [],
    })) as Address;
    const token1 = (await publicClient.readContract({
      address: poolAddress,
      abi: uniswapV3PoolAbi,
      functionName: "token1",
      args: [],
    })) as Address;
    const w = wrappedNative.toLowerCase();
    if (token0.toLowerCase() === w) return { w0gIsToken0: true };
    if (token1.toLowerCase() === w) return { w0gIsToken0: false };
    return null;
  } catch {
    return null;
  }
}

/// Build the three parallel arrays the PolicyVaultV3 constructor seeds:
/// allowedLpPools (bytes32[] pool-address-encoded), allowedStakeVaults (unique
/// address[]), stakeVaultForLpPool (address[] parallel to allowedLpPools).
/// Filters to W0G-leg pools (zappable single-sided from native 0G).
export function buildV3LpAllowlists(wrappedNative: Address = ZIA_LP_MAINNET.wrappedNative) {
  const zappable = zappableZiaLpVaults(wrappedNative);
  const allowedLpPools: Hex[] = zappable.map((v) => poolIdFromAddress(v.poolAddress));
  const stakeVaultForLpPool: Address[] = zappable.map((v) => v.vaultAddress);
  const seen = new Set<string>();
  const allowedStakeVaults: Address[] = [];
  for (const addr of stakeVaultForLpPool) {
    const key = addr.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      allowedStakeVaults.push(addr);
    }
  }
  return { allowedLpPools, allowedStakeVaults, stakeVaultForLpPool, zappable };
}

function ziaLpVault(
  label: string,
  feeLabel: string,
  feeTier: number,
  poolAddress: string,
  vaultAddress: string,
): ZiaLpVaultConfig {
  return {
    feeLabel,
    feeTier,
    label,
    poolAddress: getAddress(poolAddress),
    vaultAddress: getAddress(vaultAddress),
  };
}
