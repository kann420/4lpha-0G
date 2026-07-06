// Mainnet LP position recovery for agent-0g-mainnet-14.
//
// Context: a prior cleanup run disabled the agent key and removed the off-chain
// agent record, but the 3 on-chain LP NFTs were never zapped out (quiknode
// getLogs({fromBlock:0}) timed out → readSellableLpPositions returned []). The
// executor helper executeMainnetPolicyVaultLpAction prechecks agentKeyEnabled
// for ALL actions (including exits), so the key must be re-enabled before exits.
// Exits are authorized by lpNftOwner[tokenId] == agentKey (position-based), not
// by the off-chain registry, so a removed agent record does NOT block them.
//
// This script recovers the stuck 0G by:
//   1. Loading the removed agent's deployment via loadOgAgentWorkspace (still
//      resolves removed agents) to recover agentKey + vault + agentRef.
//   2. Re-enabling the agent key (DEPLOYER setAgentKeyEnabled(true)).
//   3. Reading each KNOWN tokenId directly from the NFPM (positions() + ownerOf)
//      — bypasses the flaky getLogs-based readSellableLpPositions entirely.
//   4. Unstaking the staked position (#4580), then zap-out all 3 via
//      executeMainnetPolicyVaultLpAction directly (bypasses runLpExitForAgent's
//      internal loadOgAgentWorkspace re-read, which can time out on public RPC).
//   5. Re-disabling the agent key (in a finally — guaranteed even if a zap-out
//      throws, so the executor window for a removed agent never stays open).
//
// Funds STAY in the vault per the owner's instruction — this script does NOT
// withdraw native 0G to the owner. The earlier `withdraw` phase was removed
// (it resolved the vault by owner rather than deployment.vault and could
// drain the wrong vault; the owner wants funds to remain in the vault anyway).
//
// Real money. DEPLOYER pays gas. Step-gated. Usage:
//   node --conditions=react-server --import tsx scripts/lp-recover-positions.ts --phase=read
//   node --conditions=react-server --import tsx scripts/lp-recover-positions.ts --phase=all

import dotenv from "dotenv";
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  getAddress,
  http,
  type Address,
  type Chain,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { executeMainnetPolicyVaultLpAction } from "../lib/executor/policy-vault-lp";
import { quoteLpZapOut } from "../lib/agent/lp/lp-zapout-quote";
import { makeMainnetPublicClient } from "../lib/agent/lp/lp-context";
import { agentKeyForDeployment, loadOgAgentWorkspace } from "../lib/agent/single-agent-server";
import { policyVaultV3Abi } from "../lib/contracts/policy-vault-v3";
import { findZiaLpVaultByPool, ziaNonfungiblePositionManagerAbi, uniswapV3PoolAbi } from "../lib/contracts/zia-lp";

dotenv.config({ path: ".env.local", quiet: true });

// Prefer the dedicated mainnet RPC (quiknode) — reliable for readContract; only
// getLogs({fromBlock:0}) times out, and this script bypasses getLogs entirely.
const preferredMainnetRpc = process.env.OG_MAINNET_RPC_URL?.trim();
if (preferredMainnetRpc) {
  process.env.OG_RPC_URL = preferredMainnetRpc;
}

const CHAIN_ID = 16661;
const AGENT_ID = "agent-0g-mainnet-14";

// Known on-chain positions from the prior readState (verified before the agent
// record was removed). tokenId → pool address. These are read fresh on-chain
// below, so a stale entry here just means "skip" (positions() returns 0 liquidity).
const KNOWN_POSITIONS: { tokenId: string; poolAddress: Address }[] = [
  { tokenId: "4580", poolAddress: getAddress("0x23336572435eC92d25eF0dD2D468B2a1aBF7BB4f") }, // W0G/USDC (was staked)
  { tokenId: "4581", poolAddress: getAddress("0x23336572435eC92d25eF0dD2D468B2a1aBF7BB4f") }, // W0G/USDC (unstaked)
  { tokenId: "4582", poolAddress: getAddress("0x20a96caf06E0ce4e9CB30f75999A6c21a484Cd49") }, // W0G/WETH (unstaked)
];

type Phase = "read" | "enable-key" | "unstake" | "zap-out" | "disable-key" | "all";

interface Args {
  phase: Phase;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { phase: "all" };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--phase") args.phase = readNext(argv, ++i, value) as Phase;
    else if (value === "--help" || value === "-h") {
      console.log(
        "Usage: node --conditions=react-server --import tsx scripts/lp-recover-positions.ts [--phase read|enable-key|unstake|zap-out|disable-key|all]",
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

function make0GMainnetChain(rpcUrl: string): Chain {
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

interface PositionState {
  tokenId: string;
  poolAddress: Address;
  nftOwner: Address | null;
  staked: boolean;
  liquidity: bigint;
  tickLower: number;
  tickUpper: number;
  stakeVault: Address | undefined;
}

async function readPosition(tokenId: string, poolAddress: Address): Promise<PositionState> {
  const publicClient = makeMainnetPublicClient();
  // A burned NFT (post zap-out) reverts on positions()/ownerOf — treat that as
  // a gone position (liquidity 0) so disable-key/withdraw phases don't crash.
  const position = (await publicClient
    .readContract({
      address: ZIA_LP_MAINNET_NONFPM,
      abi: ziaNonfungiblePositionManagerAbi,
      functionName: "positions",
      args: [BigInt(tokenId)],
    })
    .catch(() => null)) as readonly bigint[] | null;
  const nftOwner = (await publicClient
    .readContract({
      address: ZIA_LP_MAINNET_NONFPM,
      abi: ziaNonfungiblePositionManagerAbi,
      functionName: "ownerOf",
      args: [BigInt(tokenId)],
    })
    .catch(() => null)) as Address | null;
  if (!position) {
    return { tokenId, poolAddress, nftOwner: null, staked: false, liquidity: 0n, tickLower: 0, tickUpper: 0, stakeVault: undefined };
  }
  const liquidity = BigInt(position[7]);
  const tickLower = Number(position[5]);
  const tickUpper = Number(position[6]);
  const stakeCfg = findZiaLpVaultByPool(poolAddress);
  const stakeVault = stakeCfg?.vaultAddress;
  const staked = Boolean(stakeVault && nftOwner && nftOwner.toLowerCase() === stakeVault.toLowerCase());
  return { tokenId, poolAddress, nftOwner, staked, liquidity, tickLower, tickUpper, stakeVault };
}

const ZIA_LP_MAINNET_NONFPM = getAddress("0x5143ba6007C197b4cF66c20601b9dB97E0F98c6A");

async function waitForLpCooldown(vault: Address, cooldownSecondsRaw: string, label: string) {
  const cooldownSeconds = Number(cooldownSecondsRaw);
  if (!Number.isFinite(cooldownSeconds) || cooldownSeconds <= 0) return;
  const publicClient = makeMainnetPublicClient();
  const lastLpActionAt = (await publicClient.readContract({
    address: vault,
    abi: policyVaultV3Abi,
    functionName: "lastLpActionAt",
  })) as bigint;
  if (lastLpActionAt === 0n) return;
  const block = await publicClient.getBlock();
  const readyAt = Number(lastLpActionAt) + cooldownSeconds + 3;
  const waitSeconds = readyAt - Number(block.timestamp);
  if (waitSeconds <= 0) return;
  console.log(JSON.stringify({ label, stage: "cooldown-wait", waitSeconds }));
  await sleep(waitSeconds * 1000);
}

async function setAgentKeyEnabled(vault: Address, agentKey: Hex, enabled: boolean): Promise<Hex> {
  const rpcUrl = process.env.OG_RPC_URL?.trim();
  if (!rpcUrl) throw new Error("OG_RPC_URL is required.");
  const chain = make0GMainnetChain(rpcUrl);
  const deployer = privateKeyToAccount(readPrivateKeyEnv("DEPLOYER_PRIVATE_KEY"));
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl, { retryCount: 0, timeout: 8_000 }) });
  const walletClient = createWalletClient({ account: deployer, chain, transport: http(rpcUrl) });
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const phase = args.phase;
  const want = (p: Phase) => phase === p || phase === "all";

  const account = privateKeyToAccount(readPrivateKeyEnv("DEPLOYER_PRIVATE_KEY"));
  const owner = account.address as Address;

  // 1. Load the (removed) agent's deployment to recover agentKey + vault + agentRef.
  const workspace = await loadOgAgentWorkspace({ agentId: AGENT_ID, live: true, ownerAddress: owner });
  const deployment = workspace.agent.deployment;
  if (!deployment) {
    throw new Error(`No deployment (active or removed) found for ${AGENT_ID}.`);
  }
  const vault = deployment.vault;
  const agentKey = (deployment.agentKey ?? agentKeyForDeployment(deployment)) as Hex;
  const agentRef = deployment.agentRef;
  const lpPolicy = workspace.vault.lpPolicy;
  const cooldownSecondsLp = lpPolicy?.cooldownSecondsLp ?? "0";
  const lpMinOutBps = lpPolicy?.lpMinOutBps ?? 0;

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
        vaultVersion: workspace.vault.vaultVersion,
        vaultBalance0G: formatEther(await makeMainnetPublicClient().getBalance({ address: vault })),
        cooldownSecondsLp,
        lpMinOutBps,
        allowStaking: lpPolicy?.allowStaking ?? false,
        positions: KNOWN_POSITIONS.map((p) => p.tokenId),
      },
      null,
      2,
    ),
  );

  if (phase === "read") return;

  // 2. Read fresh on-chain state for each known position (bypasses getLogs).
  const positions: PositionState[] = [];
  for (const known of KNOWN_POSITIONS) {
    const state = await readPosition(known.tokenId, known.poolAddress);
    positions.push(state);
    console.log(
      JSON.stringify({
        stage: "read-position",
        tokenId: state.tokenId,
        pool: known.poolAddress,
        nftOwner: state.nftOwner,
        staked: state.staked,
        liquidity: state.liquidity.toString(),
        tickLower: state.tickLower,
        tickUpper: state.tickUpper,
        stakeVault: state.stakeVault,
      }),
    );
  }

  // 3. Re-enable the agent key (executor prechecks agentKeyEnabled for all LP
  // actions). Track whether WE enabled it so the finally below can re-disable
  // it even if a later phase throws — leaving the key enabled for a removed
  // agent widens the executor window indefinitely.
  let keyWasEnabled = false;
  if (want("enable-key")) {
    const already = await makeMainnetPublicClient()
      .readContract({ address: vault, abi: policyVaultV3Abi, functionName: "agentKeyEnabled", args: [agentKey] })
      .catch(() => false);
    if (already === true) {
      console.log(JSON.stringify({ stage: "enable-key", skipped: "already-enabled" }));
      keyWasEnabled = true;
    } else {
      await setAgentKeyEnabled(vault, agentKey, true);
      keyWasEnabled = true;
    }
  }

  // Wrap the action phases so disable-key ALWAYS runs if we enabled the key,
  // even when an unstake/zap-out tx reverts or the quote/RPC throws.
  try {
  // 4. Unstake every staked position.
  if (want("unstake")) {
    const staked = positions.filter((p) => p.staked);
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
      console.log(
        JSON.stringify({
          stage: "unstake",
          tokenId: pos.tokenId,
          lpTxHash: result.lpTxHash,
          proofTxHash: result.proofTxHash,
        }),
      );
    }
  }

  // 5. Zap-out every remaining unstaked position with liquidity > 0.
  if (want("zap-out")) {
    // Re-read after unstake so staked positions are now vault-held with real liquidity.
    let zappable = positions.filter((p) => !p.staked && p.liquidity > 0n);
    if (want("unstake")) {
      const refreshed: PositionState[] = [];
      for (const pos of positions) {
        refreshed.push(await readPosition(pos.tokenId, pos.poolAddress));
      }
      zappable = refreshed.filter((p) => !p.staked && p.liquidity > 0n);
      console.log(JSON.stringify({ stage: "zap-out", refreshed: refreshed.map((p) => ({ tokenId: p.tokenId, staked: p.staked, liquidity: p.liquidity.toString() })) }));
    }
    if (zappable.length === 0) {
      console.log(JSON.stringify({ stage: "zap-out", skipped: "no-zappable-positions" }));
    }
    for (const pos of zappable) {
      await waitForLpCooldown(vault, cooldownSecondsLp, `zap-out-${pos.tokenId}`);
      const publicClient = makeMainnetPublicClient();
      const quote = await quoteLpZapOut({
        publicClient,
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
          sqrtPriceX96: quote.sqrtPriceX96.toString(),
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
      console.log(
        JSON.stringify({
          stage: "zap-out",
          tokenId: pos.tokenId,
          lpTxHash: result.lpTxHash,
          proofTxHash: result.proofTxHash,
        }),
      );
    }
  }

  // 6. Re-disable the agent key (clean state — vault will be emptied next).
  // 6. Re-disable the agent key (clean state). Runs in finally so it ALWAYS
  // executes when we enabled the key, even if an unstake/zap-out threw above.
  // NOTE: this script no longer withdraws native 0G to the owner — per the
  // user's explicit instruction, recovered funds STAY in the vault. The
  // `withdraw` phase was removed to avoid silently draining a different
  // owner-resolved vault.
  } finally {
    if (keyWasEnabled && want("disable-key")) {
      try {
        const already = await makeMainnetPublicClient()
          .readContract({ address: vault, abi: policyVaultV3Abi, functionName: "agentKeyEnabled", args: [agentKey] })
          .catch(() => true);
        if (already === false) {
          console.log(JSON.stringify({ stage: "disable-key", skipped: "already-disabled" }));
        } else {
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