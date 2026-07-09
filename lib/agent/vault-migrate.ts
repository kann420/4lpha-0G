import "server-only";

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  formatEther,
  getAddress,
  isAddress,
  isHex,
  parseEther,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

import {
  agentKeyForDeployment,
  loadOgAgentWorkspace,
  migrateOwnerVaultToV3,
  OgAgentDeployError,
} from "@/lib/agent/single-agent-server";
import { makeDeployerRuntime, type DeployerRuntime } from "@/lib/agent/lp/lp-deploy";
import {
  MAINNET_V3_VAULT_REGISTRY_PATH,
  normalizePolicyVaultV3Policy,
  policyVaultV3Abi,
  type MainnetV3VaultRegistryEntry,
  type PolicyVaultV3Policy,
} from "@/lib/contracts/policy-vault-v3";
import { buildV3LpAllowlists } from "@/lib/contracts/zia-lp";
import { curatedMainnetRouteIds, uniqueCuratedMainnetTokens } from "@/lib/contracts/curated-routes";

// Full-flow "redeploy + migrate to a new V3 vault" orchestrator. Deploys a NEW
// per-owner PolicyVaultV3 with effectively-unlimited (1M 0G) caps, drains the
// OLD vault's native 0G into the deployer, deposits it (minus a gas reserve)
// into the new vault, flips the resolver env override to the new vault (in-memory
// for the running app process + persisted to .env.local for restart), and
// re-points every active agent record at the new vault (migrateOwnerVaultToV3).
//
// WHY: the shared singleton 0xfd39 was tightened on-chain by agent-21's deploy
// (per=1, daily=3, exposure=3) before the Bug 2 fix removed auto-tighten. That
// tighten is irreversible (tightenPolicy is onlyOwner + can-only-tighten; no
// loosen/reset on-chain), so the only forward path is a fresh vault. The Bug 2
// fix keeps the new vault safe — no agent deploy re-tightens it.
//
// Reuses the funds-touching patterns proven in scripts/lp-vault-fund-migrate.ts:
// explicit-address withdraw (NOT the resolver, which may already be flipped),
// idempotent deposit (skip if the new vault is already funded), authoritative
// on-chain postcondition checks (cover receipt timeouts), and per-agent
// agentKeyEnabled verification. The migrate half reuses migrateOwnerVaultToV3.
// Real money. DEPLOYER pays gas. Step-gated + idempotent via a state file so a
// client-side timeout → re-POST resumes from the last completed step (no
// double-deploy / double-withdraw).

const CHAIN_ID = 16661;
const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;
const SENTINEL_TXHASH = "0x" as Hex; // marks "skipped / no tx this run" in state
const STATE_FILE_PATH = join(process.cwd(), ".data", "deployments", "vault-migrate-state.json");
const ENV_LOCAL_PATH = join(process.cwd(), ".env.local");
const ENV_LOCAL_BAK_PATH = join(process.cwd(), ".env.local.bak");
// Left in the DEPLOYER wallet after deposit to cover migrate + a few proof txs.
const GAS_RESERVE_0G = "0.05";
// Post-withdraw residual the old vault may keep (dust / refund race) and still
// count as "drained". Meaningful leftovers (>0.0001) are treated as a failure.
const WITHDRAW_RESIDUAL_TOLERANCE_0G = "0.0001";

// "Unlimited" = 1M 0G finite caps (per-action + daily, swap + LP) + the uint256
// max sentinel for LP exposure. Finite caps keep the vault AGENTS.md-compliant
// (caps exist + are enforceable) while never binding the demo. Matches the
// EXPECTED_LP_DAILY_CAP_0G = 1_000_000 precedent in lp-vault-fund-migrate.ts:111.
const CAP_PRESET = "1000000";
const CAP_PRESET_WEI = parseEther(CAP_PRESET);
const MAX_UINT256 = 2n ** 256n - 1n;

export interface VaultMigrateState {
  oldVault: Address;
  newVault?: Address;
  deployTxHash?: Hex;
  withdrawnAmount0G?: string;
  withdrawTxHash?: Hex;
  depositTxHash?: Hex;
  depositAmount0G?: string;
  migratedAgents?: string[];
  updatedAt: string;
}

export interface VaultMigrateResult {
  oldVault: Address;
  newVault: Address;
  deployTxHash: Hex;
  withdrawTxHash: Hex;
  depositTxHash: Hex;
  withdrawnAmount0G: string;
  depositAmount0G: string;
  migratedAgents: string[];
  restartRequired: boolean;
  envLocalUpdated: boolean;
}

/// The 1M-cap policy the new vault is deployed with. No env dependency — the
/// preset is fixed so a misconfigured cap env var can never silently ship a
/// tighter vault. Mirrors the PolicyVaultV3Policy field layout
/// (lib/contracts/policy-vault-v3.ts:686) — 6 swap fields + nested LpPolicy.
export function buildV3MigrationPolicy(): PolicyVaultV3Policy {
  return {
    perTradeCap0G: CAP_PRESET_WEI,
    dailyCap0G: CAP_PRESET_WEI,
    maxExposure0G: CAP_PRESET_WEI,
    cooldownSeconds: 0n,
    maxDeadlineWindowSeconds: 3600n,
    defaultMinOutBps: 9500,
    lp: {
      perLpActionCap0G: CAP_PRESET_WEI,
      lpDailyCap0G: CAP_PRESET_WEI,
      maxLpExposure0G: MAX_UINT256, // unbounded sentinel (PolicyVaultV3.sol:38)
      cooldownSecondsLp: 0n,
      lpMinOutBps: 9500,
      minLiquidityFloor: 1_000_000n,
      allowStaking: true,
    },
  };
}

/// Mainnet deploy config read from the same env vars as
/// scripts/mainnet-vault-utils.ts:readMainnetVaultConfig + the optional Zia LP
/// adapter. The LP adapter is REQUIRED for this flow (we are migrating LP agents
/// that need it), unlike the swap-only create script which allows address(0).
function readVaultDeployConfig(): {
  adapter: Address;
  executor: Address;
  proofRegistry: Address;
  lpAdapter: Address;
} {
  const adapter = requireAddressEnv("NEXT_PUBLIC_POLICY_VAULT_ADAPTER_MAINNET_ADDRESS", "swap adapter");
  const executor = requireAddressEnv("NEXT_PUBLIC_VAULT_EXECUTOR_MAINNET_ADDRESS", "executor");
  const proofRegistry = requireAddressEnv("NEXT_PUBLIC_PROOF_REGISTRY_MAINNET_ADDRESS", "proof registry");
  const lpAdapterEnv = process.env.NEXT_PUBLIC_POLICY_VAULT_ZIA_LP_ADAPTER_MAINNET_ADDRESS?.trim();
  if (!lpAdapterEnv || !isAddress(lpAdapterEnv)) {
    throw new OgAgentDeployError(
      "NEXT_PUBLIC_POLICY_VAULT_ZIA_LP_ADAPTER_MAINNET_ADDRESS is required for vault migration (the new vault must seed the Zia LP allowlists).",
      "env_missing",
      500,
    );
  }
  return { adapter, executor, proofRegistry, lpAdapter: getAddress(lpAdapterEnv) };
}

function requireAddressEnv(name: string, label: string): Address {
  const value = process.env[name]?.trim();
  if (!value || !isAddress(value)) {
    throw new OgAgentDeployError(`${name} (mainnet ${label}) is required.`, "env_missing", 500);
  }
  return getAddress(value);
}

// Mirrors assertMainnetDeployEnv (single-agent-server.ts:2824) + the local gate
// in lp-vault-fund-migrate.ts:207. Run for the whole flow so a misconfigured flag
// can't let withdraw/deposit succeed then have migrate fail (which would move
// funds without re-pointing records).
function assertMainnetEnvGates(): void {
  if ((process.env.OG_NETWORK ?? "").toLowerCase() !== "mainnet") {
    throw new OgAgentDeployError("Vault migration requires OG_NETWORK=mainnet.", "mainnet_required", 409);
  }
  if (Number(process.env.OG_CHAIN_ID ?? "0") !== CHAIN_ID) {
    throw new OgAgentDeployError(`Vault migration requires OG_CHAIN_ID=${CHAIN_ID}.`, "mainnet_required", 409);
  }
  requireFlag("ENABLE_MAINNET_DEPLOY", true);
  requireFlag("ENABLE_REAL_DEX_ADAPTER", true);
  requireFlag("ENABLE_MOCK_DEX_ADAPTER", false);
}

function requireFlag(name: string, expected: boolean): void {
  const actual = (process.env[name] ?? "false").toLowerCase() === "true";
  if (actual !== expected) {
    throw new OgAgentDeployError(`${name} must be ${String(expected)}.`, "flag_mismatch", 409);
  }
}

// --- State file (idempotency / resumability) ---

async function readMigrateState(): Promise<VaultMigrateState | null> {
  try {
    const raw = await readFile(STATE_FILE_PATH, "utf8");
    return JSON.parse(raw) as VaultMigrateState;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("ENOENT") || message.includes("no such file")) return null;
    throw error;
  }
}

async function writeMigrateState(state: VaultMigrateState): Promise<void> {
  await mkdir(dirname(STATE_FILE_PATH), { recursive: true });
  await writeFile(STATE_FILE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

// --- Deploy ---

/// Read the Hardhat artifact { abi, bytecode } for PolicyVaultV3 directly from
/// disk. The exported policyVaultV3Abi (lib/contracts/policy-vault-v3.ts) omits
/// the constructor, so viem's deployContract cannot encode constructor args
/// from it — the full artifact abi (which includes the 13-input constructor) is
/// required for deploy. No hardhat runtime needed.
async function loadVaultArtifact(): Promise<{ abi: Abi; bytecode: Hex }> {
  const artifactPath = join(process.cwd(), "artifacts", "contracts", "PolicyVaultV3.sol", "PolicyVaultV3.json");
  let raw: string;
  try {
    raw = await readFile(artifactPath, "utf8");
  } catch {
    throw new OgAgentDeployError(
      `PolicyVaultV3 artifact not found at ${artifactPath}. Run \`npx hardhat compile\` first.`,
      "artifact_missing",
      500,
    );
  }
  const parsed = JSON.parse(raw) as { abi?: Abi; bytecode?: Hex };
  if (!parsed.abi || !Array.isArray(parsed.abi)) {
    throw new OgAgentDeployError("PolicyVaultV3 artifact is missing its abi.", "artifact_missing", 500);
  }
  const bytecode = parsed.bytecode;
  if (!bytecode || !isHex(bytecode) || bytecode === "0x") {
    throw new OgAgentDeployError("PolicyVaultV3 artifact is missing its bytecode.", "artifact_missing", 500);
  }
  return { abi: parsed.abi, bytecode };
}

async function appendV3RegistryEntry(entry: MainnetV3VaultRegistryEntry): Promise<void> {
  let registry: MainnetV3VaultRegistryEntry[] = [];
  try {
    const raw = await readFile(MAINNET_V3_VAULT_REGISTRY_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) registry = parsed as MainnetV3VaultRegistryEntry[];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("ENOENT") && !message.includes("no such file")) throw error;
  }
  registry.push(entry);
  await mkdir(dirname(MAINNET_V3_VAULT_REGISTRY_PATH), { recursive: true });
  await writeFile(MAINNET_V3_VAULT_REGISTRY_PATH, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}

async function verifyDeployedVault(
  publicClient: PublicClient,
  vault: Address,
  owner: Address,
  config: { executor: Address; adapter: Address; proofRegistry: Address; lpAdapter: Address },
): Promise<void> {
  const [vOwner, vExecutor, vAdapter, vLpAdapter, vProofRegistry, vPaused, vRevoked, vPolicyHash, vPolicy] = await Promise.all([
    publicClient.readContract({ address: vault, abi: policyVaultV3Abi, functionName: "owner" }) as Promise<Address>,
    publicClient.readContract({ address: vault, abi: policyVaultV3Abi, functionName: "executor" }) as Promise<Address>,
    publicClient.readContract({ address: vault, abi: policyVaultV3Abi, functionName: "adapter" }) as Promise<Address>,
    publicClient.readContract({ address: vault, abi: policyVaultV3Abi, functionName: "lpAdapter" }) as Promise<Address>,
    publicClient.readContract({ address: vault, abi: policyVaultV3Abi, functionName: "proofRegistry" }) as Promise<Address>,
    publicClient.readContract({ address: vault, abi: policyVaultV3Abi, functionName: "paused" }) as Promise<boolean>,
    publicClient.readContract({ address: vault, abi: policyVaultV3Abi, functionName: "executorRevoked" }) as Promise<boolean>,
    publicClient.readContract({ address: vault, abi: policyVaultV3Abi, functionName: "policyHash" }) as Promise<Hex>,
    publicClient.readContract({ address: vault, abi: policyVaultV3Abi, functionName: "policy" }),
  ]);
  if (getAddress(vOwner) !== getAddress(owner)) {
    throw new OgAgentDeployError(`verify: owner mismatch — got ${vOwner}, expected ${owner}`, "migrate_verify_failed", 500);
  }
  if (getAddress(vExecutor) !== getAddress(config.executor)) {
    throw new OgAgentDeployError(`verify: executor mismatch — got ${vExecutor}, expected ${config.executor}`, "migrate_verify_failed", 500);
  }
  if (getAddress(vAdapter) !== getAddress(config.adapter)) {
    throw new OgAgentDeployError(`verify: adapter mismatch — got ${vAdapter}, expected ${config.adapter}`, "migrate_verify_failed", 500);
  }
  if (getAddress(vLpAdapter) !== getAddress(config.lpAdapter)) {
    throw new OgAgentDeployError(`verify: lpAdapter mismatch — got ${vLpAdapter}, expected ${config.lpAdapter}`, "migrate_verify_failed", 500);
  }
  if (getAddress(vProofRegistry) !== getAddress(config.proofRegistry)) {
    throw new OgAgentDeployError(`verify: proofRegistry mismatch — got ${vProofRegistry}, expected ${config.proofRegistry}`, "migrate_verify_failed", 500);
  }
  if (vPaused) throw new OgAgentDeployError("verify: vault is paused", "migrate_verify_failed", 500);
  if (vRevoked) throw new OgAgentDeployError("verify: executor is revoked", "migrate_verify_failed", 500);
  if (vPolicyHash === ZERO_BYTES32) {
    throw new OgAgentDeployError("verify: policyHash is zero (policy not stored)", "migrate_verify_failed", 500);
  }
  const policy = normalizePolicyVaultV3Policy(vPolicy);
  if (policy.lp.lpDailyCap0G !== CAP_PRESET_WEI) {
    throw new OgAgentDeployError(
      `verify: lpDailyCap0G mismatch — got ${formatEther(policy.lp.lpDailyCap0G)}, expected ${CAP_PRESET}`,
      "migrate_verify_failed",
      500,
    );
  }
  // Allowlist check: every zappable W0G-leg pool must be allowlisted + bound to
  // its Zia stake vault (constructor-only + one-way-disable; a miss means the
  // agent can never mint).
  const { allowedLpPools, stakeVaultForLpPool } = buildV3LpAllowlists();
  for (let i = 0; i < allowedLpPools.length; i += 1) {
    const poolId = allowedLpPools[i];
    const expectedStakeVault = stakeVaultForLpPool[i];
    const [allowed, bound] = await Promise.all([
      publicClient.readContract({ address: vault, abi: policyVaultV3Abi, functionName: "allowedLpPools", args: [poolId] }) as Promise<boolean>,
      publicClient.readContract({ address: vault, abi: policyVaultV3Abi, functionName: "stakeVaultForLpPool", args: [poolId] }) as Promise<Address>,
    ]);
    if (!allowed) {
      throw new OgAgentDeployError(`verify: LP pool ${poolId} not allowlisted on ${vault}`, "migrate_verify_failed", 500);
    }
    if (getAddress(bound) !== getAddress(expectedStakeVault)) {
      throw new OgAgentDeployError(
        `verify: pool ${poolId} stake vault mismatch — got ${bound}, expected ${expectedStakeVault}`,
        "migrate_verify_failed",
        500,
      );
    }
  }
}

/// Deploy a new PolicyVaultV3 from the deployer wallet. Idempotent: if a prior
/// run recorded a newVault in the state file, re-verify it on-chain and skip
/// re-deploy (covers a deploy tx that mined but whose receipt timed out).
export async function deployMainnetV3Vault(
  runtime: DeployerRuntime,
  owner: Address,
  state: VaultMigrateState,
): Promise<{ vault: Address; txHash: Hex; blockNumber: bigint; skipped: boolean }> {
  // Idempotency: if state already has a newVault, verify it on-chain.
  if (state.newVault) {
    await verifyDeployedVault(runtime.publicClient, state.newVault, owner, readVaultDeployConfig());
    return { vault: state.newVault, txHash: state.deployTxHash ?? SENTINEL_TXHASH, blockNumber: 0n, skipped: true };
  }
  const config = readVaultDeployConfig();
  const { abi, bytecode } = await loadVaultArtifact();
  const policy = buildV3MigrationPolicy();
  const allowedTokens = uniqueCuratedMainnetTokens();
  const allowedPools = curatedMainnetRouteIds();
  const { allowedLpPools, allowedStakeVaults, stakeVaultForLpPool } = buildV3LpAllowlists();
  if (allowedTokens.length === 0 || allowedPools.length === 0) {
    throw new OgAgentDeployError("V3 vault requires non-empty curated tokens + pools.", "invalid_config", 500);
  }

  const deployArgs: readonly unknown[] = [
    owner, // initialOwner
    config.executor, // executor_
    config.adapter, // adapter_
    config.lpAdapter, // lpAdapter_ (required for this flow)
    config.proofRegistry, // proofRegistry_
    policy, // initialPolicy (nested tuple; viem encodes the object form)
    allowedTokens, // initialAllowedTokens
    allowedPools, // initialAllowedPools
    allowedLpPools, // initialAllowedLpPools
    allowedStakeVaults, // initialAllowedStakeVaults
    stakeVaultForLpPool, // initialStakeVaultForLpPool (parallel to allowedLpPools)
    false, // allowMockAdapter (mainnet never)
    false, // allowMockLpAdapter (mainnet never)
  ];

  const deployerBalance = await runtime.publicClient.getBalance({ address: runtime.deployer.address });
  if (deployerBalance < parseEther("0.01")) {
    throw new OgAgentDeployError(
      "Deployer wallet needs at least 0.01 0G for V3 vault deployment gas.",
      "insufficient_balance",
      402,
    );
  }

  const deployTxHash = await runtime.walletClient.deployContract({
    abi,
    bytecode,
    args: deployArgs,
    account: runtime.deployer,
    chain: runtime.chain,
  });
  const receipt = await waitForReceipt(runtime.publicClient, deployTxHash, "deploy:PolicyVaultV3");
  const vaultAddress = receipt.contractAddress;
  if (!vaultAddress) {
    throw new OgAgentDeployError("PolicyVaultV3 deploy receipt missing contractAddress.", "tx_reverted", 500);
  }
  const vault = getAddress(vaultAddress);

  // Read back + verify immutable config + policy + allowlists before recording.
  await verifyDeployedVault(runtime.publicClient, vault, owner, config);

  const entry: MainnetV3VaultRegistryEntry = {
    owner,
    vault,
    version: 3,
    chainId: CHAIN_ID,
    blockNumber: receipt.blockNumber.toString(),
    tx: deployTxHash,
    lpAdapter: config.lpAdapter,
    createdAt: new Date().toISOString(),
  };
  await appendV3RegistryEntry(entry);

  return { vault, txHash: deployTxHash, blockNumber: receipt.blockNumber, skipped: false };
}

// --- Withdraw (explicit OLD vault, NOT the resolver) ---

async function withdrawOldVault(
  runtime: DeployerRuntime,
  owner: Address,
  oldVault: Address,
  state: VaultMigrateState,
): Promise<{ amount0G: string; txHash: Hex; skipped: boolean }> {
  // Idempotency: if state already records a withdrawal, treat the recorded
  // amount as authoritative (the old vault should now be drained).
  if (state.withdrawTxHash && state.withdrawTxHash !== SENTINEL_TXHASH && state.withdrawnAmount0G) {
    const residual = await runtime.publicClient.getBalance({ address: oldVault });
    if (residual <= parseEther(WITHDRAW_RESIDUAL_TOLERANCE_0G)) {
      return { amount0G: state.withdrawnAmount0G, txHash: state.withdrawTxHash, skipped: true };
    }
    // Residual is meaningful — fall through and try to drain the remainder.
  }
  const vaultOwner = (await runtime.publicClient.readContract({
    address: oldVault,
    abi: policyVaultV3Abi,
    functionName: "owner",
  })) as Address;
  if (getAddress(vaultOwner) !== getAddress(owner)) {
    throw new OgAgentDeployError(
      `Old vault ${oldVault} owner is ${vaultOwner}, not the DEPLOYER ${owner}. Refusing to withdraw from a vault the deployer does not own.`,
      "owner_required",
      403,
    );
  }
  const balanceBefore = await runtime.publicClient.getBalance({ address: oldVault });
  if (balanceBefore <= 0n) {
    // Already drained — record a zero withdrawal so the deposit step can proceed.
    return { amount0G: "0", txHash: SENTINEL_TXHASH, skipped: true };
  }
  const simulation = await runtime.publicClient.simulateContract({
    account: runtime.deployer.address,
    address: oldVault,
    abi: policyVaultV3Abi,
    functionName: "withdrawNative",
    args: [balanceBefore],
  });
  const txHash = await runtime.walletClient.writeContract({
    ...simulation.request,
    account: runtime.deployer,
    chain: runtime.chain,
  });
  await waitForReceipt(runtime.publicClient, txHash, "withdrawNative");
  const balanceAfter = await runtime.publicClient.getBalance({ address: oldVault });
  if (balanceAfter > parseEther(WITHDRAW_RESIDUAL_TOLERANCE_0G)) {
    throw new OgAgentDeployError(
      `Old vault ${oldVault} still has ${formatEther(balanceAfter)} 0G after withdraw (expected ~0). tx ${txHash}`,
      "tx_reverted",
      500,
    );
  }
  return { amount0G: formatEther(balanceBefore), txHash, skipped: false };
}

// --- Deposit (idempotent) ---

async function depositNewVault(
  runtime: DeployerRuntime,
  newVault: Address,
  withdrawnAmount0G: string,
  state: VaultMigrateState,
): Promise<{ txHash: Hex; amount0G: string; skipped: boolean }> {
  const withdrawnWei = parseEther(withdrawnAmount0G.trim());
  const reserveWei = parseEther(GAS_RESERVE_0G);
  const depositWei = withdrawnWei > reserveWei ? withdrawnWei - reserveWei : 0n;
  if (depositWei <= 0n) {
    return { txHash: SENTINEL_TXHASH, amount0G: "0", skipped: true };
  }
  const depositAmount0G = formatEther(depositWei);
  // Idempotency: if the new vault already holds >= the deposit amount, skip.
  const currentBalance = await runtime.publicClient.getBalance({ address: newVault });
  if (currentBalance >= depositWei) {
    return { txHash: state.depositTxHash ?? SENTINEL_TXHASH, amount0G: depositAmount0G, skipped: true };
  }
  const deployerBalance = await runtime.publicClient.getBalance({ address: runtime.deployer.address });
  if (deployerBalance < depositWei + parseEther("0.001")) {
    throw new OgAgentDeployError(
      `Deployer balance ${formatEther(deployerBalance)} 0G < deposit ${depositAmount0G} + gas. Fund the DEPLOYER first.`,
      "insufficient_balance",
      402,
    );
  }
  const balanceBefore = currentBalance;
  const simulation = await runtime.publicClient.simulateContract({
    account: runtime.deployer.address,
    address: newVault,
    abi: policyVaultV3Abi,
    functionName: "depositNative",
    args: [],
    value: depositWei,
  });
  const txHash = await runtime.walletClient.writeContract({
    ...simulation.request,
    account: runtime.deployer,
    chain: runtime.chain,
    value: depositWei,
  });
  await waitForReceipt(runtime.publicClient, txHash, "depositNative");
  const balanceAfter = await runtime.publicClient.getBalance({ address: newVault });
  if (balanceAfter - balanceBefore < depositWei) {
    throw new OgAgentDeployError(
      `deposit: vault balance delta < deposit ${depositAmount0G}. tx ${txHash}`,
      "tx_reverted",
      500,
    );
  }
  return { txHash, amount0G: depositAmount0G, skipped: false };
}

// --- Env flip + persist ---

function flipEnvToNewVault(newVault: Address): void {
  // In-memory flip — immediate for the running app process (UI + new deploys).
  // The autonomous worker is a separate child process with env loaded at
  // startup; it picks up the new vault only after a dev restart (the .env.local
  // write below persists the flip across that restart).
  process.env.POLICY_VAULT_V3_MAINNET_ADDRESS = newVault;
  process.env.NEXT_PUBLIC_POLICY_VAULT_V3_MAINNET_ADDRESS = newVault;
}

/// Update .env.local in place: replace the two V3 vault address lines if
/// present, append them if absent. Backs up to .env.local.bak first. The vault
/// address is public (not a secret), so this does not violate AGENTS.md env-
/// secret rules. Never rewrites lines other than the two targeted keys.
async function persistEnvLocalFlip(newVault: Address): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(ENV_LOCAL_PATH, "utf8");
  } catch {
    // No .env.local — nothing to persist (the in-memory flip still applies for
    // the running process). Not an error.
    return false;
  }
  // Backup first.
  await writeFile(ENV_LOCAL_BAK_PATH, raw, "utf8");
  const lines = raw.split(/\r?\n/u);
  let publicSeen = false;
  let serverSeen = false;
  const next = lines.map((line) => {
    const publicMatch = /^(\s*NEXT_PUBLIC_POLICY_VAULT_V3_MAINNET_ADDRESS\s*=\s*).*$/u.exec(line);
    if (publicMatch) {
      publicSeen = true;
      return `${publicMatch[1]}${newVault}`;
    }
    const serverMatch = /^(\s*POLICY_VAULT_V3_MAINNET_ADDRESS\s*=\s*).*$/u.exec(line);
    if (serverMatch) {
      serverSeen = true;
      return `${serverMatch[1]}${newVault}`;
    }
    return line;
  });
  if (!publicSeen) next.push(`NEXT_PUBLIC_POLICY_VAULT_V3_MAINNET_ADDRESS=${newVault}`);
  if (!serverSeen) next.push(`POLICY_VAULT_V3_MAINNET_ADDRESS=${newVault}`);
  await writeFile(ENV_LOCAL_PATH, `${next.join("\n").replace(/\n+$/u, "")}\n`, "utf8");
  return true;
}

// --- Orchestrator ---

/// Run the full migrate-to-new-vault flow. Step-gated + idempotent: each step
/// records its result in the state file, and a re-POST after a partial failure
/// resumes from the last completed step (no double-deploy / double-withdraw).
///
/// ORDER (avoids the resolver targeting the wrong vault — codex finding #2 in
/// lp-vault-fund-migrate.ts): withdraw the OLD vault against its explicit
/// address BEFORE flipping env; deploy + deposit + migrate AFTER flipping env
/// (so migrateOwnerVaultToV3's internal resolver targets the new vault).
export async function runVaultMigrateFullFlow(input: {
  owner: Address;
  oldVault: Address;
  agentIds: string[];
}): Promise<VaultMigrateResult> {
  assertMainnetEnvGates();
  const { owner, oldVault, agentIds } = input;
  if (!isAddress(owner)) {
    throw new OgAgentDeployError("owner is not a valid address.", "invalid_owner", 400);
  }
  if (!isAddress(oldVault)) {
    throw new OgAgentDeployError("oldVault is not a valid address.", "invalid_request", 400);
  }

  const runtime = makeDeployerRuntime();
  const actualChainId = await runtime.publicClient.getChainId();
  if (actualChainId !== CHAIN_ID) {
    throw new OgAgentDeployError(`RPC chain mismatch: expected ${CHAIN_ID}, got ${actualChainId}.`, "chain_mismatch", 500);
  }

  // Load or init the resumable state. A stale state file pointing at a
  // different oldVault is reset (the operator started a new migration).
  let state = await readMigrateState();
  if (!state || state.oldVault.toLowerCase() !== oldVault.toLowerCase()) {
    state = { oldVault, updatedAt: new Date().toISOString() };
    await writeMigrateState(state);
  }

  // Step 1: withdraw OLD vault (explicit address, BEFORE env flip).
  const withdraw = await withdrawOldVault(runtime, owner, oldVault, state);
  state.withdrawnAmount0G = withdraw.amount0G;
  state.withdrawTxHash = withdraw.txHash;
  state.updatedAt = new Date().toISOString();
  await writeMigrateState(state);

  // Step 2: deploy NEW vault (idempotent — skips if state.newVault verified).
  const deploy = await deployMainnetV3Vault(runtime, owner, state);
  state.newVault = deploy.vault;
  state.deployTxHash = deploy.txHash;
  state.updatedAt = new Date().toISOString();
  await writeMigrateState(state);

  // Step 3: flip env to the new vault (in-memory) BEFORE deposit/migrate so the
  // resolver targets the new vault.
  flipEnvToNewVault(deploy.vault);

  // Step 4: deposit the withdrawn amount (minus reserve) into the new vault.
  const deposit = await depositNewVault(runtime, deploy.vault, withdraw.amount0G, state);
  state.depositTxHash = deposit.txHash;
  state.depositAmount0G = deposit.amount0G;
  state.updatedAt = new Date().toISOString();
  await writeMigrateState(state);

  // Step 5: migrate agents (re-point records + setAgentKeyEnabled). Skipped if
  // every target agent is already re-pointed + enabled on the new vault.
  const migratedAgents = await migrateAgents(owner, deploy.vault, agentIds, runtime.publicClient, state);
  state.migratedAgents = migratedAgents;
  state.updatedAt = new Date().toISOString();
  await writeMigrateState(state);

  // Step 6: persist the env flip to .env.local (survives dev restart).
  const envLocalUpdated = await persistEnvLocalFlip(deploy.vault);

  return {
    oldVault,
    newVault: deploy.vault,
    deployTxHash: deploy.txHash,
    withdrawTxHash: withdraw.txHash,
    depositTxHash: deposit.txHash,
    withdrawnAmount0G: withdraw.amount0G,
    depositAmount0G: deposit.amount0G,
    migratedAgents,
    restartRequired: true,
    envLocalUpdated,
  };
}

async function migrateAgents(
  owner: Address,
  newVault: Address,
  agentIds: string[],
  publicClient: PublicClient,
  state: VaultMigrateState,
): Promise<string[]> {
  // Idempotency: if state already records migrated agents and every one is
  // verified on-chain, skip the helper call.
  if (state.migratedAgents && state.migratedAgents.length > 0) {
    const allVerified = await verifyAgentsOnVault(owner, newVault, state.migratedAgents, publicClient);
    if (allVerified) return state.migratedAgents;
  }
  if (agentIds.length === 0) {
    // No active agents to migrate — nothing to do. Funds move regardless.
    return [];
  }
  // migrateOwnerVaultToV3 resolves the new vault via the resolver (now flipped
  // in-memory to newVault) + calls assertMainnetDeployEnv internally + enables
  // each agent key + re-points the records.
  let helperError: Error | null = null;
  try {
    await migrateOwnerVaultToV3(owner, agentIds);
  } catch (error) {
    helperError = error instanceof Error ? error : new Error(String(error));
  }
  // Authoritative per-agent verification (works whether the helper succeeded or
  // timed out on a setAgentKeyEnabled receipt). For EACH target agent: registry
  // deployment.vault == newVault AND agentKeyEnabled on-chain.
  const verified = await verifyAgentsOnVault(owner, newVault, agentIds, publicClient);
  if (verified.length < agentIds.length) {
    const failed = agentIds.filter((id) => !verified.includes(id));
    if (helperError) {
      throw new OgAgentDeployError(
        `Migration incomplete: ${failed.join(", ")} not verified on ${newVault}. Helper error: ${helperError.message}`,
        "migration_partial",
        500,
      );
    }
    throw new OgAgentDeployError(
      `Migration incomplete: ${failed.join(", ")} not verified on ${newVault}. Re-POST to resume.`,
      "migration_partial",
      500,
    );
  }
  return verified;
}

// Re-export for the route's idempotency pre-check + for tests.
async function verifyAgentsOnVault(
  owner: Address,
  newVault: Address,
  agentIds: string[],
  publicClient: PublicClient,
): Promise<string[]> {
  const verified: string[] = [];
  for (const agentId of agentIds) {
    const workspace = await loadOgAgentWorkspace({ agentId, live: true, ownerAddress: owner }).catch(() => null);
    const deployment = workspace?.agent.deployment;
    if (!deployment) continue;
    if (getAddress(deployment.vault) !== getAddress(newVault)) continue;
    const agentKey = deployment.agentKey ?? agentKeyForDeployment(deployment);
    if (!agentKey) continue;
    const enabled = (await publicClient.readContract({
      address: newVault,
      abi: policyVaultV3Abi,
      functionName: "agentKeyEnabled",
      args: [agentKey],
    }).catch(() => false)) as boolean;
    if (enabled) verified.push(agentId);
  }
  return verified;
}

// --- shared helpers ---

type ReceiptLike = { status: "success" | "reverted"; contractAddress: Address | null | undefined; blockNumber: bigint };

async function waitForReceipt(publicClient: PublicClient, hash: Hex, label: string): Promise<ReceiptLike> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const receipt = await publicClient.getTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        throw new OgAgentDeployError(`${label} transaction reverted: ${hash}`, "tx_reverted", 500);
      }
      return {
        status: "success",
        contractAddress: receipt.contractAddress,
        blockNumber: receipt.blockNumber,
      };
    } catch (error) {
      if (error instanceof OgAgentDeployError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (!message.toLowerCase().includes("not found") && !message.toLowerCase().includes("could not")) {
        throw error;
      }
      await sleep(1_000);
    }
  }
  throw new OgAgentDeployError(`Timed out waiting for ${label} receipt: ${hash}`, "tx_timeout", 500);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Re-exports for the route + tests.
export { CAP_PRESET, readVaultDeployConfig, assertMainnetEnvGates };
export type { DeployerRuntime };