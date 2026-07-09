// One-off recovery for the abandoned old-V3 LP agents #9/#10/#11/#12 (pre-public
// V4 cleanup). Standard tooling is broken for these: loadOgAgentWorkspace resolves
// the WRONG record (tokenId 9-12 collide with removed TRADE agents on a different
// AgenticID contract) and withdrawMainnetVaultNative targets the owner's CURRENT
// V4 vault. So this script drives everything by the EXACT registry record + vault
// address: unstake+zap-out known positions, withdraw native directly on the old
// vault, disable the agent key, remove the record.
//
// Real money. DEPLOYER (owner) + VAULT_EXECUTOR pay gas. Step-gated. Usage:
//   node --conditions=react-server --import tsx scripts/lp-recover-old-lps.ts --agent-id agent-0g-mainnet-12 --phase read
//   node --conditions=react-server --import tsx scripts/lp-recover-old-lps.ts --agent-id agent-0g-mainnet-12 --phase all

import dotenv from "dotenv";
import { readFile } from "node:fs/promises";
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  getAddress,
  http,
  parseEther,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { executeMainnetPolicyVaultLpAction } from "../lib/executor/policy-vault-lp";
import { quoteLpZapOut } from "../lib/agent/lp/lp-zapout-quote";
import { removeSingleOgAgentRecord } from "../lib/agent/single-agent-server";
import { policyVaultV3Abi } from "../lib/contracts/policy-vault-v3";
import { findZiaLpVaultByPool, ziaNonfungiblePositionManagerAbi, ZIA_LP_MAINNET } from "../lib/contracts/zia-lp";

dotenv.config({ path: ".env.local", quiet: true });

// quiknode (fast, reliable receipts) as the tx/read RPC; reads here are few +
// sequential so we stay under 15 req/s. executeMainnetPolicyVaultLpAction + the
// direct writes read OG_RPC_URL, so point it at quiknode for this run.
const RPC = process.env.OG_MAINNET_RPC_URL?.trim() || process.env.OG_RPC_URL?.trim() || "https://evmrpc.0g.ai";
process.env.OG_RPC_URL = RPC;
const CHAIN_ID = 16661;

// Known on-chain staked/unstaked positions per agent (discovered via NFPM
// enumeration of the stake vault + lpNftPool cross-check on the policy vault).
const POSITIONS: Record<string, { tokenId: string; poolAddress: Address }[]> = {
  "agent-0g-mainnet-9": [],
  "agent-0g-mainnet-10": [],
  "agent-0g-mainnet-11": [],
  "agent-0g-mainnet-12": [
    { tokenId: "4573", poolAddress: getAddress("0x159fe1d57b464eD60E2bfbBCA0dF444999131673") }, // USDC/W0G
  ],
};

type Phase = "read" | "unstake" | "zap-out" | "withdraw" | "disable-key" | "remove" | "all";

function parseArgs(argv: string[]): { agentId: string; phase: Phase } {
  let agentId = "";
  let phase: Phase = "read";
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--agent-id") agentId = argv[++i] ?? "";
    else if (argv[i] === "--phase") phase = (argv[++i] ?? "read") as Phase;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!/^agent-0g-mainnet-\d+$/u.test(agentId)) throw new Error("--agent-id agent-0g-mainnet-N is required.");
  return { agentId, phase };
}

function readPk(name: string): Hex {
  const v = process.env[name]?.trim();
  if (!v || !/^0x[0-9a-fA-F]{64}$/u.test(v)) throw new Error(`${name} must be a 0x 32-byte key.`);
  return v as Hex;
}

function chain(): Chain {
  return {
    id: CHAIN_ID,
    name: "0G Mainnet",
    nativeCurrency: { decimals: 18, name: "0G", symbol: "0G" },
    rpcUrls: { default: { http: [RPC] } },
    blockExplorers: { default: { name: "0G ChainScan", url: "https://chainscan.0g.ai" } },
  };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function readClient(): PublicClient {
  return createPublicClient({ chain: chain(), transport: http(RPC, { retryCount: 6, retryDelay: 500, timeout: 15_000 }) });
}

async function registryRecord(agentId: string) {
  const reg = JSON.parse(await readFile(".data/agents/mainnet-agents.json", "utf8"));
  const rec = (reg.agents ?? []).find((a: { id: string }) => a.id === agentId);
  if (!rec) throw new Error(`${agentId} not found in active registry.`);
  if (!(rec.filters ?? []).includes("lp-zia")) throw new Error(`${agentId} is not an lp-zia agent.`);
  return rec as { id: string; vault: Address; agentKey: Hex; agentRef: string };
}

async function readLivePos(client: PublicClient, tokenId: string, poolAddress: Address) {
  const position = (await client.readContract({
    address: ZIA_LP_MAINNET.nonfungiblePositionManager, abi: ziaNonfungiblePositionManagerAbi, functionName: "positions", args: [BigInt(tokenId)],
  }).catch(() => null)) as readonly bigint[] | null;
  const nftOwner = (await client.readContract({
    address: ZIA_LP_MAINNET.nonfungiblePositionManager, abi: ziaNonfungiblePositionManagerAbi, functionName: "ownerOf", args: [BigInt(tokenId)],
  }).catch(() => null)) as Address | null;
  if (!position || !nftOwner) return null;
  const stakeVault = findZiaLpVaultByPool(poolAddress)?.vaultAddress;
  return {
    tokenId, poolAddress,
    liquidity: BigInt(position[7]), tickLower: Number(position[5]), tickUpper: Number(position[6]),
    staked: Boolean(stakeVault && nftOwner.toLowerCase() === stakeVault.toLowerCase()),
  };
}

// Fixed protective slippage floor for the zap-out. The old V3 vaults were never
// tightened (lpMinOutBps stuck at deploy-default 0 = no on-chain floor), so we
// impose 97% (3% max slippage) ourselves rather than passing 0 (amountOutMin=0
// is forbidden and unprotected).
const ZAP_MIN_OUT_BPS = 9700;

async function confirmTx(label: string, tx: Hex): Promise<Hex> {
  const pub = createPublicClient({ chain: chain(), transport: http(RPC, { retryCount: 4, timeout: 15_000 }) });
  console.log(JSON.stringify({ stage: label, txHash: tx, action: "submitted" }));
  const receipt = await pub.waitForTransactionReceipt({ hash: tx, confirmations: 2 });
  if (receipt.status !== "success") throw new Error(`${label} tx reverted: ${tx}`);
  console.log(JSON.stringify({ stage: label, txHash: tx, status: "confirmed" }));
  return tx;
}

async function withdrawNativeTx(vault: Address, amount: bigint): Promise<Hex> {
  const deployer = privateKeyToAccount(readPk("DEPLOYER_PRIVATE_KEY"));
  const wallet = createWalletClient({ account: deployer, chain: chain(), transport: http(RPC) });
  const tx = await wallet.writeContract({ address: vault, abi: policyVaultV3Abi, functionName: "withdrawNative", args: [amount], account: deployer, chain: chain() });
  return confirmTx("withdraw", tx);
}

async function disableKeyTx(vault: Address, agentKey: Hex): Promise<Hex> {
  const deployer = privateKeyToAccount(readPk("DEPLOYER_PRIVATE_KEY"));
  const wallet = createWalletClient({ account: deployer, chain: chain(), transport: http(RPC) });
  const tx = await wallet.writeContract({ address: vault, abi: policyVaultV3Abi, functionName: "setAgentKeyEnabled", args: [agentKey, false], account: deployer, chain: chain() });
  return confirmTx("disable-key", tx);
}

async function main() {
  const { agentId, phase } = parseArgs(process.argv.slice(2));
  const want = (p: Phase) => phase === p || phase === "all";
  const rec = await registryRecord(agentId);
  const vault = getAddress(rec.vault);
  const agentKey = rec.agentKey;
  const agentRef = rec.agentRef;
  const owner = privateKeyToAccount(readPk("DEPLOYER_PRIVATE_KEY")).address as Address;
  const client = readClient();

  const lpPolicy = (await client.readContract({ address: vault, abi: policyVaultV3Abi, functionName: "policy" }).catch(() => null)) as
    | { lp?: { cooldownSecondsLp?: bigint; lpMinOutBps?: number } }
    | readonly unknown[] | null;
  const lpMinOutBps = Number((lpPolicy as { lp?: { lpMinOutBps?: number } })?.lp?.lpMinOutBps ?? 0);
  const bal = await client.getBalance({ address: vault });
  const known = POSITIONS[agentId] ?? [];
  const live = [];
  for (const k of known) {
    const p = await readLivePos(client, k.tokenId, k.poolAddress);
    if (p && p.liquidity > 0n) live.push(p);
  }
  console.log(JSON.stringify({ stage: "read", agentId, vault, owner, agentKeyEnabled: await client.readContract({ address: vault, abi: policyVaultV3Abi, functionName: "agentKeyEnabled", args: [agentKey] }).catch(() => "err"), vaultBalance0G: formatEther(bal), lpMinOutBps, livePositions: live.map((p) => ({ tokenId: p.tokenId, staked: p.staked, liquidity: p.liquidity.toString() })) }, null, 2));
  if (phase === "read") return;

  if (want("unstake")) {
    for (const p of live.filter((x) => x.staked)) {
      console.log(JSON.stringify({ stage: "unstake", tokenId: p.tokenId, submit: true }));
      const r = await executeMainnetPolicyVaultLpAction({ networkId: "mainnet", agentKey, vaultAddress: vault, agentRef, action: { kind: "unstake", poolAddress: p.poolAddress, tokenId: BigInt(p.tokenId) } });
      console.log(JSON.stringify({ stage: "unstake", tokenId: p.tokenId, lpTxHash: r.lpTxHash, proofTxHash: r.proofTxHash }));
      await sleep(3000);
    }
  }
  if (want("zap-out")) {
    for (const k of known) {
      const p = await readLivePos(client, k.tokenId, k.poolAddress);
      if (!p || p.liquidity === 0n) { console.log(JSON.stringify({ stage: "zap-out", tokenId: k.tokenId, skip: "zero-liquidity" })); continue; }
      const q = await quoteLpZapOut({ publicClient: client, poolAddress: p.poolAddress, tokenId: p.tokenId, liquidity: p.liquidity, tickLower: p.tickLower, tickUpper: p.tickUpper, lpMinOutBps: ZAP_MIN_OUT_BPS });
      console.log(JSON.stringify({ stage: "zap-out-quote", tokenId: p.tokenId, totalW0GOut: q.totalW0GOut.toString(), amountOutMin: q.amountOutMin.toString() }));
      const r = await executeMainnetPolicyVaultLpAction({ networkId: "mainnet", agentKey, vaultAddress: vault, agentRef, action: { kind: "zap-out", poolAddress: p.poolAddress, tokenId: BigInt(p.tokenId), liquidity: p.liquidity, quotedAmountOut: q.quotedAmountOut, amountOutMin: q.amountOutMin, quotedSqrtPriceX96: q.sqrtPriceX96 } });
      console.log(JSON.stringify({ stage: "zap-out", tokenId: p.tokenId, lpTxHash: r.lpTxHash, proofTxHash: r.proofTxHash }));
      await sleep(3000);
    }
  }
  if (want("withdraw")) {
    const b = await client.getBalance({ address: vault });
    if (b <= 0n) console.log(JSON.stringify({ stage: "withdraw", skip: "zero-balance" }));
    else { console.log(JSON.stringify({ stage: "withdraw", amount0G: formatEther(b), vault })); await withdrawNativeTx(vault, b); }
  }
  let disableTx: Hex | undefined;
  if (want("disable-key")) {
    const en = (await client.readContract({ address: vault, abi: policyVaultV3Abi, functionName: "agentKeyEnabled", args: [agentKey] }).catch(() => true)) as boolean;
    if (!en) console.log(JSON.stringify({ stage: "disable-key", skip: "already-disabled" }));
    else disableTx = await disableKeyTx(vault, agentKey);
  }
  if (want("remove")) {
    const removed = await removeSingleOgAgentRecord(agentId, undefined, owner, disableTx);
    console.log(JSON.stringify({ stage: "remove", agentId, removed: Boolean(removed) }));
  }
  console.log(JSON.stringify({ stage: "done", agentId, phase }));
}

main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; });
