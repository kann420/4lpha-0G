import "server-only";

import { randomBytes } from "node:crypto";

import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  isAddress,
  isHex,
  keccak256,
  toBytes,
  zeroAddress,
  type Abi,
  type Address,
  type Chain,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  LP_ACTION_TYPE,
  normalizePolicyVaultV3Policy,
  policyVaultV3LpAbi,
  policyVaultV3Abi,
  type PolicyVaultV3LpActionRequest,
} from "@/lib/contracts/policy-vault-v3";
import { policyVaultV4LpEntryAbi, policyVaultV4LpExitAbi } from "@/lib/contracts/policy-vault-v4";
import { findZiaLpVaultByPool, poolIdFromAddress, uniswapV3PoolAbi, ZIA_LP_MAINNET } from "@/lib/contracts/zia-lp";
import { proofRegistryAbi as PROOF_REGISTRY_ABI } from "@/lib/contracts/proof-registry-abi";
import { resolveMainnetV3VaultForOwner } from "@/lib/agent/mainnet-vault-resolver";
import { uploadBytesTo0GStorage } from "@/lib/og/storage-upload";
import { assertLpMainnetEnv, LP_MAINNET_CHAIN_ID as MAINNET_CHAIN_ID } from "@/lib/agent/lp/lp-env-gate";
const ZERO_HASH = `0x${"00".repeat(32)}` as Hex;
const AGENT_REF = "4lpha-agent:policy-vault-lp-executor:v1";
// Max acceptable |newSqrtPriceX96 / quotedSqrtPriceX96 - 1| in bps before the
// proof is mined. 200 bps on sqrt ≈ 400 bps on price. Coarse guard against a
// large pool move between quote time and execution; the vault's on-chain
// delta/min-out checks remain the authoritative backstop for smaller drift.
const PRICE_DRIFT_TOLERANCE_BPS = 200n;

export type LpActionKind = "zap-in-mint" | "stake" | "unstake" | "zap-out";

export interface PolicyVaultLpAction {
  kind: LpActionKind;
  poolAddress: Address; // ZIA_LP_VAULTS pool
  // zap-in-mint fields:
  amount0G?: string; // native 0G input (decimal string)
  tickLower?: number;
  tickUpper?: number;
  quotedLiquidity?: bigint; // expected liquidity
  quotedAmount0?: bigint; // expected token0 (W0G side after wrap + balancing swap)
  quotedAmount1?: bigint; // expected token1 (paired side)
  amount0Min?: bigint;
  amount1Min?: bigint;
  // stake / unstake / zap-out fields:
  tokenId?: bigint;
  // zap-out fields:
  liquidity?: bigint; // amount to burn
  quotedAmountOut?: bigint; // expected native out
  amountOutMin?: bigint; // native-out floor (mapped to request.amount0Min on zap-out)
  // Drift guard: the sqrtPriceX96 the caller used to compute the quote. For
  // zap-in-mint and zap-out, the executor re-reads slot0 immediately before
  // acceptProof and throws quote_drift if the pool moved beyond the tolerance
  // below — BEFORE any proof gas is spent. This catches stale-quote execution
  // without reordering the contract calls (the vault still requires
  // proofRegistry.isAccepted during LP simulation, so the proof must be mined
  // first; the drift check is a TS-only pre-flight).
  quotedSqrtPriceX96?: bigint;
}

export interface PolicyVaultLpExecutionInput {
  networkId: "mainnet";
  agentKey: Hex;
  vaultAddress?: Address; // V3 vault; resolved from registry/env if omitted
  action: PolicyVaultLpAction;
  agentRef?: string;
  copilotAudit?: {
    model?: string;
    policyContextHash?: Hex;
    promptHash?: Hex;
    responseHash?: Hex;
  };
}

export interface PolicyVaultLpExecution {
  actionHash: Hex;
  auditRoot: Hex;
  vaultActionHash: Hex;
  storageRef: string;
  storageWarning?: string;
  lpTxHash: Hex;
  proofTxHash: Hex | undefined; // undefined when proofAlreadyAccepted skipped acceptProof
  tokenId?: bigint;
  liquidity?: bigint;
}

type Runtime = Awaited<ReturnType<typeof resolveMainnetRuntime>>;

const proofRegistryAbi = PROOF_REGISTRY_ABI;

export async function executeMainnetPolicyVaultLpAction(
  input: PolicyVaultLpExecutionInput,
): Promise<PolicyVaultLpExecution> {
  requireLiveTradingEnabled();
  const runtime = resolveMainnetRuntime();
  const proofAccount = privateKeyToAccount(readPrivateKeyEnv("DEPLOYER_PRIVATE_KEY"));
  const executorAccount = privateKeyToAccount(readPrivateKeyEnv("VAULT_EXECUTOR_PRIVATE_KEY"));
  const proofWallet = createWalletClient({ account: proofAccount, chain: runtime.chain, transport: http(runtime.rpcUrl) });
  const executorWallet = createWalletClient({ account: executorAccount, chain: runtime.chain, transport: http(runtime.rpcUrl) });

  const vaultAddress = await resolveVault(runtime, input.vaultAddress, proofAccount.address);
  if (vaultAddress === null) {
    throw new Error("No mainnet Policy Vault resolved for this deployer wallet.");
  }
  const isV4LpEntry = await isV4LpEntryVault(runtime, vaultAddress);

  // B1 FIX: V4 splits LP into LpEntry (entries: zap-in-mint, stake) and LpExit (exits: unstake,
  // zap-out). deployment.vault resolves to the LpEntry third; unstakeLp/zapOut live ONLY on LpExit.
  // For a V4 exit action, route the write + action-hash reads + executor/proof preflight to the
  // LpExit third (its vaultActionHashForLp binds address(this)); policySnapshotHash still comes from
  // LpEntry (LpExit validates policySnapshotHash == lpEntry.policyHash()).
  const isExitAction = input.action.kind === "unstake" || input.action.kind === "zap-out";
  let actionVault = vaultAddress;
  let actionLpAbi: Abi = policyVaultV3LpAbi as unknown as Abi;
  if (isV4LpEntry && isExitAction) {
    const lpExitVault = (await runtime.publicClient.readContract({
      address: vaultAddress,
      abi: policyVaultV4LpEntryAbi,
      functionName: "lpExitVault",
    })) as Address;
    if (!lpExitVault || lpExitVault === zeroAddress) {
      throw new Error("V4 LpEntry has no linked LpExit vault (setLpExitVault not called).");
    }
    actionVault = lpExitVault;
    actionLpAbi = policyVaultV4LpExitAbi as unknown as Abi;
  }

  // V3/V4 LP vault must have an LP adapter configured for LP actions.
  const lpAdapter = await runtime.publicClient.readContract({
    address: vaultAddress,
    abi: policyVaultV3LpAbi,
    functionName: "lpAdapter",
  });
  if (lpAdapter === zeroAddress) {
    throw new Error("Resolved vault is swap-only (lpAdapter == address(0)); LP actions require an LP adapter.");
  }

  // Verify the executor key is the vault executor + the agent key is enabled.
  // L3 preflight: also read paused/executorRevoked/proofRegistry from the vault on-chain
  // before any gas is spent, mirroring the V2 trade executor (policy-vault-trade.ts:306-332).
  // The vault's immutable proofRegistry is the authoritative acceptProof target — the env
  // override is only a cross-check, never the anchoring registry.
  // For V4 exits, preflight against the LpExit third (executor/paused/executorRevoked/proofRegistry
  // live there); reads use the V3 ABI selectors, which the LpExit contract also exposes.
  const [vaultExecutor, agentKeyEnabled, paused, executorRevoked, vaultProofRegistry] = await Promise.all([
    runtime.publicClient.readContract({ address: actionVault, abi: policyVaultV3Abi, functionName: "executor" }),
    runtime.publicClient.readContract({ address: actionVault, abi: policyVaultV3Abi, functionName: "agentKeyEnabled", args: [input.agentKey] }),
    runtime.publicClient.readContract({ address: actionVault, abi: policyVaultV3Abi, functionName: "paused" }),
    runtime.publicClient.readContract({ address: actionVault, abi: policyVaultV3Abi, functionName: "executorRevoked" }),
    runtime.publicClient.readContract({ address: actionVault, abi: policyVaultV3Abi, functionName: "proofRegistry" }),
  ]) as [Address, boolean, boolean, boolean, Address];
  if (vaultExecutor.toLowerCase() !== executorAccount.address.toLowerCase()) {
    throw new Error("VAULT_EXECUTOR_PRIVATE_KEY does not control this vault executor.");
  }
  // V4 exits are NOT gated by agentKey or pause on-chain (only revokeExecutor is the hard kill, B4).
  // Mirror that here so the server preflight does not re-introduce the exit-lockup B4 removed.
  const enforceEntryGates = !(isV4LpEntry && isExitAction);
  if (enforceEntryGates && !agentKeyEnabled) {
    throw new Error("Agent key is not enabled on this vault (call setAgentKeyEnabled on the vault first).");
  }
  if (enforceEntryGates && paused) {
    throw new Error("PolicyVault is paused");
  }
  if (executorRevoked) {
    throw new Error("PolicyVault executor is revoked");
  }
  // Cross-check: if the env-configured registry differs from the vault's immutable
  // proofRegistry, refuse to anchor in the wrong registry.
  if (!sameAddress(runtime.proofRegistry, vaultProofRegistry)) {
    throw new Error("Env NEXT_PUBLIC_PROOF_REGISTRY_MAINNET_ADDRESS does not match the vault's immutable proofRegistry");
  }

  const policySnapshotHash = await runtime.publicClient.readContract({
    address: vaultAddress,
    abi: policyVaultV3LpAbi,
    functionName: "policyHash",
  }) as Hex;
  if (policySnapshotHash === ZERO_HASH) {
    throw new Error("V3 vault policyHash is zero — policy not stored.");
  }

  const block = await runtime.publicClient.getBlock();
  const deadlineWindow = await readDeadlineWindow(runtime, vaultAddress, isV4LpEntry);
  const deadline = block.timestamp + (deadlineWindow > 90n ? deadlineWindow - 30n : deadlineWindow);
  const nonce = randomNonce();
  const draftRequest = buildDraftLpRequest(input, deadline, nonce, policySnapshotHash);

  // L3 preflight: action-kind-specific allowlist checks (view calls, no gas) before any
  // audit upload. Mirrors the V2 trade executor's allowedTokens/allowedPools gate.
  // ENTRY actions (zap-in-mint, stake) require allowedLpPools[poolId]; stake additionally
  // requires the pool-bound stake vault + policy.lp.allowStaking. EXIT actions (unstake,
  // zap-out) skip allowlists — the vault authorizes exits by recorded position, not allowlists
  // (PolicyVaultV3.sol _validateLpRequest exit-lockup guard).
  if (input.action.kind === "zap-in-mint" || input.action.kind === "stake") {
    if (input.action.kind === "stake") {
      const [lpPoolAllowed, stakeVaultAllowed, boundStakeVault, currentPolicy] = await Promise.all([
        runtime.publicClient.readContract({ address: vaultAddress, abi: policyVaultV3Abi, functionName: "allowedLpPools", args: [draftRequest.poolId] }),
        runtime.publicClient.readContract({ address: vaultAddress, abi: policyVaultV3Abi, functionName: "allowedStakeVaults", args: [draftRequest.stakeVault] }),
        runtime.publicClient.readContract({ address: vaultAddress, abi: policyVaultV3Abi, functionName: "stakeVaultForLpPool", args: [draftRequest.poolId] }),
        readLpPolicyForAllowStaking(runtime, vaultAddress, isV4LpEntry),
      ]) as [boolean, boolean, Address, unknown];
      if (!lpPoolAllowed) {
        throw new Error("LP pool is not allowlisted on this V3 vault (InvalidLpPool)");
      }
      if (!stakeVaultAllowed) {
        throw new Error("Stake vault is not allowlisted on this V3 vault (InvalidStakeVault)");
      }
      if (!sameAddress(boundStakeVault, draftRequest.stakeVault)) {
        throw new Error("Stake vault does not match the vault's stakeVaultForLpPool binding (InvalidStakeVault)");
      }
      // Decode through the shared helper because viem may return nested structs
      // as positional tuples or named objects.
      const allowStaking = isV4LpEntry
        ? normalizePolicyVaultV4LpPolicy(currentPolicy).allowStaking
        : normalizePolicyVaultV3Policy(currentPolicy).lp.allowStaking;
      if (allowStaking !== true) {
        throw new Error("LP staking is disabled by policy (StakingDisabled)");
      }
    } else {
      const lpPoolAllowed = await runtime.publicClient.readContract({
        address: vaultAddress,
        abi: policyVaultV3Abi,
        functionName: "allowedLpPools",
        args: [draftRequest.poolId],
      }) as boolean;
      if (!lpPoolAllowed) {
        throw new Error("LP pool is not allowlisted on this V3 vault (InvalidLpPool)");
      }
    }
  }

  // Read the on-chain vaultActionHashForLp + actionHashFor (mixes every field in
  // declaration order — the executor cannot inflate quoted values post-sign).
  // Upload first because vaultActionHashForLp includes auditRoot.
  const auditBundle = await uploadLpAudit({
    app: "4lpha-0g",
    kind: "policy-vault-lp-action",
    agentRef: input.agentRef ?? AGENT_REF,
    chainId: MAINNET_CHAIN_ID,
    createdAt: new Date().toISOString(),
    redacted: true,
    vault: vaultAddress,
    action: input.action,
    agentKey: input.agentKey,
    deadline: deadline.toString(),
    nonce: nonce.toString(),
    policySnapshotHash,
    copilotAudit: input.copilotAudit,
  });
  const requestForHash: PolicyVaultV3LpActionRequest = {
    ...draftRequest,
    auditRoot: auditBundle.auditRoot,
  };
  const vaultActionHash = await runtime.publicClient.readContract({
    address: actionVault,
    abi: actionLpAbi,
    functionName: "vaultActionHashForLp",
    args: [requestForHash],
  }) as Hex;
  const actionHash = await runtime.publicClient.readContract({
    address: actionVault,
    abi: actionLpAbi,
    functionName: "actionHashFor",
    args: [vaultActionHash, auditBundle.auditRoot, policySnapshotHash],
  }) as Hex;
  const request: PolicyVaultV3LpActionRequest = {
    ...requestForHash,
    actionHash,
    vaultActionHash,
  };

  const modelMetadataHash = hashJson({
    copilotAudit: input.copilotAudit,
    quoteSource: "zia-lp-partner-route",
    actionKind: input.action.kind,
  });
  const agentRef = input.agentRef ?? AGENT_REF;

  // L3: retarget acceptProof to the vault's immutable proofRegistry (not env), and mirror
  // the V2 trade executor's two guards (policy-vault-trade.ts:396-404, 464-466): the
  // ProofRegistry owner must equal the DEPLOYER proof account, and isAccepted must be false
  // (skip acceptProof entirely when already accepted). Order is preserved: acceptProof is
  // mined BEFORE the LP entrypoint is sent — PolicyVaultV3._validateLpRequest requires
  // proofRegistry.isAccepted(...) at entrypoint time.
  const [proofRegistryOwner, proofAlreadyAccepted] = await Promise.all([
    runtime.publicClient.readContract({ address: vaultProofRegistry, abi: proofRegistryAbi, functionName: "owner" }) as Promise<Address>,
    runtime.publicClient.readContract({
      address: vaultProofRegistry,
      abi: proofRegistryAbi,
      functionName: "isAccepted",
      args: [actionHash, auditBundle.auditRoot, policySnapshotHash, vaultActionHash],
    }) as Promise<boolean>,
  ]);
  if (!sameAddress(proofRegistryOwner, proofAccount.address)) {
    throw new Error("ProofRegistry owner does not match DEPLOYER_PRIVATE_KEY; cannot accept this proof");
  }

  // Drift guard (codex audit A8): for zap-in-mint and zap-out, re-read the
  // pool slot0 immediately before acceptProof and compare the live
  // sqrtPriceX96 to the value the caller used to compute the quote. If the
  // pool moved beyond PRICE_DRIFT_TOLERANCE_BPS, abort with quote_drift
  // BEFORE any proof gas is spent. The vault still requires isAccepted during
  // LP simulation, so the proof must be mined first — this is a TS-only
  // pre-flight, not a reorder. The vault's on-chain delta/min-out checks
  // remain the authoritative backstop for drift that slips through.
  if (
    (input.action.kind === "zap-in-mint" || input.action.kind === "zap-out") &&
    input.action.quotedSqrtPriceX96 !== undefined &&
    input.action.quotedSqrtPriceX96 > 0n
  ) {
    const liveSlot0 = await runtime.publicClient.readContract({
      address: input.action.poolAddress,
      abi: uniswapV3PoolAbi,
      functionName: "slot0",
      args: [],
    }).catch(() => null) as readonly [bigint, number, ...unknown[]] | null;
    if (liveSlot0 === null) {
      throw new Error("quote_drift: could not re-read pool slot0 before proof acceptance");
    }
    const liveSqrtPriceX96 = liveSlot0[0];
    const quoted = input.action.quotedSqrtPriceX96;
    const diff = liveSqrtPriceX96 > quoted ? liveSqrtPriceX96 - quoted : quoted - liveSqrtPriceX96;
    const driftBps = (diff * 10_000n) / quoted;
    if (driftBps > PRICE_DRIFT_TOLERANCE_BPS) {
      throw new Error(
        `quote_drift: pool sqrtPriceX96 moved ${driftBps.toString()} bps (> ${PRICE_DRIFT_TOLERANCE_BPS.toString()} bps tolerance) between quote and proof; aborting before proof gas`,
      );
    }
  }

  let proofTxHash: Hex | undefined;
  if (!proofAlreadyAccepted) {
    const proofSimulation = await runtime.publicClient.simulateContract({
      account: proofAccount.address,
      address: vaultProofRegistry,
      abi: proofRegistryAbi,
      functionName: "acceptProof",
      args: [actionHash, auditBundle.auditRoot, policySnapshotHash, modelMetadataHash, auditBundle.storageRef, vaultActionHash, agentRef],
    });
    proofTxHash = await proofWallet.writeContract({
      ...proofSimulation.request,
      account: proofAccount,
      chain: runtime.chain,
    });
    await waitForReceipt(runtime, proofTxHash, "LP proof acceptance");
  }

  const { functionName, parseResult } = lpEntrypointFor(input.action.kind);
  const lpSimulation = await runtime.publicClient.simulateContract({
    account: executorAccount.address,
    address: actionVault,
    abi: actionLpAbi,
    functionName,
    args: [request],
  });
  const lpTxHash = await executorWallet.writeContract({
    ...lpSimulation.request,
    account: executorAccount,
    chain: runtime.chain,
  });
  const lpReceipt = await waitForReceipt(runtime, lpTxHash, `${functionName} execution`);

  const parsed = parseResult(lpSimulation.result);

  // For mint, prefer the receipt's ERC721 Transfer event over the simulated
  // tokenId. NFPM assigns sequential _nextId; if another actor mints between
  // simulateContract and mining, the simulated tokenId is stale and the
  // auto-stake position lookup would fail. The Transfer event (from=zero,
  // to=vault) on the NFPM contract is the authoritative freshly-minted id.
  let tokenId = parsed.tokenId;
  if (input.action.kind === "zap-in-mint") {
    const TRANSFER_TOPIC =
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628755a6df2d49e3a" as const;
    const nfpm = ZIA_LP_MAINNET.nonfungiblePositionManager.toLowerCase();
    const vaultAddr = vaultAddress.toLowerCase();
    for (const log of lpReceipt.logs ?? []) {
      if (log.address.toLowerCase() !== nfpm) continue;
      if (log.topics[0] !== TRANSFER_TOPIC) continue;
      // ERC721 Transfer: from=topics[1], to=topics[2], tokenId=topics[3].
      if (!log.topics[1] || !log.topics[2] || !log.topics[3]) continue;
      const from = getAddress(`0x${log.topics[1].slice(26)}`).toLowerCase();
      const to = getAddress(`0x${log.topics[2].slice(26)}`).toLowerCase();
      if (from !== zeroAddress) continue; // mint => from zero-address
      if (to !== vaultAddr) continue;     // …to the vault
      tokenId = BigInt(log.topics[3]);
      break;
    }
  }

  return {
    actionHash,
    auditRoot: auditBundle.auditRoot,
    vaultActionHash,
    storageRef: auditBundle.storageRef,
    storageWarning: auditBundle.storageWarning,
    lpTxHash,
    proofTxHash,
    tokenId,
    liquidity: parsed.liquidity,
  };
}

function buildDraftLpRequest(
  input: PolicyVaultLpExecutionInput,
  deadline: bigint,
  nonce: bigint,
  policySnapshotHash: Hex,
): PolicyVaultV3LpActionRequest {
  const action = input.action;
  const poolId = poolIdFromAddress(action.poolAddress);
  const stakeVaultCfg = findZiaLpVaultByPool(action.poolAddress);
  // stakeVault is required for stake/unstake; zero for mint/zap-out.
  const stakeVault: Address = action.kind === "stake" || action.kind === "unstake"
    ? (stakeVaultCfg?.vaultAddress ?? zeroAddress)
    : zeroAddress;

  const base: PolicyVaultV3LpActionRequest = {
    actionType: 0,
    agentKey: input.agentKey,
    poolId,
    stakeVault,
    tokenIn: zeroAddress, // sweep deferred to v4
    tokenOut: zeroAddress,
    tokenId: 0n,
    tickLower: 0,
    tickUpper: 0,
    amount0Desired: 0n,
    amount1Desired: 0n,
    liquidity: 0n,
    amount0Min: 0n,
    amount1Min: 0n,
    quotedLiquidity: 0n,
    quotedAmount0: 0n,
    quotedAmount1: 0n,
    quotedAmountOut: 0n,
    deadline,
    nonce,
    vaultActionHash: ZERO_HASH,
    actionHash: ZERO_HASH,
    policySnapshotHash,
    auditRoot: ZERO_HASH,
  };

  switch (action.kind) {
    case "zap-in-mint": {
      if (action.amount0G === undefined || action.tickLower === undefined || action.tickUpper === undefined
        || action.quotedLiquidity === undefined || action.quotedAmount0 === undefined || action.quotedAmount1 === undefined
        || action.amount0Min === undefined || action.amount1Min === undefined) {
        throw new Error("zap-in-mint requires amount0G, tickLower, tickUpper, quotedLiquidity, quotedAmount0, quotedAmount1, amount0Min, amount1Min");
      }
      return {
        ...base,
        actionType: LP_ACTION_TYPE.ZAP_IN_MINT_LP,
        tickLower: action.tickLower,
        tickUpper: action.tickUpper,
        amount0Desired: parse0G(action.amount0G),
        liquidity: action.quotedLiquidity, // vault requires request.liquidity == quotedLiquidity floor check
        amount0Min: action.amount0Min,
        amount1Min: action.amount1Min,
        quotedLiquidity: action.quotedLiquidity,
        quotedAmount0: action.quotedAmount0,
        quotedAmount1: action.quotedAmount1,
      };
    }
    case "stake": {
      if (action.tokenId === undefined) throw new Error("stake requires tokenId");
      if (stakeVault === zeroAddress) throw new Error("No Zia stake vault mapped for this pool");
      return {
        ...base,
        actionType: LP_ACTION_TYPE.STAKE_LP,
        tokenId: action.tokenId,
      };
    }
    case "unstake": {
      if (action.tokenId === undefined) throw new Error("unstake requires tokenId");
      if (stakeVault === zeroAddress) throw new Error("No Zia stake vault mapped for this pool");
      return {
        ...base,
        actionType: LP_ACTION_TYPE.UNSTAKE_LP,
        tokenId: action.tokenId,
      };
    }
    case "zap-out": {
      if (action.tokenId === undefined || action.liquidity === undefined
        || action.quotedAmountOut === undefined || action.amountOutMin === undefined) {
        throw new Error("zap-out requires tokenId, liquidity, quotedAmountOut, amountOutMin");
      }
      // zap-out maps amountOutMin -> request.amount0Min (native-out floor); amount1Min unused.
      return {
        ...base,
        actionType: LP_ACTION_TYPE.ZAP_OUT,
        tokenId: action.tokenId,
        liquidity: action.liquidity,
        amount0Min: action.amountOutMin,
        quotedAmountOut: action.quotedAmountOut,
      };
    }
    default:
      throw new Error(`Unsupported LP action kind: ${String(action.kind)}`);
  }
}

function lpEntrypointFor(kind: LpActionKind): {
  functionName: "zapInMintLp" | "stakeLp" | "unstakeLp" | "zapOut";
  parseResult: (result: unknown) => { tokenId?: bigint; liquidity?: bigint };
} {
  switch (kind) {
    case "zap-in-mint":
      return {
        functionName: "zapInMintLp",
        parseResult: (r) => {
          const arr = r as readonly [bigint, bigint, bigint, bigint];
          return { tokenId: arr[0], liquidity: arr[1] };
        },
      };
    case "stake":
      return { functionName: "stakeLp", parseResult: () => ({}) };
    case "unstake":
      return { functionName: "unstakeLp", parseResult: () => ({}) };
    case "zap-out":
      return {
        functionName: "zapOut",
        parseResult: (r) => {
          const out = r as bigint;
          return { tokenId: undefined, liquidity: undefined, amountOut: out };
        },
      };
  }
}

async function resolveVault(runtime: Runtime, vaultAddress: Address | undefined, owner: Address): Promise<Address | null> {
  if (vaultAddress) {
    return getAddress(vaultAddress);
  }
  return await resolveMainnetV3VaultForOwner(owner, runtime.publicClient).catch(() => null);
}

async function isV4LpEntryVault(runtime: Runtime, vault: Address): Promise<boolean> {
  const linkedExit = await runtime.publicClient.readContract({
    address: vault,
    abi: policyVaultV4LpEntryAbi,
    functionName: "lpExitVault",
  }).catch(() => zeroAddress) as Address;
  return linkedExit !== zeroAddress;
}

async function readLpPolicyForAllowStaking(runtime: Runtime, vault: Address, isV4LpEntry: boolean): Promise<unknown> {
  return runtime.publicClient.readContract({
    address: vault,
    abi: isV4LpEntry ? policyVaultV4LpEntryAbi : policyVaultV3Abi,
    functionName: "policy",
  });
}

async function readDeadlineWindow(runtime: Runtime, vault: Address, isV4LpEntry: boolean): Promise<bigint> {
  if (isV4LpEntry) {
    return 24n * 60n * 60n;
  }
  const rawPolicy = await runtime.publicClient.readContract({
    address: vault,
    abi: policyVaultV3Abi,
    functionName: "policy",
  });
  // V3 policy tuple: [perTradeCap0G, dailyCap0G, maxExposure0G, cooldownSeconds,
  // maxDeadlineWindowSeconds, defaultMinOutBps, lpStruct]. Decode by index — named
  // access on viem tuples is unreliable, mirroring single-agent-server.ts:718 and
  // policy-vault-trade.ts:354. Index [4] is the deadline window.
  const policy = rawPolicy as readonly [bigint, bigint, bigint, bigint, bigint, number, readonly unknown[]];
  const window = policy[4];
  if (typeof window !== "bigint") {
    throw new Error("Could not read V3 policy.maxDeadlineWindowSeconds");
  }
  return window;
}

function normalizePolicyVaultV4LpPolicy(raw: unknown): { allowStaking: boolean } {
  const record = raw as Record<string, unknown>;
  const list = raw as readonly unknown[];
  const value = record?.allowStaking ?? list?.[6];
  if (typeof value !== "boolean") {
    throw new Error("Could not read V4 lpPolicy.allowStaking");
  }
  return { allowStaking: value };
}

function resolveMainnetRuntime() {
  requireMainnetFlags();
  const rpcUrl = requireEnv("OG_RPC_URL");
  const chain = make0GMainnetChain(rpcUrl);
  // Default viem retry (3/150ms); env override opts into 429 backoff for
  // bursty one-off scripts. viem only retries non-deterministic errors.
  const retryCount = Number(process.env.OG_RPC_RETRY_COUNT ?? 3);
  const retryDelay = Number(process.env.OG_RPC_RETRY_DELAY_MS ?? 150);
  const publicClient = createPublicClient({
    chain,
    transport: http(rpcUrl, {
      retryCount: Number.isFinite(retryCount) && retryCount >= 0 ? retryCount : 3,
      retryDelay: Number.isFinite(retryDelay) && retryDelay >= 0 ? retryDelay : 150,
    }),
  });
  return {
    chain,
    proofRegistry: readAddressEnv("NEXT_PUBLIC_PROOF_REGISTRY_MAINNET_ADDRESS"),
    publicClient,
    rpcUrl,
  };
}

function requireMainnetFlags() {
  // Delegates to the shared LP env gate so the executor and the LP API routes
  // cannot drift. `execute` mode is the live-trading path; `deploy` (mint
  // AgenticID + tightenPolicy + deposit) is gated separately at the route.
  assertLpMainnetEnv("execute");
}

function requireLiveTradingEnabled() {
  requireMainnetFlags();
}

function make0GMainnetChain(rpcUrl: string): Chain {
  return {
    id: MAINNET_CHAIN_ID,
    name: "0G Mainnet",
    nativeCurrency: { decimals: 18, name: "0G", symbol: "0G" },
    rpcUrls: { default: { http: [rpcUrl] } },
  };
}

async function uploadLpAudit(payload: unknown): Promise<{ auditRoot: Hex; storageRef: string; storageWarning?: string }> {
  const encoded = new TextEncoder().encode(`${stableJson(payload)}\n`);
  try {
    const upload = await uploadBytesTo0GStorage(encoded);
    return { auditRoot: upload.rootHash, storageRef: upload.storageRef };
  } catch (error) {
    const auditRoot = keccak256(encoded);
    const reason = sanitizeStorageFallbackReason(error);
    return {
      auditRoot,
      storageRef: `local-fallback:${auditRoot}:0g-storage-unavailable`,
      storageWarning: `0G Storage upload failed; anchored local fallback audit root. ${reason}`,
    };
  }
}

function sanitizeStorageFallbackReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/https?:\/\/[^\s"']+/g, "[url]")
    .replace(/\b(?:sk|mk)-[A-Za-z0-9._-]{8,}\b/g, "[redacted-key]")
    .replace(/[A-Fa-f0-9]{64,}/g, "[redacted-hex]")
    .slice(0, 180);
}

function hashJson(value: unknown): Hex {
  return keccak256(toBytes(stableJson(value)));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  if (typeof value === "bigint") {
    return JSON.stringify(value.toString());
  }
  return JSON.stringify(value);
}

function parse0G(value: string): bigint {
  const normalized = value.trim();
  if (!/^\d+(\.\d+)?$/u.test(normalized)) {
    throw new Error("0G amount must be a positive decimal value.");
  }
  // 18 decimals (native 0G). Reject inputs with more than 18 fractional digits — the
  // padEnd(18, "0") concat below would otherwise silently inflate the wei value (e.g.
  // 1.0000000000000000001 -> 10.000000000000000001 0G). Vault caps still bound the damage,
  // but the operator's intent must be honored.
  const [whole, frac = ""] = normalized.split(".");
  if (frac.length > 18) {
    throw new Error("0G amount must not have more than 18 fractional digits.");
  }
  const padded = (whole + frac.padEnd(18, "0")).replace(/^0+(?=\d)/, "");
  return BigInt(padded || "0");
}

function randomNonce(): bigint {
  return BigInt(`0x${randomBytes(16).toString("hex")}`);
}

async function waitForReceipt(runtime: Runtime, hash: Hex, label: string) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const receipt = await runtime.publicClient.getTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        throw new Error(`${label} transaction reverted: ${hash}`);
      }
      return receipt;
    } catch (error) {
      if (!isReceiptPendingError(error)) {
        throw error;
      }
      await sleep(1_000);
    }
  }
  throw new Error(`Timed out waiting for ${label} receipt: ${hash}`);
}

function isReceiptPendingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes("receipt") && message.toLowerCase().includes("not") && message.toLowerCase().includes("found");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readPrivateKeyEnv(name: string): Hex {
  const value = requireEnv(name);
  if (!isHex(value, { strict: true }) || value.length !== 66) {
    throw new Error(`${name} must be a 32-byte private key hex string.`);
  }
  return value as Hex;
}

function readAddressEnv(name: string): Address {
  const value = requireEnv(name);
  if (!isAddress(value)) {
    throw new Error(`${name} must be a valid EVM address.`);
  }
  return getAddress(value);
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function sameAddress(left: Address, right: Address): boolean {
  return left.toLowerCase() === right.toLowerCase();
}
