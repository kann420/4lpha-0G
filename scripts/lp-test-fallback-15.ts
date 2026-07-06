// Direct (no-HTTP) verification of the readLpPositionByTokenId fallback in
// lib/agent/lp/lp-exec.ts, AND cleanup of the stranded position #4585 from
// agent-0g-mainnet-15.
//
// Context: the live smoke minted #4585 for agent-0g-mainnet-15, but auto-stake
// failed with "position_not_found" because readSellableLpPositions enumerates
// tokenIds via getLogs({fromBlock:0}) which times out on quiknode → empty list
// → runLpExitForAgent's position lookup never found #4585. The fix adds a
// readLpPositionByTokenId fallback that reads the vault's per-tokenId getters
// + NFPM positions()/ownerOf directly (no getLogs). This script exercises that
// fallback by calling runLpExitForAgent directly: if sellableLpPositions is
// empty (getLogs timeout) the fallback MUST resolve #4585 or the stake throws.
//
// Flow: enable key → stake #4585 (fallback path) → unstake → quote+zap-out
// (funds return to the VAULT, not the owner) → disable key in finally.
//
// Real money. DEPLOYER pays gas. Usage:
//   node --conditions=react-server --import tsx scripts/lp-test-fallback-15.ts --phase=read
//   node --conditions=react-server --import tsx scripts/lp-test-fallback-15.ts --phase=all

import dotenv from "dotenv";
import { createPublicClient, createWalletClient, formatEther, getAddress, http, type Address, type Chain, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { runLpExitForAgent } from "../lib/agent/lp/lp-exec";
import { quoteLpZapOut } from "../lib/agent/lp/lp-zapout-quote";
import { makeMainnetPublicClient } from "../lib/agent/lp/lp-context";
import { agentKeyForDeployment, loadOgAgentWorkspace } from "../lib/agent/single-agent-server";
import { policyVaultV3Abi } from "../lib/contracts/policy-vault-v3";
import { ZIA_LP_VAULTS, ZIA_LP_MAINNET, poolIdFromAddress, ziaNonfungiblePositionManagerAbi } from "../lib/contracts/zia-lp";

dotenv.config({ path: ".env.local", quiet: true });

const preferredMainnetRpc = process.env.OG_MAINNET_RPC_URL?.trim();
if (preferredMainnetRpc) {
  process.env.OG_RPC_URL = preferredMainnetRpc;
}

const CHAIN_ID = 16661;
const DEFAULT_AGENT_ID = "agent-0g-mainnet-15";
const DEFAULT_TOKEN_ID = "4585";

type Phase = "read" | "enable-key" | "stake" | "unstake" | "zap-out" | "disable-key" | "cleanup" | "all";

interface Args {
  phase: Phase;
  agentId: string;
  tokenId: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { phase: "all", agentId: DEFAULT_AGENT_ID, tokenId: DEFAULT_TOKEN_ID };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--phase") args.phase = readNext(argv, ++i, value) as Phase;
    else if (value === "--agent-id") args.agentId = readNext(argv, ++i, value);
    else if (value === "--token-id") args.tokenId = readNext(argv, ++i, value);
    else if (value === "--help" || value === "-h") {
      console.log("Usage: node --conditions=react-server --import tsx scripts/lp-test-fallback-15.ts [--agent-id agent-0g-mainnet-N] [--token-id N] [--phase read|enable-key|stake|unstake|zap-out|disable-key|cleanup|all]");
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

async function waitForLpCooldown(vault: Address, cooldownSecondsRaw: string, label: string) {
  const cooldownSeconds = Number(cooldownSecondsRaw);
  if (!Number.isFinite(cooldownSeconds) || cooldownSeconds <= 0) return;
  const publicClient = makeMainnetPublicClient();
  const lastLpActionAt = await publicClient.readContract({
    address: vault,
    abi: policyVaultV3Abi,
    functionName: "lastLpActionAt",
  }) as bigint;
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
  console.log(JSON.stringify({ stage: enabled ? "enable-key" : "disable-key", agentKey, vault, action: "submit" }));
  const txHash = await walletClient.writeContract({
    address: vault,
    abi: policyVaultV3Abi,
    functionName: "setAgentKeyEnabled",
    args: [agentKey, enabled],
    account: deployer,
    chain,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 2 });
  if (receipt.status !== "success") {
    throw new Error(`${enabled ? "enable" : "disable"}-key tx reverted: ${txHash}`);
  }
  const after = await publicClient.readContract({
    address: vault,
    abi: policyVaultV3Abi,
    functionName: "agentKeyEnabled",
    args: [agentKey],
  }) as boolean;
  if (after !== enabled) {
    throw new Error(`agentKeyEnabled is ${after} (expected ${enabled}) after tx ${txHash}`);
  }
  console.log(JSON.stringify({ stage: enabled ? "enable-key" : "disable-key", txHash, agentKeyEnabled: after, status: "confirmed" }));
  return txHash;
}

// Resolve a position's pool address from the vault's lpNftPool(tokenId) getter —
// bypasses the flaky getLogs-based snapshot. Matches the bytes32 poolId back to
// a ZIA_LP_VAULTS config to recover the EVM pool address + stake vault.
async function resolvePositionPool(vault: Address, tokenIdRaw: string): Promise<{ poolAddress: Address; poolLabel: string; stakeVault?: Address; tickLower: number; tickUpper: number; liquidity: bigint; staked: boolean; nftOwner: Address | null }> {
  const publicClient = makeMainnetPublicClient();
  const tokenId = BigInt(tokenIdRaw);
  const nfpm = ZIA_LP_MAINNET.nonfungiblePositionManager;
  const [poolId, deployedNative, tickLower, tickUpper, nftOwner, position] = await Promise.all([
    publicClient.readContract({ address: vault, abi: policyVaultV3Abi, functionName: "lpNftPool", args: [tokenId] }) as Promise<Hex>,
    publicClient.readContract({ address: vault, abi: policyVaultV3Abi, functionName: "lpNftDeployedNative", args: [tokenId] }) as Promise<bigint>,
    publicClient.readContract({ address: vault, abi: policyVaultV3Abi, functionName: "lpNftTickLower", args: [tokenId] }) as Promise<number>,
    publicClient.readContract({ address: vault, abi: policyVaultV3Abi, functionName: "lpNftTickUpper", args: [tokenId] }) as Promise<number>,
    publicClient.readContract({ address: nfpm, abi: ziaNonfungiblePositionManagerAbi, functionName: "ownerOf", args: [tokenId] }).catch(() => null) as Promise<Address | null>,
    publicClient.readContract({ address: nfpm, abi: ziaNonfungiblePositionManagerAbi, functionName: "positions", args: [tokenId] }).catch(() => null) as Promise<readonly bigint[] | null>,
  ]);
  void deployedNative;
  const cfg = ZIA_LP_VAULTS.find((v) => poolIdFromAddress(v.poolAddress).toLowerCase() === poolId.toLowerCase());
  if (!cfg) throw new Error(`lpNftPool(${tokenIdRaw}) = ${poolId} does not match any ZIA_LP_VAULTS entry.`);
  const stakeVault = cfg.vaultAddress;
  const nftOwnerLower = nftOwner?.toLowerCase() ?? null;
  const staked = Boolean(stakeVault && nftOwnerLower && nftOwnerLower === stakeVault.toLowerCase());
  const liquidity = position ? BigInt(position[7]) : 0n;
  return {
    poolAddress: getAddress(cfg.poolAddress),
    poolLabel: cfg.label,
    stakeVault,
    tickLower,
    tickUpper,
    liquidity,
    staked,
    nftOwner,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const phase = args.phase;
  const tokenId = args.tokenId;
  // `cleanup` = enable-key + zap-out + disable-key (skip stake/unstake) — for
  // zapping an already-unstaked residual position. `all` = full stake/unstake/zap-out.
  const want = (p: Phase) => phase === p || phase === "all" || (phase === "cleanup" && (p === "enable-key" || p === "zap-out" || p === "disable-key"));

  const account = privateKeyToAccount(readPrivateKeyEnv("DEPLOYER_PRIVATE_KEY"));
  const owner = account.address as Address;

  const workspace = await loadOgAgentWorkspace({ agentId: args.agentId, live: true, ownerAddress: owner });
  const deployment = workspace.agent.deployment;
  if (!deployment) throw new Error(`No deployment found for ${args.agentId}.`);
  const vault = deployment.vault;
  const agentKey = (deployment.agentKey ?? agentKeyForDeployment(deployment)) as Hex;
  const agentRef = deployment.agentRef;
  const lpPolicy = workspace.vault.lpPolicy;
  const cooldownSecondsLp = lpPolicy?.cooldownSecondsLp ?? "0";
  const lpMinOutBps = lpPolicy?.lpMinOutBps ?? 0;

  const pos = await resolvePositionPool(vault, tokenId);
  const publicClient = makeMainnetPublicClient();
  const vaultBalance0G = await publicClient.getBalance({ address: vault });

  console.log(JSON.stringify({
    stage: "read",
    agentId: args.agentId,
    vault,
    owner,
    agentKey,
    agentRef,
    tokenId,
    poolAddress: pos.poolAddress,
    poolLabel: pos.poolLabel,
    stakeVault: pos.stakeVault,
    tickLower: pos.tickLower,
    tickUpper: pos.tickUpper,
    liquidity: pos.liquidity.toString(),
    staked: pos.staked,
    nftOwner: pos.nftOwner,
    vaultBalance0G: formatEther(vaultBalance0G),
    cooldownSecondsLp,
    lpMinOutBps,
    allowStaking: lpPolicy?.allowStaking ?? false,
    sellableLpPositionsCount: (workspace.vault.sellableLpPositions ?? []).length,
  }, null, 2));

  if (phase === "read") return;

  let keyWasEnabled = false;
  if (want("enable-key")) {
    const already = await makeMainnetPublicClient()
      .readContract({ address: vault, abi: policyVaultV3Abi, functionName: "agentKeyEnabled", args: [agentKey] })
      .catch(() => false) as boolean;
    if (already === true) {
      console.log(JSON.stringify({ stage: "enable-key", skipped: "already-enabled" }));
      keyWasEnabled = true;
    } else {
      await setAgentKeyEnabled(vault, agentKey, true);
      keyWasEnabled = true;
    }
  }

  try {
    if (want("stake") && !pos.staked) {
      await waitForLpCooldown(vault, cooldownSecondsLp, "stake");
      console.log(JSON.stringify({ stage: "stake", tokenId, pool: pos.poolAddress, action: "submit" }));
      const result = await runLpExitForAgent({ deployment, kind: "stake", poolAddress: pos.poolAddress, tokenId });
      console.log(JSON.stringify({ stage: "stake", tokenId, lpTxHash: result.lpTxHash, proofTxHash: result.proofTxHash }));
    } else if (want("stake")) {
      console.log(JSON.stringify({ stage: "stake", skipped: "already-staked" }));
    }

    if (want("unstake")) {
      // Re-read staked state in case we just staked.
      const fresh = await resolvePositionPool(vault, tokenId);
      if (!fresh.staked) {
        console.log(JSON.stringify({ stage: "unstake", skipped: "not-staked" }));
      } else {
        await waitForLpCooldown(vault, cooldownSecondsLp, "unstake");
        console.log(JSON.stringify({ stage: "unstake", tokenId, pool: pos.poolAddress, action: "submit" }));
        const result = await runLpExitForAgent({ deployment, kind: "unstake", poolAddress: pos.poolAddress, tokenId });
        console.log(JSON.stringify({ stage: "unstake", tokenId, lpTxHash: result.lpTxHash, proofTxHash: result.proofTxHash }));
      }
    }

    if (want("zap-out")) {
      const fresh = await resolvePositionPool(vault, tokenId);
      if (fresh.staked) {
        console.log(JSON.stringify({ stage: "zap-out", skipped: "still-staked-run-unstake-first" }));
      } else if (fresh.liquidity <= 0n) {
        console.log(JSON.stringify({ stage: "zap-out", skipped: "zero-liquidity" }));
      } else {
        await waitForLpCooldown(vault, cooldownSecondsLp, "zap-out");
        const quote = await quoteLpZapOut({
          publicClient,
          poolAddress: pos.poolAddress,
          tokenId,
          liquidity: fresh.liquidity,
          tickLower: fresh.tickLower,
          tickUpper: fresh.tickUpper,
          lpMinOutBps,
        });
        console.log(JSON.stringify({
          stage: "zap-out-quote",
          tokenId,
          totalW0GOut: quote.totalW0GOut.toString(),
          amountOutMin: quote.amountOutMin.toString(),
          sqrtPriceX96: quote.sqrtPriceX96.toString(),
        }));
        const result = await runLpExitForAgent({
          deployment,
          kind: "zap-out",
          poolAddress: pos.poolAddress,
          tokenId,
          quotedAmountOut: quote.quotedAmountOut,
          amountOutMin: quote.amountOutMin,
          quotedSqrtPriceX96: quote.sqrtPriceX96,
        });
        console.log(JSON.stringify({ stage: "zap-out", tokenId, lpTxHash: result.lpTxHash, proofTxHash: result.proofTxHash, amountOutMin: result.amountOutMin?.toString() }));
      }
    }
  } finally {
    if (keyWasEnabled && want("disable-key")) {
      try {
        const already = await makeMainnetPublicClient()
          .readContract({ address: vault, abi: policyVaultV3Abi, functionName: "agentKeyEnabled", args: [agentKey] })
          .catch(() => true) as boolean;
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

  const finalBalance = await makeMainnetPublicClient().getBalance({ address: vault });
  console.log(JSON.stringify({ stage: "done", phase, vaultBalance0G: formatEther(finalBalance) }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});