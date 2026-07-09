"use client";

import { useState } from "react";
import type { UseSignMessageReturnType } from "wagmi";
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  type Address,
  type Chain,
  type EIP1193Provider,
  type Hex,
} from "viem";

import { policyVaultAgentKeyAbi } from "@/lib/contracts/policy-vault";
import { dispatchSigmaPetReaction } from "@/lib/copilot/sigma-pet";
import { buildCopilotWalletAccessMessage, type CopilotWalletAccess } from "@/lib/copilot/wallet-access";
import { getOgNetwork } from "@/lib/og/networks";
import type { OgAgentWorkspace } from "@/lib/agent/single-agent";
import type { OgNetworkConfig, OgNetworkId } from "@/lib/types";

const MAINNET = getOgNetwork("mainnet");

export type AgentWalletProof = CopilotWalletAccess;

interface OwnerControlWallet {
  address?: Address;
  isConnected: boolean;
  isWrongChain: boolean;
  switchToOg: () => Promise<unknown>;
}

interface UseAgentOwnerControlsParams {
  agentId: string;
  networkId: OgNetworkId;
  ownerAddress?: Address;
  vaultAddress?: Address;
  vaultVersion?: number;
  v4SwapAddress?: Address;
  v4LpEntryAddress?: Address;
  v4LpExitAddress?: Address;
  agentKey?: Hex;
  network: OgNetworkConfig;
  wallet: OwnerControlWallet;
  signMessage: UseSignMessageReturnType;
  setActionMessage: (message: string) => void;
}

export function useAgentOwnerControls({
  agentId,
  networkId,
  ownerAddress,
  vaultAddress,
  vaultVersion = 1,
  v4SwapAddress,
  v4LpEntryAddress,
  v4LpExitAddress,
  agentKey,
  network,
  wallet,
  signMessage,
  setActionMessage,
}: UseAgentOwnerControlsParams) {
  const [walletAccessByKey, setWalletAccessByKey] = useState<Record<string, string>>({});

  async function ensureOwnerWalletProof(): Promise<AgentWalletProof> {
    if (!wallet.address) {
      throw new Error("Connect the Policy Vault owner wallet first.");
    }
    if (!ownerAddress || wallet.address.toLowerCase() !== ownerAddress.toLowerCase()) {
      dispatchSigmaPetReaction("wallet.owner-mismatch", { force: true });
      throw new Error("Connected wallet is not the Policy Vault owner.");
    }
    if (wallet.isWrongChain) {
      setActionMessage(`Switching wallet to ${network.networkName}.`);
      dispatchSigmaPetReaction("wallet.switch.start", { force: true });
      await wallet.switchToOg();
      dispatchSigmaPetReaction("wallet.switch.success", { force: true });
    }
    const message = buildCopilotWalletAccessMessage({
      address: wallet.address,
      chainId: network.chainId,
      networkId,
    });
    const walletAccessKey = `${networkId}:${network.chainId}:${wallet.address.toLowerCase()}`;
    const cached = walletAccessByKey[walletAccessKey];
    if (!cached) dispatchSigmaPetReaction("wallet.signature.pending", { force: true });
    const signature = cached ?? await signMessage.signMessageAsync({ message });
    if (!cached) {
      setWalletAccessByKey((current) => ({ ...current, [walletAccessKey]: signature }));
    }
    return {
      address: wallet.address,
      chainId: network.chainId,
      message,
      signature,
    };
  }

  async function setAgentKeyEnabledOnActiveVault(enabled: boolean): Promise<Hex | undefined> {
    if (!agentKey || !vaultAddress || vaultVersion < 2) {
      return undefined;
    }
    const provider = typeof window === "undefined"
      ? undefined
      : (window as Window & { ethereum?: EIP1193Provider }).ethereum;
    if (!provider) {
      throw new Error("Wallet provider is required to update the V2 agent key.");
    }
    setActionMessage(enabled ? "Waiting for wallet confirmation to enable the agent key." : "Waiting for wallet confirmation to disable the agent key.");
    const chain = make0GMainnetChain(network.rpcUrl);
    const publicClient = createPublicClient({ chain, transport: http(network.rpcUrl) });
    const walletClient = createWalletClient({
      chain,
      transport: custom(provider),
    });
    const [account] = await walletClient.getAddresses();
    if (!account || !ownerAddress || account.toLowerCase() !== ownerAddress.toLowerCase()) {
      dispatchSigmaPetReaction("wallet.owner-mismatch", { force: true });
      throw new Error("Connected wallet is not the Policy Vault owner.");
    }
    if (vaultVersion >= 4) {
      // H8 FIX: never silently fall back to a single-vault write for a V4 agent — that would leave
      // the agent key enabled on the untouched thirds. Require the full trio.
      if (!v4SwapAddress || !v4LpEntryAddress || !v4LpExitAddress) {
        throw new Error("V4 agent is missing its vault trio; cannot toggle the agent key on all three thirds.");
      }
      return setAgentKeyEnabledOnAllV4Vaults({
        account,
        agentKey,
        enabled,
        publicClient,
        walletClient,
        vaults: [v4SwapAddress, v4LpEntryAddress, v4LpExitAddress],
      });
    }
    const txHash = await writeAgentKeyTx({ account, agentKey, enabled, publicClient, vault: vaultAddress, walletClient });
    return txHash;
  }

  async function setAgentKeyEnabledOnAllV4Vaults({
    account,
    agentKey,
    enabled,
    publicClient,
    vaults,
    walletClient,
  }: {
    account: Address;
    agentKey: Hex;
    enabled: boolean;
    publicClient: ReturnType<typeof createPublicClient>;
    vaults: [Address, Address, Address];
    walletClient: ReturnType<typeof createWalletClient>;
  }): Promise<Hex | undefined> {
    let lastHash: Hex | undefined;
    for (const vault of vaults) {
      lastHash = await writeAgentKeyTx({ account, agentKey, enabled, publicClient, vault, walletClient });
    }
    return lastHash;
  }

  async function writeAgentKeyTx({
    account,
    agentKey,
    enabled,
    publicClient,
    vault,
    walletClient,
  }: {
    account: Address;
    agentKey: Hex;
    enabled: boolean;
    publicClient: ReturnType<typeof createPublicClient>;
    vault: Address;
    walletClient: ReturnType<typeof createWalletClient>;
  }): Promise<Hex> {
    const txHash = await walletClient.writeContract({
      account,
      address: vault,
      abi: policyVaultAgentKeyAbi,
      chain: null,
      functionName: "setAgentKeyEnabled",
      args: [agentKey, enabled],
      // explicit gas → wallet skips eth_estimateGas (fails on 0G in OKX, blocks Confirm)
      gas: 200_000n,
    });
    setActionMessage(enabled ? "Agent key enable submitted. Waiting for confirmation." : "Agent key disable submitted. Waiting for confirmation.");
    // H7 FIX: a mined-but-reverted setAgentKeyEnabled must not be reported as success (it would
    // record a bogus "disable evidence" hash on remove while the key stays enabled on-chain).
    const receipt = await waitForReceipt(publicClient, txHash);
    if (receipt.status !== "success") {
      throw new Error(`Agent key transaction ${txHash} reverted on-chain.`);
    }
    return txHash;
  }

  async function postAgentStatus(action: "arm" | "pause", proof: AgentWalletProof): Promise<OgAgentWorkspace> {
    const response = await fetch("/api/agents/status", {
      body: JSON.stringify({
        action,
        agentId,
        networkId: "mainnet",
        wallet: proof,
      }),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    const payload = (await response.json()) as { data?: { workspace: OgAgentWorkspace }; error?: { message: string } };
    if (!response.ok || !payload.data) {
      throw new Error(payload.error?.message ?? "Agent status update failed.");
    }
    return payload.data.workspace;
  }

  async function postAgentRemove(proof: AgentWalletProof, agentKeyDisableTxHash?: Hex): Promise<OgAgentWorkspace> {
    const response = await fetch("/api/agents/remove", {
      body: JSON.stringify({
        agentId,
        agentKeyDisableTxHash,
        networkId: "mainnet",
        wallet: proof,
      }),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    const payload = (await response.json()) as { data?: { workspace: OgAgentWorkspace }; error?: { message: string } };
    if (!response.ok || !payload.data) {
      throw new Error(payload.error?.message ?? "Remove request failed.");
    }
    return payload.data.workspace;
  }

  return {
    ensureOwnerWalletProof,
    setAgentKeyEnabledOnActiveVault,
    setAgentKeyEnabledOnAllV4Vaults,
    postAgentStatus,
    postAgentRemove,
    walletAccessByKey,
    setWalletAccessByKey,
  };
}

function make0GMainnetChain(rpcUrl: string): Chain {
  return {
    id: MAINNET.chainId,
    name: MAINNET.networkName,
    nativeCurrency: {
      decimals: 18,
      name: "0G",
      symbol: "0G",
    },
    rpcUrls: {
      default: { http: [rpcUrl] },
    },
    blockExplorers: {
      default: {
        name: "0G ChainScan",
        url: MAINNET.explorerUrl,
      },
    },
  };
}

async function waitForReceipt(
  publicClient: ReturnType<typeof createPublicClient>,
  hash: Hex,
) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      return await publicClient.getTransactionReceipt({ hash });
    } catch {
      await new Promise((resolve) => window.setTimeout(resolve, 1_000));
    }
  }
  throw new Error("Timed out waiting for the V2 agent key transaction.");
}
