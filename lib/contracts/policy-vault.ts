import { isAddress, isHex, parseAbiItem, parseEther, type Address, type Hex } from "viem";
import { curatedMainnetRouteIds, uniqueCuratedMainnetTokens } from "@/lib/contracts/curated-routes";
import type { OgNetworkConfig, OgNetworkId } from "@/lib/types";

export const UNBOUNDED_POLICY_LIMIT = (1n << 256n) - 1n;

export interface PolicyVaultPolicy {
  cooldownSeconds: bigint;
  dailyCap0G: bigint;
  defaultMinOutBps: number;
  maxDeadlineWindowSeconds: bigint;
  maxExposure0G: bigint;
  perTradeCap0G: bigint;
}

export interface PolicyVaultFactoryVersion {
  address: Address;
  fromBlock: bigint;
  version: number;
}

// Public, non-secret deployment defaults for the live 0G mainnet vault stack.
// Environment variables still override these values for future deployments.
const MAINNET_POLICY_VAULT_FACTORY_V2_ADDRESS = "0xc9CA07dc92eEf55aFB4d83BBffb9E8EFc5c0036f";
const MAINNET_POLICY_VAULT_FACTORY_V2_FROM_BLOCK = "37476922";

export const defaultPolicyVaultPolicy: PolicyVaultPolicy = {
  cooldownSeconds: 0n,
  dailyCap0G: UNBOUNDED_POLICY_LIMIT,
  defaultMinOutBps: 9_925,
  maxDeadlineWindowSeconds: 30n * 60n,
  maxExposure0G: UNBOUNDED_POLICY_LIMIT,
  perTradeCap0G: UNBOUNDED_POLICY_LIMIT,
} as const;

export const defaultMainnetPolicyVaultPolicy: PolicyVaultPolicy = {
  cooldownSeconds: readBigIntEnv(process.env.NEXT_PUBLIC_POLICY_VAULT_MAINNET_COOLDOWN_SECONDS, 0n),
  dailyCap0G: read0GAmountEnv(process.env.NEXT_PUBLIC_POLICY_VAULT_MAINNET_DAILY_CAP_0G, "25"),
  defaultMinOutBps: readBpsEnv(process.env.NEXT_PUBLIC_POLICY_VAULT_MAINNET_DEFAULT_MIN_OUT_BPS, 9_950),
  maxDeadlineWindowSeconds: readBigIntEnv(process.env.NEXT_PUBLIC_POLICY_VAULT_MAINNET_MAX_DEADLINE_WINDOW_SECONDS, 15n * 60n),
  maxExposure0G: read0GAmountEnv(process.env.NEXT_PUBLIC_POLICY_VAULT_MAINNET_MAX_EXPOSURE_0G, "25"),
  perTradeCap0G: read0GAmountEnv(process.env.NEXT_PUBLIC_POLICY_VAULT_MAINNET_PER_TRADE_CAP_0G, "5"),
} as const;

export const policyVaultAbi = [
  {
    inputs: [],
    name: "depositNative",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "amount", type: "uint256" }],
    name: "withdrawNative",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "bool", name: "value", type: "bool" }],
    name: "setPaused",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "revokeExecutor",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "adapter",
    outputs: [{ internalType: "contract IPolicyVaultAdapter", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "paused",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "executorRevoked",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "proofRegistry",
    outputs: [{ internalType: "contract IProofRegistry", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "mockAdapterAllowed",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "owner",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "executor",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "policy",
    outputs: [
      { internalType: "uint256", name: "perTradeCap0G", type: "uint256" },
      { internalType: "uint256", name: "dailyCap0G", type: "uint256" },
      { internalType: "uint256", name: "maxExposure0G", type: "uint256" },
      { internalType: "uint256", name: "cooldownSeconds", type: "uint256" },
      { internalType: "uint256", name: "maxDeadlineWindowSeconds", type: "uint256" },
      { internalType: "uint16", name: "defaultMinOutBps", type: "uint16" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "policyHash",
    outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "dailySpent0G",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "dailyWindowStart",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "lastTradeAt",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "openExposure0G",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "token", type: "address" }],
    name: "positionUnits",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "token", type: "address" }],
    name: "allowedTokens",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "bytes32", name: "poolId", type: "bytes32" }],
    name: "allowedPools",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
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
      { internalType: "bool", name: "isBuy", type: "bool" },
      {
        components: [
          { internalType: "address", name: "tokenIn", type: "address" },
          { internalType: "address", name: "tokenOut", type: "address" },
          { internalType: "uint256", name: "amountIn", type: "uint256" },
          { internalType: "uint256", name: "quotedAmountOut", type: "uint256" },
          { internalType: "uint256", name: "amountOutMin", type: "uint256" },
          { internalType: "uint256", name: "deadline", type: "uint256" },
          { internalType: "uint256", name: "nonce", type: "uint256" },
          { internalType: "bytes32", name: "poolId", type: "bytes32" },
          { internalType: "bytes32", name: "vaultActionHash", type: "bytes32" },
          { internalType: "bytes32", name: "actionHash", type: "bytes32" },
          { internalType: "bytes32", name: "policySnapshotHash", type: "bytes32" },
          { internalType: "bytes32", name: "auditRoot", type: "bytes32" },
        ],
        internalType: "struct PolicyVault.TradeRequest",
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
        components: [
          { internalType: "address", name: "tokenIn", type: "address" },
          { internalType: "address", name: "tokenOut", type: "address" },
          { internalType: "uint256", name: "amountIn", type: "uint256" },
          { internalType: "uint256", name: "quotedAmountOut", type: "uint256" },
          { internalType: "uint256", name: "amountOutMin", type: "uint256" },
          { internalType: "uint256", name: "deadline", type: "uint256" },
          { internalType: "uint256", name: "nonce", type: "uint256" },
          { internalType: "bytes32", name: "poolId", type: "bytes32" },
          { internalType: "bytes32", name: "vaultActionHash", type: "bytes32" },
          { internalType: "bytes32", name: "actionHash", type: "bytes32" },
          { internalType: "bytes32", name: "policySnapshotHash", type: "bytes32" },
          { internalType: "bytes32", name: "auditRoot", type: "bytes32" },
        ],
        internalType: "struct PolicyVault.TradeRequest",
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
        components: [
          { internalType: "address", name: "tokenIn", type: "address" },
          { internalType: "address", name: "tokenOut", type: "address" },
          { internalType: "uint256", name: "amountIn", type: "uint256" },
          { internalType: "uint256", name: "quotedAmountOut", type: "uint256" },
          { internalType: "uint256", name: "amountOutMin", type: "uint256" },
          { internalType: "uint256", name: "deadline", type: "uint256" },
          { internalType: "uint256", name: "nonce", type: "uint256" },
          { internalType: "bytes32", name: "poolId", type: "bytes32" },
          { internalType: "bytes32", name: "vaultActionHash", type: "bytes32" },
          { internalType: "bytes32", name: "actionHash", type: "bytes32" },
          { internalType: "bytes32", name: "policySnapshotHash", type: "bytes32" },
          { internalType: "bytes32", name: "auditRoot", type: "bytes32" },
        ],
        internalType: "struct PolicyVault.TradeRequest",
        name: "request",
        type: "tuple",
      },
    ],
    name: "sell",
    outputs: [{ internalType: "uint256", name: "amountOut", type: "uint256" }],
    stateMutability: "payable",
    type: "function",
  },
] as const;

export const policyVaultFactoryAbi = [
  {
    inputs: [{ internalType: "address", name: "owner", type: "address" }],
    name: "vaultOf",
    outputs: [{ internalType: "address", name: "vault", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "owner", type: "address" },
      { indexed: true, internalType: "address", name: "executor", type: "address" },
      { indexed: true, internalType: "address", name: "vault", type: "address" },
      { indexed: false, internalType: "address", name: "adapter", type: "address" },
      { indexed: false, internalType: "address", name: "proofRegistry", type: "address" },
      { indexed: false, internalType: "bool", name: "mockAdapterAllowed", type: "bool" },
    ],
    name: "VaultCreated",
    type: "event",
  },
  {
    inputs: [
      { internalType: "address", name: "owner", type: "address" },
      { internalType: "address", name: "executor", type: "address" },
      { internalType: "address", name: "adapter", type: "address" },
      { internalType: "address", name: "proofRegistry", type: "address" },
      {
        components: [
          { internalType: "uint256", name: "perTradeCap0G", type: "uint256" },
          { internalType: "uint256", name: "dailyCap0G", type: "uint256" },
          { internalType: "uint256", name: "maxExposure0G", type: "uint256" },
          { internalType: "uint256", name: "cooldownSeconds", type: "uint256" },
          { internalType: "uint256", name: "maxDeadlineWindowSeconds", type: "uint256" },
          { internalType: "uint16", name: "defaultMinOutBps", type: "uint16" },
        ],
        internalType: "struct PolicyVault.Policy",
        name: "policy",
        type: "tuple",
      },
      { internalType: "address[]", name: "allowedTokens", type: "address[]" },
      { internalType: "bytes32[]", name: "allowedPools", type: "bytes32[]" },
      { internalType: "bool", name: "allowMockAdapter", type: "bool" },
    ],
    name: "createVault",
    outputs: [{ internalType: "address", name: "vault", type: "address" }],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

export const policyVaultAgentKeyAbi = [
  {
    inputs: [{ internalType: "bytes32", name: "agentKey", type: "bytes32" }],
    name: "agentKeyEnabled",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
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
  {
    inputs: [{ internalType: "bytes32", name: "agentKey", type: "bytes32" }],
    name: "agentOpenPositionCount",
    outputs: [{ internalType: "uint256", name: "count", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
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
] as const;

const policyVaultV2TradeRequestComponents = [
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

export const policyVaultV2TradeAbi = [
  {
    inputs: [
      { internalType: "bool", name: "isBuy", type: "bool" },
      {
        components: policyVaultV2TradeRequestComponents,
        internalType: "struct PolicyVaultV2.TradeRequest",
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
        components: policyVaultV2TradeRequestComponents,
        internalType: "struct PolicyVaultV2.TradeRequest",
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
        components: policyVaultV2TradeRequestComponents,
        internalType: "struct PolicyVaultV2.TradeRequest",
        name: "request",
        type: "tuple",
      },
    ],
    name: "sell",
    outputs: [{ internalType: "uint256", name: "amountOut", type: "uint256" }],
    stateMutability: "payable",
    type: "function",
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
] as const;

export const policyVaultCreatedEvent = parseAbiItem(
  "event VaultCreated(address indexed owner, address indexed executor, address indexed vault, address adapter, address proofRegistry, bool mockAdapterAllowed)",
);

export interface PolicyVaultCreationConfig {
  allowMockAdapter: boolean;
  adapter: Address;
  allowedPools: Hex[];
  allowedTokens: Address[];
  executor: Address;
  factory: Address;
  factoryVersion: number;
  policy: PolicyVaultPolicy;
  proofRegistry: Address;
}

export interface PolicyVaultReadiness {
  isReady: boolean;
  missing: string[];
  reason: string;
}

export function getPolicyVaultAddress(networkId: OgNetworkId): Address | null {
  const value =
    networkId === "mainnet"
      ? process.env.NEXT_PUBLIC_POLICY_VAULT_MAINNET_ADDRESS
      : process.env.NEXT_PUBLIC_POLICY_VAULT_ADDRESS;

  return value !== undefined && isAddress(value) ? value : null;
}

export function getPolicyVaultFactoryAddress(networkId: OgNetworkId): Address | null {
  return getLatestPolicyVaultFactoryVersion(networkId)?.address ?? null;
}

export function getPolicyVaultFactoryVersions(networkId: OgNetworkId): PolicyVaultFactoryVersion[] {
  const versions = [
    readFactoryVersion(networkId, 1),
    readFactoryVersion(networkId, 2),
  ].filter((version): version is PolicyVaultFactoryVersion => version !== null);
  return versions.sort((left, right) => left.version - right.version);
}

export function getLatestPolicyVaultFactoryVersion(networkId: OgNetworkId): PolicyVaultFactoryVersion | null {
  return getPolicyVaultFactoryVersions(networkId).at(-1) ?? null;
}

export function getProofRegistryAddress(networkId: OgNetworkId): Address | null {
  const value =
    networkId === "mainnet"
      ? process.env.NEXT_PUBLIC_PROOF_REGISTRY_MAINNET_ADDRESS
      : process.env.NEXT_PUBLIC_PROOF_REGISTRY_ADDRESS;

  return value !== undefined && isAddress(value) ? value : null;
}

export function getPolicyVaultCreationConfig(networkId: OgNetworkId): PolicyVaultCreationConfig | null {
  const factoryVersion = getLatestPolicyVaultFactoryVersion(networkId);
  const factory = factoryVersion?.address ?? null;
  const proofRegistry = getProofRegistryAddress(networkId);
  const executor =
    networkId === "mainnet"
      ? readAddress(process.env.NEXT_PUBLIC_VAULT_EXECUTOR_MAINNET_ADDRESS)
      : readAddress(process.env.NEXT_PUBLIC_VAULT_EXECUTOR_ADDRESS);
  const adapter =
    networkId === "mainnet"
      ? readAddress(process.env.NEXT_PUBLIC_POLICY_VAULT_ADAPTER_MAINNET_ADDRESS)
      : readAddress(process.env.NEXT_PUBLIC_POLICY_VAULT_ADAPTER_ADDRESS);
  const allowedTokens =
    networkId === "mainnet"
      ? uniqueCuratedMainnetTokens()
      : compactAddressList([readAddress(process.env.NEXT_PUBLIC_POLICY_VAULT_ALLOWED_TOKEN_ADDRESS)]);
  const allowedPools =
    networkId === "mainnet"
      ? curatedMainnetRouteIds()
      : compactHexList([readHex32(process.env.NEXT_PUBLIC_POLICY_VAULT_ALLOWED_POOL_ID)]);

  if (
    factoryVersion === null ||
    factory === null ||
    proofRegistry === null ||
    executor === null ||
    adapter === null ||
    allowedTokens.length === 0 ||
    allowedPools.length === 0
  ) {
    return null;
  }

  return {
    allowMockAdapter: networkId !== "mainnet",
    adapter,
    allowedPools,
    allowedTokens,
    executor,
    factory,
    factoryVersion: factoryVersion.version,
    policy: getPolicyVaultPolicy(networkId),
    proofRegistry,
  };
}

export function getPolicyVaultReadiness(networkId: OgNetworkId): PolicyVaultReadiness {
  const missing: string[] = [];
  const latestFactoryVersion = getLatestPolicyVaultFactoryVersion(networkId);
  if (latestFactoryVersion === null) {
    missing.push(networkId === "mainnet" ? "NEXT_PUBLIC_POLICY_VAULT_FACTORY_MAINNET_ADDRESS" : "NEXT_PUBLIC_POLICY_VAULT_FACTORY_ADDRESS");
  }
  if (getProofRegistryAddress(networkId) === null) {
    missing.push(networkId === "mainnet" ? "NEXT_PUBLIC_PROOF_REGISTRY_MAINNET_ADDRESS" : "NEXT_PUBLIC_PROOF_REGISTRY_ADDRESS");
  }
  if (
    readAddress(
      networkId === "mainnet"
        ? process.env.NEXT_PUBLIC_VAULT_EXECUTOR_MAINNET_ADDRESS
        : process.env.NEXT_PUBLIC_VAULT_EXECUTOR_ADDRESS,
    ) === null
  ) {
    missing.push(networkId === "mainnet" ? "NEXT_PUBLIC_VAULT_EXECUTOR_MAINNET_ADDRESS" : "NEXT_PUBLIC_VAULT_EXECUTOR_ADDRESS");
  }
  if (
    readAddress(
      networkId === "mainnet"
        ? process.env.NEXT_PUBLIC_POLICY_VAULT_ADAPTER_MAINNET_ADDRESS
        : process.env.NEXT_PUBLIC_POLICY_VAULT_ADAPTER_ADDRESS,
    ) === null
  ) {
    missing.push(networkId === "mainnet" ? "NEXT_PUBLIC_POLICY_VAULT_ADAPTER_MAINNET_ADDRESS" : "NEXT_PUBLIC_POLICY_VAULT_ADAPTER_ADDRESS");
  }
  if (networkId !== "mainnet" && readAddress(process.env.NEXT_PUBLIC_POLICY_VAULT_ALLOWED_TOKEN_ADDRESS) === null) {
    missing.push("NEXT_PUBLIC_POLICY_VAULT_ALLOWED_TOKEN_ADDRESS");
  }
  if (networkId !== "mainnet" && readHex32(process.env.NEXT_PUBLIC_POLICY_VAULT_ALLOWED_POOL_ID) === null) {
    missing.push("NEXT_PUBLIC_POLICY_VAULT_ALLOWED_POOL_ID");
  }
  if (networkId === "mainnet" && latestFactoryVersion !== null && readFactoryFromBlockEnv(networkId, latestFactoryVersion.version) === null) {
    missing.push(
      latestFactoryVersion.version === 1
        ? "NEXT_PUBLIC_POLICY_VAULT_FACTORY_MAINNET_FROM_BLOCK"
        : `NEXT_PUBLIC_POLICY_VAULT_FACTORY_V${latestFactoryVersion.version}_MAINNET_FROM_BLOCK`,
    );
  }

  return {
    isReady: missing.length === 0,
    missing,
    reason:
      missing.length === 0
        ? "Policy Vault config is ready for this network."
        : `Policy Vault config is incomplete: ${missing.join(", ")}.`,
  };
}

export function getPolicyVaultFactoryFromBlock(networkId: OgNetworkId, version?: number): bigint {
  const parsed = readFactoryFromBlockEnv(networkId, version ?? getLatestPolicyVaultFactoryVersion(networkId)?.version ?? 1);
  return parsed ?? 0n;
}

function getPolicyVaultPolicy(networkId: OgNetworkId): PolicyVaultPolicy {
  return networkId === "mainnet" ? defaultMainnetPolicyVaultPolicy : defaultPolicyVaultPolicy;
}

function readFactoryVersion(networkId: OgNetworkId, version: number): PolicyVaultFactoryVersion | null {
  const address = readAddress(readFactoryAddressEnv(networkId, version));
  const fromBlock = readFactoryFromBlockEnv(networkId, version);
  if (address === null || fromBlock === null) {
    return null;
  }
  return { address, fromBlock, version };
}

function readFactoryAddressEnv(networkId: OgNetworkId, version: number): string | undefined {
  if (networkId === "mainnet") {
    switch (version) {
      case 1:
        return process.env.NEXT_PUBLIC_POLICY_VAULT_FACTORY_MAINNET_ADDRESS;
      case 2:
        return process.env.NEXT_PUBLIC_POLICY_VAULT_FACTORY_V2_MAINNET_ADDRESS ?? MAINNET_POLICY_VAULT_FACTORY_V2_ADDRESS;
      default:
        return undefined;
    }
  }
  switch (version) {
    case 1:
      return process.env.NEXT_PUBLIC_POLICY_VAULT_FACTORY_ADDRESS;
    case 2:
      return process.env.NEXT_PUBLIC_POLICY_VAULT_FACTORY_V2_ADDRESS;
    default:
      return undefined;
  }
}

function readFactoryFromBlockEnv(networkId: OgNetworkId, version: number): bigint | null {
  const value = readFactoryFromBlockValue(networkId, version)?.trim();
  if (value === undefined || value === "") {
    return null;
  }

  try {
    const parsed = BigInt(value);
    return parsed >= 0n ? parsed : null;
  } catch {
    return null;
  }
}

function readFactoryFromBlockValue(networkId: OgNetworkId, version: number): string | undefined {
  if (networkId === "mainnet") {
    switch (version) {
      case 1:
        return process.env.NEXT_PUBLIC_POLICY_VAULT_FACTORY_MAINNET_FROM_BLOCK;
      case 2:
        return process.env.NEXT_PUBLIC_POLICY_VAULT_FACTORY_V2_MAINNET_FROM_BLOCK ?? MAINNET_POLICY_VAULT_FACTORY_V2_FROM_BLOCK;
      default:
        return undefined;
    }
  }
  switch (version) {
    case 1:
      return process.env.NEXT_PUBLIC_POLICY_VAULT_FACTORY_FROM_BLOCK;
    case 2:
      return process.env.NEXT_PUBLIC_POLICY_VAULT_FACTORY_V2_FROM_BLOCK;
    default:
      return undefined;
  }
}

export function explorerAddressUrl(network: OgNetworkConfig, address: Address): string {
  return `${network.explorerUrl}/address/${address}`;
}

function readAddress(value: string | undefined): Address | null {
  return value !== undefined && isAddress(value) ? value : null;
}

function readHex32(value: string | undefined): Hex | null {
  return value !== undefined && isHex(value, { strict: true }) && value.length === 66 ? value : null;
}

function compactAddressList(values: Array<Address | null>): Address[] {
  return values.filter((value): value is Address => value !== null);
}

function compactHexList(values: Array<Hex | null>): Hex[] {
  return values.filter((value): value is Hex => value !== null);
}

function read0GAmountEnv(value: string | undefined, fallback: string): bigint {
  const normalized = value?.trim() || fallback;
  try {
    return parseEther(normalized);
  } catch {
    return parseEther(fallback);
  }
}

function readBigIntEnv(value: string | undefined, fallback: bigint): bigint {
  const normalized = value?.trim();
  if (!normalized || !/^\d+$/.test(normalized)) {
    return fallback;
  }
  return BigInt(normalized);
}

function readBpsEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 10_000 ? parsed : fallback;
}
