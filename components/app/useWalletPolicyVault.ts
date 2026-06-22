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
} from "viem";
import { useAccount, useChainId, useSwitchChain } from "wagmi";
import {
  getPolicyVaultCreationConfig,
  getPolicyVaultFactoryAddress,
  getPolicyVaultFactoryFromBlock,
  getPolicyVaultReadiness,
  policyVaultAbi,
  policyVaultCreatedEvent,
  policyVaultFactoryAbi,
  type PolicyVaultPolicy,
} from "@/lib/contracts/policy-vault";
import type { OgNetworkConfig } from "@/lib/types";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export interface WalletPolicyVaultState {
  createVault: (policyOverride?: PolicyVaultPolicy) => Promise<void>;
  factoryAddress: Address | null;
  isCreating: boolean;
  isDiscovering: boolean;
  refreshVaultAddress: () => Promise<void>;
  statusText: string;
  vaultAddress: Address | null;
  vaults: Address[];
}

export function useWalletPolicyVault(network: OgNetworkConfig): WalletPolicyVaultState {
  const walletAccount = useAccount();
  const connectedChainId = useChainId();
  const switchChain = useSwitchChain();
  const [vaultAddress, setVaultAddress] = useState<Address | null>(null);
  const [vaults, setVaults] = useState<Address[]>([]);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [statusText, setStatusText] = useState("Connect a wallet to resolve its Policy Vault.");
  const requestIdRef = useRef(0);
  const factoryAddress = getPolicyVaultFactoryAddress(network.id);
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
      setStatusText("Connect a wallet to resolve its Policy Vault.");
      return;
    }

    if (factoryAddress === null) {
      setVaultAddress(null);
      setVaults([]);
      setStatusText("PolicyVaultFactory is not configured for this network.");
      return;
    }

    setIsDiscovering(true);
    setStatusText("Scanning factory events for this wallet.");

    try {
      const verified = await readVerifiedVaults({
        factoryAddress,
        networkId: network.id,
        owner: walletAccount.address,
        publicClient,
      });

      if (requestIdRef.current !== requestId) {
        return;
      }

      setVaults(verified);
      setVaultAddress(verified.at(-1) ?? null);
      setStatusText(
        verified.length > 0
          ? `Resolved ${verified.length} owner vault${verified.length === 1 ? "" : "s"} from factory.`
          : "No Policy Vault found for this wallet yet.",
      );
    } catch {
      if (requestIdRef.current === requestId) {
        setVaultAddress(null);
        setVaults([]);
        setStatusText("Could not scan PolicyVaultFactory logs from this RPC.");
      }
    } finally {
      if (requestIdRef.current === requestId) {
        setIsDiscovering(false);
      }
    }
  }, [factoryAddress, network.id, publicClient, walletAccount.address]);

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

    if (vaultAddress !== null || vaults.length > 0) {
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

  return {
    createVault,
    factoryAddress,
    isCreating,
    isDiscovering,
    refreshVaultAddress: discoverVaults,
    statusText,
    vaultAddress,
    vaults,
  };
}

async function readVerifiedVaults({
  factoryAddress,
  networkId,
  owner,
  publicClient,
}: {
  factoryAddress: Address;
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
    fromBlock: getPolicyVaultFactoryFromBlock(networkId),
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
