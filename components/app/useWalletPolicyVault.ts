"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  decodeEventLog,
  http,
  parseEther,
  type Abi,
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
import { policyVaultV3Abi } from "@/lib/contracts/policy-vault-v3";
import {
  NEXT_PUBLIC_POLICY_VAULT_V4_REGISTRY_MAINNET_ADDRESS,
  NEXT_PUBLIC_POLICY_VAULT_ZIA_LP_ADAPTER_V4_MAINNET_ADDRESS,
  ensureV4BytecodeReady,
  policyVaultV4LpEntryAbi,
  policyVaultV4LpEntryBytecode,
  policyVaultV4LpExitAbi,
  policyVaultV4LpExitBytecode,
  policyVaultV4SwapAbi,
  policyVaultV4SwapBytecode,
  vaultRegistryV4Abi,
  type PolicyVaultV4LpPolicy,
  type PolicyVaultV4SwapPolicy,
} from "@/lib/contracts/policy-vault-v4";
import { buildV3LpAllowlists } from "@/lib/contracts/zia-lp";
import { ziaNonfungiblePositionManagerAbi, ZIA_LP_MAINNET } from "@/lib/contracts/zia-lp";
import {
  buildCopilotWalletAccessMessage,
  buildVaultMigrateV4FinalizeConsentMessage,
} from "@/lib/copilot/wallet-access";
import { requestActionConsentNonce } from "@/components/agents/lp/actionConsentNonce";
import {
  type PerNftDecision,
  type V4VaultTrio,
} from "@/lib/agent/vault-migrate-v4-shared";
import type { OgNetworkConfig } from "@/lib/types";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_BYTES32 = `0x${"00".repeat(32)}` as Hex;
const MIGRATE_V4_USER_GAS_RESERVE_WEI = parseEther("0.02");

export interface VersionedVault {
  factory: Address;
  vault: Address;
  version: number;
}

// Client-side view of the V4 migration phase-1 inventory review. Mirrors the
// server response shape (structurally) — the fetch JSON is cast to this.
export interface V4MigrationNftInventory {
  tokenId: string;
  stage?: string;
  decision?: PerNftDecision;
  staked?: boolean;
  stakeVault?: Address;
  agentKey?: Hex;
  poolId?: Hex;
  tickLower?: number;
  tickUpper?: number;
  deployedNative0G?: string;
  deployedNativeSource?: string;
}

export interface V4MigrationResult {
  oldVault: Address;
  v4Trio: V4VaultTrio;
  inventoryHash?: Hex;
  preservedTokenIds?: string[];
  repointedAgents?: string[];
  retired?: boolean;
}

interface V4MigrationPlan {
  agentKeys: Hex[];
  blockingIssues: string[];
  inventory: {
    fromBlock: string;
    nativeBalance0G: string;
    nfts: V4MigrationNftInventory[];
    scannedToBlock: string;
    tokenBalances: { token: Address; balance: string }[];
  } | null;
  inventoryHash: Hex | null;
  needsV4Deploy: boolean;
  planHash: Hex;
  source: { vault: Address; version: 1 | 2 | 3 } | null;
  v4Trio: V4VaultTrio | null;
}

export interface WalletPolicyVaultState {
  createVault: (policyOverride?: PolicyVaultPolicy) => Promise<void>;
  createVaultV4: (swapPolicyOverride?: PolicyVaultV4SwapPolicy, lpPolicyOverride?: PolicyVaultV4LpPolicy) => Promise<void>;
  factoryAddress: Address | null;
  activeVaultVersion?: number;
  isCreating: boolean;
  isDiscovering: boolean;
  isMigratingToV3: boolean;
  isMigratingToV4: boolean;
  legacyVaults: VersionedVault[];
  migrateVault: () => Promise<void>;
  migrateToV4: () => Promise<void>;
  migrateVaultToV3: () => Promise<void>;
  migrationRequired: boolean;
  refreshVaultAddress: () => Promise<void>;
  statusText: string;
  vaultAddress: Address | null;
  vaults: Address[];
  v4MigrateError: string | null;
  v4MigrateResult: V4MigrationResult | null;
  v4MigrationAvailable: boolean;
  v4SwapAddress: Address | null;
  v4LpEntryAddress: Address | null;
  v4LpExitAddress: Address | null;
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
  const [isMigratingToV4, setIsMigratingToV4] = useState(false);
  const [v4MigrateResult, setV4MigrateResult] = useState<V4MigrationResult | null>(null);
  const [v4MigrateError, setV4MigrateError] = useState<string | null>(null);
  const [statusText, setStatusText] = useState("Connect a wallet to resolve its Policy Vault.");
  // V3 singleton (mainnet-only, deployer-owned, resolved from the off-chain registry
  // via /api/vault/v3-status). When present it supersedes the latest V2 factory vault
  // as the active vault, and the v2 -> v3 migrate panel becomes available.
  const [v3VaultAddress, setV3VaultAddress] = useState<Address | null>(null);
  const [v4SwapAddress, setV4SwapAddress] = useState<Address | null>(null);
  const [v4LpEntryAddress, setV4LpEntryAddress] = useState<Address | null>(null);
  const [v4LpExitAddress, setV4LpExitAddress] = useState<Address | null>(null);
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
      setV4SwapAddress(null);
      setV4LpEntryAddress(null);
      setV4LpExitAddress(null);
      setLegacyV2Balance(0n);
      setStatusText("Connect a wallet to resolve its Policy Vault.");
      return;
    }

    if (factoryAddress === null) {
      setVaultAddress(null);
      setVaults([]);
      setVersionedVaults([]);
      setV3VaultAddress(null);
      setV4SwapAddress(null);
      setV4LpEntryAddress(null);
      setV4LpExitAddress(null);
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
        let resolvedV4 = false;
        try {
          if (NEXT_PUBLIC_POLICY_VAULT_V4_REGISTRY_MAINNET_ADDRESS !== ZERO_ADDRESS) {
            const [swapVault, lpEntryVault, lpExitVault] = await publicClient.readContract({
              address: NEXT_PUBLIC_POLICY_VAULT_V4_REGISTRY_MAINNET_ADDRESS,
              abi: vaultRegistryV4Abi,
              functionName: "vaultOf",
              args: [walletAccount.address],
            });
            if (requestIdRef.current === requestId) {
              const hasV4 = swapVault !== ZERO_ADDRESS && lpEntryVault !== ZERO_ADDRESS && lpExitVault !== ZERO_ADDRESS;
              setV4SwapAddress(hasV4 ? swapVault : null);
              setV4LpEntryAddress(hasV4 ? lpEntryVault : null);
              setV4LpExitAddress(hasV4 ? lpExitVault : null);
              if (hasV4) {
                resolvedV4 = true;
                setVaultAddress(swapVault);
                setStatusText("Resolved V4 Policy Vault trio from VaultRegistryV4.");
              }
            }
          }
        } catch {
          setV4SwapAddress(null);
          setV4LpEntryAddress(null);
          setV4LpExitAddress(null);
        }
        try {
          const v3Response = await fetch(
            `/api/vault/v3-status?ownerAddress=${walletAccount.address}`,
          );
          if (v3Response.ok) {
            const payload = (await v3Response.json()) as { data?: { v3VaultAddress?: Address | null } };
            const v3 = (payload.data?.v3VaultAddress ?? null) as Address | null;
            setV3VaultAddress(v3);
            if (v3 && !resolvedV4) {
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
        setV4SwapAddress(null);
        setV4LpEntryAddress(null);
        setV4LpExitAddress(null);
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

  const createVaultV4 = useCallback(async (
    swapPolicyOverride?: PolicyVaultV4SwapPolicy,
    lpPolicyOverride?: PolicyVaultV4LpPolicy,
  ) => {
    if (!walletAccount.isConnected || !walletAccount.address) {
      setStatusText("Connect the owner wallet before creating a V4 vault.");
      return;
    }
    if (creationConfig === null) {
      setStatusText(readiness.reason);
      return;
    }
    if (network.id !== "mainnet") {
      setStatusText("V4 user vault deployment is configured for 0G mainnet only.");
      return;
    }
    if (NEXT_PUBLIC_POLICY_VAULT_V4_REGISTRY_MAINNET_ADDRESS === ZERO_ADDRESS) {
      setStatusText("VaultRegistryV4 is not configured.");
      return;
    }
    if (NEXT_PUBLIC_POLICY_VAULT_ZIA_LP_ADAPTER_V4_MAINNET_ADDRESS === ZERO_ADDRESS) {
      setStatusText("ZiaLpAdapterV4 is not configured.");
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
        throw new Error("Wallet account changed before V4 vault creation.");
      }

      // H6 FIX: delegate to the resumable trio deployer. It reads each registry slot, reuses an
      // already-registered third, and deploys+registers each MISSING third one at a time — so a
      // mid-flow failure (user rejects/loses a tx) never dead-ends on AlreadyRegistered. Generous
      // explicit gas is set inside each deploy so the wallet skips its (failing on 0G) estimation.
      // Policy overrides are unused by the only caller; the trio uses the default creation policy.
      void swapPolicyOverride;
      void lpPolicyOverride;
      const trio = await ensureWalletV4Trio(
        { account, creationConfig, publicClient, setStatusText, walletClient },
        null,
      );

      setV4SwapAddress(trio.swapVault);
      setV4LpEntryAddress(trio.lpEntryVault);
      setV4LpExitAddress(trio.lpExitVault);
      setVaultAddress(trio.swapVault);
      setVaults((current) => dedupeAddresses([...current, trio.swapVault]));
      setStatusText("V4 Policy Vault trio created and registered.");
    } catch (error) {
      setStatusText(error instanceof Error ? sanitizeWalletError(error.message) : "V4 vault creation failed.");
    } finally {
      setIsCreating(false);
    }
  }, [
    chain,
    connectedChainId,
    creationConfig,
    network.chainId,
    network.id,
    network.networkName,
    publicClient,
    readiness.reason,
    switchChain,
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
        const withdrawTxHash = await walletClient.writeContract({ ...withdrawSimulation.request, gas: 200_000n });
        await waitForReceipt(publicClient, withdrawTxHash);

        setStatusText("Depositing migrated 0G into PolicyVaultV2.");
        const depositSimulation = await publicClient.simulateContract({
          account,
          address: createdVault,
          abi: policyVaultAbi,
          functionName: "depositNative",
          value: legacyBalance,
        });
        const depositTxHash = await walletClient.writeContract({ ...depositSimulation.request, gas: 200_000n });
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
        const withdrawTxHash = await walletClient.writeContract({ ...withdrawSimulation.request, gas: 200_000n });
        await waitForReceipt(publicClient, withdrawTxHash);

        setStatusText("Depositing migrated 0G into the V3 Policy Vault.");
        const depositSimulation = await publicClient.simulateContract({
          account,
          address: v3VaultAddress,
          abi: policyVaultAbi,
          functionName: "depositNative",
          value: legacyBalance,
        });
        const depositTxHash = await walletClient.writeContract({ ...depositSimulation.request, gas: 200_000n });
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
  /*

  // vault, deposit into the new vault, re-point all agents, flip .env.local) —
      setStatusText("Migrating: deploying new vault, moving funds, re-pointing agents. This may take 1-3 min — keep the tab open.");
  */
  const migrateToV4 = useCallback(async () => {
    if (!walletAccount.isConnected || !walletAccount.address) {
      setStatusText("Connect the owner wallet before migrating to V4.");
      return;
    }
    if (network.id !== "mainnet") {
      setStatusText("Migrate to V4 is configured for 0G mainnet only.");
      return;
    }
    if (creationConfig === null) {
      setStatusText(readiness.reason);
      return;
    }
    setV4MigrateError(null);
    setV4MigrateResult(null);
    setIsMigratingToV4(true);
    try {
      if (connectedChainId !== network.chainId) {
        setStatusText(`Switching wallet to ${network.networkName}.`);
        await switchChain.switchChainAsync({ chainId: network.chainId });
      }
      const walletClient = await getWalletClient(chain);
      const [account] = await walletClient.getAddresses();
      if (account.toLowerCase() !== walletAccount.address.toLowerCase()) {
        throw new Error("Wallet account changed before V4 migration.");
      }

      setStatusText("Building V4 migration plan.");
      const planResponse = await fetch("/api/vault/migrate-v4/plan", {
        body: JSON.stringify({ wallet: { address: account, chainId: network.chainId } }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const planPayload = (await planResponse.json().catch(() => ({}))) as { data?: V4MigrationPlan; error?: { code?: string; message?: string } };
      if (!planResponse.ok || !planPayload.data) {
        const messageText = planPayload.error?.message ?? "Unable to build the V4 migration plan.";
        setV4MigrateError(`${planPayload.error?.code ?? "plan_failed"}: ${messageText}`);
        setStatusText(messageText);
        return;
      }
      const plan = planPayload.data;
      if (plan.blockingIssues.includes("already_v4")) {
        setStatusText("This wallet already has a registered V4 Policy Vault.");
        await discoverVaults();
        return;
      }
      if (!plan.source) {
        throw new Error("No legacy vault was found for this wallet.");
      }

      const v4Trio = await ensureWalletV4Trio({
        account,
        creationConfig,
        publicClient,
        setStatusText,
        walletClient,
      }, plan.v4Trio);
      setV4SwapAddress(v4Trio.swapVault);
      setV4LpEntryAddress(v4Trio.lpEntryVault);
      setV4LpExitAddress(v4Trio.lpExitVault);

      const uniqueAgentKeys = Array.from(new Set(plan.agentKeys.map((key) => key.toLowerCase()))).map((key) => key as Hex);
      if (uniqueAgentKeys.length > 0) {
        setStatusText("Enabling migrated agent keys on V4.");
        await enableAgentKeysOnV4Trio({ account, agentKeys: uniqueAgentKeys, publicClient, trio: v4Trio, walletClient });
      }

      if (plan.source.version === 3) {
        if (!plan.inventory || !plan.inventoryHash) {
          throw new Error("V3 migration plan is missing inventory.");
        }
        setStatusText("Preserving V3 LP NFTs into V4.");
        await preserveV3Nfts({
          account,
          inventory: plan.inventory,
          publicClient,
          sourceVault: plan.source.vault,
          trio: v4Trio,
          walletClient,
        });
      }

      setStatusText("Moving native 0G into V4 Swap and retiring the source vault.");
      await moveNativeAndRetireSource({
        account,
        publicClient,
        sourceVersion: plan.source.version,
        sourceVault: plan.source.vault,
        trio: v4Trio,
        walletClient,
      });

      setStatusText("Signing finalize consent.");
      const { nonce, expiresAt } = await requestActionConsentNonce("vault-migrate-v4", account);
      const message = buildVaultMigrateV4FinalizeConsentMessage({
        address: account,
        chainId: network.chainId,
        networkId: network.id,
        sourceVault: plan.source.vault,
        sourceVersion: plan.source.version,
        planHash: plan.planHash,
        inventoryHash: plan.inventoryHash,
        v4SwapAddress: v4Trio.swapVault,
        v4LpEntryAddress: v4Trio.lpEntryVault,
        v4LpExitAddress: v4Trio.lpExitVault,
        nonce,
        expiresAt,
      });
      const signature = await signMessage.signMessageAsync({ message });
      const finalizeResponse = await fetch("/api/vault/migrate-v4", {
        body: JSON.stringify({
          wallet: { address: account, chainId: network.chainId, message, signature },
          nonce,
          expiresAt,
          sourceVault: plan.source.vault,
          sourceVersion: plan.source.version,
          planHash: plan.planHash,
          inventoryHash: plan.inventoryHash ?? undefined,
          v4Trio: { swap: v4Trio.swapVault, lpEntry: v4Trio.lpEntryVault, lpExit: v4Trio.lpExitVault },
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const finalizePayload = (await finalizeResponse.json().catch(() => ({}))) as {
        data?: V4MigrationResult;
        error?: { code?: string; message?: string };
      };
      if (!finalizeResponse.ok || !finalizePayload.data) {
        const messageText = finalizePayload.error?.message ?? "Unable to finalize the V4 migration.";
        setV4MigrateError(`${finalizePayload.error?.code ?? "migration_failed"}: ${messageText}`);
        setStatusText(messageText);
        return;
      }
      setV4MigrateResult(finalizePayload.data);
      setStatusText("V4 migration complete. The V4 vault trio is active for this wallet.");
      await discoverVaults();
    } catch (error) {
      const messageText = error instanceof Error ? sanitizeWalletError(error.message) : "V4 migration failed.";
      setV4MigrateError(messageText);
      setStatusText(messageText);
    } finally {
      setIsMigratingToV4(false);
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
    walletAccount.address,
    walletAccount.isConnected,
  ]);

  const activeVaultVersion = versionedVaults.at(-1)?.version;
  const latestFactoryVersion = factoryVersions.at(-1)?.version;

  return {
    activeVaultVersion,
    createVault,
    createVaultV4,
    factoryAddress,
    isCreating,
    isDiscovering,
    isMigratingToV3,
    isMigratingToV4,
    legacyVaults: latestFactoryVersion === undefined
      ? []
      : versionedVaults.filter((entry) => entry.version < latestFactoryVersion),
    migrateVault,
    migrateToV4,
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
    v4MigrateError,
    v4MigrateResult,
    v4MigrationAvailable: v4SwapAddress === null && (v3VaultAddress !== null || versionedVaults.length > 0),
    v4SwapAddress,
    v4LpEntryAddress,
    v4LpExitAddress,
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

function toV4SwapPolicy(policy: PolicyVaultPolicy): PolicyVaultV4SwapPolicy {
  return {
    perTradeCap0G: policy.perTradeCap0G,
    dailyCap0G: policy.dailyCap0G,
    maxExposure0G: policy.maxExposure0G,
    cooldownSeconds: policy.cooldownSeconds,
    maxDeadlineWindowSeconds: policy.maxDeadlineWindowSeconds,
    defaultMinOutBps: policy.defaultMinOutBps,
  };
}

function toV4LpPolicy(policy: PolicyVaultPolicy): PolicyVaultV4LpPolicy {
  return {
    perLpActionCap0G: policy.perTradeCap0G,
    lpDailyCap0G: policy.dailyCap0G,
    maxLpExposure0G: policy.maxExposure0G,
    cooldownSecondsLp: policy.cooldownSeconds,
    lpMinOutBps: policy.defaultMinOutBps,
    minLiquidityFloor: 1n,
    allowStaking: true,
  };
}

async function ensureWalletV4Trio(
  {
    account,
    creationConfig,
    publicClient,
    setStatusText,
    walletClient,
  }: {
    account: Address;
    creationConfig: NonNullable<ReturnType<typeof getPolicyVaultCreationConfig>>;
    publicClient: ReturnType<typeof createPublicClient>;
    setStatusText: (value: string) => void;
    walletClient: WalletClient;
  },
  plannedTrio: V4VaultTrio | null,
): Promise<V4VaultTrio> {
  if (NEXT_PUBLIC_POLICY_VAULT_V4_REGISTRY_MAINNET_ADDRESS === ZERO_ADDRESS) {
    throw new Error("VaultRegistryV4 is not configured.");
  }
  if (NEXT_PUBLIC_POLICY_VAULT_ZIA_LP_ADAPTER_V4_MAINNET_ADDRESS === ZERO_ADDRESS) {
    throw new Error("ZiaLpAdapterV4 is not configured.");
  }
  const registryTrio = await readRegistryV4Trio(publicClient, account);
  if (registryTrio) {
    if (plannedTrio && !sameAddress(registryTrio.swapVault, plannedTrio.swapVault)) {
      throw new Error("V4 registry changed after planning. Refresh and retry.");
    }
    return registryTrio;
  }

  const lpAllowlists = buildV3LpAllowlists();
  const swapBytecode = ensureV4BytecodeReady(policyVaultV4SwapBytecode, "PolicyVaultV4Swap");
  const lpEntryBytecode = ensureV4BytecodeReady(policyVaultV4LpEntryBytecode, "PolicyVaultV4LpEntry");
  const lpExitBytecode = ensureV4BytecodeReady(policyVaultV4LpExitBytecode, "PolicyVaultV4LpExit");
  const swapPolicy = toV4SwapPolicy(creationConfig.policy);
  const lpPolicy = toV4LpPolicy(creationConfig.policy);

  // H6 FIX: resume a partial deploy. Read each registry slot individually; reuse an already-
  // registered third and deploy+register each MISSING third one at a time (register right after
  // deploy). A mid-flow failure then never forces a full 3-contract redeploy that reverts
  // AlreadyRegistered on the slot that already succeeded.
  let lpEntryVault = await readRegistrySlotV4(publicClient, "lpEntryVaultOf", account);
  if (!lpEntryVault) {
    setStatusText("Deploying V4 LP Entry.");
    const lpEntryHash = await walletClient.deployContract({
      account,
      chain: null,
      abi: policyVaultV4LpEntryAbi,
      bytecode: lpEntryBytecode,
      gas: 8_000_000n, // explicit generous gas → wallet skips (failing) estimation on 0G (actual ~4.44M, refunded if unused)
      args: [
        account,
        creationConfig.executor,
        NEXT_PUBLIC_POLICY_VAULT_ZIA_LP_ADAPTER_V4_MAINNET_ADDRESS,
        creationConfig.proofRegistry,
        false,
        NEXT_PUBLIC_POLICY_VAULT_V4_REGISTRY_MAINNET_ADDRESS,
        lpPolicy,
        lpAllowlists.allowedLpPools,
        lpAllowlists.allowedStakeVaults,
        lpAllowlists.stakeVaultForLpPool,
      ],
    });
    lpEntryVault = await readContractAddressFromDeploy(publicClient, lpEntryHash);
    setStatusText("Registering V4 LP Entry.");
    await writeAndWait(walletClient, publicClient, {
      account,
      address: NEXT_PUBLIC_POLICY_VAULT_V4_REGISTRY_MAINNET_ADDRESS,
      abi: vaultRegistryV4Abi,
      functionName: "registerLpEntry",
      args: [lpEntryVault],
      gas: 300_000n,
    });
  }

  let lpExitVault = await readRegistrySlotV4(publicClient, "lpExitVaultOf", account);
  if (!lpExitVault) {
    setStatusText("Deploying V4 LP Exit.");
    const lpExitHash = await walletClient.deployContract({
      account,
      chain: null,
      abi: policyVaultV4LpExitAbi,
      bytecode: lpExitBytecode,
      gas: 8_000_000n, // explicit generous gas → wallet skips (failing) estimation on 0G (actual ~4.40M, refunded if unused)
      args: [
        account,
        creationConfig.executor,
        NEXT_PUBLIC_POLICY_VAULT_ZIA_LP_ADAPTER_V4_MAINNET_ADDRESS,
        creationConfig.proofRegistry,
        false,
        NEXT_PUBLIC_POLICY_VAULT_V4_REGISTRY_MAINNET_ADDRESS,
        lpEntryVault,
        lpAllowlists.allowedLpPools,
        creationConfig.allowedTokens,
      ],
    });
    lpExitVault = await readContractAddressFromDeploy(publicClient, lpExitHash);
    setStatusText("Registering V4 LP Exit.");
    await writeAndWait(walletClient, publicClient, {
      account,
      address: NEXT_PUBLIC_POLICY_VAULT_V4_REGISTRY_MAINNET_ADDRESS,
      abi: vaultRegistryV4Abi,
      functionName: "registerLpExit",
      args: [lpExitVault],
      gas: 300_000n,
    });
  }

  let swapVault = await readRegistrySlotV4(publicClient, "swapVaultOf", account);
  if (!swapVault) {
    setStatusText("Deploying V4 Swap.");
    const swapHash = await walletClient.deployContract({
      account,
      chain: null,
      abi: policyVaultV4SwapAbi,
      bytecode: swapBytecode,
      gas: 5_500_000n, // explicit generous gas → wallet skips (failing) estimation on 0G (actual ~3M, refunded if unused)
      args: [
        account,
        creationConfig.executor,
        creationConfig.adapter,
        creationConfig.proofRegistry,
        swapPolicy,
        creationConfig.allowedTokens,
        creationConfig.allowedPools,
        false,
        NEXT_PUBLIC_POLICY_VAULT_V4_REGISTRY_MAINNET_ADDRESS,
      ],
    });
    swapVault = await readContractAddressFromDeploy(publicClient, swapHash);
    setStatusText("Registering V4 Swap.");
    await writeAndWait(walletClient, publicClient, {
      account,
      address: NEXT_PUBLIC_POLICY_VAULT_V4_REGISTRY_MAINNET_ADDRESS,
      abi: vaultRegistryV4Abi,
      functionName: "registerSwap",
      args: [swapVault],
      gas: 300_000n,
    });
  }

  // Link LP Entry → LP Exit (one-time onlyOwner). Skip if already linked so a resume is idempotent.
  const linkedExit = (await publicClient.readContract({
    address: lpEntryVault,
    abi: policyVaultV4LpEntryAbi,
    functionName: "lpExitVault",
  }).catch(() => ZERO_ADDRESS)) as Address;
  if (!linkedExit || linkedExit === ZERO_ADDRESS) {
    setStatusText("Linking LP Entry to LP Exit.");
    await writeAndWait(walletClient, publicClient, {
      account,
      address: lpEntryVault,
      abi: policyVaultV4LpEntryAbi,
      functionName: "setLpExitVault",
      args: [lpExitVault],
      gas: 250_000n,
    });
  }

  const trio = await readRegistryV4Trio(publicClient, account);
  if (!trio) throw new Error("V4 registry did not resolve after registration.");
  return trio;
}

async function readRegistryV4Trio(publicClient: ReturnType<typeof createPublicClient>, owner: Address): Promise<V4VaultTrio | null> {
  if (NEXT_PUBLIC_POLICY_VAULT_V4_REGISTRY_MAINNET_ADDRESS === ZERO_ADDRESS) return null;
  const [swapVault, lpEntryVault, lpExitVault] = await publicClient.readContract({
    address: NEXT_PUBLIC_POLICY_VAULT_V4_REGISTRY_MAINNET_ADDRESS,
    abi: vaultRegistryV4Abi,
    functionName: "vaultOf",
    args: [owner],
  }).catch(() => [ZERO_ADDRESS, ZERO_ADDRESS, ZERO_ADDRESS] as const);
  if (swapVault === ZERO_ADDRESS || lpEntryVault === ZERO_ADDRESS || lpExitVault === ZERO_ADDRESS) return null;
  return { swapVault, lpEntryVault, lpExitVault };
}

async function readRegistrySlotV4(
  publicClient: ReturnType<typeof createPublicClient>,
  fn: "swapVaultOf" | "lpEntryVaultOf" | "lpExitVaultOf",
  owner: Address,
): Promise<Address | null> {
  const value = (await publicClient.readContract({
    address: NEXT_PUBLIC_POLICY_VAULT_V4_REGISTRY_MAINNET_ADDRESS,
    abi: vaultRegistryV4Abi,
    functionName: fn,
    args: [owner],
  }).catch(() => ZERO_ADDRESS)) as Address;
  return value && value !== ZERO_ADDRESS ? value : null;
}

async function enableAgentKeysOnV4Trio({
  account,
  agentKeys,
  publicClient,
  trio,
  walletClient,
}: {
  account: Address;
  agentKeys: Hex[];
  publicClient: ReturnType<typeof createPublicClient>;
  trio: V4VaultTrio;
  walletClient: WalletClient;
}) {
  await enableAgentKeysOnVault({ account, agentKeys, publicClient, vault: trio.swapVault, abi: policyVaultV4SwapAbi, walletClient });
  await enableAgentKeysOnVault({ account, agentKeys, publicClient, vault: trio.lpEntryVault, abi: policyVaultV4LpEntryAbi, walletClient });
  await enableAgentKeysOnVault({ account, agentKeys, publicClient, vault: trio.lpExitVault, abi: policyVaultV4LpExitAbi, walletClient });
}

async function enableAgentKeysOnVault({
  account,
  agentKeys,
  abi,
  publicClient,
  vault,
  walletClient,
}: {
  account: Address;
  agentKeys: Hex[];
  abi: Abi | readonly unknown[];
  publicClient: ReturnType<typeof createPublicClient>;
  vault: Address;
  walletClient: WalletClient;
}) {
  const missing: Hex[] = [];
  for (const agentKey of agentKeys) {
    const enabled = await publicClient.readContract({
      address: vault,
      abi,
      functionName: "agentKeyEnabled",
      args: [agentKey],
    }).catch(() => false);
    if (!enabled) missing.push(agentKey);
  }
  if (missing.length === 0) return;
  await writeAndWait(walletClient, publicClient, {
    account,
    address: vault,
    abi,
    functionName: "setAgentKeysEnabled",
    args: [missing, true],
    gas: 400_000n,
  });
}

async function preserveV3Nfts({
  account,
  inventory,
  publicClient,
  sourceVault,
  trio,
  walletClient,
}: {
  account: Address;
  inventory: NonNullable<V4MigrationPlan["inventory"]>;
  publicClient: ReturnType<typeof createPublicClient>;
  sourceVault: Address;
  trio: V4VaultTrio;
  walletClient: WalletClient;
}) {
  for (const nft of inventory.nfts) {
    if (nft.stage === "skipped_burned") continue;
    if (!nft.agentKey || !nft.poolId || nft.tickLower === undefined || nft.tickUpper === undefined || nft.deployedNative0G === undefined) {
      throw new Error(`NFT ${nft.tokenId} is missing V3 accounting; migration halted before moving it.`);
    }
    const tokenId = BigInt(nft.tokenId);
    let owner = await ownerOfNfpm(publicClient, tokenId);
    if (nft.staked && nft.stakeVault) {
      await writeAndWait(walletClient, publicClient, {
        account,
        address: sourceVault,
        abi: policyVaultV3Abi,
        functionName: "unstakeLpOwner",
        args: [tokenId, nft.stakeVault],
      });
      owner = await ownerOfNfpm(publicClient, tokenId);
    }
    if (sameAddress(owner, sourceVault)) {
      await writeAndWait(walletClient, publicClient, {
        account,
        address: sourceVault,
        abi: policyVaultV3Abi,
        functionName: "rescueNft",
        args: [ZIA_LP_MAINNET.nonfungiblePositionManager, tokenId],
      });
      owner = await ownerOfNfpm(publicClient, tokenId);
    }
    if (sameAddress(owner, account)) {
      await writeAndWait(walletClient, publicClient, {
        account,
        address: ZIA_LP_MAINNET.nonfungiblePositionManager,
        abi: ziaNonfungiblePositionManagerAbi,
        functionName: "safeTransferFrom",
        args: [account, trio.lpEntryVault, tokenId],
      });
      owner = await ownerOfNfpm(publicClient, tokenId);
    }
    if (!sameAddress(owner, trio.lpEntryVault)) {
      throw new Error(`NFT ${nft.tokenId} custody is ${owner}; expected V4 LP Entry.`);
    }
    const importedOwner = await publicClient.readContract({
      address: trio.lpEntryVault,
      abi: policyVaultV4LpEntryAbi,
      functionName: "lpNftOwner",
      args: [tokenId],
    }).catch(() => ZERO_BYTES32) as Hex;
    if (importedOwner.toLowerCase() === ZERO_BYTES32.toLowerCase()) {
      await writeAndWait(walletClient, publicClient, {
        account,
        address: trio.lpEntryVault,
        abi: policyVaultV4LpEntryAbi,
        functionName: "importLpNft",
        args: [tokenId, nft.agentKey, nft.poolId, nft.tickLower, nft.tickUpper, BigInt(nft.deployedNative0G)],
      });
    }
  }
}

async function moveNativeAndRetireSource({
  account,
  publicClient,
  sourceVersion,
  sourceVault,
  trio,
  walletClient,
}: {
  account: Address;
  publicClient: ReturnType<typeof createPublicClient>;
  sourceVersion: 1 | 2 | 3;
  sourceVault: Address;
  trio: V4VaultTrio;
  walletClient: WalletClient;
}) {
  const sourceAbi = sourceVersion === 3 ? policyVaultV3Abi : policyVaultAbi;
  const sourceBalance = await publicClient.getBalance({ address: sourceVault });
  if (sourceBalance > 0n) {
    await writeAndWait(walletClient, publicClient, {
      account,
      address: sourceVault,
      abi: sourceAbi,
      functionName: "withdrawNative",
      args: [sourceBalance],
      gas: 200_000n,
    });
    const depositWei = sourceBalance > MIGRATE_V4_USER_GAS_RESERVE_WEI ? sourceBalance - MIGRATE_V4_USER_GAS_RESERVE_WEI : 0n;
    if (depositWei > 0n) {
      await writeAndWait(walletClient, publicClient, {
        account,
        address: trio.swapVault,
        abi: policyVaultV4SwapAbi,
        functionName: "depositNative",
        args: [],
        value: depositWei,
        gas: 200_000n,
      });
    }
  }
  const [paused, revoked] = await Promise.all([
    publicClient.readContract({ address: sourceVault, abi: sourceAbi, functionName: "paused" }).catch(() => false),
    publicClient.readContract({ address: sourceVault, abi: sourceAbi, functionName: "executorRevoked" }).catch(() => false),
  ]);
  if (!paused) {
    await writeBestEffortOwnerTx({ account, address: sourceVault, args: [true], abi: sourceAbi, functionName: "setPaused", publicClient, walletClient });
  }
  if (!revoked) {
    await writeBestEffortOwnerTx({ account, address: sourceVault, args: [], abi: sourceAbi, functionName: "revokeExecutor", publicClient, walletClient });
  }
}

async function ownerOfNfpm(publicClient: ReturnType<typeof createPublicClient>, tokenId: bigint): Promise<Address> {
  const owner = await publicClient.readContract({
    address: ZIA_LP_MAINNET.nonfungiblePositionManager,
    abi: ziaNonfungiblePositionManagerAbi,
    functionName: "ownerOf",
    args: [tokenId],
  });
  return owner as Address;
}

function sameAddress(left: Address | string, right: Address | string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

async function readContractAddressFromDeploy(
  publicClient: ReturnType<typeof createPublicClient>,
  hash: Hex,
): Promise<Address> {
  const receipt = await waitForReceipt(publicClient, hash);
  // H7 FIX: a null receipt means the tx was not confirmed in time; a reverted create can still
  // carry a contractAddress on some clients. Never treat either as a successful deploy.
  if (!receipt) {
    throw new Error(`Deployment ${hash} was not confirmed in time. Check the explorer before retrying.`);
  }
  if (receipt.status !== "success") {
    throw new Error(`Deployment ${hash} reverted on-chain.`);
  }
  const address = receipt.contractAddress;
  if (!address) {
    throw new Error("Deployment receipt did not include a contract address.");
  }
  return address;
}

async function writeAndWait(
  walletClient: WalletClient,
  publicClient: ReturnType<typeof createPublicClient>,
  request: {
    account: Address;
    address: Address;
    abi: Abi | readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
    value?: bigint;
    // UX FIX: pass an explicit gas limit so the wallet does NOT call eth_estimateGas (which fails on
    // 0G in OKX/some wallets → "network fee estimation unsuccessful", blocking Confirm). Unused gas
    // is refunded, so a generous limit costs nothing extra.
    gas?: bigint;
  },
) {
  const hash = await walletClient.writeContract({ chain: null, ...request } as Parameters<WalletClient["writeContract"]>[0]);
  // H7 FIX: assert the tx actually succeeded. Previously a mined-but-reverted tx (or a 90s timeout
  // returning null) was silently treated as success, so a broken registration/setLpExitVault/deposit
  // let the flow report "trio created" on a half-built vault.
  const receipt = await waitForReceipt(publicClient, hash);
  if (!receipt) {
    throw new Error(`Transaction ${hash} was not confirmed in time. Check the explorer before retrying.`);
  }
  if (receipt.status !== "success") {
    throw new Error(`Transaction ${hash} reverted on-chain (${request.functionName}).`);
  }
  return receipt;
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
  abi = policyVaultAbi,
  functionName,
  publicClient,
  walletClient,
}: {
  account: Address;
  address: Address;
  args: readonly unknown[];
  abi?: Abi | readonly unknown[];
  functionName: "revokeExecutor" | "setPaused";
  publicClient: ReturnType<typeof createPublicClient>;
  walletClient: WalletClient;
}) {
  try {
    const txHash = await walletClient.writeContract({
      account,
      address,
      abi,
      functionName,
      args,
      gas: 200_000n, // explicit gas → wallet skips (failing) estimation on 0G
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
