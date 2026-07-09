import { isAddress, zeroAddress, type Address, type Hex } from "viem";
import {
  policyVaultV4LpEntryBytecode,
  policyVaultV4LpExitBytecode,
  policyVaultV4SwapBytecode,
} from "./policy-vault-v4-bytecode";
import {
  policyVaultLpPolicyComponents,
  policyVaultLpRequestComponents,
  policyVaultSwapPolicyComponents,
  policyVaultTradeRequestComponents,
  type PolicyVaultLpActionRequest,
  type PolicyVaultV4LpPolicy,
  type PolicyVaultV4SwapPolicy,
} from "@/lib/types/vault-policy-shapes";

export type { PolicyVaultLpActionRequest, PolicyVaultV4LpPolicy, PolicyVaultV4SwapPolicy };

export const NEXT_PUBLIC_POLICY_VAULT_V4_REGISTRY_MAINNET_ADDRESS =
  readAddress(process.env.NEXT_PUBLIC_POLICY_VAULT_V4_REGISTRY_MAINNET_ADDRESS) ?? zeroAddress;

export const NEXT_PUBLIC_POLICY_VAULT_ZIA_LP_ADAPTER_V4_MAINNET_ADDRESS =
  readAddress(process.env.NEXT_PUBLIC_POLICY_VAULT_ZIA_LP_ADAPTER_V4_MAINNET_ADDRESS) ?? zeroAddress;

export const NEXT_PUBLIC_VAULT_REGISTRY_V4_MAINNET_FROM_BLOCK =
  readBigIntEnv(process.env.NEXT_PUBLIC_VAULT_REGISTRY_V4_MAINNET_FROM_BLOCK, 0n);

export { policyVaultV4LpEntryBytecode, policyVaultV4LpExitBytecode, policyVaultV4SwapBytecode };

export const vaultRegistryV4Abi = [
  { inputs: [], name: "VERSION", outputs: [{ internalType: "uint256", name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [{ internalType: "address", name: "owner", type: "address" }], name: "swapVaultOf", outputs: [{ internalType: "address", name: "", type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [{ internalType: "address", name: "owner", type: "address" }], name: "lpEntryVaultOf", outputs: [{ internalType: "address", name: "", type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [{ internalType: "address", name: "owner", type: "address" }], name: "lpExitVaultOf", outputs: [{ internalType: "address", name: "", type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [{ internalType: "address", name: "vault", type: "address" }], name: "registerSwap", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ internalType: "address", name: "vault", type: "address" }], name: "registerLpEntry", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ internalType: "address", name: "vault", type: "address" }], name: "registerLpExit", outputs: [], stateMutability: "nonpayable", type: "function" },
  {
    inputs: [{ internalType: "address", name: "owner", type: "address" }],
    name: "vaultOf",
    outputs: [
      { internalType: "address", name: "swapVault", type: "address" },
      { internalType: "address", name: "lpEntryVault", type: "address" },
      { internalType: "address", name: "lpExitVault", type: "address" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "owner", type: "address" },
      { indexed: true, internalType: "address", name: "vault", type: "address" },
      { indexed: false, internalType: "uint256", name: "version", type: "uint256" },
    ],
    name: "SwapVaultRegistered",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "owner", type: "address" },
      { indexed: true, internalType: "address", name: "vault", type: "address" },
      { indexed: false, internalType: "uint256", name: "version", type: "uint256" },
    ],
    name: "LpEntryVaultRegistered",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "owner", type: "address" },
      { indexed: true, internalType: "address", name: "vault", type: "address" },
      { indexed: false, internalType: "uint256", name: "version", type: "uint256" },
    ],
    name: "LpExitVaultRegistered",
    type: "event",
  },
] as const;

const ownerAgentKeyAbi = [
  { inputs: [], name: "owner", outputs: [{ internalType: "address", name: "", type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "executor", outputs: [{ internalType: "address", name: "", type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [{ internalType: "bytes32", name: "agentKey", type: "bytes32" }], name: "agentKeyEnabled", outputs: [{ internalType: "bool", name: "", type: "bool" }], stateMutability: "view", type: "function" },
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
] as const;

// H5 FIX: custom-error ABI fragments so viem decodes on-chain reverts into named errors
// (e.g. "LpCapExceeded") instead of raw selector hex. All three vaults inherit Ownable +
// ReentrancyGuard (NotOwner / ReentrantCall / ZeroOwner). Kept per-vault to mirror each source.
const replayError = { type: "error", name: "Replay", inputs: [{ internalType: "bytes32", name: "actionHash", type: "bytes32" }] } as const;
const err = <N extends string>(name: N) => ({ type: "error", name, inputs: [] as const }) as const;

export const policyVaultV4SwapErrorsAbi = [
  err("AdapterBlocked"), err("BadDelta"), err("BadPolicy"), err("CooldownActive"), err("DailyCapExceeded"),
  err("DeadlineExpired"), err("DeadlineTooFar"), err("ExecutorIsRevoked"), err("InvalidAdapter"), err("InvalidAgentKey"),
  err("InvalidAmount"), err("InvalidProof"), err("InvalidRecipient"), err("InvalidTradePair"), err("LowMinOut"),
  err("MaxExposureExceeded"), err("NotAllowed"), err("NotExecutor"), err("Paused"), err("TradeCapExceeded"),
  err("UnexpectedValue"), err("NotOwner"), err("ReentrantCall"), err("ZeroOwner"), replayError,
] as const;

export const policyVaultV4LpEntryErrorsAbi = [
  err("AdapterBlocked"), err("AlreadyRegistered"), err("BadParams"), err("BadPolicy"), err("DeadlineExpired"),
  err("DeadlineTooFar"), err("ExecutorIsRevoked"), err("InvalidActionType"), err("InvalidAdapter"), err("InvalidAgentKey"),
  err("InvalidLpAmount"), err("InvalidLpPool"), err("InvalidProof"), err("InvalidStakeVault"), err("LpAdapterNotConfigured"),
  err("LpBadDelta"), err("LpCapExceeded"), err("LpCooldownActive"), err("LpDailyCapExceeded"), err("LpEntryMismatch"),
  err("LpExposureExceeded"), err("LpInvalidMinOut"), err("LpLiquidityFloor"), err("LpPoolNotZappable"), err("LpPositionNotEmpty"),
  err("LpTickMismatch"), err("NotAgentLpNft"), err("NotAllowed"), err("NotExecutor"), err("NotStakedNft"),
  err("NotVaultNft"), err("Paused"), err("PoolMismatch"), err("StakingDisabled"), err("UnexpectedValue"),
  err("NotOwner"), err("ReentrantCall"), err("ZeroOwner"), replayError,
] as const;

export const policyVaultV4LpExitErrorsAbi = [
  err("AdapterBlocked"), err("DeadlineExpired"), err("DeadlineTooFar"), err("ExecutorIsRevoked"), err("InvalidActionType"),
  err("InvalidAdapter"), err("InvalidAgentKey"), err("InvalidLpAmount"), err("InvalidLpPool"), err("InvalidProof"),
  err("InvalidStakeVault"), err("LpAdapterNotConfigured"), err("LpBadDelta"), err("LpEntryMismatch"), err("LpInvalidMinOut"),
  err("LpPositionNotEmpty"), err("NotAgentLpNft"), err("NotAllowed"), err("NotExecutor"), err("NotStakedNft"),
  err("Paused"), err("PoolMismatch"), err("RewardsNotConfigured"), err("UnexpectedValue"),
  err("NotOwner"), err("ReentrantCall"), err("ZeroOwner"), replayError,
] as const;

export const policyVaultV4SwapAbi = [
  ...policyVaultV4SwapErrorsAbi,
  {
    inputs: [
      { internalType: "address", name: "initialOwner", type: "address" },
      { internalType: "address", name: "executor_", type: "address" },
      { internalType: "address", name: "swapAdapter_", type: "address" },
      { internalType: "address", name: "proofRegistry_", type: "address" },
      { components: policyVaultSwapPolicyComponents, internalType: "struct PolicyVaultV4Swap.Policy", name: "initialPolicy", type: "tuple" },
      { internalType: "address[]", name: "initialAllowedTokens", type: "address[]" },
      { internalType: "bytes32[]", name: "initialAllowedPools", type: "bytes32[]" },
      { internalType: "bool", name: "allowMockAdapter", type: "bool" },
      { internalType: "address", name: "vaultRegistry_", type: "address" },
    ],
    stateMutability: "nonpayable",
    type: "constructor",
  },
  ...ownerAgentKeyAbi,
  { inputs: [], name: "swapAdapter", outputs: [{ internalType: "contract IPolicyVaultAdapter", name: "", type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "proofRegistry", outputs: [{ internalType: "contract IProofRegistry", name: "", type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "policy", outputs: policyVaultSwapPolicyComponents, stateMutability: "view", type: "function" },
  { inputs: [], name: "policyHash", outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "paused", outputs: [{ internalType: "bool", name: "", type: "bool" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "executorRevoked", outputs: [{ internalType: "bool", name: "", type: "bool" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "dailySpent0G", outputs: [{ internalType: "uint256", name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "openExposure0G", outputs: [{ internalType: "uint256", name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "depositNative", outputs: [], stateMutability: "payable", type: "function" },
  { inputs: [{ internalType: "uint256", name: "amount", type: "uint256" }], name: "withdrawNative", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ internalType: "bool", name: "value", type: "bool" }], name: "setPaused", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [], name: "revokeExecutor", outputs: [], stateMutability: "nonpayable", type: "function" },
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
      { components: policyVaultTradeRequestComponents, internalType: "struct PolicyVaultV4Swap.TradeRequest", name: "request", type: "tuple" },
    ],
    name: "vaultActionHashFor",
    outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ components: policyVaultTradeRequestComponents, internalType: "struct PolicyVaultV4Swap.TradeRequest", name: "request", type: "tuple" }],
    name: "buy",
    outputs: [{ internalType: "uint256", name: "amountOut", type: "uint256" }],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [{ components: policyVaultTradeRequestComponents, internalType: "struct PolicyVaultV4Swap.TradeRequest", name: "request", type: "tuple" }],
    name: "sell",
    outputs: [{ internalType: "uint256", name: "amountOut", type: "uint256" }],
    stateMutability: "payable",
    type: "function",
  },
] as const;

export const policyVaultV4LpEntryAbi = [
  ...policyVaultV4LpEntryErrorsAbi,
  {
    inputs: [
      { internalType: "address", name: "initialOwner", type: "address" },
      { internalType: "address", name: "executor_", type: "address" },
      { internalType: "address", name: "lpAdapter_", type: "address" },
      { internalType: "address", name: "proofRegistry_", type: "address" },
      { internalType: "bool", name: "allowMockLpAdapter", type: "bool" },
      { internalType: "address", name: "vaultRegistry_", type: "address" },
      { components: policyVaultLpPolicyComponents, internalType: "struct PolicyVaultV4LpEntry.LpPolicy", name: "initialPolicy", type: "tuple" },
      { internalType: "bytes32[]", name: "initialAllowedLpPools", type: "bytes32[]" },
      { internalType: "address[]", name: "initialAllowedStakeVaults", type: "address[]" },
      { internalType: "address[]", name: "initialStakeVaultForLpPool", type: "address[]" },
    ],
    stateMutability: "nonpayable",
    type: "constructor",
  },
  ...ownerAgentKeyAbi,
  { inputs: [], name: "lpAdapter", outputs: [{ internalType: "contract IPolicyVaultLpAdapter", name: "", type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "proofRegistry", outputs: [{ internalType: "contract IProofRegistry", name: "", type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "policy", outputs: policyVaultLpPolicyComponents, stateMutability: "view", type: "function" },
  { inputs: [], name: "policyHash", outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "lpExitVault", outputs: [{ internalType: "address", name: "", type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "paused", outputs: [{ internalType: "bool", name: "", type: "bool" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "executorRevoked", outputs: [{ internalType: "bool", name: "", type: "bool" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "lpDailySpent0G", outputs: [{ internalType: "uint256", name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "lpDailyWindowStart", outputs: [{ internalType: "uint256", name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "openLpExposure0G", outputs: [{ internalType: "uint256", name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [{ internalType: "address", name: "candidate", type: "address" }], name: "setLpExitVault", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [], name: "depositNative", outputs: [], stateMutability: "payable", type: "function" },
  { inputs: [{ internalType: "uint256", name: "amount", type: "uint256" }], name: "withdrawNative", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ internalType: "address", name: "token", type: "address" }, { internalType: "uint256", name: "amount", type: "uint256" }], name: "rescueToken", outputs: [], stateMutability: "nonpayable", type: "function" },
  {
    inputs: [
      { internalType: "uint256", name: "tokenId", type: "uint256" },
      { internalType: "bytes32", name: "agentKey", type: "bytes32" },
      { internalType: "bytes32", name: "poolId", type: "bytes32" },
      { internalType: "int24", name: "tickLower", type: "int24" },
      { internalType: "int24", name: "tickUpper", type: "int24" },
      { internalType: "uint256", name: "deployedNative0G", type: "uint256" },
    ],
    name: "importLpNft",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "uint256", name: "tokenId", type: "uint256" },
      { internalType: "address", name: "to", type: "address" },
    ],
    name: "rescueNft",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ components: policyVaultLpRequestComponents, internalType: "struct PolicyVaultV4LpEntry.LpActionRequest", name: "request", type: "tuple" }],
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
    inputs: [{ components: policyVaultLpRequestComponents, internalType: "struct PolicyVaultV4LpEntry.LpActionRequest", name: "request", type: "tuple" }],
    name: "zapInIncreaseLiquidity",
    outputs: [
      { internalType: "uint128", name: "liquidity", type: "uint128" },
      { internalType: "uint256", name: "amount0", type: "uint256" },
      { internalType: "uint256", name: "amount1", type: "uint256" },
    ],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [{ components: policyVaultLpRequestComponents, internalType: "struct PolicyVaultV4LpEntry.LpActionRequest", name: "request", type: "tuple" }],
    name: "stakeLp",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [{ components: policyVaultLpRequestComponents, internalType: "struct PolicyVaultV4LpEntry.LpActionRequest", name: "request", type: "tuple" }],
    name: "vaultActionHashForLp",
    outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
    stateMutability: "view",
    type: "function",
  },
  { inputs: [{ internalType: "bytes32", name: "poolId", type: "bytes32" }], name: "poolAddressOf", outputs: [{ internalType: "address", name: "", type: "address" }], stateMutability: "pure", type: "function" },
  { inputs: [{ internalType: "bytes32", name: "poolId", type: "bytes32" }], name: "allowedLpPools", outputs: [{ internalType: "bool", name: "", type: "bool" }], stateMutability: "view", type: "function" },
  { inputs: [{ internalType: "bytes32", name: "poolId", type: "bytes32" }], name: "stakeVaultForLpPool", outputs: [{ internalType: "address", name: "", type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [{ internalType: "address", name: "stakeVault", type: "address" }], name: "allowedStakeVaults", outputs: [{ internalType: "bool", name: "", type: "bool" }], stateMutability: "view", type: "function" },
  { inputs: [{ internalType: "uint256", name: "tokenId", type: "uint256" }], name: "lpNftOwner", outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }], stateMutability: "view", type: "function" },
  { inputs: [{ internalType: "uint256", name: "tokenId", type: "uint256" }], name: "lpNftPool", outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }], stateMutability: "view", type: "function" },
  { inputs: [{ internalType: "uint256", name: "tokenId", type: "uint256" }], name: "lpNftTickLower", outputs: [{ internalType: "int24", name: "", type: "int24" }], stateMutability: "view", type: "function" },
  { inputs: [{ internalType: "uint256", name: "tokenId", type: "uint256" }], name: "lpNftTickUpper", outputs: [{ internalType: "int24", name: "", type: "int24" }], stateMutability: "view", type: "function" },
  { inputs: [{ internalType: "uint256", name: "tokenId", type: "uint256" }], name: "lpNftDeployedNative", outputs: [{ internalType: "uint256", name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [{ internalType: "bytes32", name: "agentKey", type: "bytes32" }, { internalType: "uint256", name: "tokenId", type: "uint256" }], name: "isLpNftStaked", outputs: [{ internalType: "bool", name: "", type: "bool" }], stateMutability: "view", type: "function" },
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
] as const;

export const policyVaultV4LpExitAbi = [
  ...policyVaultV4LpExitErrorsAbi,
  {
    inputs: [
      { internalType: "address", name: "initialOwner", type: "address" },
      { internalType: "address", name: "executor_", type: "address" },
      { internalType: "address", name: "lpAdapter_", type: "address" },
      { internalType: "address", name: "proofRegistry_", type: "address" },
      { internalType: "bool", name: "allowMockLpAdapter", type: "bool" },
      { internalType: "address", name: "vaultRegistry_", type: "address" },
      { internalType: "address", name: "lpEntry_", type: "address" },
      { internalType: "bytes32[]", name: "initialAllowedSweepPools", type: "bytes32[]" },
      { internalType: "address[]", name: "initialAllowedSweepTokens", type: "address[]" },
    ],
    stateMutability: "nonpayable",
    type: "constructor",
  },
  ...ownerAgentKeyAbi,
  { inputs: [], name: "paused", outputs: [{ internalType: "bool", name: "", type: "bool" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "executorRevoked", outputs: [{ internalType: "bool", name: "", type: "bool" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "lpEntry", outputs: [{ internalType: "contract IPolicyVaultV4LpEntry", name: "", type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "lpAdapter", outputs: [{ internalType: "contract IPolicyVaultLpAdapter", name: "", type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "proofRegistry", outputs: [{ internalType: "contract IProofRegistry", name: "", type: "address" }], stateMutability: "view", type: "function" },
  { inputs: [{ internalType: "bytes32", name: "poolId", type: "bytes32" }], name: "allowedSweepPools", outputs: [{ internalType: "bool", name: "", type: "bool" }], stateMutability: "view", type: "function" },
  { inputs: [{ internalType: "address", name: "token", type: "address" }], name: "allowedSweepTokens", outputs: [{ internalType: "bool", name: "", type: "bool" }], stateMutability: "view", type: "function" },
  { inputs: [{ internalType: "bytes32", name: "poolId", type: "bytes32" }], name: "addSweepPool", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ internalType: "bytes32", name: "poolId", type: "bytes32" }], name: "disableSweepPool", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ internalType: "address", name: "token", type: "address" }], name: "addSweepToken", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ internalType: "address", name: "token", type: "address" }], name: "disableSweepToken", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ internalType: "uint256", name: "amount", type: "uint256" }], name: "withdrawNative", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ internalType: "address", name: "token", type: "address" }, { internalType: "uint256", name: "amount", type: "uint256" }], name: "rescueToken", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ internalType: "uint256", name: "tokenId", type: "uint256" }], name: "rescueNft", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ internalType: "bool", name: "value", type: "bool" }], name: "setPaused", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [], name: "revokeExecutor", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ components: policyVaultLpRequestComponents, internalType: "struct IPolicyVaultV4LpEntry.LpActionRequest", name: "request", type: "tuple" }], name: "unstakeLp", outputs: [], stateMutability: "payable", type: "function" },
  { inputs: [{ internalType: "uint256", name: "tokenId", type: "uint256" }, { internalType: "address", name: "stakeVault", type: "address" }], name: "unstakeLpOwner", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [{ components: policyVaultLpRequestComponents, internalType: "struct IPolicyVaultV4LpEntry.LpActionRequest", name: "request", type: "tuple" }], name: "zapOut", outputs: [{ internalType: "uint256", name: "amountOut", type: "uint256" }], stateMutability: "payable", type: "function" },
  { inputs: [{ components: policyVaultLpRequestComponents, internalType: "struct IPolicyVaultV4LpEntry.LpActionRequest", name: "request", type: "tuple" }], name: "decreaseLiquidity", outputs: [{ internalType: "uint256", name: "amount0", type: "uint256" }, { internalType: "uint256", name: "amount1", type: "uint256" }], stateMutability: "payable", type: "function" },
  { inputs: [{ components: policyVaultLpRequestComponents, internalType: "struct IPolicyVaultV4LpEntry.LpActionRequest", name: "request", type: "tuple" }], name: "collectFees", outputs: [{ internalType: "uint256", name: "amount0", type: "uint256" }, { internalType: "uint256", name: "amount1", type: "uint256" }], stateMutability: "payable", type: "function" },
  { inputs: [{ components: policyVaultLpRequestComponents, internalType: "struct IPolicyVaultV4LpEntry.LpActionRequest", name: "request", type: "tuple" }], name: "burnLp", outputs: [{ internalType: "uint256", name: "amount0", type: "uint256" }, { internalType: "uint256", name: "amount1", type: "uint256" }], stateMutability: "payable", type: "function" },
  { inputs: [{ components: policyVaultLpRequestComponents, internalType: "struct IPolicyVaultV4LpEntry.LpActionRequest", name: "request", type: "tuple" }], name: "sweepToken", outputs: [{ internalType: "uint256", name: "amountOut", type: "uint256" }], stateMutability: "payable", type: "function" },
  { inputs: [{ components: policyVaultLpRequestComponents, internalType: "struct IPolicyVaultV4LpEntry.LpActionRequest", name: "request", type: "tuple" }], name: "claimRewards", outputs: [], stateMutability: "payable", type: "function" },
  { inputs: [{ components: policyVaultLpRequestComponents, internalType: "struct IPolicyVaultV4LpEntry.LpActionRequest", name: "request", type: "tuple" }], name: "vaultActionHashForLp", outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }], stateMutability: "view", type: "function" },
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
  { inputs: [{ internalType: "bytes32", name: "poolId", type: "bytes32" }], name: "poolAddressOf", outputs: [{ internalType: "address", name: "", type: "address" }], stateMutability: "pure", type: "function" },
  { anonymous: false, inputs: [{ indexed: true, internalType: "address", name: "token", type: "address" }], name: "SweepTokenAllowed", type: "event" },
  { anonymous: false, inputs: [{ indexed: true, internalType: "bytes32", name: "poolId", type: "bytes32" }], name: "SweepPoolAllowed", type: "event" },
] as const;

export function ensureV4BytecodeReady(bytecode: Hex, label: string): Hex {
  if (bytecode === "0x") {
    throw new Error(`${label} bytecode is missing. Run npx hardhat compile and update lib/contracts/policy-vault-v4.ts from artifacts before using createVaultV4.`);
  }
  return bytecode;
}

function readAddress(value: string | undefined): Address | null {
  return value !== undefined && isAddress(value) ? value : null;
}

function readBigIntEnv(value: string | undefined, fallback: bigint): bigint {
  const normalized = value?.trim();
  if (!normalized || !/^\d+$/u.test(normalized)) {
    return fallback;
  }
  return BigInt(normalized);
}
