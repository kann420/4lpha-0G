import "server-only";

import { formatEther, getAddress, type Address, Hex, PublicClient } from "viem";

import { executeMainnetPolicyVaultLpAction, type PolicyVaultLpExecution } from "@/lib/executor/policy-vault-lp";
import { agentKeyForDeployment } from "@/lib/agent/single-agent-server";
import { loadReadyLpWorkspace } from "@/lib/agent/lp/lp-workspace-load";
import type { OgAgentDeploymentRecord, OgAgentVaultLpPosition } from "@/lib/agent/single-agent";
import { findZiaLpVaultByPool, poolIdFromAddress, ZIA_LP_MAINNET, ZIA_LP_VAULTS, ziaNonfungiblePositionManagerAbi } from "@/lib/contracts/zia-lp";
import { policyVaultV3Abi } from "@/lib/contracts/policy-vault-v3";
import { makeMainnetPublicClient, readPairedToken } from "@/lib/agent/lp/lp-context";
import { uniswapV3PoolAbi } from "@/lib/contracts/zia-lp";
import { removeTokenIdFromRegistry } from "@/lib/agent/lp/lp-position-registry";

// Shared LP exit executor — stake / unstake / zap-out. The vault enforces the
// on-chain fence; this helper derives the agent key, resolves the position from
// the live workspace snapshot, and dispatches to executeMainnetPolicyVaultLpAction
// (which anchors the proof + audit for all 4 kinds). Exits are user-manual in
// this phase — no autonomous rebalance/TP/SL/compound.

export type LpExitKind = "stake" | "unstake" | "zap-out";

export interface RunLpExitInput {
  deployment: OgAgentDeploymentRecord;
  kind: LpExitKind;
  poolAddress: Address;
  tokenId: string;
  // zap-out only: the route computes quoteLpZapOut and passes the floors.
  quotedAmountOut?: bigint;
  amountOutMin?: bigint;
  // Optional: the sqrtPriceX96 the caller used for the quote (drift guard).
  // When omitted for zap-out, the helper re-reads slot0.
  quotedSqrtPriceX96?: bigint;
  publicClient?: PublicClient;
}

export interface RunLpExitResult {
  lpTxHash: Hex;
  proofTxHash?: Hex;
  tokenId: string;
  poolAddress: Address;
  amountOutMin?: bigint;
  storageWarning?: string;
}

export async function runLpExitForAgent(input: RunLpExitInput): Promise<RunLpExitResult> {
  const agentKey = agentKeyForDeployment({
    identityAddress: input.deployment.identityAddress,
    tokenId: input.deployment.tokenId,
  });

  // Load the workspace with retry — readVaultSnapshot is wrapped in
  // withTimeout and a flaky mainnet RPC (quiknode) read can time out, leaving
  // the snapshot ready:false even though the vault is fine on-chain. The
  // shared helper retries on transient timeouts and throws immediately with
  // the real `vault.warnings` surfaced for non-transient states (paused /
  // executorRevoked / chain mismatch / V2 / swap-only vault) — so those are
  // already rejected here with an actionable message.
  const workspace = await loadReadyLpWorkspace(input.deployment, { allowZeroBalance: true });
  const vault = workspace.vault;
  // loadReadyLpWorkspace only returns when v.lpPolicy is truthy, so this is a
  // TypeScript type-guard (narrowing vault.lpPolicy for the allowStaking read
  // below), not a runtime defense — the helper has already guaranteed it.
  const lpPolicy = vault.lpPolicy;
  if (!lpPolicy) {
    throw new Error("LP exit requires a ready V3 vault with an LP adapter and lpPolicy.");
  }

  // Resolve the position. The live snapshot enumerates positions via
  // getLogs({fromBlock:0}), which times out on some mainnet RPCs (quiknode),
  // returning an empty list — and right after a mint the read node may not
  // have indexed the block yet either. So: try sellableLpPositions from the
  // (retry-loaded) snapshot, then fall back to reading the position DIRECTLY
  // from the vault + NFPM by tokenId (bypasses getLogs entirely; the caller
  // always knows the tokenId). This keeps the auto-stake path (mint → stake
  // in one request) and the exit routes working on mainnet.
  let position: OgAgentVaultLpPosition | undefined = (vault.sellableLpPositions ?? []).find(
    (p) => p.tokenId === input.tokenId
      && p.poolAddress.toLowerCase() === input.poolAddress.toLowerCase(),
  );
  if (!position) {
    position = await readLpPositionByTokenId(
      input.tokenId,
      input.deployment.vault,
      agentKey,
      input.publicClient ?? makeMainnetPublicClient(),
    );
  }
  if (!position) {
    throw new Error(`LP position #${input.tokenId} not found in the vault snapshot or on-chain.`);
  }

  // The position's poolAddress is AUTHORITATIVE — both the snapshot path and
  // the fallback derive it from the vault's on-chain lpNftPool(tokenId), never
  // from the client-supplied input.poolAddress. Build the action from
  // position.poolAddress so a stale/wrong client poolAddress cannot cause an
  // on-chain PoolMismatch revert (the vault would reject it anyway; this
  // avoids wasting the gas and gives a clear client-side error instead).
  const poolAddress = position.poolAddress;
  if (input.kind === "stake") {
    if (position.staked) throw new Error(`Position #${input.tokenId} is already staked.`);
    if (!lpPolicy.allowStaking) throw new Error("Vault lpPolicy does not allow staking.");
    if (!findZiaLpVaultByPool(poolAddress)) {
      throw new Error("No Zia stake vault mapped for this pool; cannot stake.");
    }
  } else if (input.kind === "unstake") {
    if (!position.staked) throw new Error(`Position #${input.tokenId} is not staked; nothing to unstake.`);
    if (!findZiaLpVaultByPool(poolAddress)) {
      throw new Error("No Zia stake vault mapped for this pool; cannot unstake.");
    }
  } else if (input.kind === "zap-out") {
    if (position.staked) {
      throw new Error(`Position #${input.tokenId} is staked; unstake before zap-out (staked positions report liquidity 0).`);
    }
    if (input.amountOutMin === undefined || input.quotedAmountOut === undefined) {
      throw new Error("zap-out requires quotedAmountOut + amountOutMin from quoteLpZapOut.");
    }
  }

  const action: Parameters<typeof executeMainnetPolicyVaultLpAction>[0]["action"] = {
    kind: input.kind,
    poolAddress,
    tokenId: BigInt(input.tokenId),
  };

  if (input.kind === "zap-out") {
    const liquidity = parseLiquidity(position.liquidity);
    if (liquidity <= 0n) {
      throw new Error(`Position #${input.tokenId} has zero liquidity; cannot zap-out.`);
    }
    action.liquidity = liquidity;
    action.quotedAmountOut = input.quotedAmountOut;
    action.amountOutMin = input.amountOutMin;
    // Drift guard: prefer the caller's quoted sqrtPriceX96; otherwise re-read slot0.
    if (input.quotedSqrtPriceX96 !== undefined && input.quotedSqrtPriceX96 > 0n) {
      action.quotedSqrtPriceX96 = input.quotedSqrtPriceX96;
    } else {
      const publicClient = input.publicClient ?? makeMainnetPublicClient();
      const slot0 = await publicClient.readContract({
        address: poolAddress,
        abi: uniswapV3PoolAbi,
        functionName: "slot0",
        args: [],
      }) as readonly [bigint, number, ...unknown[]];
      action.quotedSqrtPriceX96 = slot0[0];
    }
  }

  const execution: PolicyVaultLpExecution = await executeMainnetPolicyVaultLpAction({
    networkId: "mainnet",
    agentKey,
    vaultAddress: input.deployment.vault,
    action,
    agentRef: input.deployment.agentRef,
  });

  // Registry prune on a confirmed full-burn zap-out. The vault only deletes the
  // NFT's on-chain mappings (lpNftOwner/lpNftPool/etc) on a FULL burn — a partial
  // liquidity zap-out keeps the NFT recorded (PolicyVaultV3.sol fullBurn path),
  // so the pool slot is still occupied and the registry entry must stay to keep
  // dedup blocking that pool. Re-read the position after the tx: if it's gone
  // (undefined), remove from registry; if it's still live (partial zap), keep.
  // Best-effort: a registry failure must not turn a successful exit into a 500.
  if (input.kind === "zap-out") {
    try {
      const after = await readLpPositionByTokenId(
        input.tokenId,
        input.deployment.vault,
        agentKey,
        input.publicClient ?? makeMainnetPublicClient(),
      );
      if (after === undefined) {
        await removeTokenIdFromRegistry(agentKey, input.tokenId);
      }
    } catch (err) {
      console.warn("[lp-registry] zap-out prune failed (non-fatal):", err instanceof Error ? err.message : String(err));
    }
  }

  return {
    lpTxHash: execution.lpTxHash,
    proofTxHash: execution.proofTxHash,
    tokenId: input.tokenId,
    poolAddress,
    amountOutMin: input.kind === "zap-out" ? input.amountOutMin : undefined,
    storageWarning: execution.storageWarning,
  };
}

function parseLiquidity(value: string): bigint {
  try {
    const parsed = BigInt(value);
    return parsed > 0n ? parsed : 0n;
  } catch {
    return 0n;
  }
}

// Direct per-tokenId position reader — bypasses the getLogs-based enumeration in
// readSellableLpPositions entirely (that path times out on some mainnet RPCs
// like quiknode, returning an empty list and breaking auto-stake right after a
// mint). The caller of runLpExitForAgent always knows the tokenId, so we read
// the vault's per-tokenId getters + NFPM positions()/ownerOf directly.
//
// The pool is derived from the vault's on-chain `lpNftPool(tokenId)` — NOT from
// a caller-supplied poolAddress. This matches the authoritative snapshot path
// (single-agent-server.ts readSellableLpPositions) and keeps the fallback from
// stamping a wrong-pool position when a client sends a stale/mismatched
// poolAddress. Returns undefined when the position does not belong to this
// agent key / vault, has no deployed native (burned / wrong key / wrong vault),
// or its on-chain pool is not in the ZIA_LP_VAULTS registry.
//
// Returns the base position shape (liquidity + staked are the fields the exit
// path consumes); accounting fields are left undefined — the UI shows "—"
// rather than fake numbers when this fallback feeds a snapshot.
export async function readLpPositionByTokenId(
  tokenIdRaw: string,
  vault: Address,
  agentKey: Hex,
  publicClient: PublicClient,
): Promise<OgAgentVaultLpPosition | undefined> {
  const tokenId = BigInt(tokenIdRaw);
  const nfpm = ZIA_LP_MAINNET.nonfungiblePositionManager;
  const [ownerAgent, poolId, deployedNative, tickLower, tickUpper, position, nftOwner] = await Promise.all([
    publicClient.readContract({ address: vault, abi: policyVaultV3Abi, functionName: "lpNftOwner", args: [tokenId] }) as Promise<Hex>,
    publicClient.readContract({ address: vault, abi: policyVaultV3Abi, functionName: "lpNftPool", args: [tokenId] }) as Promise<Hex>,
    publicClient.readContract({ address: vault, abi: policyVaultV3Abi, functionName: "lpNftDeployedNative", args: [tokenId] }) as Promise<bigint>,
    publicClient.readContract({ address: vault, abi: policyVaultV3Abi, functionName: "lpNftTickLower", args: [tokenId] }) as Promise<number>,
    publicClient.readContract({ address: vault, abi: policyVaultV3Abi, functionName: "lpNftTickUpper", args: [tokenId] }) as Promise<number>,
    publicClient.readContract({
      address: nfpm,
      abi: ziaNonfungiblePositionManagerAbi,
      functionName: "positions",
      args: [tokenId],
    }).catch(() => null) as Promise<readonly unknown[] | null>,
    publicClient.readContract({
      address: nfpm,
      abi: ziaNonfungiblePositionManagerAbi,
      functionName: "ownerOf",
      args: [tokenId],
    }).catch(() => null) as Promise<Address | null>,
  ]);
  if (ownerAgent.toLowerCase() !== agentKey.toLowerCase() || deployedNative <= 0n || !nftOwner) {
    return undefined;
  }
  // Derive the pool config from the on-chain poolId — authoritative, matches the
  // snapshot path. An unknown poolId (not in ZIA_LP_VAULTS) is not sellable.
  const poolCfg = ZIA_LP_VAULTS.find((item) => poolIdFromAddress(item.poolAddress).toLowerCase() === poolId.toLowerCase());
  if (!poolCfg) {
    return undefined;
  }
  const poolAddress = getAddress(poolCfg.poolAddress);
  const stakeVault = poolCfg.vaultAddress;
  const nftOwnerLower = nftOwner.toLowerCase();
  const staked = stakeVault ? nftOwnerLower === stakeVault.toLowerCase() : false;
  // Position must be held by the vault (unstaked) or the Zia stake vault
  // (staked). Any other owner means it was transferred out — not sellable.
  if (nftOwnerLower !== vault.toLowerCase() && !staked) {
    return undefined;
  }
  const posTuple = position as readonly bigint[] | null;
  const liquidity = posTuple ? BigInt(posTuple[7]) : 0n;
  return {
    tokenId: tokenIdRaw,
    poolId,
    poolAddress,
    poolLabel: poolCfg.label,
    tickLower,
    tickUpper,
    deployedNative0G: formatEther(deployedNative),
    liquidity: liquidity.toString(),
    staked,
    stakeVault: staked ? stakeVault : undefined,
  };
}

// Re-export so callers can resolve the paired token without an extra import hop.
export { readPairedToken };

// Position type re-export for callers that build precheck UIs.
export type { OgAgentVaultLpPosition };
