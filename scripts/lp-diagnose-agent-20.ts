// Diagnostic for agent-0g-mainnet-20: read the REAL on-chain LpPolicy + enumerate
// LP NFTs via the vault's agentLpNfts[agentKey][poolId] mapping (token-id path,
// no getLogs) to confirm:
//   1. Whether on-chain caps (perLpActionCap0G, maxLpExposure0G) are actually
//      tightened to the operator's intended 1/3, or left loose (which would
//      explain 8 positions × ~2 0G each — impossible under per=1/total=3).
//   2. The real position count + per-pool distribution (Bug 3 duplicate pairs).
//   3. Total deployed 0G vs maxLpExposure0G (how much headroom remains).
//
// Read-only. No tx. DEPLOYER not required (pure reads). Usage:
//   node --conditions=react-server --import tsx scripts/lp-diagnose-agent-20.ts

import dotenv from "dotenv";
import { formatEther, getAddress, type Address, type Hex } from "viem";

import { makeMainnetPublicClient } from "../lib/agent/lp/lp-context";
import { agentKeyForDeployment, loadOgAgentWorkspace } from "../lib/agent/single-agent-server";
import { normalizePolicyVaultV3Policy, policyVaultV3Abi } from "../lib/contracts/policy-vault-v3";
import {
  ZIA_LP_MAINNET,
  findZiaLpVaultByPool,
  poolIdFromAddress,
  ziaNonfungiblePositionManagerAbi,
  zappableZiaLpVaults,
} from "../lib/contracts/zia-lp";

dotenv.config({ path: ".env.local", quiet: true });

const CHAIN_ID = 16661;
const AGENT_ID = "agent-0g-mainnet-20";

// Prefer the dedicated mainnet RPC (quiknode) — reliable for readContract; only
// getLogs({fromBlock:0}) times out, and this script never calls getLogs.
const preferredMainnetRpc = process.env.OG_MAINNET_RPC_URL?.trim();
if (preferredMainnetRpc) {
  process.env.OG_RPC_URL = preferredMainnetRpc;
}

function deriveMaxPositions(per: bigint, total: bigint): number {
  if (per <= 0n) return 0;
  return Number(total / per);
}

async function main() {
  const owner = (process.env.DEPLOYER_PRIVATE_KEY?.trim()
    ? (await import("viem/accounts")).privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY.trim() as Hex).address
    : undefined) as Address | undefined;

  const workspace = await loadOgAgentWorkspace({ agentId: AGENT_ID, live: true, ownerAddress: owner });
  const deployment = workspace.agent.deployment;
  if (!deployment) {
    throw new Error(`No deployment (active or removed) found for ${AGENT_ID}.`);
  }
  const vault = deployment.vault;
  const agentKey = (deployment.agentKey ?? agentKeyForDeployment(deployment)) as Hex;

  const publicClient = makeMainnetPublicClient();

  // --- Read the on-chain Policy + LP accounting in one batch.
  const [policyRaw, openLpExposure, lpDailySpent, lastLpActionAt, agentKeyEnabled, paused, executorRevoked, balance, vaultOwner, vaultExecutor] =
    await Promise.all([
      publicClient.readContract({ address: vault, abi: policyVaultV3Abi, functionName: "policy" }) as Promise<unknown>,
      publicClient.readContract({ address: vault, abi: policyVaultV3Abi, functionName: "openLpExposure0G" }) as Promise<bigint>,
      publicClient.readContract({ address: vault, abi: policyVaultV3Abi, functionName: "lpDailySpent0G" }) as Promise<bigint>,
      publicClient.readContract({ address: vault, abi: policyVaultV3Abi, functionName: "lastLpActionAt" }) as Promise<bigint>,
      publicClient.readContract({ address: vault, abi: policyVaultV3Abi, functionName: "agentKeyEnabled", args: [agentKey] }) as Promise<boolean>,
      publicClient.readContract({ address: vault, abi: policyVaultV3Abi, functionName: "paused" }) as Promise<boolean>,
      publicClient.readContract({ address: vault, abi: policyVaultV3Abi, functionName: "executorRevoked" }) as Promise<boolean>,
      publicClient.getBalance({ address: vault }),
      publicClient.readContract({ address: vault, abi: policyVaultV3Abi, functionName: "owner" }) as Promise<Address>,
      publicClient.readContract({ address: vault, abi: policyVaultV3Abi, functionName: "executor" }) as Promise<Address>,
    ]);

  const policy = normalizePolicyVaultV3Policy(policyRaw);
  const lp = policy.lp;

  console.log("=== Vault state ===");
  console.log(JSON.stringify({
    agentId: AGENT_ID,
    vault,
    vaultVersion: workspace.vault.vaultVersion,
    vaultOwner,
    vaultExecutor,
    agentKey,
    agentKeyEnabled,
    paused,
    executorRevoked,
    vaultBalance0G: formatEther(balance),
  }, null, 2));

  console.log("\n=== On-chain LpPolicy (REAL caps the vault enforces) ===");
  console.log(JSON.stringify({
    perLpActionCap0G: formatEther(lp.perLpActionCap0G),
    maxLpExposure0G: formatEther(lp.maxLpExposure0G),
    lpDailyCap0G: formatEther(lp.lpDailyCap0G),
    cooldownSecondsLp: lp.cooldownSecondsLp.toString(),
    lpMinOutBps: lp.lpMinOutBps,
    minLiquidityFloor: lp.minLiquidityFloor.toString(),
    allowStaking: lp.allowStaking,
  }, null, 2));

  console.log("\n=== Derived + accounting ===");
  console.log(JSON.stringify({
    derivedMaxPositions: deriveMaxPositions(lp.perLpActionCap0G, lp.maxLpExposure0G),
    openLpExposure0G: formatEther(openLpExposure),
    lpDailySpent0G: formatEther(lpDailySpent),
    lastLpActionAt: lastLpActionAt.toString(),
    exposureHeadroom0G: formatEther(lp.maxLpExposure0G - openLpExposure),
  }, null, 2));

  // --- Enumerate positions via agentLpNfts[agentKey][poolId] (token-id path, no getLogs).
  // poolId is pool-address-encoded (bytes32(uint256(uint160(poolAddress)))).
  const zappable = zappableZiaLpVaults();
  console.log(`\n=== Positions (token-id read across ${zappable.length} zappable pools) ===`);

  interface PosRow {
    tokenId: string;
    pool: Address;
    poolLabel: string;
    deployedNative0G: string;
    liquidity: string;
    tickLower: number;
    tickUpper: number;
    staked: boolean;
    nftOwner: Address | null;
  }
  const rows: PosRow[] = [];
  const perPoolCount: Record<string, number> = {};
  let totalDeployedRaw = 0n;

  for (const cfg of zappable) {
    const poolId = poolIdFromAddress(cfg.poolAddress);
    let tokenIds: readonly bigint[] = [];
    try {
      tokenIds = await publicClient.readContract({
        address: vault,
        abi: policyVaultV3Abi,
        functionName: "agentLpNfts",
        args: [agentKey, poolId],
      }) as readonly bigint[];
    } catch {
      console.log(`[skip] agentLpNfs revert/429 for pool ${cfg.poolAddress}`);
      continue;
    }
    // Small sleep to stay under quiknode's per-minute read rate cap.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    if (tokenIds.length === 0) continue;

    perPoolCount[cfg.poolAddress] = tokenIds.length;

    for (const id of tokenIds) {
      const tokenId = id.toString();
      let owner: Hex; let pool: Hex; let deployed: bigint; let tickLo: number; let tickHi: number;
      try {
        [owner, pool, deployed, tickLo, tickHi] = await Promise.all([
          publicClient.readContract({ address: vault, abi: policyVaultV3Abi, functionName: "lpNftOwner", args: [id] }) as Promise<Hex>,
          publicClient.readContract({ address: vault, abi: policyVaultV3Abi, functionName: "lpNftPool", args: [id] }) as Promise<Hex>,
          publicClient.readContract({ address: vault, abi: policyVaultV3Abi, functionName: "lpNftDeployedNative", args: [id] }) as Promise<bigint>,
          publicClient.readContract({ address: vault, abi: policyVaultV3Abi, functionName: "lpNftTickLower", args: [id] }) as Promise<number>,
          publicClient.readContract({ address: vault, abi: policyVaultV3Abi, functionName: "lpNftTickUpper", args: [id] }) as Promise<number>,
        ]);
      } catch (err) {
        console.log(`[skip] per-tokenId read failed for ${tokenId}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const stakeCfg = findZiaLpVaultByPool(cfg.poolAddress);
      const staked = Boolean(stakeCfg?.vaultAddress && owner.toLowerCase() === stakeCfg.vaultAddress.toLowerCase());

      // NFPM liquidity (separate read — confirms the NFT is live, not burned).
      const pos = (await publicClient.readContract({
        address: ZIA_LP_MAINNET.nonfungiblePositionManager,
        abi: ziaNonfungiblePositionManagerAbi,
        functionName: "positions",
        args: [id],
      }).catch(() => null)) as readonly bigint[] | null;
      const liquidity = pos ? BigInt(pos[7]) : 0n;

      totalDeployedRaw += deployed;
      rows.push({
        tokenId,
        pool: getAddress(pool),
        poolLabel: cfg.poolAddress,
        deployedNative0G: formatEther(deployed),
        liquidity: liquidity.toString(),
        tickLower: tickLo,
        tickUpper: tickHi,
        staked,
        nftOwner: getAddress(owner),
      });
    }
  }

  for (const r of rows) {
    console.log(JSON.stringify(r));
  }

  console.log("\n=== Summary ===");
  console.log(JSON.stringify({
    totalPositions: rows.length,
    derivedMaxPositions: deriveMaxPositions(lp.perLpActionCap0G, lp.maxLpExposure0G),
    perPoolCount,
    duplicatePools: Object.entries(perPoolCount).filter(([, n]) => n > 1),
    sumDeployedNative0G: formatEther(totalDeployedRaw),
    openLpExposure0G: formatEther(openLpExposure),
    policyPerLpActionCap0G: formatEther(lp.perLpActionCap0G),
    policyMaxLpExposure0G: formatEther(lp.maxLpExposure0G),
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});