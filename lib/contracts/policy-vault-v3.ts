import type { Address, Hex } from "viem";

// Off-chain V3 vault registry path. There is NO on-chain V3 factory on 0G
// mainnet (PolicyVaultFactoryV3 exceeds EIP-170's 24KB cap), so owner->vault
// resolution for V3 goes through this JSON registry instead of factory.vaultOf.
// The deploy script (scripts/create-mainnet-vault-v3.ts) appends one entry per
// deploy; the server resolver (lib/agent/mainnet-vault-resolver.ts) reads it.
//
// TRUST BOUNDARY: this file is a local deploy artifact, not on-chain truth. It
// can be missing, stale, or branch-local. The deploy script gates on
// MAINNET_V3_REDEPLOY_FORCE when this file is missing/stale, and the resolver
// (resolveMainnetV3VaultForOwner) prefers an explicit env override
// (NEXT_PUBLIC_POLICY_VAULT_V3_MAINNET_ADDRESS / POLICY_VAULT_V3_MAINNET_ADDRESS)
// over this registry so UI/executor point at the operator-asserted V3.
export const MAINNET_V3_VAULT_REGISTRY_PATH = ".data/deployments/mainnet-policy-vault-v3-registry.json";

export interface MainnetV3VaultRegistryEntry {
  owner: Address;
  vault: Address;
  version: number;
  chainId: number;
  blockNumber: string;
  tx: Hex;
  lpAdapter: Address | null;
  createdAt: string;
}

// =====================================================================
// PolicyVaultV3 ABI + typed request shapes.
// Source of truth: contracts/PolicyVaultV3.sol. The swap surface is
// byte-for-byte V2 (buy/sell, TradeRequest, balance-delta checks); V3 adds
// the LP primitive layer (zapInMintLp / stakeLp / unstakeLp / zapOut /
// claimRewards-stub), the lpAdapter immutable, LpPolicy, and the
// allowlists/allowances for LP accounting. Keep this file aligned with the
// Solidity struct order EXACTLY — vaultActionHashForLp mixes every field in
// declaration order, so any drift breaks the proof hash.
// =====================================================================

// --- LpPolicy struct (PolicyVaultV3.sol L35-43) ---
export const policyVaultV3LpPolicyComponents = [
  { internalType: "uint256", name: "perLpActionCap0G", type: "uint256" },
  { internalType: "uint256", name: "lpDailyCap0G", type: "uint256" },
  { internalType: "uint256", name: "maxLpExposure0G", type: "uint256" },
  { internalType: "uint256", name: "cooldownSecondsLp", type: "uint256" },
  { internalType: "uint16", name: "lpMinOutBps", type: "uint16" },
  { internalType: "uint256", name: "minLiquidityFloor", type: "uint256" },
  { internalType: "bool", name: "allowStaking", type: "bool" },
] as const;

// --- Policy struct (PolicyVaultV3.sol L45-53): 6 swap fields + nested LpPolicy ---
export const policyVaultV3PolicyComponents = [
  { internalType: "uint256", name: "perTradeCap0G", type: "uint256" },
  { internalType: "uint256", name: "dailyCap0G", type: "uint256" },
  { internalType: "uint256", name: "maxExposure0G", type: "uint256" },
  { internalType: "uint256", name: "cooldownSeconds", type: "uint256" },
  { internalType: "uint256", name: "maxDeadlineWindowSeconds", type: "uint256" },
  { internalType: "uint16", name: "defaultMinOutBps", type: "uint16" },
  {
    components: policyVaultV3LpPolicyComponents,
    internalType: "struct PolicyVaultV3.LpPolicy",
    name: "lp",
    type: "tuple",
  },
] as const;

// --- LpActionRequest struct (PolicyVaultV3.sol L86-111): 24 fields, declaration order.
//     Two uint128 slots (liquidity, quotedLiquidity) — no truncation gap vs the adapter. ---
export const policyVaultV3LpRequestComponents = [
  { internalType: "uint8", name: "actionType", type: "uint8" },
  { internalType: "bytes32", name: "agentKey", type: "bytes32" },
  { internalType: "bytes32", name: "poolId", type: "bytes32" },
  { internalType: "address", name: "stakeVault", type: "address" },
  { internalType: "address", name: "tokenIn", type: "address" },
  { internalType: "address", name: "tokenOut", type: "address" },
  { internalType: "uint256", name: "tokenId", type: "uint256" },
  { internalType: "int24", name: "tickLower", type: "int24" },
  { internalType: "int24", name: "tickUpper", type: "int24" },
  { internalType: "uint256", name: "amount0Desired", type: "uint256" },
  { internalType: "uint256", name: "amount1Desired", type: "uint256" },
  { internalType: "uint128", name: "liquidity", type: "uint128" },
  { internalType: "uint256", name: "amount0Min", type: "uint256" },
  { internalType: "uint256", name: "amount1Min", type: "uint256" },
  { internalType: "uint128", name: "quotedLiquidity", type: "uint128" },
  { internalType: "uint256", name: "quotedAmount0", type: "uint256" },
  { internalType: "uint256", name: "quotedAmount1", type: "uint256" },
  { internalType: "uint256", name: "quotedAmountOut", type: "uint256" },
  { internalType: "uint256", name: "deadline", type: "uint256" },
  { internalType: "uint256", name: "nonce", type: "uint256" },
  { internalType: "bytes32", name: "vaultActionHash", type: "bytes32" },
  { internalType: "bytes32", name: "actionHash", type: "bytes32" },
  { internalType: "bytes32", name: "policySnapshotHash", type: "bytes32" },
  { internalType: "bytes32", name: "auditRoot", type: "bytes32" },
] as const;

// --- TradeRequest struct (PolicyVaultV3.sol L55-69): byte-for-byte V2. ---
export const policyVaultV3TradeRequestComponents = [
  { internalType: "address", name: "tokenIn", type: "address" },
  { internalType: "address", name: "tokenOut", type: "address" },
  { internalType: "uint256", name: "amountIn", type: "uint256" },
  { internalType: "uint256", name: "quotedAmountOut", type: "uint256" },
  { internalType: "uint256", name: "amountOutMin", type: "uint256" },
  { internalType: "uint256", name: "deadline", type: "uint256" },
  { internalType: "uint256", name: "nonce", type: "uint256" },
  { internalType: "bytes32", name: "agentKey", type: "bytes32" },
  { internalType: "bytes32", name: "poolId", type: "bytes32" },
  { internalType: "bytes32", name: "vaultActionHash", type: "bytes32" },
  { internalType: "bytes32", name: "actionHash", type: "bytes32" },
  { internalType: "bytes32", name: "policySnapshotHash", type: "bytes32" },
  { internalType: "bytes32", name: "auditRoot", type: "bytes32" },
] as const;

// =====================================================================
// Comprehensive V3 ABI — used by readVaultSnapshot, the migrate UI, and owner
// ops. Swap entrypoints reuse the V2 TradeRequest shape; LP entrypoints use
// LpActionRequest.
// =====================================================================
export const policyVaultV3Abi = [
  // --- Immutables ---
  { inputs: [], name: "owner", outputs: [{ internalType: "address", name: "", type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "executor", outputs: [{ internalType: "address", name: "", type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "adapter", outputs: [{ internalType: "contract IPolicyVaultAdapter", name: "", type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "lpAdapter", outputs: [{ internalType: "contract IPolicyVaultLpAdapter", name: "", type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "proofRegistry", outputs: [{ internalType: "contract IProofRegistry", name: "", type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "mockAdapterAllowed", outputs: [{ internalType: "bool", name: "", type: "bool" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "mockLpAdapterAllowed", outputs: [{ internalType: "bool", name: "", type: "bool" }], stateMutability: "view", type: "function" },

  // --- State ---
  { inputs: [], name: "paused", outputs: [{ internalType: "bool", name: "", type: "bool" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "executorRevoked", outputs: [{ internalType: "bool", name: "", type: "bool" }], stateMutability: "view", type: "function" },
  {
    inputs: [],
    name: "policy",
    outputs: policyVaultV3PolicyComponents.map((c) =>
      c.type === "tuple"
        ? { components: c.components, internalType: c.internalType, name: c.name, type: "tuple" }
        : { internalType: c.internalType, name: c.name, type: c.type },
    ),
    stateMutability: "view",
    type: "function",
  },
  { inputs: [], name: "policyHash", outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "dailySpent0G", outputs: [{ internalType: "uint256", name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "dailyWindowStart", outputs: [{ internalType: "uint256", name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "lastTradeAt", outputs: [{ internalType: "uint256", name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "openExposure0G", outputs: [{ internalType: "uint256", name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "lpDailySpent0G", outputs: [{ internalType: "uint256", name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "lpDailyWindowStart", outputs: [{ internalType: "uint256", name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "lastLpActionAt", outputs: [{ internalType: "uint256", name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "openLpExposure0G", outputs: [{ internalType: "uint256", name: "", type: "uint256" }], stateMutability: "view", type: "function" },

  // --- Allowlists ---
  { inputs: [{ internalType: "address", name: "token", type: "address" }], name: "allowedTokens", outputs: [{ internalType: "bool", name: "", type: "bool" }], stateMutability: "view", type: "function" },
  { inputs: [{ internalType: "bytes32", name: "poolId", type: "bytes32" }], name: "allowedPools", outputs: [{ internalType: "bool", name: "", type: "bool" }], stateMutability: "view", type: "function" },
  { inputs: [{ internalType: "bytes32", name: "lpPoolId", type: "bytes32" }], name: "allowedLpPools", outputs: [{ internalType: "bool", name: "", type: "bool" }], stateMutability: "view", type: "function" },
  { inputs: [{ internalType: "address", name: "stakeVault", type: "address" }], name: "allowedStakeVaults", outputs: [{ internalType: "bool", name: "", type: "bool" }], stateMutability: "view", type: "function" },
  { inputs: [{ internalType: "bytes32", name: "lpPoolId", type: "bytes32" }], name: "stakeVaultForLpPool", outputs: [{ internalType: "address", name: "", type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [{ internalType: "bytes32", name: "agentKey", type: "bytes32" }], name: "agentKeyEnabled", outputs: [{ internalType: "bool", name: "", type: "bool" }], stateMutability: "view", type: "function" },

  // --- Swap accounting ---
  { inputs: [{ internalType: "address", name: "token", type: "address" }], name: "positionUnits", outputs: [{ internalType: "uint256", name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  {
    inputs: [
      { internalType: "bytes32", name: "agentKey", type: "bytes32" },
      { internalType: "address", name: "token", type: "address" },
    ],
    name: "agentPositionUnits",
    outputs: [{ internalType: "uint256", name: "units", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  { inputs: [{ internalType: "bytes32", name: "agentKey", type: "bytes32" }], name: "agentOpenPositionCount", outputs: [{ internalType: "uint256", name: "count", type: "uint256" }], stateMutability: "view", type: "function" },

  // --- LP accounting ---
  {
    inputs: [
      { internalType: "bytes32", name: "agentKey", type: "bytes32" },
      { internalType: "bytes32", name: "poolId", type: "bytes32" },
    ],
    name: "agentLpNfts",
    outputs: [{ internalType: "uint256[]", name: "", type: "uint256[]" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "bytes32", name: "agentKey", type: "bytes32" },
      { internalType: "address", name: "stakeVault", type: "address" },
    ],
    name: "agentStakedNfts",
    outputs: [{ internalType: "uint256[]", name: "", type: "uint256[]" }],
    stateMutability: "view",
    type: "function",
  },
  { inputs: [{ internalType: "bytes32", name: "agentKey", type: "bytes32" }], name: "agentLpNotionalDeployed", outputs: [{ internalType: "uint256", name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [{ internalType: "uint256", name: "tokenId", type: "uint256" }], name: "lpNftOwner", outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }], stateMutability: "view", type: "function" },
  { inputs: [{ internalType: "uint256", name: "tokenId", type: "uint256" }], name: "lpNftPool", outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }], stateMutability: "view", type: "function" },
  { inputs: [{ internalType: "uint256", name: "tokenId", type: "uint256" }], name: "lpNftDeployedNative", outputs: [{ internalType: "uint256", name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [{ internalType: "uint256", name: "tokenId", type: "uint256" }], name: "lpNftTickLower", outputs: [{ internalType: "int24", name: "", type: "int24" }], stateMutability: "view", type: "function" },
  { inputs: [{ internalType: "uint256", name: "tokenId", type: "uint256" }], name: "lpNftTickUpper", outputs: [{ internalType: "int24", name: "", type: "int24" }], stateMutability: "view", type: "function" },

  // --- Owner ops (swap path, V2 verbatim) ---
  { inputs: [], name: "depositNative", outputs: [], stateMutability: "payable", type: "function" },
  { inputs: [{ internalType: "uint256", name: "amount", type: "uint256" }], name: "withdrawNative", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ internalType: "address", name: "token", type: "address" }, { internalType: "uint256", name: "amount", type: "uint256" }], name: "rescueToken", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ internalType: "bool", name: "value", type: "bool" }], name: "setPaused", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [], name: "revokeExecutor", outputs: [], stateMutability: "nonpayable", type: "function" },
  {
    inputs: [
      { internalType: "bytes32", name: "agentKey", type: "bytes32" },
      { internalType: "bool", name: "enabled", type: "bool" },
    ],
    name: "setAgentKeyEnabled",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "bytes32[]", name: "agentKeys", type: "bytes32[]" },
      { internalType: "bool", name: "enabled", type: "bool" },
    ],
    name: "setAgentKeysEnabled",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  { inputs: [{ internalType: "address", name: "token", type: "address" }], name: "disableToken", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ internalType: "bytes32", name: "poolId", type: "bytes32" }], name: "disablePool", outputs: [], stateMutability: "nonpayable", type: "function" },
  {
    inputs: [
      { internalType: "address", name: "tokenIn", type: "address" },
      { internalType: "address", name: "tokenOut", type: "address" },
      { internalType: "uint16", name: "minOutBps", type: "uint16" },
    ],
    name: "tightenPairMinOutBps",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },

  // --- Owner ops (LP path, V3 new) ---
  { inputs: [{ internalType: "address", name: "nft", type: "address" }, { internalType: "uint256", name: "tokenId", type: "uint256" }], name: "rescueNft", outputs: [], stateMutability: "nonpayable", type: "function" },
  {
    inputs: [
      { internalType: "uint256", name: "tokenId", type: "uint256" },
      { internalType: "address", name: "stakeVault", type: "address" },
    ],
    name: "unstakeLpOwner",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  { inputs: [{ internalType: "bytes32", name: "lpPoolId", type: "bytes32" }], name: "disableLpPool", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ internalType: "address", name: "stakeVault", type: "address" }], name: "disableStakeVault", outputs: [], stateMutability: "nonpayable", type: "function" },
  {
    inputs: [
      {
        components: policyVaultV3PolicyComponents,
        internalType: "struct PolicyVaultV3.Policy",
        name: "nextPolicy",
        type: "tuple",
      },
    ],
    name: "tightenPolicy",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },

  // --- Views ---
  {
    inputs: [
      { internalType: "address", name: "tokenIn", type: "address" },
      { internalType: "address", name: "tokenOut", type: "address" },
    ],
    name: "minOutBpsFor",
    outputs: [{ internalType: "uint16", name: "", type: "uint16" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "tokenIn", type: "address" },
      { internalType: "address", name: "tokenOut", type: "address" },
      { internalType: "uint256", name: "quotedAmountOut", type: "uint256" },
    ],
    name: "minOutFor",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "bytes32", name: "vaultActionHash", type: "bytes32" },
      { internalType: "bytes32", name: "auditRoot", type: "bytes32" },
      { internalType: "bytes32", name: "policySnapshotHash", type: "bytes32" },
    ],
    name: "actionHashFor",
    outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
    stateMutability: "pure",
    type: "function",
  },
  {
    inputs: [
      { internalType: "bool", name: "isBuy", type: "bool" },
      {
        components: policyVaultV3TradeRequestComponents,
        internalType: "struct PolicyVaultV3.TradeRequest",
        name: "request",
        type: "tuple",
      },
    ],
    name: "vaultActionHashFor",
    outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      {
        components: policyVaultV3LpRequestComponents,
        internalType: "struct PolicyVaultV3.LpActionRequest",
        name: "request",
        type: "tuple",
      },
    ],
    name: "vaultActionHashForLp",
    outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "bytes32", name: "poolId", type: "bytes32" }],
    name: "poolAddressOf",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "pure",
    type: "function",
  },

  // --- Executor swap entrypoints (V2 verbatim) ---
  {
    inputs: [
      {
        components: policyVaultV3TradeRequestComponents,
        internalType: "struct PolicyVaultV3.TradeRequest",
        name: "request",
        type: "tuple",
      },
    ],
    name: "buy",
    outputs: [{ internalType: "uint256", name: "amountOut", type: "uint256" }],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [
      {
        components: policyVaultV3TradeRequestComponents,
        internalType: "struct PolicyVaultV3.TradeRequest",
        name: "request",
        type: "tuple",
      },
    ],
    name: "sell",
    outputs: [{ internalType: "uint256", name: "amountOut", type: "uint256" }],
    stateMutability: "payable",
    type: "function",
  },

  // --- Executor LP entrypoints ---
  {
    inputs: [
      {
        components: policyVaultV3LpRequestComponents,
        internalType: "struct PolicyVaultV3.LpActionRequest",
        name: "request",
        type: "tuple",
      },
    ],
    name: "zapInMintLp",
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
      {
        components: policyVaultV3LpRequestComponents,
        internalType: "struct PolicyVaultV3.LpActionRequest",
        name: "request",
        type: "tuple",
      },
    ],
    name: "stakeLp",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [
      {
        components: policyVaultV3LpRequestComponents,
        internalType: "struct PolicyVaultV3.LpActionRequest",
        name: "request",
        type: "tuple",
      },
    ],
    name: "unstakeLp",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [
      {
        components: policyVaultV3LpRequestComponents,
        internalType: "struct PolicyVaultV3.LpActionRequest",
        name: "request",
        type: "tuple",
      },
    ],
    name: "zapOut",
    outputs: [{ internalType: "uint256", name: "amountOut", type: "uint256" }],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [
      {
        components: policyVaultV3LpRequestComponents,
        internalType: "struct PolicyVaultV3.LpActionRequest",
        name: "request",
        type: "tuple",
      },
    ],
    name: "claimRewards",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },

  // --- Events (V3 LP) ---
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "bytes32", name: "actionHash", type: "bytes32" },
      { indexed: true, internalType: "bytes32", name: "agentKey", type: "bytes32" },
      { indexed: true, internalType: "uint8", name: "actionType", type: "uint8" },
      { indexed: false, internalType: "bytes32", name: "poolId", type: "bytes32" },
      { indexed: false, internalType: "uint256", name: "tokenId", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "amountIn0G", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "amountOut", type: "uint256" },
      { indexed: false, internalType: "int256", name: "liquidityDelta", type: "int256" },
      { indexed: false, internalType: "bytes32", name: "auditRoot", type: "bytes32" },
      { indexed: false, internalType: "bytes32", name: "policySnapshotHash", type: "bytes32" },
    ],
    name: "LpActionExecutedV3",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "bytes32", name: "agentKey", type: "bytes32" },
      { indexed: true, internalType: "uint256", name: "tokenId", type: "uint256" },
      { indexed: true, internalType: "address", name: "stakeVault", type: "address" },
      { indexed: false, internalType: "bytes32", name: "poolId", type: "bytes32" },
    ],
    name: "Staked",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "bytes32", name: "agentKey", type: "bytes32" },
      { indexed: true, internalType: "uint256", name: "tokenId", type: "uint256" },
      { indexed: true, internalType: "address", name: "stakeVault", type: "address" },
      { indexed: false, internalType: "bytes32", name: "poolId", type: "bytes32" },
    ],
    name: "Unstaked",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "nft", type: "address" },
      { indexed: true, internalType: "uint256", name: "tokenId", type: "uint256" },
      { indexed: true, internalType: "address", name: "to", type: "address" },
    ],
    name: "NftRescued",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "uint256", name: "tokenId", type: "uint256" },
      { indexed: true, internalType: "address", name: "stakeVault", type: "address" },
    ],
    name: "OwnerUnstaked",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [{ indexed: true, internalType: "bytes32", name: "poolId", type: "bytes32" }],
    name: "LpPoolAllowed",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [{ indexed: true, internalType: "bytes32", name: "poolId", type: "bytes32" }],
    name: "LpPoolDisabled",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [{ indexed: true, internalType: "address", name: "stakeVault", type: "address" }],
    name: "StakeVaultAllowed",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [{ indexed: true, internalType: "address", name: "stakeVault", type: "address" }],
    name: "StakeVaultDisabled",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      {
        components: policyVaultV3LpPolicyComponents,
        internalType: "struct PolicyVaultV3.LpPolicy",
        name: "lp",
        type: "tuple",
      },
    ],
    name: "LpPolicyTightened",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "bytes32", name: "actionHash", type: "bytes32" },
      { indexed: true, internalType: "bytes32", name: "agentKey", type: "bytes32" },
      { indexed: true, internalType: "bool", name: "isBuy", type: "bool" },
      { indexed: false, internalType: "address", name: "token", type: "address" },
      { indexed: false, internalType: "uint256", name: "amountIn", type: "uint256" },
      { indexed: false, internalType: "uint256", name: "amountOut", type: "uint256" },
      { indexed: false, internalType: "bytes32", name: "auditRoot", type: "bytes32" },
      { indexed: false, internalType: "bytes32", name: "policySnapshotHash", type: "bytes32" },
    ],
    name: "TradeExecutedV2",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [{ indexed: true, internalType: "bytes32", name: "agentKey", type: "bytes32" }],
    name: "AgentKeyEnabledSet",
    type: "event",
  },
] as const;

// --- LP executor subset: proof-hash views + LP entrypoints + lpAdapter read. ---
export const policyVaultV3LpAbi = [
  { inputs: [], name: "lpAdapter", outputs: [{ internalType: "contract IPolicyVaultLpAdapter", name: "", type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "policyHash", outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }], stateMutability: "view", type: "function" },
  {
    inputs: [
      { internalType: "bytes32", name: "vaultActionHash", type: "bytes32" },
      { internalType: "bytes32", name: "auditRoot", type: "bytes32" },
      { internalType: "bytes32", name: "policySnapshotHash", type: "bytes32" },
    ],
    name: "actionHashFor",
    outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
    stateMutability: "pure",
    type: "function",
  },
  {
    inputs: [
      {
        components: policyVaultV3LpRequestComponents,
        internalType: "struct PolicyVaultV3.LpActionRequest",
        name: "request",
        type: "tuple",
      },
    ],
    name: "vaultActionHashForLp",
    outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      {
        components: policyVaultV3LpRequestComponents,
        internalType: "struct PolicyVaultV3.LpActionRequest",
        name: "request",
        type: "tuple",
      },
    ],
    name: "zapInMintLp",
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
      {
        components: policyVaultV3LpRequestComponents,
        internalType: "struct PolicyVaultV3.LpActionRequest",
        name: "request",
        type: "tuple",
      },
    ],
    name: "stakeLp",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [
      {
        components: policyVaultV3LpRequestComponents,
        internalType: "struct PolicyVaultV3.LpActionRequest",
        name: "request",
        type: "tuple",
      },
    ],
    name: "unstakeLp",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [
      {
        components: policyVaultV3LpRequestComponents,
        internalType: "struct PolicyVaultV3.LpActionRequest",
        name: "request",
        type: "tuple",
      },
    ],
    name: "zapOut",
    outputs: [{ internalType: "uint256", name: "amountOut", type: "uint256" }],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [
      {
        components: policyVaultV3LpRequestComponents,
        internalType: "struct PolicyVaultV3.LpActionRequest",
        name: "request",
        type: "tuple",
      },
    ],
    name: "claimRewards",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },
] as const;

// =====================================================================
// Typed shapes
// =====================================================================

export interface PolicyVaultV3LpPolicy {
  perLpActionCap0G: bigint;
  lpDailyCap0G: bigint;
  maxLpExposure0G: bigint;
  cooldownSecondsLp: bigint;
  lpMinOutBps: number;
  minLiquidityFloor: bigint;
  allowStaking: boolean;
}

export interface PolicyVaultV3Policy {
  perTradeCap0G: bigint;
  dailyCap0G: bigint;
  maxExposure0G: bigint;
  cooldownSeconds: bigint;
  maxDeadlineWindowSeconds: bigint;
  defaultMinOutBps: number;
  lp: PolicyVaultV3LpPolicy;
}

export function normalizePolicyVaultV3Policy(raw: unknown): PolicyVaultV3Policy {
  const lpRaw = readTupleField(raw, 6, "lp");
  return {
    perTradeCap0G: readBigIntField(raw, 0, "perTradeCap0G"),
    dailyCap0G: readBigIntField(raw, 1, "dailyCap0G"),
    maxExposure0G: readBigIntField(raw, 2, "maxExposure0G"),
    cooldownSeconds: readBigIntField(raw, 3, "cooldownSeconds"),
    maxDeadlineWindowSeconds: readBigIntField(raw, 4, "maxDeadlineWindowSeconds"),
    defaultMinOutBps: readNumberField(raw, 5, "defaultMinOutBps"),
    lp: normalizePolicyVaultV3LpPolicy(lpRaw),
  };
}

export function normalizePolicyVaultV3LpPolicy(raw: unknown): PolicyVaultV3LpPolicy {
  return {
    perLpActionCap0G: readBigIntField(raw, 0, "perLpActionCap0G"),
    lpDailyCap0G: readBigIntField(raw, 1, "lpDailyCap0G"),
    maxLpExposure0G: readBigIntField(raw, 2, "maxLpExposure0G"),
    cooldownSecondsLp: readBigIntField(raw, 3, "cooldownSecondsLp"),
    lpMinOutBps: readNumberField(raw, 4, "lpMinOutBps"),
    minLiquidityFloor: readBigIntField(raw, 5, "minLiquidityFloor"),
    allowStaking: readBooleanField(raw, 6, "allowStaking"),
  };
}

function readTupleField(raw: unknown, index: number, key: string): unknown {
  const byKey = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>)[key] : undefined;
  if (byKey !== undefined) return byKey;
  if (Array.isArray(raw) || (raw !== null && typeof raw === "object" && index in (raw as Record<number, unknown>))) {
    return (raw as readonly unknown[])[index];
  }
  throw new Error(`PolicyVaultV3 policy decode missing field ${key}.`);
}

function readBigIntField(raw: unknown, index: number, key: string): bigint {
  const value = readTupleField(raw, index, key);
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^\d+$/u.test(value)) return BigInt(value);
  throw new Error(`PolicyVaultV3 policy field ${key} is not a uint value.`);
}

function readNumberField(raw: unknown, index: number, key: string): number {
  const value = readTupleField(raw, index, key);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "bigint" && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  if (typeof value === "string" && /^\d+$/u.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new Error(`PolicyVaultV3 policy field ${key} is not a safe number.`);
}

function readBooleanField(raw: unknown, index: number, key: string): boolean {
  const value = readTupleField(raw, index, key);
  if (typeof value === "boolean") return value;
  throw new Error(`PolicyVaultV3 policy field ${key} is not a boolean.`);
}

// LpActionType enum mirror (PolicyVaultV3.sol L71-84). Only 2/7/8/10/11 are
// accepted by the shipping entrypoints; the rest are reserved (v4-deferred).
export const LP_ACTION_TYPE = {
  SWAP_BUY: 0,
  SWAP_SELL: 1,
  ZAP_IN_MINT_LP: 2,
  ZAP_IN_INCREASE_LIQUIDITY: 3,
  DECREASE_LIQUIDITY: 4,
  COLLECT_FEES: 5,
  BURN_LP: 6,
  STAKE_LP: 7,
  UNSTAKE_LP: 8,
  SWEEP_TOKEN: 9,
  ZAP_OUT: 10,
  CLAIM_REWARDS: 11,
} as const;

export interface PolicyVaultV3LpActionRequest {
  actionType: number;
  agentKey: Hex;
  poolId: Hex;
  stakeVault: Address;
  tokenIn: Address;
  tokenOut: Address;
  tokenId: bigint;
  tickLower: number;
  tickUpper: number;
  amount0Desired: bigint;
  amount1Desired: bigint;
  liquidity: bigint;
  amount0Min: bigint;
  amount1Min: bigint;
  quotedLiquidity: bigint;
  quotedAmount0: bigint;
  quotedAmount1: bigint;
  quotedAmountOut: bigint;
  deadline: bigint;
  nonce: bigint;
  vaultActionHash: Hex;
  actionHash: Hex;
  policySnapshotHash: Hex;
  auditRoot: Hex;
}
