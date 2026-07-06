import dotenv from "dotenv";
import { getAddress, isAddress, type Address } from "viem";

import { buildPoolCandidates, makeMainnetPublicClient } from "../lib/agent/lp/lp-context";
import { agentKeyForDeployment, loadOgAgentWorkspace } from "../lib/agent/single-agent-server";
import { policyVaultV3Abi } from "../lib/contracts/policy-vault-v3";
import { findZiaLpVaultByPool, poolIdFromAddress, zappableZiaLpVaults } from "../lib/contracts/zia-lp";

dotenv.config({ path: ".env.local", quiet: true });

const MAINNET_CHAIN_ID = 16661;

interface Check {
  detail?: string;
  name: string;
  ok: boolean;
}

interface Args {
  agentId?: string;
  expectPosition: boolean;
  expectStaked?: boolean;
  owner?: Address;
  tokenId?: string;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const publicClient = makeMainnetPublicClient();
  const chainId = await publicClient.getChainId();
  const workspace = await loadOgAgentWorkspace({
    agentId: args.agentId,
    live: true,
    ownerAddress: args.owner,
  });
  const checks: Check[] = [];
  check(checks, "0G mainnet RPC", chainId === MAINNET_CHAIN_ID, `chainId=${chainId}`);
  check(checks, "agent resolved", Boolean(workspace.agent.deployment), workspace.agent.id);

  const deployment = workspace.agent.deployment;
  if (!deployment) {
    finish({ checks, positions: [], workspace: summary(workspace) });
    return;
  }

  const agentKey = deployment.agentKey ?? agentKeyForDeployment(deployment);
  const vault = deployment.vault;
  const [vaultLpAdapter, vaultProofRegistry, paused, executorRevoked, agentKeyEnabled] = await Promise.all([
    publicClient.readContract({ address: vault, abi: policyVaultV3Abi, functionName: "lpAdapter" }) as Promise<Address>,
    publicClient.readContract({ address: vault, abi: policyVaultV3Abi, functionName: "proofRegistry" }) as Promise<Address>,
    publicClient.readContract({ address: vault, abi: policyVaultV3Abi, functionName: "paused" }) as Promise<boolean>,
    publicClient.readContract({ address: vault, abi: policyVaultV3Abi, functionName: "executorRevoked" }) as Promise<boolean>,
    publicClient.readContract({ address: vault, abi: policyVaultV3Abi, functionName: "agentKeyEnabled", args: [agentKey] }) as Promise<boolean>,
  ]);

  check(checks, "LP agent filter", deployment.filters.includes("lp-zia"), deployment.filters.join(","));
  check(checks, "V3 vault snapshot", (workspace.vault.vaultVersion ?? 0) >= 3 && Boolean(workspace.vault.lpAdapter), workspace.vault.vault);
  check(checks, "vault not paused", !paused, `paused=${paused}`);
  check(checks, "executor active", !executorRevoked, `executorRevoked=${executorRevoked}`);
  check(checks, "agent key enabled", agentKeyEnabled, agentKey);
  check(checks, "LP adapter matches snapshot", sameAddress(vaultLpAdapter, workspace.vault.lpAdapter), vaultLpAdapter);
  check(checks, "proof registry matches snapshot", sameAddress(vaultProofRegistry, workspace.vault.proofRegistry), vaultProofRegistry);
  check(checks, "0G Storage upload ready", workspace.storage.uploadReady, workspace.storage.warnings?.join("; "));

  const envProofRegistry = process.env.NEXT_PUBLIC_PROOF_REGISTRY_MAINNET_ADDRESS?.trim();
  if (envProofRegistry) {
    check(checks, "proof registry env matches vault", sameAddress(vaultProofRegistry, envProofRegistry), envProofRegistry);
  }

  const allowlist = await readAllowlist(publicClient, vault);
  check(
    checks,
    "at least one mint+stake pool allowed",
    allowlist.some((item) => item.poolAllowed && item.stakeVaultAllowed && item.liveCandidate),
    `${allowlist.filter((item) => item.poolAllowed && item.stakeVaultAllowed && item.liveCandidate).length}/${allowlist.length}`,
  );

  const positions = workspace.vault.sellableLpPositions ?? [];
  if (args.expectPosition) {
    check(checks, "LP position present", positions.length > 0, `positions=${positions.length}`);
  }
  if (args.tokenId) {
    const position = positions.find((item) => item.tokenId === args.tokenId);
    check(checks, `position #${args.tokenId} present`, Boolean(position), position?.poolAddress);
    if (position && args.expectStaked !== undefined) {
      check(checks, `position #${args.tokenId} staked state`, position.staked === args.expectStaked, `staked=${position.staked}`);
    }
  }

  finish({
    allowlist,
    checks,
    positions: positions.map((position) => ({
      poolAddress: position.poolAddress,
      poolLabel: position.poolLabel,
      staked: position.staked,
      tokenId: position.tokenId,
    })),
    workspace: summary(workspace),
  });
}

async function readAllowlist(
  publicClient: ReturnType<typeof makeMainnetPublicClient>,
  vault: Address,
) {
  const liveCandidates = await buildPoolCandidates(publicClient).catch(() => []);
  const liveCandidateSet = new Set(liveCandidates.map((item) => item.poolAddress.toLowerCase()));
  const configs = zappableZiaLpVaults();
  return Promise.all(
    configs.map(async (config) => {
      const stakeVault = findZiaLpVaultByPool(config.poolAddress)?.vaultAddress ?? config.vaultAddress;
      const poolId = poolIdFromAddress(config.poolAddress);
      const [poolAllowed, stakeVaultAllowed] = await Promise.all([
        publicClient.readContract({
          address: vault,
          abi: policyVaultV3Abi,
          functionName: "allowedLpPools",
          args: [poolId],
        }) as Promise<boolean>,
        publicClient.readContract({
          address: vault,
          abi: policyVaultV3Abi,
          functionName: "allowedStakeVaults",
          args: [stakeVault],
        }) as Promise<boolean>,
      ]);
      return {
        label: config.label,
        liveCandidate: liveCandidateSet.has(config.poolAddress.toLowerCase()),
        poolAddress: config.poolAddress,
        poolAllowed,
        stakeVault,
        stakeVaultAllowed,
      };
    }),
  );
}

function parseArgs(argv: string[]): Args {
  const args: Args = { expectPosition: false };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--agent-id") args.agentId = readNext(argv, ++i, value);
    else if (value === "--owner") {
      const owner = readNext(argv, ++i, value);
      if (!isAddress(owner)) throw new Error("--owner must be a valid address.");
      args.owner = getAddress(owner);
    } else if (value === "--expect-position") args.expectPosition = true;
    else if (value === "--expect-token-id") args.tokenId = readNext(argv, ++i, value);
    else if (value === "--expect-staked") {
      const raw = readNext(argv, ++i, value);
      if (raw !== "true" && raw !== "false") throw new Error("--expect-staked must be true or false.");
      args.expectStaked = raw === "true";
    } else if (value === "--help" || value === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return args;
}

function readNext(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function check(checks: Check[], name: string, ok: boolean, detail?: unknown) {
  checks.push({ detail: detail === undefined ? undefined : String(detail), name, ok });
}

function sameAddress(a: string | undefined | null, b: string | undefined | null): boolean {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}

function summary(workspace: Awaited<ReturnType<typeof loadOgAgentWorkspace>>) {
  return {
    agentId: workspace.agent.id,
    autoMint: workspace.agent.deployment?.runtime?.automation?.autoMint ?? false,
    balance0G: workspace.vault.balance0G,
    lpAdapter: workspace.vault.lpAdapter,
    owner: workspace.vault.owner,
    proofRegistry: workspace.vault.proofRegistry,
    status: workspace.agent.status,
    storageUploadReady: workspace.storage.uploadReady,
    vault: workspace.vault.vault,
    vaultVersion: workspace.vault.vaultVersion,
  };
}

function finish(payload: Record<string, unknown> & { checks: Check[] }) {
  const ok = payload.checks.every((item) => item.ok);
  console.log(JSON.stringify({ ok, ...payload }, null, 2));
  if (!ok) process.exitCode = 1;
}

function printHelp() {
  console.log(`Usage: node --conditions=react-server --import tsx scripts/lp-live-readiness.ts --agent-id <id> [--owner <address>] [--expect-position] [--expect-token-id <id>] [--expect-staked true|false]`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
