// One-shot recovery for agent-0g-mainnet-20: unstake + zap-out all 10 LP
// positions, disable the agent key, remove the off-chain agent record, and
// withdraw the remaining native 0G back to the DEPLOYER (owner). Bypasses the
// flaky readVaultSnapshot path (quiknode 429s under load → vaultVersion
// undefined → routes return migrate_to_v3) by calling
// executeMainnetPolicyVaultLpAction + setAgentKeyEnabled + remove + withdraw
// directly with KNOWN on-chain tokenIds.
//
// Real money. DEPLOYER pays gas. Step-gated. Usage:
//   node --conditions=react-server --import tsx scripts/lp-recover-agent-20.ts --phase=read
//   node --conditions=react-server --import tsx scripts/lp-recover-agent-20.ts --phase=all

import dotenv from "dotenv";
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
import { readLpPositionByTokenId } from "../lib/agent/lp/lp-exec";
import {
  agentKeyForDeployment,
  loadOgAgentWorkspace,
  removeSingleOgAgentRecord,
} from "../lib/agent/single-agent-server";
import { withdrawMainnetVaultNative } from "../lib/agent/mainnet-vault-withdraw";
import { policyVaultV3Abi } from "../lib/contracts/policy-vault-v3";
import {
  findZiaLpVaultByPool,
  ziaNonfungiblePositionManagerAbi,
  ZIA_LP_MAINNET,
} from "../lib/contracts/zia-lp";

dotenv.config({ path: ".env.local", quiet: true });

// Use the public 0G RPC for reads + txs — quiknode 429s under burst load (the
// worker pid competes), which is what made the route-based cleanup fail
// (readVaultSnapshot flaked → vaultVersion undefined → migrate_to_v3). The
// public RPC has a ~50-req/burst cap; this script's reads are sequential + few,
// so it stays well under. The executor + withdrawMainnetVaultNative both read
// OG_RPC_URL, so override it to the public RPC for this run.
const LP_PUBLIC_RPC = process.env.OG_PUBLIC_RPC_URL?.trim() || "https://evmrpc.0g.ai";
process.env.OG_RPC_URL = LP_PUBLIC_RPC;

const CHAIN_ID = 16661;
const AGENT_ID = "agent-0g-mainnet-20";

// 10 known on-chain positions (verified via the cleanup readState pass + direct
// lpNftPool reads). 9 are staked (NFT held by the W0G/WETH or W0G/USDC stake
// vault), 1 unstaked (#4712). poolAddress is only used to resolve the stake
// vault + zia pool config; liquidity is re-read fresh on-chain per token.
const KNOWN_POSITIONS: { tokenId: string; poolAddress: Address }[] = [
  { tokenId: "4704", poolAddress: getAddress("0x20a96caf06e0ce4e9CB30f75999A6c21a484Cd49") },
  { tokenId: "4705", poolAddress: getAddress("0x20a96caf06e0ce4e9CB30f75999A6c21a484Cd49") },
  { tokenId: "4706", poolAddress: getAddress("0x20a96caf06e0ce4e9CB30f75999A6c21a484Cd49") },
  { tokenId: "4707", poolAddress: getAddress("0x20a96caf06e0ce4e9CB30f75999A6c21a484Cd49") },
  { tokenId: "4708", poolAddress: getAddress("0x20a96caf06e0ce4e9CB30f75999A6c21a484Cd49") },
  { tokenId: "4709", poolAddress: getAddress("0x20a96caf06e0ce4e9CB30f75999A6c21a484Cd49") },
  { tokenId: "4710", poolAddress: getAddress("0x20a96caf06e0ce4e9CB30f75999A6c21a484Cd49") },
  { tokenId: "4712", poolAddress: getAddress("0x20a96caf06e0ce4e9CB30f75999A6c21a484Cd49") },
  { tokenId: "4713", poolAddress: getAddress("0x23336572435eC92d25eF0dD2D468B2a1aBF7BB4f") },
  { tokenId: "4714", poolAddress: getAddress("0x20a96caf06e0ce4e9CB30f75999A6c21a484Cd49") },
];

type Phase = "read" | "enable-key" | "unstake" | "zap-out" | "disable-key" | "remove" | "withdraw" | "all";

interface Args {
  phase: Phase;
  withdrawAmount0G?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { phase: "all" };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--phase") args.phase = readNext(argv, ++i, value) as Phase;
    else if (value === "--withdraw-amount") args.withdrawAmount0G = readNext(argv, ++i, value);
    else if (value === "--help" || value === "-h") {
      console.log(
        "Usage: node --conditions=react-server --import tsx scripts/lp-recover-agent-20.ts [--phase read|enable-key|unstake|zap-out|disable-key|remove|withdraw|all] [--withdraw-amount 20.7]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return args;
}

function readNext(argv: string[], i: number, flag: string): string {
  const value = argv[i];
  if (value === undefined) throw new Error(`${flag} requires a value.`);
  return value;
}

function readPrivateKeyEnv(name: string): Hex {
  const value = process.env[name]?.trim();
  if (!value || !/^0x[0-9a-fA-F]{64}$/u.test(value)) {
    throw new Error(`${name} must be a 0x-prefixed 32-byte private key.`);
  }
  return value as Hex;
}

function makeChain(rpcUrl: string): Chain {
  return {
    id: CHAIN_ID,
    name: "0G Mainnet",
    nativeCurrency: { decimals: 18, name: "0G", symbol: "0G" },
    rpcUrls: { default: { http: [rpcUrl] } },
    blockExplorers: { default: { name: "0G ChainScan", url: "https://chainscan.0g.ai" } },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeReadClient(): PublicClient {
  return createPublicClient({
    chain: makeChain(LP_PUBLIC_RPC),
    transport: http(LP_PUBLIC_RPC, { retryCount: 6, retryDelay: 250, timeout: 8_000 }),
  });
}

async function waitForLpCooldown(vault: Address, cooldownSecondsRaw: string, label: string) {
  const cooldownSeconds = Number(cooldownSecondsRaw);
  if (!Number.isFinite(cooldownSeconds) || cooldownSeconds <= 0) return;
  const client = makeReadClient();
  const lastLpActionAt = (await client.readContract({
    address: vault,
    abi: policyVaultV3Abi,
    functionName: "lastLpActionAt",
  })) as bigint;
  if (lastLpActionAt === 0n) return;
  const block = await client.getBlock();
  const readyAt = Number(lastLpActionAt) + cooldownSeconds + 3;
  const waitSeconds = readyAt - Number(block.timestamp);
  if (waitSeconds <= 0) return;
  console.log(JSON.stringify({ label, stage: "cooldown-wait", waitSeconds }));
  await sleep(waitSeconds * 1000);
}

async function setAgentKeyEnabled(vault: Address, agentKey: Hex, enabled: boolean): Promise<Hex> {
  const chain = makeChain(LP_PUBLIC_RPC);
  const deployer = privateKeyToAccount(readPrivateKeyEnv("DEPLOYER_PRIVATE_KEY"));
  const publicClient = createPublicClient({ chain, transport: http(LP_PUBLIC_RPC, { retryCount: 0, timeout: 8_000 }) });
  const walletClient = createWalletClient({ account: deployer, chain, transport: http(LP_PUBLIC_RPC) });
  const action = `setAgentKeyEnabled(${enabled})`;
  console.log(JSON.stringify({ stage: enabled ? "enable-key" : "disable-key", agentKey, vault, action }));
  const txHash = await walletClient.writeContract({
    address: vault,
    abi: policyVaultV3Abi,
    functionName: "setAgentKeyEnabled",
    args: [agentKey, enabled],
    account: deployer,
    chain,
  });
  console.log(JSON.stringify({ stage: enabled ? "enable-key" : "disable-key", txHash, action: "submitted" }));
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 2 });
  if (receipt.status !== "success") {
    throw new Error(`${enabled ? "enable" : "disable"}-key tx reverted: ${txHash}`);
  }
  const after = (await publicClient.readContract({
    address: vault,
    abi: policyVaultV3Abi,
    functionName: "agentKeyEnabled",
    args: [agentKey],
  })) as boolean;
  if (after !== enabled) {
    throw new Error(`agentKeyEnabled is ${after} (expected ${enabled}) after tx ${txHash}`);
  }
  console.log(JSON.stringify({ stage: enabled ? "enable-key" : "disable-key", txHash, agentKeyEnabled: after, status: "confirmed" }));
  return txHash;
}

interface LivePos {
  tokenId: string;
  poolAddress: Address;
  staked: boolean;
  liquidity: bigint;
  tickLower: number;
  tickUpper: number;
}

async function readLivePos(tokenId: string, poolAddress: Address): Promise<LivePos | null> {
  const client = makeReadClient();
  const position = (await client
    .readContract({
      address: ZIA_LP_MAINNET.nonfungiblePositionManager,
      abi: ziaNonfungiblePositionManagerAbi,
      functionName: "positions",
      args: [BigInt(tokenId)],
    })
    .catch(() => null)) as readonly bigint[] | null;
  const nftOwner = (await client
    .readContract({
      address: ZIA_LP_MAINNET.nonfungiblePositionManager,
      abi: ziaNonfungiblePositionManagerAbi,
      functionName: "ownerOf",
      args: [BigInt(tokenId)],
    })
    .catch(() => null)) as Address | null;
  if (!position || !nftOwner) return null;
  const liquidity = BigInt(position[7]);
  const tickLower = Number(position[5]);
  const tickUpper = Number(position[6]);
  const stakeCfg = findZiaLpVaultByPool(poolAddress);
  const stakeVault = stakeCfg?.vaultAddress;
  const staked = Boolean(stakeVault && nftOwner.toLowerCase() === stakeVault.toLowerCase());
  return { tokenId, poolAddress, staked, liquidity, tickLower, tickUpper };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const phase = args.phase;
  const want = (p: Phase) => phase === p || phase === "all";

  const deployer = privateKeyToAccount(readPrivateKeyEnv("DEPLOYER_PRIVATE_KEY"));
  const owner = deployer.address as Address;

  // Load only the deployment (roster-based, survives readVaultSnapshot flakes).
  const workspace = await loadOgAgentWorkspace({ agentId: AGENT_ID, live: true, ownerAddress: owner });
  const deployment = workspace.agent.deployment;
  if (!deployment) {
    throw new Error(`No deployment found for ${AGENT_ID}.`);
  }
  const vault = deployment.vault;
  const agentKey = (deployment.agentKey ?? agentKeyForDeployment(deployment)) as Hex;
  const agentRef = deployment.agentRef;
  const lpPolicy = workspace.vault.lpPolicy;
  const cooldownSecondsLp = lpPolicy?.cooldownSecondsLp ?? "0";
  const lpMinOutBps = lpPolicy?.lpMinOutBps ?? 0;

  const client = makeReadClient();
  const vaultBalance = await client.getBalance({ address: vault });
  console.log(
    JSON.stringify(
      {
        stage: "read",
        agentId: AGENT_ID,
        vault,
        owner,
        agentKey,
        agentRef,
        status: workspace.agent.status,
        vaultBalance0G: formatEther(vaultBalance),
        cooldownSecondsLp,
        lpMinOutBps,
        positions: KNOWN_POSITIONS.map((p) => p.tokenId),
      },
      null,
      2,
    ),
  );
  if (phase === "read") return;

  // Re-read fresh live state for every known position (bypasses getLogs).
  const livePositions: LivePos[] = [];
  for (const known of KNOWN_POSITIONS) {
    const live = await readLivePos(known.tokenId, known.poolAddress);
    if (!live || live.liquidity === 0n) {
      console.log(JSON.stringify({ stage: "read-position", tokenId: known.tokenId, status: "burned-or-zero-liquidity", skip: true }));
      continue;
    }
    livePositions.push(live);
    console.log(
      JSON.stringify({
        stage: "read-position",
        tokenId: live.tokenId,
        pool: known.poolAddress,
        staked: live.staked,
        liquidity: live.liquidity.toString(),
        tickLower: live.tickLower,
        tickUpper: live.tickUpper,
      }),
    );
  }

  let keyWasEnabled = false;
  if (want("enable-key")) {
    const already = (await client.readContract({
      address: vault,
      abi: policyVaultV3Abi,
      functionName: "agentKeyEnabled",
      args: [agentKey],
    }).catch(() => false)) as boolean;
    if (already) {
      console.log(JSON.stringify({ stage: "enable-key", skipped: "already-enabled" }));
      keyWasEnabled = true;
    } else {
      await setAgentKeyEnabled(vault, agentKey, true);
      keyWasEnabled = true;
    }
  }

  let disableKeyTxHash: Hex | undefined;
  try {
    // Unstake every staked position.
    if (want("unstake")) {
      const staked = livePositions.filter((p) => p.staked);
      if (staked.length === 0) {
        console.log(JSON.stringify({ stage: "unstake", skipped: "no-staked-positions" }));
      }
      for (const pos of staked) {
        await waitForLpCooldown(vault, cooldownSecondsLp, `unstake-${pos.tokenId}`);
        console.log(JSON.stringify({ stage: "unstake", tokenId: pos.tokenId, pool: pos.poolAddress, action: "submit" }));
        const result = await executeMainnetPolicyVaultLpAction({
          networkId: "mainnet",
          agentKey,
          vaultAddress: vault,
          agentRef,
          action: { kind: "unstake", poolAddress: pos.poolAddress, tokenId: BigInt(pos.tokenId) },
        });
        console.log(JSON.stringify({ stage: "unstake", tokenId: pos.tokenId, lpTxHash: result.lpTxHash, proofTxHash: result.proofTxHash }));
      }
    }

    // Zap-out every remaining position with liquidity > 0 (re-read after unstake).
    if (want("zap-out")) {
      const refreshed: LivePos[] = [];
      for (const pos of livePositions) {
        const live = await readLivePos(pos.tokenId, pos.poolAddress);
        if (live && live.liquidity > 0n) refreshed.push(live);
      }
      if (refreshed.length === 0) {
        console.log(JSON.stringify({ stage: "zap-out", skipped: "no-zappable-positions" }));
      }
      for (const pos of refreshed) {
        await waitForLpCooldown(vault, cooldownSecondsLp, `zap-out-${pos.tokenId}`);
        const quote = await quoteLpZapOut({
          publicClient: client,
          poolAddress: pos.poolAddress,
          tokenId: pos.tokenId,
          liquidity: pos.liquidity,
          tickLower: pos.tickLower,
          tickUpper: pos.tickUpper,
          lpMinOutBps,
        });
        console.log(
          JSON.stringify({
            stage: "zap-out-quote",
            tokenId: pos.tokenId,
            totalW0GOut: quote.totalW0GOut.toString(),
            amountOutMin: quote.amountOutMin.toString(),
          }),
        );
        const result = await executeMainnetPolicyVaultLpAction({
          networkId: "mainnet",
          agentKey,
          vaultAddress: vault,
          agentRef,
          action: {
            kind: "zap-out",
            poolAddress: pos.poolAddress,
            tokenId: BigInt(pos.tokenId),
            liquidity: pos.liquidity,
            quotedAmountOut: quote.quotedAmountOut,
            amountOutMin: quote.amountOutMin,
            quotedSqrtPriceX96: quote.sqrtPriceX96,
          },
        });
        console.log(JSON.stringify({ stage: "zap-out", tokenId: pos.tokenId, lpTxHash: result.lpTxHash, proofTxHash: result.proofTxHash }));
      }
    }

    if (want("disable-key")) {
      const already = (await client.readContract({
        address: vault,
        abi: policyVaultV3Abi,
        functionName: "agentKeyEnabled",
        args: [agentKey],
      }).catch(() => true)) as boolean;
      if (!already) {
        console.log(JSON.stringify({ stage: "disable-key", skipped: "already-disabled" }));
      } else {
        disableKeyTxHash = await setAgentKeyEnabled(vault, agentKey, false);
      }
    }

    if (want("remove")) {
      console.log(JSON.stringify({ stage: "remove", agentId: AGENT_ID }));
      const removed = await removeSingleOgAgentRecord(AGENT_ID, deployment, owner, disableKeyTxHash);
      console.log(JSON.stringify({ stage: "remove", removed: Boolean(removed), agentId: AGENT_ID }));
    }

    if (want("withdraw")) {
      const balance = await client.getBalance({ address: vault });
      const amount0G = args.withdrawAmount0G ?? formatEther(balance);
      if (parseEther(amount0G) <= 0n) {
        console.log(JSON.stringify({ stage: "withdraw", skipped: "vault-balance-zero" }));
      } else {
        console.log(JSON.stringify({ stage: "withdraw", amount0G, owner, vault }));
        const result = await withdrawMainnetVaultNative({ owner, amount0G });
        console.log(
          JSON.stringify({
            stage: "withdraw",
            txHash: result.txHash,
            amount0G: result.amount0G,
            balanceBefore0G: result.balanceBefore0G,
            balanceAfter0G: result.balanceAfter0G,
            vault: result.vault,
          }),
        );
      }
    }
  } finally {
    if (keyWasEnabled && want("disable-key")) {
      try {
        const already = (await client.readContract({
          address: vault,
          abi: policyVaultV3Abi,
          functionName: "agentKeyEnabled",
          args: [agentKey],
        }).catch(() => true)) as boolean;
        if (already) {
          await setAgentKeyEnabled(vault, agentKey, false);
        }
      } catch (disableErr) {
        console.error("disable-key failed:", disableErr instanceof Error ? disableErr.message : String(disableErr));
      }
    }
  }

  console.log(JSON.stringify({ stage: "done", phase }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});