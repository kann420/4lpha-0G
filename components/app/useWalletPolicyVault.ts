"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  decodeEventLog,
  http,
  type Address,
  type Chain,
  type EIP1193Provider,
  type Hex,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import { useAccount, useChainId, useSignMessage, useSwitchChain } from "wagmi";
import {
  getPolicyVaultCreationConfig,
  getPolicyVaultFactoryAddress,
  getPolicyVaultFactoryFromBlock,
  getPolicyVaultFactoryVersions,
  getPolicyVaultReadiness,
  policyVaultAbi,
  policyVaultCreatedEvent,
  policyVaultFactoryAbi,
  type PolicyVaultFactoryVersion,
  type PolicyVaultPolicy,
} from "@/lib/contracts/policy-vault";
import { buildCopilotWalletAccessMessage } from "@/lib/copilot/wallet-access";
import type { OgNetworkConfig } from "@/lib/types";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export interface VersionedVault {
  factory: Address;
  vault: Address;
  version: number;
}

export interface WalletPolicyVaultState {
  createVault: (policyOverride?: PolicyVaultPolicy) => Promise<void>;
  factoryAddress: Address | null;
  activeVaultVersion?: number;
  isCreating: boolean;
  isDiscovering: boolean;
  isMigratingToV3: boolean;
  legacyVaults: VersionedVault[];
  migrateVault: () => Promise<void>;
  migrateVaultToV3: () => Promise<void>;
  migrationRequired: boolean;
  refreshVaultAddress: () => Promise<void>;
  statusText: string;
  vaultAddress: Address | null;
  vaults: Address[];
  v3MigrationAvailable: boolean;
  v3VaultAddress: Address | null;
  versionedVaults: VersionedVault[];
}

const erc20BalanceAbi = [
  {
    inputs: [{ internalType: "address", name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export function useWalletPolicyVault(network: OgNetworkConfig): WalletPolicyVaultState {
  const walletAccount = useAccount();
  const connectedChainId = useChainId();
  const switchChain = useSwitchChain();
  const [vaultAddress, setVaultAddress] = useState<Address | null>(null);
  const [vaults, setVaults] = useState<Address[]>([]);
  const [versionedVaults, setVersionedVaults] = useState<VersionedVault[]>([]);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [isMigratingToV3, setIsMigratingToV3] = useState(false);
  const [statusText, setStatusText] = useState("Connect a wallet to resolve its Policy Vault.");
  // V3 singleton (mainnet-only, deployer-owned, resolved from the off-chain registry
  // via /api/vault/v3-status). When present it supersedes the latest V2 factory vault
  // as the active vault, and the v2 -> v3 migrate panel becomes available.
  const [v3VaultAddress, setV3VaultAddress] = useState<Address | null>(null);
  const [legacyV2Balance, setLegacyV2Balance] = useState<bigint>(0n);
  const signMessage = useSignMessage();
  const requestIdRef = useRef(0);
  const factoryAddress = getPolicyVaultFactoryAddress(network.id);
  const factoryVersions = useMemo(() => getPolicyVaultFactoryVersions(network.id), [network.id]);
  const creationConfig = getPolicyVaultCreationConfig(network.id);
  const readiness = getPolicyVaultReadiness(network.id);
  const chain = useMemo(() => makeViemChain(network), [network]);
  const publicClient = useMemo(
    () => createPublicClient({ chain, transport: http(network.rpcUrl) }),
    [chain, network.rpcUrl],
  );

  const discoverVaults = useCallback(async () => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    if (!walletAccount.address) {
      setVaultAddress(null);
      setVaults([]);
      setVersionedVaults([]);
      setV3VaultAddress(null);
      setLegacyV2Balance(0n);
      setStatusText("Connect a wallet to resolve its Policy Vault.");
      return;
    }

    if (factoryAddress === null) {
      setVaultAddress(null);
      setVaults([]);
      setVersionedVaults([]);
      setV3VaultAddress(null);
      setLegacyV2Balance(0n);
      setStatusText("PolicyVaultFactory is not configured for this network.");
      return;
    }

    setIsDiscovering(true);
    setStatusText("Scanning factory events for this wallet.");

    try {
      const verified = await readVerifiedVaultVersions({
        factoryVersions,
        networkId: network.id,
        owner: walletAccount.address,
        publicClient,
      });

      if (requestIdRef.current !== requestId) {
        return;
      }

      const active = verified.at(-1);
      setVersionedVaults(verified);
      setVaults(verified.map((entry) => entry.vault));
      setVaultAddress(active?.vault ?? null);
      setStatusText(
        verified.length > 0
          ? `Resolved active Policy Vault V${active?.version ?? "?"} for this wallet.`
          : "No Policy Vault found for this wallet yet.",
      );

      // Mainnet-only: resolve the V3 singleton from the off-chain registry. When a
      // V3 exists for this owner it becomes the active vault (V2 factory vaults are
      // treated as legacy). The v2 -> v3 migrate panel is gated on the legacy V2
      // still holding native 0G, so we read its balance here.
      if (network.id === "mainnet" && walletAccount.address && requestIdRef.current === requestId) {
        try {
          const v3Response = await fetch(
            `/api/vault/v3-status?ownerAddress=${walletAccount.address}`,
          );
          if (v3Response.ok) {
            const payload = (await v3Response.json()) as { data?: { v3VaultAddress?: Address | null } };
            const v3 = (payload.data?.v3VaultAddress ?? null) as Address | null;
            setV3VaultAddress(v3);
            if (v3) {
              setVaultAddress(v3);
              const legacy = verified.at(-1);
              if (legacy) {
                const balance = await publicClient.getBalance({ address: legacy.vault });
                if (requestIdRef.current === requestId) {
                  setLegacyV2Balance(balance);
                }
              } else {
                setLegacyV2Balance(0n);
              }
            } else {
              setLegacyV2Balance(0n);
            }
          }
        } catch {
          // V3 registry lookup is best-effort; the V2 path stays usable.
        }
      }
    } catch {
      if (requestIdRef.current === requestId) {
        setVaultAddress(null);
        setVaults([]);
        setVersionedVaults([]);
        setV3VaultAddress(null);
        setLegacyV2Balance(0n);
        setStatusText("Could not scan PolicyVaultFactory logs from this RPC.");
      }
    } finally {
      if (requestIdRef.current === requestId) {
        setIsDiscovering(false);
      }
    }
  }, [factoryAddress, factoryVersions, network.id, publicClient, walletAccount.address]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void discoverVaults();
    }, 0);

    return () => window.clearTimeout(timer);
  }, [discoverVaults]);

  const createVault = useCallback(async (policyOverride?: PolicyVaultPolicy) => {
    if (!walletAccount.isConnected || !walletAccount.address) {
      setStatusText("Connect the owner wallet before creating a vault.");
      return;
    }

    if (creationConfig === null) {
      setStatusText(readiness.reason);
      return;
    }

    if (vaultAddress !== null) {
      setStatusText("This wallet already has a Policy Vault. Use Discover vault instead of creating another one.");
      return;
    }

    setIsCreating(true);
    setStatusText("Checking whether this wallet already has a Policy Vault.");

    try {
      const existingVaults = await readVerifiedVaults({
        factoryAddress: creationConfig.factory,
        networkId: network.id,
        owner: walletAccount.address,
        publicClient,
      });
      if (existingVaults.length > 0) {
        setVaults(existingVaults);
        setVaultAddress(existingVaults.at(-1) ?? null);
        setStatusText("This wallet already has a Policy Vault. Funding controls are using the existing vault.");
        return;
      }

      setStatusText("Waiting for wallet confirmation to create your Policy Vault.");

      if (connectedChainId !== network.chainId) {
        setStatusText(`Switching wallet to ${network.networkName}.`);
        await switchChain.switchChainAsync({ chainId: network.chainId });
      }

      const walletClient = await getWalletClient(chain);
      const [account] = await walletClient.getAddresses();
      if (account.toLowerCase() !== walletAccount.address.toLowerCase()) {
        throw new Error("Wallet account changed before vault creation.");
      }

      const simulation = await publicClient.simulateContract({
        account,
        address: creationConfig.factory,
        abi: policyVaultFactoryAbi,
        functionName: "createVault",
        args: [
          account,
          creationConfig.executor,
          creationConfig.adapter,
          creationConfig.proofRegistry,
          policyOverride ?? creationConfig.policy,
          creationConfig.allowedTokens,
          creationConfig.allowedPools,
          creationConfig.allowMockAdapter,
        ],
      });
      const txHash = await walletClient.writeContract(simulation.request);
      setStatusText("Vault creation submitted. Waiting for factory event.");
      const receipt = await waitForReceipt(publicClient, txHash);
      const createdVault = receipt === null ? null : readCreatedVaultFromReceipt(receipt, account);

      if (createdVault !== null) {
        await verifyVaultOwner(publicClient, createdVault, account);
        setVaultAddress(createdVault);
        setVaults((current) => dedupeAddresses([...current, createdVault]));
        setStatusText("Policy Vault created for this wallet.");
      } else {
        await discoverVaults();
        setStatusText("Vault creation submitted. Factory logs were refreshed from RPC.");
      }
    } catch (error) {
      setStatusText(error instanceof Error ? sanitizeWalletError(error.message) : "Vault creation failed.");
    } finally {
      setIsCreating(false);
    }
  }, [
    chain,
    connectedChainId,
    creationConfig,
    discoverVaults,
    network.chainId,
    network.id,
    network.networkName,
    publicClient,
    readiness.reason,
    switchChain,
    vaultAddress,
    vaults.length,
    walletAccount.address,
    walletAccount.isConnected,
  ]);

  const migrateVault = useCallback(async () => {
    if (!walletAccount.isConnected || !walletAccount.address) {
      setStatusText("Connect the owner wallet before migrating a vault.");
      return;
    }
    if (creationConfig === null) {
      setStatusText(readiness.reason);
      return;
    }
    const latestFactoryVersion = factoryVersions.at(-1)?.version;
    const legacy = latestFactoryVersion === undefined
      ? undefined
      : versionedVaults.filter((entry) => entry.version < latestFactoryVersion).at(-1);
    if (!legacy) {
      setStatusText("No legacy vault is available for migration.");
      return;
    }

    setIsCreating(true);
    try {
      if (connectedChainId !== network.chainId) {
        setStatusText(`Switching wallet to ${network.networkName}.`);
        await switchChain.switchChainAsync({ chainId: network.chainId });
      }
      const walletClient = await getWalletClient(chain);
      const [account] = await walletClient.getAddresses();
      if (account.toLowerCase() !== walletAccount.address.toLowerCase()) {
        throw new Error("Wallet account changed before vault migration.");
      }

      setStatusText("Checking legacy vault token positions before migration.");
      await assertLegacyVaultIsNativeOnly(publicClient, legacy.vault, account, creationConfig.allowedTokens);

      setStatusText("Waiting for wallet confirmation to create PolicyVaultV2.");
      const createSimulation = await publicClient.simulateContract({
        account,
        address: creationConfig.factory,
        abi: policyVaultFactoryAbi,
        functionName: "createVault",
        args: [
          account,
          creationConfig.executor,
          creationConfig.adapter,
          creationConfig.proofRegistry,
          creationConfig.policy,
          creationConfig.allowedTokens,
          creationConfig.allowedPools,
          creationConfig.allowMockAdapter,
        ],
      });
      const createTxHash = await walletClient.writeContract(createSimulation.request);
      const createReceipt = await waitForReceipt(publicClient, createTxHash);
      const createdVault = createReceipt === null ? null : readCreatedVaultFromReceipt(createReceipt, account);
      if (!createdVault) {
        throw new Error("PolicyVaultV2 creation did not emit a vault address.");
      }
      await verifyVaultOwner(publicClient, createdVault, account);

      const legacyBalance = await publicClient.getBalance({ address: legacy.vault });
      if (legacyBalance > 0n) {
        setStatusText("Withdrawing native 0G from legacy vault to owner wallet.");
        const withdrawSimulation = await publicClient.simulateContract({
          account,
          address: legacy.vault,
          abi: policyVaultAbi,
          functionName: "withdrawNative",
          args: [legacyBalance],
        });
        const withdrawTxHash = await walletClient.writeContract(withdrawSimulation.request);
        await waitForReceipt(publicClient, withdrawTxHash);

        setStatusText("Depositing migrated 0G into PolicyVaultV2.");
        const depositSimulation = await publicClient.simulateContract({
          account,
          address: createdVault,
          abi: policyVaultAbi,
          functionName: "depositNative",
          value: legacyBalance,
        });
        const depositTxHash = await walletClient.writeContract(depositSimulation.request);
        await waitForReceipt(publicClient, depositTxHash);
      }

      setStatusText("Pausing and revoking the legacy vault executor.");
      await writeBestEffortOwnerTx({ account, address: legacy.vault, functionName: "setPaused", publicClient, walletClient, args: [true] });
      await writeBestEffortOwnerTx({ account, address: legacy.vault, functionName: "revokeExecutor", publicClient, walletClient, args: [] });

      await discoverVaults();
      setStatusText("Vault migration to PolicyVaultV2 completed.");
    } catch (error) {
      setStatusText(error instanceof Error ? sanitizeWalletError(error.message) : "Vault migration failed.");
    } finally {
      setIsCreating(false);
    }
  }, [
    chain,
    connectedChainId,
    creationConfig,
    discoverVaults,
    factoryVersions,
    network.chainId,
    network.networkName,
    publicClient,
    readiness.reason,
    switchChain,
    versionedVaults,
    walletAccount.address,
    walletAccount.isConnected,
  ]);

  const migrateVaultToV3 = useCallback(async () => {
    if (!walletAccount.isConnected || !walletAccount.address) {
      setStatusText("Connect the owner wallet before migrating to V3.");
      return;
    }
    if (!v3VaultAddress) {
      setStatusText("No V3 Policy Vault is registered for this wallet.");
      return;
    }
    if (creationConfig === null) {
      setStatusText(readiness.reason);
      return;
    }
    const legacy = versionedVaults.at(-1);
    if (!legacy) {
      setStatusText("No legacy V2 vault is available for migration.");
      return;
    }

    setIsMigratingToV3(true);
    try {
      if (connectedChainId !== network.chainId) {
        setStatusText(`Switching wallet to ${network.networkName}.`);
        await switchChain.switchChainAsync({ chainId: network.chainId });
      }
      const walletClient = await getWalletClient(chain);
      const [account] = await walletClient.getAddresses();
      if (account.toLowerCase() !== walletAccount.address.toLowerCase()) {
        throw new Error("Wallet account changed before V3 vault migration.");
      }

      // V3 is deployer-owned; the connected wallet must be that owner (demo path:
      // user == deployer). Reusing the V2 owner check (V3 exposes the same owner()).
      setStatusText("Verifying V3 vault ownership before migration.");
      await verifyVaultOwner(publicClient, v3VaultAddress, account);

      setStatusText("Checking legacy vault token positions before migration.");
      await assertLegacyVaultIsNativeOnly(publicClient, legacy.vault, account, creationConfig.allowedTokens);

      const legacyBalance = await publicClient.getBalance({ address: legacy.vault });
      if (legacyBalance > 0n) {
        setStatusText("Withdrawing native 0G from legacy vault to owner wallet.");
        const withdrawSimulation = await publicClient.simulateContract({
          account,
          address: legacy.vault,
          abi: policyVaultAbi,
          functionName: "withdrawNative",
          args: [legacyBalance],
        });
        const withdrawTxHash = await walletClient.writeContract(withdrawSimulation.request);
        await waitForReceipt(publicClient, withdrawTxHash);

        setStatusText("Depositing migrated 0G into the V3 Policy Vault.");
        const depositSimulation = await publicClient.simulateContract({
          account,
          address: v3VaultAddress,
          abi: policyVaultAbi,
          functionName: "depositNative",
          value: legacyBalance,
        });
        const depositTxHash = await walletClient.writeContract(depositSimulation.request);
        await waitForReceipt(publicClient, depositTxHash);
      }

      setStatusText("Pausing and revoking the legacy vault executor.");
      await writeBestEffortOwnerTx({
        account,
        address: legacy.vault,
        functionName: "setPaused",
        publicClient,
        walletClient,
        args: [true],
      });
      await writeBestEffortOwnerTx({
        account,
        address: legacy.vault,
        functionName: "revokeExecutor",
        publicClient,
        walletClient,
        args: [],
      });

      // Re-point the owner's agent records to V3 and re-enable each agent key on V3
      // (server-side, DEPLOYER pays gas). Funds movement is already complete, so a
      // failure here is non-fatal — the user can retry the agent re-point from /agents.
      setStatusText("Re-pointing agent records to the V3 vault.");
      try {
        const message = buildCopilotWalletAccessMessage({
          address: account,
          chainId: network.chainId,
          networkId: network.id,
        });
        const signature = await signMessage.signMessageAsync({ message });
        const response = await fetch("/api/agents/migrate-vault", {
          body: JSON.stringify({ wallet: { address: account, chainId: network.chainId, message, signature } }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        if (!response.ok) {
          const payload = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
          setStatusText(`Funds moved to V3. Agent re-point skipped: ${payload.error?.message ?? "unknown error"}.`);
        }
      } catch (error) {
        setStatusText(
          `Funds moved to V3. Agent re-point skipped: ${error instanceof Error ? error.message : "unknown error"}.`,
        );
      }

      await discoverVaults();
      setStatusText("Vault migration to PolicyVaultV3 completed.");
    } catch (error) {
      setStatusText(error instanceof Error ? sanitizeWalletError(error.message) : "V3 vault migration failed.");
    } finally {
      setIsMigratingToV3(false);
    }
  }, [
    chain,
    connectedChainId,
    creationConfig,
    discoverVaults,
    network.chainId,
    network.id,
    network.networkName,
    publicClient,
    readiness.reason,
    signMessage,
    switchChain,
    v3VaultAddress,
    versionedVaults,
    walletAccount.address,
    walletAccount.isConnected,
  ]);

  const activeVaultVersion = versionedVaults.at(-1)?.version;
  const latestFactoryVersion = factoryVersions.at(-1)?.version;

  return {
    activeVaultVersion,
    createVault,
    factoryAddress,
    isCreating,
    isDiscovering,
    isMigratingToV3,
    legacyVaults: latestFactoryVersion === undefined
      ? []
      : versionedVaults.filter((entry) => entry.version < latestFactoryVersion),
    migrateVault,
    migrateVaultToV3,
    // Suppress the v1 -> v2 factory panel once a V3 singleton exists; the v2 -> v3
    // panel takes over and creating a fresh V2 via factory would be a step backward.
    migrationRequired:
      v3VaultAddress === null &&
      versionedVaults.length > 0 &&
      latestFactoryVersion !== undefined &&
      (activeVaultVersion ?? 0) < latestFactoryVersion,
    refreshVaultAddress: discoverVaults,
    statusText,
    vaultAddress,
    vaults,
    v3MigrationAvailable: v3VaultAddress !== null && legacyV2Balance > 0n,
    v3VaultAddress,
    versionedVaults,
  };
}

async function readVerifiedVaultVersions({
  factoryVersions,
  networkId,
  owner,
  publicClient,
}: {
  factoryVersions: PolicyVaultFactoryVersion[];
  networkId: OgNetworkConfig["id"];
  owner: Address;
  publicClient: ReturnType<typeof createPublicClient>;
}): Promise<VersionedVault[]> {
  const results: VersionedVault[] = [];
  for (const factory of factoryVersions) {
    const verified = await readVerifiedVaults({
      factoryAddress: factory.address,
      fromBlock: factory.fromBlock,
      networkId,
      owner,
      publicClient,
    });
    for (const vault of verified) {
      results.push({ factory: factory.address, vault, version: factory.version });
    }
  }
  return results.sort((left, right) => left.version - right.version);
}

async function readVerifiedVaults({
  factoryAddress,
  fromBlock,
  networkId,
  owner,
  publicClient,
}: {
  factoryAddress: Address;
  fromBlock?: bigint;
  networkId: OgNetworkConfig["id"];
  owner: Address;
  publicClient: ReturnType<typeof createPublicClient>;
}): Promise<Address[]> {
  const candidates: Address[] = [];

  try {
    const mappedVault = await publicClient.readContract({
      address: factoryAddress,
      abi: policyVaultFactoryAbi,
      functionName: "vaultOf",
      args: [owner],
    });

    if (mappedVault !== ZERO_ADDRESS) {
      candidates.push(mappedVault);
    }
  } catch {
    // Older deployed factories do not expose vaultOf; event discovery remains the fallback.
  }

  const logs = await publicClient.getLogs({
    address: factoryAddress,
    args: { owner },
    event: policyVaultCreatedEvent,
    fromBlock: fromBlock ?? getPolicyVaultFactoryFromBlock(networkId),
    toBlock: "latest",
  });
  candidates.push(
    ...logs
      .map((log) => log.args.vault)
      .filter((value): value is Address => typeof value === "string"),
  );

  const verified: Address[] = [];
  for (const candidate of dedupeAddresses(candidates)) {
    try {
      const vaultOwner = await publicClient.readContract({
        address: candidate,
        abi: policyVaultAbi,
        functionName: "owner",
      });

      if (vaultOwner.toLowerCase() === owner.toLowerCase()) {
        verified.push(candidate);
      }
    } catch {
      // Ignore stale or non-vault logs; verified ownership is required before use.
    }
  }

  return verified;
}

function readCreatedVaultFromReceipt(receipt: TransactionReceipt, owner: Address): Address | null {
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi: policyVaultFactoryAbi,
        data: log.data,
        topics: log.topics,
      });

      if (decoded.eventName !== "VaultCreated") {
        continue;
      }

      const args = decoded.args;
      if (args.owner.toLowerCase() === owner.toLowerCase()) {
        return args.vault;
      }
    } catch {
      // Keep looking through unrelated logs in the transaction receipt.
    }
  }

  return null;
}

async function verifyVaultOwner(
  publicClient: ReturnType<typeof createPublicClient>,
  vault: Address,
  expectedOwner: Address,
) {
  const owner = await publicClient.readContract({
    address: vault,
    abi: policyVaultAbi,
    functionName: "owner",
  });

  if (owner.toLowerCase() !== expectedOwner.toLowerCase()) {
    throw new Error("Created vault owner did not match the connected wallet.");
  }
}

async function assertLegacyVaultIsNativeOnly(
  publicClient: ReturnType<typeof createPublicClient>,
  vault: Address,
  owner: Address,
  tokens: Address[],
) {
  for (const token of tokens) {
    const [positionUnits, tokenBalance] = await Promise.all([
      publicClient.readContract({
        address: vault,
        abi: policyVaultAbi,
        functionName: "positionUnits",
        args: [token],
      }).catch(() => 0n),
      publicClient.readContract({
        address: token,
        abi: erc20BalanceAbi,
        functionName: "balanceOf",
        args: [vault],
      }).catch(() => 0n),
    ]);
    if (positionUnits > 0n) {
      throw new Error("Legacy vault still has sellable token positions. Sell all positions before migration.");
    }
    if (tokenBalance > 0n) {
      throw new Error("Legacy vault still has token balance dust. Rescue or clear tokens before migration.");
    }
  }

  const vaultOwner = await publicClient.readContract({
    address: vault,
    abi: policyVaultAbi,
    functionName: "owner",
  });
  if (vaultOwner.toLowerCase() !== owner.toLowerCase()) {
    throw new Error("Legacy vault owner does not match the connected wallet.");
  }
}

async function writeBestEffortOwnerTx({
  account,
  address,
  args,
  functionName,
  publicClient,
  walletClient,
}: {
  account: Address;
  address: Address;
  args: readonly unknown[];
  functionName: "revokeExecutor" | "setPaused";
  publicClient: ReturnType<typeof createPublicClient>;
  walletClient: WalletClient;
}) {
  try {
    const txHash = await walletClient.writeContract({
      account,
      address,
      abi: policyVaultAbi,
      functionName,
      args,
    } as never);
    await waitForReceipt(publicClient, txHash);
  } catch {
    // Legacy cleanup is best-effort; the V2 vault remains the active vault after migration.
  }
}

async function waitForReceipt(
  publicClient: ReturnType<typeof createPublicClient>,
  hash: Hex,
): Promise<TransactionReceipt | null> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      return await publicClient.getTransactionReceipt({ hash });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("could not be found") && !message.includes("not be found")) {
        throw error;
      }
      await sleep(1_500);
    }
  }

  return null;
}

function dedupeAddresses(values: Address[]): Address[] {
  const seen = new Set<string>();
  const result: Address[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
  }
  return result;
}

function makeViemChain(network: OgNetworkConfig): Chain {
  return {
    id: network.chainId,
    name: network.networkName,
    nativeCurrency: {
      decimals: 18,
      name: "0G",
      symbol: "0G",
    },
    rpcUrls: {
      default: { http: [network.rpcUrl] },
    },
    blockExplorers: {
      default: {
        name: "0G ChainScan",
        url: network.explorerUrl,
      },
    },
  };
}

async function getWalletClient(chain: Chain) {
  const ethereum = getEthereumProvider();
  await ethereum.request({ method: "eth_requestAccounts" });
  const currentChainId = await ethereum.request({ method: "eth_chainId" });
  const requiredChainId = `0x${chain.id.toString(16)}` as `0x${string}`;
  if (String(currentChainId).toLowerCase() !== requiredChainId) {
    await switchOrAddChain(ethereum, chain, requiredChainId);
  }
  return createWalletClient({ chain, transport: custom(ethereum) });
}

async function switchOrAddChain(
  ethereum: EIP1193Provider,
  chain: Chain,
  requiredChainId: `0x${string}`,
) {
  try {
    await ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: requiredChainId }],
    });
  } catch (error) {
    if (!isUnknownChainError(error)) {
      throw error;
    }

    await ethereum.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          blockExplorerUrls: chain.blockExplorers?.default?.url
            ? [chain.blockExplorers.default.url]
            : undefined,
          chainId: requiredChainId,
          chainName: chain.name,
          nativeCurrency: chain.nativeCurrency,
          rpcUrls: chain.rpcUrls.default.http,
        },
      ],
    });
  }
}

function getEthereumProvider(): EIP1193Provider {
  const maybeWindow = window as Window & { ethereum?: EIP1193Provider };
  if (maybeWindow.ethereum === undefined) {
    throw new Error("No injected wallet found.");
  }
  return maybeWindow.ethereum;
}

function isUnknownChainError(error: unknown) {
  const maybeError = error as { code?: unknown; message?: unknown };
  return (
    maybeError.code === 4902 ||
    (typeof maybeError.message === "string" && maybeError.message.toLowerCase().includes("unrecognized chain"))
  );
}

function sanitizeWalletError(message: string): string {
  if (message.length > 160) {
    return `${message.slice(0, 157)}...`;
  }
  return message;
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
