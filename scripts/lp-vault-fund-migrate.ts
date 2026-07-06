// Mainnet V3 vault swap — move the old vault's 0G to a NEW V3 vault with an
// (effectively) unlimited LP daily cap, and re-point the owner's agents at it.
//
// WHY: the existing per-owner V3 singleton `0x2F89D8…1553` has `lpDailyCap0G=10`
// which is tighten-only (PolicyVaultV3.sol:679) and already ~80% spent today, so
// the armed LP agent `agent-0g-mainnet-16` errors every mint cycle with
// LpDailyCapExceeded (0x19b4c74f). A new vault is deployed separately
// (scripts/create-mainnet-vault-v3.ts) with `lpDailyCap0G=1,000,000`; THIS script
// moves the funds + migrates the agents. No contract change, no app-code change.
//
// Real money. DEPLOYER pays gas. Step-gated so each phase verifies before the next.
// Every pass/fail is driven by ON-CHAIN reads (balances, agentKeyEnabled, registry
// vault), never by trusting a helper return value or a console log.
//
// ORDER (avoids the resolver targeting the wrong vault — codex finding #2):
//   1. `--phase withdraw --old-vault 0xOLD` runs BEFORE the new-vault deploy. The
//      withdraw is INLINED against the explicit `--old-vault` address (the resolver
//      is NOT used), so it always drains the OLD vault regardless of env/registry
//      state. Verify owner() == DEPLOYER first; refuse otherwise.
//   2. Deploy the new vault separately (scripts/create-mainnet-vault-v3.ts with
//      LP_DAILY_CAP=1000000 + REDEPLOY_FORCE + CREATE=true).
//   3. `--phase post-deploy --new-vault 0xNEW --agent-ids 15,16` runs AFTER.
//      `--new-vault` pins the resolver at the new vault IN-MEMORY (env override is
//      authoritative over the registry, mainnet-vault-resolver.ts:91-100) so
//      verify/deposit/migrate target the new vault. The running worker/dev-server
//      are unaffected until .env.local is updated + they are restarted (phase 6).
//
// IDEMPOTENCY (codex findings #1 + #6): the deposit re-reads the new vault balance
// first and SKIPS if the vault already holds >= the deposit amount (a prior
// post-deploy run may have deposited then failed at migrate). Receipt polling
// returns a status; on TIMEOUT the phase re-reads the authoritative on-chain
// postcondition (old-vault balance / new-vault balance delta / agentKeyEnabled)
// and treats a met postcondition as success — so a mined-but-receipt-unavailable
// tx never causes a double-action on rerun.
//
// Reuses existing helpers — NO funds-touching logic of its own:
//   - withdrawNative() inlined (mirrors withdrawMainnetVaultNative, but explicit vault) — phase withdraw
//   - depositNative() inlined (mirrors runDepositNative, lp-deploy.ts:236) — phase deposit
//   - migrateOwnerVaultToV3(owner, targetAgentIds) (lib/agent/single-agent-server.ts:2236) — phase migrate
//
// Usage:
//   # 1. Pre-deploy: drain the OLD vault to the DEPLOYER (explicit address, no resolver).
//   node --conditions=react-server --import tsx scripts/lp-vault-fund-migrate.ts \
//     --phase withdraw --old-vault 0x2F89D8d03EAb4a5Bd1056A9Cb8706bc7609e1553
//
//   # 2. (separately) deploy the new unlimited vault — see plan / create-mainnet-vault-v3.ts.
//
//   # 3. Post-deploy: verify + deposit + migrate, pinned at the new vault.
//   #    --agent-ids is REQUIRED (bounds the authorization blast radius: only those
//   #    agents are key-enabled on the new vault; agents not listed stay on the old vault).
//   node --conditions=react-server --import tsx scripts/lp-vault-fund-migrate.ts \
//     --phase post-deploy --new-vault 0xNEW --agent-ids 15,16
//
// Env (mainnet gates, mirrored from assertMainnetDeployEnv in single-agent-server.ts:2624;
// enforced for ALL write phases — withdraw/deposit/migrate — not just migrate — so a
// missing flag can't let funds move then have migrate fail):
//   OG_NETWORK=mainnet OG_CHAIN_ID=16661 ENABLE_MAINNET_DEPLOY=true
//   ENABLE_REAL_DEX_ADAPTER=true ENABLE_MOCK_DEX_ADAPTER=false
//   DEPLOYER_PRIVATE_KEY=0x…  OG_RPC_URL=https://evmrpc.0g.ai  (or OG_MAINNET_RPC_URL)

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
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  agentKeyForDeployment,
  loadOgAgentWorkspace,
  migrateOwnerVaultToV3,
  type VaultMigrationResult,
} from "../lib/agent/single-agent-server";
import { resolveMainnetV3VaultForOwner } from "../lib/agent/mainnet-vault-resolver";
import { policyVaultV3Abi } from "../lib/contracts/policy-vault-v3";
import { buildV3LpAllowlists } from "../lib/contracts/zia-lp";

dotenv.config({ path: ".env.local", quiet: true });

// Prefer the dedicated mainnet RPC (quiknode) over the public evmrpc.0g.ai when
// available, matching scripts/lp-cleanup-agent.ts. The URL stays in .env.local.
const preferredMainnetRpc = process.env.OG_MAINNET_RPC_URL?.trim();
if (preferredMainnetRpc && !process.env.OG_RPC_URL?.trim()) {
  process.env.OG_RPC_URL = preferredMainnetRpc;
}

const CHAIN_ID = 16661;
const STATE_FILE_PATH = join(process.cwd(), ".data", "deployments", "lp-vault-swap-state.json");
// Left in the DEPLOYER wallet after deposit to cover deposit + migrate + a few
// proof-accept txs. The withdrawn 0G minus this reserve goes into the new vault.
const GAS_RESERVE_0G = "0.05";
// Post-withdraw residual the old vault may keep (dust / refund race) and still
// count as "drained". Meaningful leftovers (>0.0001) are treated as a failure.
const WITHDRAW_RESIDUAL_TOLERANCE_0G = "0.0001";

// Shared mainnet infra the new vault reuses (verified in the `verify` phase).
const EXPECTED_EXECUTOR = "0xF56bD1DB9F423ED36224AC70751d1315C2B8F737" as Address;
const EXPECTED_LP_ADAPTER = "0x049a989d30337da6DdE237a6A08F4dd2db62a340" as Address;
const EXPECTED_PROOF_REGISTRY = "0xfe87d95B76E297Bb28b0eC4dD72b15cfC2b14E7a" as Address;
const EXPECTED_LP_DAILY_CAP_0G = parseEther("1000000");
const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex;
const SENTINEL_TXHASH = "0x" as Hex; // marks "skipped / no tx this run" in state + logs

type Phase = "withdraw" | "verify" | "deposit" | "migrate" | "post-deploy";

interface Args {
  phase: Phase;
  oldVault?: Address;
  newVault?: Address;
  depositAmount0G?: string;
  forceFullDeposit: boolean;
  forceDeposit: boolean;
  agentIds?: string[];
  strictAgentIds: boolean;
}

interface SwapState {
  oldVault: Address;
  withdrawnAmount0G: string;
  withdrawTxHash: Hex;
  withdrawnAt: string;
  depositTxHash?: Hex;
  depositVault?: Address;
  depositAmount0G?: string;
  depositedAt?: string;
}

interface DeployerRuntime {
  chain: Chain;
  publicClient: PublicClient;
  walletClient: WalletClient;
  deployer: ReturnType<typeof privateKeyToAccount>;
}

type ReceiptStatus = "success" | "reverted" | "timeout";

const USAGE =
  "Usage:\n" +
  "  node --conditions=react-server --import tsx scripts/lp-vault-fund-migrate.ts \\\n" +
  "    --phase withdraw --old-vault 0xOLD\n" +
  "  node --conditions=react-server --import tsx scripts/lp-vault-fund-migrate.ts \\\n" +
  "    --phase post-deploy --new-vault 0xNEW --agent-ids 15,16\n" +
  "Flags:\n" +
  "  --phase withdraw|verify|deposit|migrate|post-deploy\n" +
  "  --old-vault 0xOLD      (required for withdraw — explicit OLD vault, resolver NOT used)\n" +
  "  --new-vault 0xNEW      (pin resolver at the new vault for verify/deposit/migrate)\n" +
  "  --agent-ids 15,16      (required for migrate/post-deploy — explicit agent set)\n" +
  "  --deposit-amount 5.93  (optional; capped at withdrawn − 0.05 reserve unless --force-full-deposit)\n" +
  "  --force-full-deposit   (allow depositing the full withdrawn amount, no gas reserve)\n" +
  "  --force-deposit        (re-deposit even if the new vault is already funded)\n" +
  "  --strict-agent-ids     (fail if any --agent-ids entry was not migrated; default: warn)";

function parseArgs(argv: string[]): Args {
  const args: Args = { phase: "post-deploy", forceFullDeposit: false, forceDeposit: false, strictAgentIds: false };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--phase") args.phase = readNext(argv, ++i, value) as Phase;
    else if (value === "--old-vault") args.oldVault = readNext(argv, ++i, value) as Address;
    else if (value === "--new-vault") args.newVault = readNext(argv, ++i, value) as Address;
    else if (value === "--deposit-amount") args.depositAmount0G = readNext(argv, ++i, value);
    else if (value === "--agent-ids") {
      args.agentIds = readNext(argv, ++i, value)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (value === "--force-full-deposit") args.forceFullDeposit = true;
    else if (value === "--force-deposit") args.forceDeposit = true;
    else if (value === "--strict-agent-ids") args.strictAgentIds = true;
    else if (value === "--help" || value === "-h") {
      console.log(USAGE);
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

// Mirrors assertMainnetDeployEnv (single-agent-server.ts:2624). Run for ALL write
// phases so a misconfigured flag can't let withdraw/deposit succeed then have
// migrate fail (which would move funds without re-pointing records).
function assertMainnetEnvGates(): void {
  if ((process.env.OG_NETWORK ?? "").toLowerCase() !== "mainnet") {
    throw new Error("This script requires OG_NETWORK=mainnet.");
  }
  if (Number(process.env.OG_CHAIN_ID ?? "0") !== CHAIN_ID) {
    throw new Error(`This script requires OG_CHAIN_ID=${CHAIN_ID}.`);
  }
  requireFlag("ENABLE_MAINNET_DEPLOY", true);
  requireFlag("ENABLE_REAL_DEX_ADAPTER", true);
  requireFlag("ENABLE_MOCK_DEX_ADAPTER", false);
}

function requireFlag(name: string, expected: boolean): void {
  const actual = (process.env[name] ?? "false").toLowerCase() === "true";
  if (actual !== expected) {
    throw new Error(`${name} must be ${String(expected)}.`);
  }
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

// Poll the receipt for up to ~5 min. Returns "timeout" instead of throwing when
// the receipt never lands — the public 0G RPC can be slow to return receipts
// even after the tx is mined (lp-quiknode-getlogs-fallback memory). The caller
// then re-reads the authoritative on-chain postcondition and treats a met
// postcondition as success, so a mined-but-receipt-unavailable tx never causes
// a double-action on rerun.
async function waitForReceiptOutcome(publicClient: PublicClient, hash: Hex): Promise<ReceiptStatus> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const receipt = await publicClient.getTransactionReceipt({ hash });
      return receipt.status === "success" ? "success" : "reverted";
    } catch {
      // receipt not available yet — retry
    }
    await sleep(2_000);
  }
  return "timeout";
}

// `policy()` returns the Policy struct. viem returns tuples as arrays
// (verified for this contract in prior sessions). Policy.lp is index 6; within
// LpPolicy, lpDailyCap0G is index 1 (PolicyVaultV3.sol:35-53). Handle the object
// shape too in case the ABI names resolve to an object.
function extractLpDailyCap0G(policy: unknown): bigint {
  const arr = policy as readonly unknown[];
  const lp = arr?.[6];
  if (Array.isArray(lp)) return BigInt(lp[1] as bigint);
  if (lp && typeof lp === "object" && "lpDailyCap0G" in lp) {
    return BigInt((lp as { lpDailyCap0G: bigint }).lpDailyCap0G);
  }
  throw new Error(`Could not extract lpDailyCap0G from policy: ${JSON.stringify(policy)}`);
}

async function writeState(state: SwapState): Promise<void> {
  await mkdir(dirname(STATE_FILE_PATH), { recursive: true });
  await writeFile(STATE_FILE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function readState(): Promise<SwapState | null> {
  try {
    const raw = await readFile(STATE_FILE_PATH, "utf8");
    return JSON.parse(raw) as SwapState;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("ENOENT") || message.includes("no such file")) return null;
    throw error;
  }
}

async function resolveDepositAmount(explicit: string | undefined, forceFull: boolean): Promise<string> {
  const state = await readState();
  if (!state) {
    if (explicit) return explicit.trim();
    throw new Error("No --deposit-amount and no swap state. Run --phase withdraw first, or pass --deposit-amount.");
  }
  const withdrawn = parseEther(state.withdrawnAmount0G);
  const reserve = parseEther(GAS_RESERVE_0G);
  const maxDeposit = withdrawn - reserve;
  if (explicit) {
    const explicitWei = parseEther(explicit.trim());
    if (explicitWei > maxDeposit && !forceFull) {
      throw new Error(
        `--deposit-amount ${explicit} exceeds (withdrawn ${state.withdrawnAmount0G} − reserve ${GAS_RESERVE_0G}) = ${formatEther(maxDeposit)}. Pass --force-full-deposit to deposit the full withdrawn amount (leaves no gas reserve).`,
      );
    }
    return explicit.trim();
  }
  if (maxDeposit <= 0n) {
    throw new Error(`Withdrawn ${state.withdrawnAmount0G} 0G <= gas reserve ${GAS_RESERVE_0G}; nothing to deposit.`);
  }
  return formatEther(maxDeposit);
}

async function markDeposited(txHash: Hex, vault: Address, amount0G: string): Promise<void> {
  const state = await readState();
  if (!state) return; // no withdraw state — nothing to annotate
  state.depositTxHash = txHash;
  state.depositVault = vault;
  state.depositAmount0G = amount0G;
  state.depositedAt = new Date().toISOString();
  await writeState(state);
}

// --- Phase: withdraw (pre-deploy, explicit --old-vault, NO resolver) ---

async function phaseWithdraw(
  owner: Address,
  publicClient: PublicClient,
  walletClient: WalletClient,
  deployer: ReturnType<typeof privateKeyToAccount>,
  chain: Chain,
  oldVault: Address,
): Promise<SwapState> {
  // Explicit OLD vault — do NOT use the resolver. Verify on-chain owner first;
  // refuse to withdraw from a vault the DEPLOYER does not own.
  const vaultOwner = (await publicClient.readContract({
    address: oldVault,
    abi: policyVaultV3Abi,
    functionName: "owner",
  })) as Address;
  if (getAddress(vaultOwner) !== getAddress(owner)) {
    throw new Error(
      `--old-vault ${oldVault} owner is ${vaultOwner}, not the DEPLOYER ${owner}. Refusing to withdraw from a vault the deployer does not own.`,
    );
  }
  const balanceBefore = await publicClient.getBalance({ address: oldVault });
  console.log(JSON.stringify({ stage: "withdraw", oldVault, balanceBefore0G: formatEther(balanceBefore) }));
  if (balanceBefore <= 0n) {
    throw new Error(`Old vault ${oldVault} balance is 0; nothing to withdraw. Was the funds move already done?`);
  }
  // withdrawNative(amount) is onlyOwner + sends native to msg.sender (owner).
  // Withdraw the EXACT current balance so nothing is stranded.
  const simulation = await publicClient.simulateContract({
    account: deployer.address,
    address: oldVault,
    abi: policyVaultV3Abi,
    functionName: "withdrawNative",
    args: [balanceBefore],
  });
  const txHash = await walletClient.writeContract({ ...simulation.request, account: deployer, chain });
  const status = await waitForReceiptOutcome(publicClient, txHash);
  if (status === "reverted") {
    throw new Error(`withdrawNative reverted: ${txHash}`);
  }
  // Authoritative effect check — also covers receipt-timeout: if the tx mined
  // but the receipt never landed, the balance read confirms it.
  const balanceAfter = await publicClient.getBalance({ address: oldVault });
  if (balanceAfter > parseEther(WITHDRAW_RESIDUAL_TOLERANCE_0G)) {
    if (status === "timeout") {
      throw new Error(
        `withdraw tx ${txHash} receipt timed out AND old vault still has ${formatEther(balanceAfter)} 0G — status unknown. Re-run --phase withdraw (idempotent: it will report "nothing to withdraw" once the tx settles).`,
      );
    }
    throw new Error(`Old vault ${oldVault} still has ${formatEther(balanceAfter)} 0G after withdraw (expected ~0). tx ${txHash}`);
  }
  const state: SwapState = {
    oldVault,
    withdrawnAmount0G: formatEther(balanceBefore),
    withdrawTxHash: txHash,
    withdrawnAt: new Date().toISOString(),
  };
  await writeState(state);
  console.log(
    JSON.stringify({
      stage: "withdraw-ok",
      oldVault,
      withdrawnAmount0G: state.withdrawnAmount0G,
      withdrawTxHash: txHash,
      balanceAfter0G: formatEther(balanceAfter),
      receiptStatus: status,
    }),
  );
  return state;
}

// --- Phase: verify (post-deploy, read-only) ---

async function phaseVerify(publicClient: PublicClient, newVault: Address, owner: Address): Promise<void> {
  const [vOwner, vExecutor, vLpAdapter, vProofRegistry, vPaused, vRevoked, vPolicyHash, vPolicy, vDailySpent] = await Promise.all([
    publicClient.readContract({ address: newVault, abi: policyVaultV3Abi, functionName: "owner" }) as Promise<Address>,
    publicClient.readContract({ address: newVault, abi: policyVaultV3Abi, functionName: "executor" }) as Promise<Address>,
    publicClient.readContract({ address: newVault, abi: policyVaultV3Abi, functionName: "lpAdapter" }) as Promise<Address>,
    publicClient.readContract({ address: newVault, abi: policyVaultV3Abi, functionName: "proofRegistry" }) as Promise<Address>,
    publicClient.readContract({ address: newVault, abi: policyVaultV3Abi, functionName: "paused" }) as Promise<boolean>,
    publicClient.readContract({ address: newVault, abi: policyVaultV3Abi, functionName: "executorRevoked" }) as Promise<boolean>,
    publicClient.readContract({ address: newVault, abi: policyVaultV3Abi, functionName: "policyHash" }) as Promise<Hex>,
    publicClient.readContract({ address: newVault, abi: policyVaultV3Abi, functionName: "policy" }),
    publicClient.readContract({ address: newVault, abi: policyVaultV3Abi, functionName: "lpDailySpent0G" }) as Promise<bigint>,
  ]);
  const lpDailyCap0G = extractLpDailyCap0G(vPolicy);
  console.log(
    JSON.stringify(
      {
        stage: "verify",
        newVault,
        owner: vOwner,
        executor: vExecutor,
        lpAdapter: vLpAdapter,
        proofRegistry: vProofRegistry,
        paused: vPaused,
        executorRevoked: vRevoked,
        policyHash: vPolicyHash,
        lpDailyCap0G: formatEther(lpDailyCap0G),
        lpDailySpent0G: formatEther(vDailySpent),
      },
      null,
      2,
    ),
  );
  if (getAddress(vOwner) !== getAddress(owner)) {
    throw new Error(`verify: owner mismatch — got ${vOwner}, expected ${owner}`);
  }
  if (getAddress(vExecutor) !== getAddress(EXPECTED_EXECUTOR)) {
    throw new Error(`verify: executor mismatch — got ${vExecutor}, expected ${EXPECTED_EXECUTOR}`);
  }
  if (getAddress(vLpAdapter) !== getAddress(EXPECTED_LP_ADAPTER)) {
    throw new Error(`verify: lpAdapter mismatch — got ${vLpAdapter}, expected ${EXPECTED_LP_ADAPTER}`);
  }
  if (getAddress(vProofRegistry) !== getAddress(EXPECTED_PROOF_REGISTRY)) {
    throw new Error(`verify: proofRegistry mismatch — got ${vProofRegistry}, expected ${EXPECTED_PROOF_REGISTRY}`);
  }
  if (vPaused) throw new Error("verify: vault is paused");
  if (vRevoked) throw new Error("verify: executor is revoked");
  if (vPolicyHash === ZERO_BYTES32) throw new Error("verify: policyHash is zero (policy not set)");
  if (lpDailyCap0G !== EXPECTED_LP_DAILY_CAP_0G) {
    throw new Error(`verify: lpDailyCap0G mismatch — got ${formatEther(lpDailyCap0G)}, expected 1000000`);
  }
  // Allowlist check: every zappable W0G-leg pool must be allowlisted + bound to its
  // Zia stake vault (allowlists are constructor-only + one-way-disable, so a miss
  // here means the deploy seeded them wrong and the agent can never mint).
  const { allowedLpPools, stakeVaultForLpPool } = buildV3LpAllowlists();
  for (let i = 0; i < allowedLpPools.length; i += 1) {
    const poolId = allowedLpPools[i];
    const expectedStakeVault = stakeVaultForLpPool[i];
    const [allowed, bound] = await Promise.all([
      publicClient.readContract({ address: newVault, abi: policyVaultV3Abi, functionName: "allowedLpPools", args: [poolId] }) as Promise<boolean>,
      publicClient.readContract({ address: newVault, abi: policyVaultV3Abi, functionName: "stakeVaultForLpPool", args: [poolId] }) as Promise<Address>,
    ]);
    if (!allowed) throw new Error(`verify: LP pool ${poolId} not allowlisted on ${newVault}`);
    if (getAddress(bound) !== getAddress(expectedStakeVault)) {
      throw new Error(`verify: pool ${poolId} stake vault mismatch — got ${bound}, expected ${expectedStakeVault}`);
    }
  }
  console.log(JSON.stringify({ stage: "verify-ok", allowedLpPoolCount: allowedLpPools.length }));
}

// --- Phase: deposit (post-deploy, idempotent) ---

async function phaseDeposit(
  runtime: DeployerRuntime,
  vault: Address,
  amount0G: string,
  forceDeposit: boolean,
): Promise<{ txHash: Hex; amount0G: string }> {
  const value = parseEther(amount0G.trim());
  if (value <= 0n) throw new Error("deposit amount must be > 0");
  const currentBalance = await runtime.publicClient.getBalance({ address: vault });
  // Idempotency: if the vault already holds >= the deposit amount, the deposit
  // already happened (a prior post-deploy run may have deposited then failed at
  // migrate). Skip unless --force-deposit. Prevents double-deposit on rerun.
  if (currentBalance >= value && !forceDeposit) {
    console.log(
      JSON.stringify({
        stage: "deposit-skip",
        vault,
        currentBalance0G: formatEther(currentBalance),
        depositAmount0G: amount0G,
        note: "vault already funded >= deposit amount; pass --force-deposit to re-deposit",
      }),
    );
    return { txHash: SENTINEL_TXHASH, amount0G };
  }
  const deployerBalance = await runtime.publicClient.getBalance({ address: runtime.deployer.address });
  if (deployerBalance < value + parseEther("0.001")) {
    throw new Error(
      `Deployer balance ${formatEther(deployerBalance)} 0G < deposit ${amount0G} + 0.001 gas buffer. Fund the DEPLOYER first.`,
    );
  }
  const balanceBefore = currentBalance;
  console.log(JSON.stringify({ stage: "deposit", vault, amount0G, vaultBalanceBefore0G: formatEther(balanceBefore) }));
  const simulation = await runtime.publicClient.simulateContract({
    account: runtime.deployer.address,
    address: vault,
    abi: policyVaultV3Abi,
    functionName: "depositNative",
    args: [],
    value,
  });
  const txHash = await runtime.walletClient.writeContract({
    ...simulation.request,
    account: runtime.deployer,
    chain: runtime.chain,
    value,
  });
  const status = await waitForReceiptOutcome(runtime.publicClient, txHash);
  if (status === "reverted") {
    throw new Error(`depositNative reverted: ${txHash}`);
  }
  // Authoritative effect check: the vault received at least `value`. On receipt
  // timeout, the delta read confirms whether the tx mined.
  const balanceAfter = await runtime.publicClient.getBalance({ address: vault });
  const delta = balanceAfter - balanceBefore;
  if (delta < value) {
    if (status === "timeout") {
      throw new Error(
        `deposit tx ${txHash} receipt timed out AND vault delta ${formatEther(delta)} < ${amount0G}. Re-run --phase post-deploy (idempotent: it will skip the deposit if the vault is now funded).`,
      );
    }
    throw new Error(`deposit: vault balance delta ${formatEther(delta)} < deposit ${amount0G}. tx ${txHash}`);
  }
  console.log(
    JSON.stringify({ stage: "deposit-ok", txHash, amount0G, vaultBalanceAfter0G: formatEther(balanceAfter), receiptStatus: status }),
  );
  return { txHash, amount0G };
}

// --- Phase: migrate (post-deploy, explicit agent set, per-agent verified) ---

async function phaseMigrate(
  owner: Address,
  newVault: Address,
  agentIds: string[],
  publicClient: PublicClient,
  strictAgentIds: boolean,
): Promise<void> {
  console.log(JSON.stringify({ stage: "migrate", owner, newVault, targetAgentIds: agentIds }));
  // migrateOwnerVaultToV3 resolves the new vault internally via the resolver —
  // the in-memory env override (set in main from --new-vault) pins it at the new
  // vault. targetAgentIds bounds the loop to the explicit set (codex finding #3).
  let helperResult: VaultMigrationResult | null = null;
  try {
    helperResult = await migrateOwnerVaultToV3(owner, agentIds);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isTimeout = /timed out|not mined/i.test(message);
    if (!isTimeout) throw error;
    // A setAgentKeyEnabled tx may have mined but its receipt never landed. Fall
    // through to the authoritative per-agent verification below — if every target
    // agent is enabled on-chain + registry-re-pointed, treat as success.
    console.log(
      JSON.stringify({ stage: "migrate-helper-timeout", message, note: "re-verifying via on-chain agentKeyEnabled + registry" }),
    );
  }
  if (helperResult && getAddress(helperResult.v3Vault) !== getAddress(newVault)) {
    throw new Error(`migrate: targeted ${helperResult.v3Vault}, expected ${newVault} (pass --new-vault).`);
  }
  // Authoritative per-agent verification (works whether the helper succeeded or
  // timed out). For EACH target agent: registry deployment.vault == newVault AND
  // agentKeyEnabled on-chain. This is the codex finding #7 fix (verify all, not
  // just one) + the #3 fix (the operator sees exactly which agents were migrated).
  const verified: string[] = [];
  const failed: string[] = [];
  for (const agentId of agentIds) {
    const workspace = await loadOgAgentWorkspace({ agentId, live: true, ownerAddress: owner });
    const deployment = workspace.agent.deployment;
    if (!deployment) {
      console.log(JSON.stringify({ stage: "migrate-agent-no-deployment", agentId, note: "removed or absent — not migrated" }));
      failed.push(agentId);
      continue;
    }
    if (getAddress(deployment.vault) !== getAddress(newVault)) {
      failed.push(`${agentId}(registry vault ${deployment.vault} != ${newVault})`);
      continue;
    }
    const agentKey = deployment.agentKey ?? agentKeyForDeployment(deployment);
    const enabled = (await publicClient.readContract({
      address: newVault,
      abi: policyVaultV3Abi,
      functionName: "agentKeyEnabled",
      args: [agentKey],
    })) as boolean;
    if (!enabled) {
      failed.push(`${agentId}(agentKey not enabled on ${newVault})`);
      continue;
    }
    verified.push(agentId);
    console.log(JSON.stringify({ stage: "migrate-agent-ok", agentId, agentKey, vault: deployment.vault }));
  }
  if (failed.length > 0) {
    const message = `agents not migrated+verified on ${newVault}: ${failed.join(", ")}`;
    if (strictAgentIds) throw new Error(message);
    console.log(JSON.stringify({ stage: "migrate-warn-not-migrated", failed, note: "pass --strict-agent-ids to fail" }));
  }
  const helperMigrated = helperResult ? helperResult.agents.map((a) => a.id) : [];
  console.log(JSON.stringify({ stage: "migrate-ok", verified, failed, helperMigrated }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const deployer = privateKeyToAccount(readPrivateKeyEnv("DEPLOYER_PRIVATE_KEY"));
  const owner = deployer.address as Address;

  // Env gate for ALL write phases (verify is read-only). Mirrors
  // assertMainnetDeployEnv — prevents a misconfigured flag from letting funds
  // move then having migrate fail (codex finding #4).
  if (args.phase !== "verify") assertMainnetEnvGates();

  // Pin the resolver at the new vault for post-deploy phases (in-memory only).
  // This makes resolveMainnetV3VaultForOwner — used by verify/deposit reads AND
  // by migrateOwnerVaultToV3 internally — return the NEW vault. The running
  // worker / dev-server do NOT see this (they loaded env at startup); they
  // switch only after .env.local is updated + they are restarted (phase 6).
  if (args.newVault) {
    process.env.POLICY_VAULT_V3_MAINNET_ADDRESS = args.newVault;
    process.env.NEXT_PUBLIC_POLICY_VAULT_V3_MAINNET_ADDRESS = args.newVault;
  }

  const rpcUrl = process.env.OG_RPC_URL?.trim();
  if (!rpcUrl) throw new Error("OG_RPC_URL is required (set it directly or via OG_MAINNET_RPC_URL).");
  const chain = make0GMainnetChain(rpcUrl);
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl, { retryCount: 0, timeout: 8_000 }) });
  const walletClient = createWalletClient({ account: deployer, chain, transport: http(rpcUrl) });
  const runtime: DeployerRuntime = { chain, publicClient, walletClient, deployer };

  const actualChainId = await publicClient.getChainId();
  if (actualChainId !== CHAIN_ID) {
    throw new Error(`RPC chain mismatch: expected ${CHAIN_ID}, got ${actualChainId}.`);
  }

  if (args.phase === "withdraw") {
    if (!args.oldVault) {
      throw new Error("--phase withdraw requires --old-vault <address> (the explicit OLD vault; the resolver is NOT used).");
    }
    const state = await phaseWithdraw(owner, publicClient, walletClient, deployer, chain, args.oldVault);
    console.log(JSON.stringify({ stage: "withdraw-phase-done", state }));
    return;
  }

  // Post-deploy phases: resolve the new vault (prefer --new-vault, already pinned
  // in env above; fall back to the resolver).
  const newVault = args.newVault ?? (await resolveMainnetV3VaultForOwner(owner)) ?? undefined;
  if (!newVault) {
    throw new Error("No new vault resolved. Pass --new-vault <address> or set POLICY_VAULT_V3_MAINNET_ADDRESS.");
  }
  console.log(JSON.stringify({ stage: "resolved-new-vault", newVault }));

  if (args.phase === "verify") {
    await phaseVerify(publicClient, newVault, owner);
    return;
  }
  if (args.phase === "deposit") {
    const amount0G = await resolveDepositAmount(args.depositAmount0G, args.forceFullDeposit);
    const res = await phaseDeposit(runtime, newVault, amount0G, args.forceDeposit);
    if (res.txHash !== SENTINEL_TXHASH) await markDeposited(res.txHash, newVault, res.amount0G);
    return;
  }
  if (args.phase === "migrate") {
    if (!args.agentIds?.length) {
      throw new Error("--phase migrate requires --agent-ids <csv> (the explicit set of agents to migrate — bounds the authorization blast radius).");
    }
    await phaseMigrate(owner, newVault, args.agentIds, publicClient, args.strictAgentIds);
    return;
  }
  if (args.phase === "post-deploy") {
    if (!args.agentIds?.length) {
      throw new Error("--phase post-deploy requires --agent-ids <csv> (the explicit set of agents to migrate).");
    }
    await phaseVerify(publicClient, newVault, owner);
    const amount0G = await resolveDepositAmount(args.depositAmount0G, args.forceFullDeposit);
    const res = await phaseDeposit(runtime, newVault, amount0G, args.forceDeposit);
    if (res.txHash !== SENTINEL_TXHASH) await markDeposited(res.txHash, newVault, res.amount0G);
    await phaseMigrate(owner, newVault, args.agentIds, publicClient, args.strictAgentIds);
    console.log(
      JSON.stringify({
        stage: "post-deploy-done",
        newVault,
        nextStep: `Update .env.local POLICY_VAULT_V3_MAINNET_ADDRESS=${newVault} + NEXT_PUBLIC_…=${newVault}, restart the worker, then unpause the migrated agents.`,
      }),
    );
    return;
  }
  throw new Error(`Unknown phase: ${args.phase as string}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});