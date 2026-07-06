// Rescue-sell the deployer's legacy V2 PolicyVault token positions so the vault
// can be migrated to V3. The V2 vault is deny-by-default and tracks per-token
// `positionUnits` AND per-agentKey `agentPositionUnits`; both are only
// decremented by an executor `sell` through the vault. `rescueToken` (owner)
// moves the ERC20 balance but leaves both counters > 0, which keeps
// `assertLegacyVaultIsNativeOnly` blocking the migration. So the only correct
// way to clear the positions is a real executor sell via the curated routes.
//
// V2 sell requires agentPositionUnits[agentKey][tokenIn] >= amountIn, so each
// position must be sold under the agentKey that opened it, and that key must be
// enabled. This script:
//   1. Maps every open (token, agentKey) position by reading agentPositionUnits
//      for the registry agent keys AND the ghost key discovered via event scan
//      (0x972b26ab... — owns 258362604020 raw WETH, no registry record).
//   2. Quotes each sell via quoteCuratedTrade (auto-quotes the best ZIA route).
//   3. Dry-run: prints the full plan. No txs.
//   4. Broadcast (MAINNET_V2_RESCUE_SELL_EXECUTE=true):
//      a. Batch-re-enable every disabled owning agentKey via setAgentKeysEnabled
//         (DEPLOYER owner admin, single tx).
//      b. For each position: executeCuratedTrade — the 2-key mainnet proof flow
//         (DEPLOYER accepts the audit proof, EXECUTOR submits the vault sell).
//
// The proof registry owner is the deployer, not the executor, so a single-key
// executor sell is rejected — the 2-key flow is mandatory.
//
// Gates: dry-run by default. Set MAINNET_V2_RESCUE_SELL_EXECUTE=true to
// broadcast (real gas: 1 DEPLOYER re-enable tx + 4x (DEPLOYER proof + EXECUTOR
// sell) = 9 mainnet txs). Also requires the live-trading env gates that
// executeCuratedTrade enforces (AGENT_TRADE_LIVE_ENABLED=true,
// ENABLE_REAL_DEX_ADAPTER=true, ENABLE_MOCK_DEX_ADAPTER=false).

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import dotenv from "dotenv";
dotenv.config({ path: ".env.local", quiet: true });

import {
  createPublicClient,
  createWalletClient,
  formatUnits,
  getAddress,
  http,
  type Address,
  type Chain,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { MAINNET_TOKENS } from "@/lib/contracts/curated-routes";
import { policyVaultAbi, policyVaultAgentKeyAbi } from "@/lib/contracts/policy-vault";
import {
  executeCuratedTrade,
  quoteCuratedTrade,
} from "@/lib/agent/curated-trade";

const MAINNET_CHAIN_ID = 16661;
const AGENT_REGISTRY_PATH = join(".data", "agents", "mainnet-agents.json");

// Ghost agentKey discovered by scanning TradeExecutedV2 events on the V2 vault.
// It owns 258362604020 raw WETH (no registry record — likely a dev/test deploy
// whose record was overwritten). Required to clear the orphaned WETH position.
const GHOST_AGENT_KEY: Hex = "0x972b26ab3e82bcbd57fd669530646aa3bb1f8b41fc8988cee04ab051471c1c0c";

const V2_VAULT: Address = getAddress("0x20b45F0BC16837173a9090C6e9E991214ECc9f0d");

const CURATED_TOKENS: { symbol: string; address: Address; decimals: number }[] = [
  { symbol: "USDC.e", address: MAINNET_TOKENS.USDC_E, decimals: 6 },
  { symbol: "WETH", address: MAINNET_TOKENS.WETH, decimals: 18 },
];

const erc20Abi = [
  {
    inputs: [{ internalType: "address", name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "decimals",
    outputs: [{ internalType: "uint8", name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const setAgentKeysEnabledAbi = [
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

interface AgentKey {
  id: string;
  agentKey: Hex;
  ghost: boolean;
}

async function loadRegistryAgents(deployer: Address): Promise<AgentKey[]> {
  let raw: string;
  try {
    raw = await readFile(AGENT_REGISTRY_PATH, "utf8");
  } catch {
    return [];
  }
  const parsed = JSON.parse(raw) as { agents?: { id: string; owner: Address; agentKey?: Hex }[] };
  const arr = parsed.agents ?? [];
  return arr
    .filter((a) => a.owner && a.owner.toLowerCase() === deployer.toLowerCase() && a.agentKey)
    .map((a) => ({ id: a.id, agentKey: a.agentKey as Hex, ghost: false }));
}

function makeChain(rpcUrl: string): Chain {
  return {
    id: MAINNET_CHAIN_ID,
    name: "0G Mainnet",
    nativeCurrency: { decimals: 18, name: "0G", symbol: "0G" },
    rpcUrls: { default: { http: [rpcUrl] } },
  };
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") throw new Error(`Missing env ${name}`);
  return v.trim();
}

function readBoolEnv(name: string): boolean {
  const v = process.env[name];
  if (!v || v === "") return false;
  return v.trim().toLowerCase() === "true" || v.trim() === "1";
}

function readDeployerKey(): `0x${string}` {
  const v = process.env.DEPLOYER_PRIVATE_KEY;
  if (!v || !v.startsWith("0x")) throw new Error("DEPLOYER_PRIVATE_KEY is not set or not 0x-prefixed.");
  return v as `0x${string}`;
}

async function main() {
  const rpcUrl = requireEnv("OG_RPC_URL");
  const chain = makeChain(rpcUrl);
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });

  const deployerAccount = privateKeyToAccount(readDeployerKey());
  const deployer = getAddress(deployerAccount.address);
  console.log("Deployer (proof signer + vault owner):", deployer);
  console.log("V2 vault:", V2_VAULT);

  const [ownerOnChain, executorOnChain, proofRegOnChain] = await Promise.all([
    publicClient.readContract({ address: V2_VAULT, abi: policyVaultAbi, functionName: "owner" }) as Promise<Address>,
    publicClient.readContract({ address: V2_VAULT, abi: policyVaultAbi, functionName: "executor" }) as Promise<Address>,
    publicClient.readContract({ address: V2_VAULT, abi: policyVaultAbi, functionName: "proofRegistry" }) as Promise<Address>,
  ]);
  console.log("Vault owner on-chain:", ownerOnChain);
  console.log("Vault executor on-chain:", executorOnChain);
  console.log("Vault proofRegistry on-chain:", proofRegOnChain);
  if (ownerOnChain.toLowerCase() !== deployer.toLowerCase()) {
    throw new Error(`Vault owner mismatch: on-chain ${ownerOnChain} != deployer ${deployer}`);
  }

  // Build the full agentKey set: registry agents + the ghost key.
  const registryAgents = await loadRegistryAgents(deployer);
  const agents: AgentKey[] = [...registryAgents];
  if (!agents.some((a) => a.agentKey.toLowerCase() === GHOST_AGENT_KEY.toLowerCase())) {
    agents.push({ id: "ghost-0x972b26ab", agentKey: GHOST_AGENT_KEY, ghost: true });
  }
  console.log("\nAgent keys considered:", agents.map((a) => `${a.id}=${a.agentKey.slice(0, 10)}...`).join(", "));

  // Map every open (token, agentKey) position via agentPositionUnits.
  const positions: {
    token: { symbol: string; address: Address; decimals: number };
    agent: AgentKey;
    unitsRaw: bigint;
    amountFormatted: string;
    enabled: boolean;
  }[] = [];
  console.log("\nPer-key per-token agentPositionUnits (open positions only):");
  for (const agent of agents) {
    let enabled = false;
    try {
      enabled = Boolean(
        await publicClient.readContract({
          address: V2_VAULT,
          abi: policyVaultAgentKeyAbi,
          functionName: "agentKeyEnabled",
          args: [agent.agentKey],
        }),
      );
    } catch {
      enabled = false;
    }
    for (const token of CURATED_TOKENS) {
      let units = 0n;
      try {
        units = BigInt(
          (await publicClient.readContract({
            address: V2_VAULT,
            abi: policyVaultAgentKeyAbi,
            functionName: "agentPositionUnits",
            args: [agent.agentKey, token.address],
          })) as bigint,
        );
      } catch {
        units = 0n;
      }
      if (units > 0n) {
        const decimals = await publicClient
          .readContract({ address: token.address, abi: erc20Abi, functionName: "decimals" })
          .then((d) => Number(d))
          .catch(() => token.decimals);
        console.log(`  ${agent.id} key=${agent.agentKey.slice(0, 10)}... ${token.symbol} units=${units.toString()} enabled=${enabled}`);
        positions.push({
          token: { symbol: token.symbol, address: token.address, decimals },
          agent,
          unitsRaw: units,
          amountFormatted: formatUnits(units, decimals),
          enabled,
        });
      }
    }
  }

  if (positions.length === 0) {
    console.log("\nNo open V2 token positions found — vault is already native-only. Nothing to sell.");
    return;
  }

  // Cross-check: sum of agentPositionUnits per token must equal on-chain
  // positionUnits + balanceOf, else an unknown key still owns a position.
  for (const token of CURATED_TOKENS) {
    const [posUnits, bal] = await Promise.all([
      publicClient.readContract({ address: V2_VAULT, abi: policyVaultAbi, functionName: "positionUnits", args: [token.address] }) as Promise<bigint>,
      publicClient.readContract({ address: token.address, abi: erc20Abi, functionName: "balanceOf", args: [V2_VAULT] }) as Promise<bigint>,
    ]);
    const sumByAgents = positions
      .filter((p) => p.token.address.toLowerCase() === token.address.toLowerCase())
      .reduce((acc, p) => acc + p.unitsRaw, 0n);
    console.log(`\n${token.symbol}: positionUnits=${posUnits.toString()} balanceOf=${bal.toString()} sumByKnownKeys=${sumByAgents.toString()}`);
    if (sumByAgents !== posUnits || sumByAgents !== bal) {
      console.log(`  WARNING: mismatch — an unknown agentKey still owns ${posUnits - sumByAgents} raw ${token.symbol}. Migration will stay blocked.`);
    }
  }

  // Quote each sell.
  console.log("\nQuotes:");
  const sellPlans: {
    position: (typeof positions)[number];
    quote: Awaited<ReturnType<typeof quoteCuratedTrade>>;
    quoteError?: string;
  }[] = [];
  for (const p of positions) {
    try {
      const quote = await quoteCuratedTrade({
        amount: p.amountFormatted,
        networkId: "mainnet",
        side: "sell",
        tokenAddress: p.token.address,
        vaultAddress: V2_VAULT,
      });
      sellPlans.push({ position: p, quote });
      console.log(
        `  ${p.agent.id} sell ${p.token.symbol} ${p.amountFormatted} -> ${quote.quotedAmountOutFormatted} 0G (min ${quote.amountOutMinFormatted}, route ${quote.route.label}, canExecute=${quote.canExecute})`,
      );
      if (quote.warnings.length > 0) console.log(`    warnings: ${quote.warnings.join("; ")}`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      sellPlans.push({ position: p, quote: null as never, quoteError: msg });
      console.log(`  ${p.agent.id} sell ${p.token.symbol} ${p.amountFormatted} FAILED: ${msg}`);
    }
  }

  const executable = sellPlans.filter((p) => !p.quoteError && p.quote.canExecute && p.quote.quotedAmountOut !== "0");
  const disabledOwningKeys = Array.from(
    new Map(
      positions
        .filter((p) => !p.enabled && executable.some((e) => e.position === p))
        .map((p) => [p.agent.agentKey.toLowerCase(), p.agent.agentKey]),
    ).values(),
  );

  if (executable.length === 0) {
    console.log("\nNo position can be sold cleanly. Manual review required.");
    return;
  }

  console.log(`\nExecutable sells: ${executable.length}`);
  console.log(`Disabled owning keys to re-enable: ${disabledOwningKeys.length} (${disabledOwningKeys.map((k) => k.slice(0, 10)).join(", ")})`);

  if (!readBoolEnv("MAINNET_V2_RESCUE_SELL_EXECUTE")) {
    console.log("\nDry-run only. No transactions sent.");
    console.log("Set MAINNET_V2_RESCUE_SELL_EXECUTE=true to broadcast:");
    console.log("  1. setAgentKeysEnabled(disabledOwningKeys, true) — DEPLOYER owner admin tx");
    console.log("  2. For each position: DEPLOYER acceptProof + EXECUTOR sell (2-key flow)");
    console.log(`  Total: ${1 + executable.length * 2} mainnet txs (real gas).`);
    return;
  }

  // Step 1: batch-re-enable disabled owning agentKeys.
  if (disabledOwningKeys.length > 0) {
    console.log("\n[1] Re-enabling owning agentKeys via setAgentKeysEnabled (DEPLOYER)...");
    const deployerWallet = createWalletClient({ account: deployerAccount, chain, transport: http(rpcUrl) });
    const sim = await publicClient.simulateContract({
      account: deployerAccount.address,
      address: V2_VAULT,
      abi: setAgentKeysEnabledAbi,
      functionName: "setAgentKeysEnabled",
      args: [disabledOwningKeys, true],
    });
    const reEnableTx = await deployerWallet.writeContract({ ...sim.request, account: deployerAccount, chain });
    console.log(`  setAgentKeysEnabled tx: ${reEnableTx}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: reEnableTx });
    console.log(`  confirmed in block ${receipt.blockNumber}, status=${receipt.status}`);
    if (receipt.status !== "success") throw new Error("setAgentKeysEnabled reverted");
  }

  // Step 2: sell each position via the 2-key proof flow.
  console.log("\n[2] Selling each position via executeCuratedTrade (2-key proof flow)...");
  for (const plan of executable) {
    const p = plan.position;
    console.log(`\n  Selling ${p.token.symbol} ${p.amountFormatted} under ${p.agent.id} (key ${p.agent.agentKey.slice(0, 10)}...)...`);
    const execution = await executeCuratedTrade({
      agentRef: `4lpha-0g:v2-rescue-sell:${p.agent.id}`,
      agentKey: p.agent.agentKey,
      amount: p.amountFormatted,
      networkId: "mainnet",
      side: "sell",
      tokenAddress: p.token.address,
      vaultAddress: V2_VAULT,
    });
    console.log(`    proofTx: ${execution.proofTxHash}`);
    console.log(`    sellTx:  ${execution.executionTxHash}`);
    console.log(`    auditRoot: ${execution.auditRoot}`);
  }

  console.log("\nRescue sells complete. Re-check positionUnits + balanceOf before migrating to V3.");
}

main().catch((error) => {
  console.error(`Rescue sell failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});