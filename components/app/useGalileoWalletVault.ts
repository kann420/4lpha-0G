"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPublicClient, createWalletClient, custom, http, parseEther, type Address, type EIP1193Provider, type Hex } from "viem";
import { useAccount, useChainId, useSwitchChain } from "wagmi";
import { OG_GALILEO_CHAIN } from "@/lib/wallet/chains";
import {
  GALILEO_CHAIN_ID,
  GALILEO_DEFAULT_VAULT_POLICY,
  galileoFaucetAbi,
  galileoSandboxPoolAbi,
  galileoVaultAbi,
  galileoVaultDeploymentAbi,
  galileoVaultDeploymentBytecode,
  galileoVaultRegistryAbi,
  resolveGalileoVaultStack,
  type GalileoVaultStackAddresses,
  type VerifiedGalileoVaultStack,
} from "@/lib/contracts/policy-vault-v4-galileo";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

export interface GalileoVaultAttestationRequest {
  adapter: Address;
  chainId: typeof GALILEO_CHAIN_ID;
  deploymentTxHash: Hex;
  executor: Address;
  poolId: Hex;
  proofRegistry: Address;
  sandboxToken: Address;
  vault: Address;
  vaultRegistry: Address;
}

export interface GalileoVaultState {
  agentKeyEnabled: boolean | null;
  attestationRequest: GalileoVaultAttestationRequest | null;
  attested: boolean | null;
  canCreate: boolean;
  canWrite: boolean;
  createVault: () => Promise<void>;
  executorRevoked: boolean | null;
  faucetBalance: bigint | null;
  isBusy: boolean;
  paused: boolean | null;
  poolNativeReserve: bigint | null;
  poolTokenReserve: bigint | null;
  refresh: () => Promise<void>;
  requestFaucet: () => Promise<void>;
  setAgentKeyEnabled: (agentKey: Hex, enabled: boolean) => Promise<void>;
  setPaused: (value: boolean) => Promise<void>;
  status: string;
  vaultAddress: Address | null;
  withdraw: (amount: string) => Promise<void>;
  deposit: (amount: string) => Promise<void>;
  revokeExecutor: () => Promise<void>;
}

function pendingVaultStorageKey(owner: Address, registry: Address) {
  return `4lpha-0g:galileo-vault-pending:${GALILEO_CHAIN_ID}:${owner.toLowerCase()}:${registry.toLowerCase()}`;
}

function readPendingVault(owner: Address, registry: Address): Address | null {
  if (typeof window === "undefined") return null;
  const value = window.localStorage.getItem(pendingVaultStorageKey(owner, registry));
  return value && /^0x[a-fA-F0-9]{40}$/.test(value) ? value as Address : null;
}

function persistPendingVault(owner: Address, registry: Address, vault: Address) {
  window.localStorage.setItem(pendingVaultStorageKey(owner, registry), vault);
}

function clearPendingVault(owner: Address, registry: Address) {
  if (typeof window !== "undefined") window.localStorage.removeItem(pendingVaultStorageKey(owner, registry));
}

/** A testnet-only wallet surface. It cannot read or reuse a mainnet V4 trio. */
export function useGalileoWalletVault(testnetEnabled: boolean): GalileoVaultState {
  const account = useAccount();
  const chainId = useChainId();
  const switchChain = useSwitchChain();
  const stack = useMemo(resolveGalileoVaultStack, []);
  const client = useMemo(() => createPublicClient({ chain: OG_GALILEO_CHAIN, transport: http(OG_GALILEO_CHAIN.rpcUrls.default.http[0]) }), []);
  const [vaultAddress, setVaultAddress] = useState<Address | null>(null);
  const [attested, setAttested] = useState<boolean | null>(null);
  const [paused, setPausedState] = useState<boolean | null>(null);
  const [executorRevoked, setExecutorRevoked] = useState<boolean | null>(null);
  const [agentKeyEnabled, setAgentKeyEnabledState] = useState<boolean | null>(null);
  const [poolNativeReserve, setPoolNativeReserve] = useState<bigint | null>(null);
  const [poolTokenReserve, setPoolTokenReserve] = useState<bigint | null>(null);
  const [faucetBalance, setFaucetBalance] = useState<bigint | null>(null);
  const [attestationRequest, setAttestationRequest] = useState<GalileoVaultAttestationRequest | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [status, setStatus] = useState("Galileo stack configuration is required before vault actions are available.");

  const assertStack = useCallback(async (): Promise<VerifiedGalileoVaultStack> => {
    if (!stack) throw new Error("Galileo public stack addresses are not configured.");
    if (await client.getChainId() !== GALILEO_CHAIN_ID) throw new Error("Galileo RPC chain mismatch; expected 16602.");
    const code = await Promise.all(Object.values(stack).map((address) => client.getCode({ address })));
    if (code.some((item) => !item || item === "0x")) throw new Error("Galileo stack bytecode verification failed.");
    const [adapter, proofRegistry, token, poolId, executor] = await Promise.all([
      client.readContract({ address: stack.vaultRegistry, abi: galileoVaultRegistryAbi, functionName: "expectedAdapter" }),
      client.readContract({ address: stack.vaultRegistry, abi: galileoVaultRegistryAbi, functionName: "expectedProofRegistry" }),
      client.readContract({ address: stack.vaultRegistry, abi: galileoVaultRegistryAbi, functionName: "expectedToken" }),
      client.readContract({ address: stack.vaultRegistry, abi: galileoVaultRegistryAbi, functionName: "expectedPoolId" }),
      client.readContract({ address: stack.vaultRegistry, abi: galileoVaultRegistryAbi, functionName: "expectedExecutor" }),
    ]);
    if (adapter.toLowerCase() !== stack.adapter.toLowerCase() || token.toLowerCase() !== stack.sandboxToken.toLowerCase() || proofRegistry === ZERO_ADDRESS || executor === ZERO_ADDRESS || poolId === "0x".padEnd(66, "0")) {
      throw new Error("Galileo registry configuration does not match the configured stack.");
    }
    const proofCode = await client.getCode({ address: proofRegistry });
    if (!proofCode || proofCode === "0x") throw new Error("Galileo ProofRegistry bytecode verification failed.");
    return { ...stack, executor, poolId, proofRegistry };
  }, [client, stack]);

  const verifyVaultConfiguration = useCallback(async (verified: VerifiedGalileoVaultStack, vault: Address, owner: Address) => {
    const code = await client.getCode({ address: vault });
    if (!code || code === "0x") throw new Error("Galileo vault deployment has no bytecode.");
    const [vaultOwner, executor, adapter, proofRegistry, registry, mockAllowed, tokenAllowed, poolAllowed] = await Promise.all([
      client.readContract({ address: vault, abi: galileoVaultAbi, functionName: "owner" }),
      client.readContract({ address: vault, abi: galileoVaultAbi, functionName: "executor" }),
      client.readContract({ address: vault, abi: galileoVaultAbi, functionName: "swapAdapter" }),
      client.readContract({ address: vault, abi: galileoVaultAbi, functionName: "proofRegistry" }),
      client.readContract({ address: vault, abi: galileoVaultAbi, functionName: "vaultRegistry" }),
      client.readContract({ address: vault, abi: galileoVaultAbi, functionName: "mockAdapterAllowed" }),
      client.readContract({ address: vault, abi: galileoVaultAbi, functionName: "allowedTokens", args: [verified.sandboxToken] }),
      client.readContract({ address: vault, abi: galileoVaultAbi, functionName: "allowedPools", args: [verified.poolId] }),
    ]);
    if (vaultOwner.toLowerCase() !== owner.toLowerCase() || executor.toLowerCase() !== verified.executor.toLowerCase() || adapter.toLowerCase() !== verified.adapter.toLowerCase() || proofRegistry.toLowerCase() !== verified.proofRegistry.toLowerCase() || registry.toLowerCase() !== verified.vaultRegistry.toLowerCase() || mockAllowed || !tokenAllowed || !poolAllowed) {
      throw new Error("Vault configuration does not match the dedicated Galileo stack.");
    }
  }, [client]);

  const refresh = useCallback(async () => {
    if (!account.address || !stack) {
      setVaultAddress(null); setAttested(null); setPausedState(null); setExecutorRevoked(null); setAgentKeyEnabledState(null); setAttestationRequest(null);
      setStatus("Connect a wallet and configure the dedicated Galileo stack.");
      return;
    }
    try {
      const verified = await assertStack();
      const registeredVault = await client.readContract({ address: verified.vaultRegistry, abi: galileoVaultRegistryAbi, functionName: "vaultOf", args: [account.address] });
      const balance = await client.readContract({ address: verified.sandboxToken, abi: galileoFaucetAbi, functionName: "balanceOf", args: [account.address] });
      const [nativeReserve, tokenReserve] = await Promise.all([
        client.readContract({ address: verified.pool, abi: galileoSandboxPoolAbi, functionName: "nativeReserve" }),
        client.readContract({ address: verified.pool, abi: galileoSandboxPoolAbi, functionName: "tokenReserve" }),
      ]);
      setFaucetBalance(balance); setPoolNativeReserve(nativeReserve); setPoolTokenReserve(tokenReserve);
      const vault = registeredVault === ZERO_ADDRESS ? readPendingVault(account.address, verified.vaultRegistry) : registeredVault;
      if (!vault) { setVaultAddress(null); setAttested(false); setAttestationRequest(null); setStatus("No Galileo Swap Vault is registered for this wallet."); return; }
      await verifyVaultConfiguration(verified, vault, account.address);
      const [isAttested, isPaused, revoked] = await Promise.all([
        client.readContract({ address: verified.vaultRegistry, abi: galileoVaultRegistryAbi, functionName: "isAttestedVault", args: [vault] }),
        client.readContract({ address: vault, abi: galileoVaultAbi, functionName: "paused" }),
        client.readContract({ address: vault, abi: galileoVaultAbi, functionName: "executorRevoked" }),
      ]);
      setVaultAddress(vault); setAttested(isAttested); setPausedState(isPaused); setExecutorRevoked(revoked);
      if (isAttested) { clearPendingVault(account.address, verified.vaultRegistry); setAttestationRequest(null); setStatus("Attested Galileo Swap Vault verified on chain 16602."); }
      else setStatus("Vault deployment is verified locally and awaiting dedicated server attestation.");
    } catch (error) { setStatus(error instanceof Error ? error.message : "Galileo vault verification failed."); }
  }, [account.address, assertStack, client, stack, verifyVaultConfiguration]);

  useEffect(() => {
    if (!testnetEnabled) return;
    void refresh();
  }, [refresh, testnetEnabled]);

  const walletForGalileo = useCallback(async () => {
    if (!account.address) throw new Error("Connect the owner wallet first.");
    if (chainId !== GALILEO_CHAIN_ID) await switchChain.switchChainAsync({ chainId: GALILEO_CHAIN_ID });
    const ethereum = (window as Window & { ethereum?: EIP1193Provider }).ethereum;
    if (!ethereum) throw new Error("No browser wallet provider is available.");
    const wallet = createWalletClient({ account: account.address, chain: OG_GALILEO_CHAIN, transport: custom(ethereum) });
    if (await wallet.getChainId() !== GALILEO_CHAIN_ID) throw new Error("Wallet chain mismatch; switch to Galileo (16602) before signing.");
    return wallet;
  }, [account.address, chainId, switchChain]);

  const createVault = useCallback(async () => {
    if (!account.address) { setStatus("Connect the owner wallet first."); return; }
    setIsBusy(true);
    try {
      const verified = await assertStack();
      const existing = await client.readContract({ address: verified.vaultRegistry, abi: galileoVaultRegistryAbi, functionName: "vaultOf", args: [account.address] });
      if (existing !== ZERO_ADDRESS) { await verifyVaultConfiguration(verified, existing, account.address); setStatus("A correctly configured Galileo vault is already registered; no second vault was deployed."); await refresh(); return; }
      const pending = readPendingVault(account.address, verified.vaultRegistry);
      if (pending) { await verifyVaultConfiguration(verified, pending, account.address); setVaultAddress(pending); setAttested(false); setStatus("A previously deployed Galileo vault is awaiting dedicated server attestation; no second vault was deployed."); return; }
      const wallet = await walletForGalileo();
      const deploymentTxHash = await wallet.deployContract({
        account: account.address,
        abi: galileoVaultDeploymentAbi,
        bytecode: galileoVaultDeploymentBytecode,
        args: [account.address, verified.executor, verified.adapter, verified.proofRegistry, GALILEO_DEFAULT_VAULT_POLICY, verified.sandboxToken, verified.poolId, verified.vaultRegistry],
      });
      setStatus(`Galileo Swap Vault deployment submitted: ${deploymentTxHash.slice(0, 10)}…`);
      const receipt = await client.waitForTransactionReceipt({ hash: deploymentTxHash });
      const vault = receipt.contractAddress;
      if (!vault) throw new Error("Galileo vault deployment transaction did not create a contract.");
      await verifyVaultConfiguration(verified, vault, account.address);
      persistPendingVault(account.address, verified.vaultRegistry, vault);
      setVaultAddress(vault); setAttested(false);
      setAttestationRequest({ adapter: verified.adapter, chainId: GALILEO_CHAIN_ID, deploymentTxHash, executor: verified.executor, poolId: verified.poolId, proofRegistry: verified.proofRegistry, sandboxToken: verified.sandboxToken, vault, vaultRegistry: verified.vaultRegistry });
      setStatus("Vault deployed and configuration verified. The dedicated server attestor must now attest this exact vault; the client cannot self-attest.");
    } catch (error) { setStatus(error instanceof Error ? error.message : "Galileo vault deployment failed."); }
    finally { setIsBusy(false); }
  }, [account.address, assertStack, client, refresh, verifyVaultConfiguration, walletForGalileo]);

  const write = useCallback(async (label: string, action: (verified: VerifiedGalileoVaultStack, vault: Address, wallet: Awaited<ReturnType<typeof walletForGalileo>>) => Promise<Hex>) => {
    if (!account.address || !vaultAddress || !attested) { setStatus("An attested Galileo vault is required."); return; }
    setIsBusy(true);
    try {
      const verified = await assertStack();
      const wallet = await walletForGalileo();
      const hash = await action(verified, vaultAddress, wallet);
      setStatus(`${label} submitted on Galileo: ${hash.slice(0, 10)}…`);
      await client.waitForTransactionReceipt({ hash });
      await refresh();
    } catch (error) { setStatus(error instanceof Error ? error.message : `${label} failed.`); }
    finally { setIsBusy(false); }
  }, [account.address, assertStack, attested, client, refresh, vaultAddress, walletForGalileo]);

  const requestFaucet = useCallback(async () => {
    if (!account.address) { setStatus("Connect the recipient wallet first."); return; }
    setIsBusy(true);
    try {
      const verified = await assertStack();
      const wallet = await walletForGalileo();
      const hash = await wallet.writeContract({ account: account.address, chain: OG_GALILEO_CHAIN, address: verified.sandboxToken, abi: galileoFaucetAbi, functionName: "claimFaucet" });
      setStatus(`mUSDC faucet claim submitted: ${hash.slice(0, 10)}…`); await client.waitForTransactionReceipt({ hash }); await refresh();
    } catch (error) { setStatus(error instanceof Error ? error.message : "Faucet claim failed."); } finally { setIsBusy(false); }
  }, [account.address, assertStack, client, refresh, walletForGalileo]);

  return {
    agentKeyEnabled, attestationRequest, attested, canCreate: Boolean(stack && account.address && !vaultAddress && !isBusy), canWrite: Boolean(stack && account.address && vaultAddress && attested && !isBusy), createVault, executorRevoked, faucetBalance, isBusy, paused, poolNativeReserve, poolTokenReserve, refresh, requestFaucet, status, vaultAddress,
    deposit: (amount) => write("Deposit", async (_stack, vault, wallet) => wallet.writeContract({ account: account.address as Address, chain: OG_GALILEO_CHAIN, address: vault, abi: galileoVaultAbi, functionName: "depositNative", value: parseEther(amount) })),
    withdraw: (amount) => write("Withdrawal", async (_stack, vault, wallet) => wallet.writeContract({ account: account.address as Address, chain: OG_GALILEO_CHAIN, address: vault, abi: galileoVaultAbi, functionName: "withdrawNative", args: [parseEther(amount)] })),
    setPaused: (value) => write(value ? "Pause" : "Unpause", async (_stack, vault, wallet) => wallet.writeContract({ account: account.address as Address, chain: OG_GALILEO_CHAIN, address: vault, abi: galileoVaultAbi, functionName: "setPaused", args: [value] })),
    revokeExecutor: () => write("Executor revocation", async (_stack, vault, wallet) => wallet.writeContract({ account: account.address as Address, chain: OG_GALILEO_CHAIN, address: vault, abi: galileoVaultAbi, functionName: "revokeExecutor" })),
    setAgentKeyEnabled: async (key, enabled) => {
      if (!/^0x[0-9a-fA-F]{64}$/.test(key)) { setStatus("A server-derived 32-byte Galileo agent key is required."); return; }
      await write(enabled ? "Agent-key enable" : "Agent-key disable", async (_stack, vault, wallet) => wallet.writeContract({ account: account.address as Address, chain: OG_GALILEO_CHAIN, address: vault, abi: galileoVaultAbi, functionName: "setAgentKeyEnabled", args: [key, enabled] }));
      if (vaultAddress) setAgentKeyEnabledState(enabled);
    },
  };
}
