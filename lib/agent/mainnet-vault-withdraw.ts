import "server-only";

import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  parseEther,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { policyVaultV3Abi } from "@/lib/contracts/policy-vault-v3";
import { resolveMainnetV3VaultForOwner } from "@/lib/agent/mainnet-vault-resolver";
import { OgAgentDeployError } from "@/lib/agent/single-agent-server";

// Owner-initiated native 0G withdrawal from the V3 Policy Vault. The vault's
// `withdrawNative(amount)` is `onlyOwner` and sends native 0G to `msg.sender`
// (the owner). On mainnet the DEPLOYER key IS the vault owner for the demo
// (V3 singleton, deployer-owned), so the server signs with DEPLOYER_PRIVATE_KEY
// and the on-chain `owner` check enforces that the signer is the owner. The
// route layer additionally verifies the connected wallet === vault owner before
// calling this, so the user's signed consent maps to the same identity that
// receives the funds. Never auto-broadcast — the route gates on
// ENABLE_MAINNET_WITHDRAW + confirmedSteps:["withdraw-native"] + action-consent.

const MAINNET_CHAIN_ID = 16661;
const RPC_TIMEOUT_MS = 8_000;

export interface MainnetVaultWithdrawResult {
  txHash: Hex;
  amount0G: string;
  balanceBefore0G: string;
  balanceAfter0G: string;
  vault: Address;
}

export async function withdrawMainnetVaultNative(input: {
  owner: Address;
  amount0G: string;
}): Promise<MainnetVaultWithdrawResult> {
  const amountWei = parsePositive0G(input.amount0G);

  const rpcUrl = requireEnv("OG_RPC_URL");
  const chain = make0GMainnetChain(rpcUrl);
  const publicClient = createPublicClient({
    chain,
    transport: http(rpcUrl, { retryCount: 0, timeout: RPC_TIMEOUT_MS }),
  });

  const actualChainId = await publicClient.getChainId();
  if (actualChainId !== MAINNET_CHAIN_ID) {
    throw new OgAgentDeployError(
      `RPC chain mismatch: expected ${MAINNET_CHAIN_ID}, got ${actualChainId}.`,
      "chain_mismatch",
      500,
    );
  }

  const vault = await resolveMainnetV3VaultForOwner(input.owner, publicClient);
  if (!vault) {
    throw new OgAgentDeployError(
      "No V3 Policy Vault is registered for this owner. Run npm run vault:mainnet:create:v3 first.",
      "v3_vault_not_found",
      409,
    );
  }

  // On-chain owner check. The signer (DEPLOYER) must be the vault owner —
  // withdrawNative is onlyOwner and pays native to msg.sender. If the DEPLOYER
  // key is not the vault owner, the simulate would revert; surface a clear
  // server error instead of a generic revert.
  const deployer = privateKeyToAccount(readPrivateKeyEnv("DEPLOYER_PRIVATE_KEY"));
  const vaultOwner = await publicClient.readContract({
    address: vault,
    abi: policyVaultV3Abi,
    functionName: "owner",
  });
  if (getAddress(vaultOwner) !== getAddress(deployer.address)) {
    throw new OgAgentDeployError(
      "DEPLOYER_PRIVATE_KEY must be the V3 vault owner to withdraw native 0G.",
      "signer_not_owner",
      500,
    );
  }
  // The connected wallet (input.owner) must also be the vault owner — the
  // route enforces this, but re-check here so the helper is safe to call.
  if (getAddress(vaultOwner) !== getAddress(input.owner)) {
    throw new OgAgentDeployError(
      "Connected wallet is not the Policy Vault owner.",
      "owner_required",
      403,
    );
  }

  const balanceBefore = await publicClient.getBalance({ address: vault });
  if (amountWei > balanceBefore) {
    throw new OgAgentDeployError(
      `Withdrawal ${format0G(amountWei)} 0G exceeds vault balance ${format0G(balanceBefore)} 0G.`,
      "insufficient_balance",
      400,
    );
  }

  const walletClient = createWalletClient({ account: deployer, chain, transport: http(rpcUrl) });
  const simulation = await publicClient.simulateContract({
    account: deployer.address,
    address: vault,
    abi: policyVaultV3Abi,
    functionName: "withdrawNative",
    args: [amountWei],
  });
  const txHash = await walletClient.writeContract({
    ...simulation.request,
    account: deployer,
    chain,
  });
  await waitForReceipt(publicClient, txHash, "Withdraw native 0G");
  const balanceAfter = await publicClient.getBalance({ address: vault });

  return {
    txHash,
    amount0G: format0G(amountWei),
    balanceBefore0G: format0G(balanceBefore),
    balanceAfter0G: format0G(balanceAfter),
    vault,
  };
}

function parsePositive0G(value: string): bigint {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{1,18})?$/u.test(normalized)) {
    throw new OgAgentDeployError(
      "0G amount must be a positive decimal value with at most 18 fractional digits.",
      "invalid_amount",
      400,
    );
  }
  const wei = parseEther(normalized);
  if (wei <= 0n) {
    throw new OgAgentDeployError("0G withdrawal amount must be greater than zero.", "invalid_amount", 400);
  }
  return wei;
}

function format0G(wei: bigint): string {
  // 18 decimals -> decimal string with up to 18 fractional digits, trailing
  // zeros trimmed. Keeps the UI honest about exact vault balance.
  const negative = wei < 0n;
  const abs = negative ? -wei : wei;
  const padded = abs.toString().padStart(19, "0");
  const whole = padded.slice(0, -18) || "0";
  let frac = padded.slice(-18).replace(/0+$/u, "");
  if (frac.length > 0) frac = `.${frac}`;
  return `${negative ? "-" : ""}${whole}${frac}`;
}

function make0GMainnetChain(rpcUrl: string): Chain {
  return {
    id: MAINNET_CHAIN_ID,
    name: "0G Mainnet",
    nativeCurrency: { decimals: 18, name: "0G", symbol: "0G" },
    rpcUrls: { default: { http: [rpcUrl] } },
    blockExplorers: { default: { name: "0G ChainScan", url: "https://chainscan.0g.ai" } },
  };
}

async function waitForReceipt(publicClient: PublicClient, hash: Hex, label: string) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const receipt = await publicClient.getTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        throw new OgAgentDeployError(`${label} transaction reverted: ${hash}`, "tx_reverted", 500);
      }
      return receipt;
    } catch (error) {
      if (error instanceof OgAgentDeployError) throw error;
      // fall through and retry until the receipt is mined
    }
    await sleep(2_000);
  }
  throw new OgAgentDeployError(`${label} transaction not mined after 5 minutes: ${hash}`, "tx_timeout", 500);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new OgAgentDeployError(`${name} is required.`, "env_missing", 500);
  }
  return value;
}

function readPrivateKeyEnv(name: string): Hex {
  const value = process.env[name]?.trim();
  if (!value || !/^0x[0-9a-fA-F]{64}$/u.test(value)) {
    throw new OgAgentDeployError(`${name} must be a 0x-prefixed 32-byte private key.`, "env_missing", 500);
  }
  return value as Hex;
}
