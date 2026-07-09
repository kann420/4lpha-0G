import type { Address, Hex } from "viem";

export const policyVaultSwapPolicyComponents = [
  { internalType: "uint256", name: "perTradeCap0G", type: "uint256" },
  { internalType: "uint256", name: "dailyCap0G", type: "uint256" },
  { internalType: "uint256", name: "maxExposure0G", type: "uint256" },
  { internalType: "uint256", name: "cooldownSeconds", type: "uint256" },
  { internalType: "uint256", name: "maxDeadlineWindowSeconds", type: "uint256" },
  { internalType: "uint16", name: "defaultMinOutBps", type: "uint16" },
] as const;

export const policyVaultLpPolicyComponents = [
  { internalType: "uint256", name: "perLpActionCap0G", type: "uint256" },
  { internalType: "uint256", name: "lpDailyCap0G", type: "uint256" },
  { internalType: "uint256", name: "maxLpExposure0G", type: "uint256" },
  { internalType: "uint256", name: "cooldownSecondsLp", type: "uint256" },
  { internalType: "uint16", name: "lpMinOutBps", type: "uint16" },
  { internalType: "uint256", name: "minLiquidityFloor", type: "uint256" },
  { internalType: "bool", name: "allowStaking", type: "bool" },
] as const;

export const policyVaultV3PolicyComponents = [
  ...policyVaultSwapPolicyComponents,
  {
    components: policyVaultLpPolicyComponents,
    internalType: "struct PolicyVaultV3.LpPolicy",
    name: "lp",
    type: "tuple",
  },
] as const;

export const policyVaultTradeRequestComponents = [
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

export const policyVaultLpRequestComponents = [
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

export interface PolicyVaultV4SwapPolicy {
  perTradeCap0G: bigint;
  dailyCap0G: bigint;
  maxExposure0G: bigint;
  cooldownSeconds: bigint;
  maxDeadlineWindowSeconds: bigint;
  defaultMinOutBps: number;
}

export interface PolicyVaultV4LpPolicy {
  perLpActionCap0G: bigint;
  lpDailyCap0G: bigint;
  maxLpExposure0G: bigint;
  cooldownSecondsLp: bigint;
  lpMinOutBps: number;
  minLiquidityFloor: bigint;
  allowStaking: boolean;
}

export interface PolicyVaultV3Policy extends PolicyVaultV4SwapPolicy {
  lp: PolicyVaultV4LpPolicy;
}

export interface PolicyVaultTradeRequest {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  quotedAmountOut: bigint;
  amountOutMin: bigint;
  deadline: bigint;
  nonce: bigint;
  agentKey: Hex;
  poolId: Hex;
  vaultActionHash: Hex;
  actionHash: Hex;
  policySnapshotHash: Hex;
  auditRoot: Hex;
}

export interface PolicyVaultLpActionRequest {
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
