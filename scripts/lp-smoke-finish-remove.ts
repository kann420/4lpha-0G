// Finish the agent-23 remove after close-all + disable-key already succeeded
// (the main remove driver aborted at disable-key's receipt poll on public RPC,
// but the disable-key tx did mine — agentKeyEnabled is false on-chain). This
// finishes the remaining two steps: removeSingleOgAgentRecord (file-only) +
// withdrawMainnetVaultNative (full vault 0G to owner). No disable-key redo.
//
// Usage:
//   node --conditions=react-server --import tsx scripts/lp-smoke-finish-remove.ts --agent-id agent-0g-mainnet-23 --disable-tx 0xd6b83da18278e26fda50d5d954d9ec6c082b534fba9601dac49ba7c7e9022884

import dotenv from "dotenv";
import { formatEther, type Address, type Hex } from "viem";

import { makeMainnetPublicClient } from "../lib/agent/lp/lp-context";
import { withdrawMainnetVaultNative } from "../lib/agent/mainnet-vault-withdraw";
import { agentKeyForDeployment, loadOgAgentWorkspace, removeSingleOgAgentRecord } from "../lib/agent/single-agent-server";
import { policyVaultV3Abi } from "../lib/contracts/policy-vault-v3";

dotenv.config({ path: ".env.local", quiet: true });

process.env.OG_RPC_URL = "https://evmrpc.0g.ai";
process.env.OG_MAINNET_RPC_URL = "https://evmrpc.0g.ai";
process.env.OG_RPC_RETRY_COUNT = "8";
process.env.OG_RPC_RETRY_DELAY_MS = "700";
process.env.OG_PUBLIC_RPC_RETRY_COUNT = "8";
process.env.OG_PUBLIC_RPC_RETRY_DELAY_MS = "700";

function log(stage: string, data: Record<string, unknown>) {
  console.log(JSON.stringify({ stage, ...data }));
}

async function main() {
  let agentId = "agent-0g-mainnet-23";
  let disableTx: Hex | undefined;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--agent-id") agentId = argv[++i] ?? agentId;
    else if (argv[i] === "--disable-tx") disableTx = argv[++i] as Hex | undefined;
  }

  // Owner = DEPLOYER (read privately, never printed).
  const pk = process.env.DEPLOYER_PRIVATE_KEY?.trim();
  if (!pk) throw new Error("DEPLOYER_PRIVATE_KEY is required.");
  const { privateKeyToAccount } = await import("viem/accounts");
  const owner = privateKeyToAccount(pk as Hex).address as Address;

  const workspace = await loadOgAgentWorkspace({ agentId, live: true, ownerAddress: owner });
  const deployment = workspace.agent.deployment;
  if (!deployment) throw new Error(`No deployed agent for ${agentId}.`);
  const publicClient = makeMainnetPublicClient();
  const agentKey = (deployment.agentKey ?? agentKeyForDeployment(deployment)) as Hex;
  const agentKeyEnabled = await publicClient.readContract({
    address: deployment.vault, abi: policyVaultV3Abi, functionName: "agentKeyEnabled", args: [agentKey],
  });
  const vaultBalance = await publicClient.getBalance({ address: deployment.vault });
  const positions = (workspace.vault.sellableLpPositions ?? []).length;
  log("verify", { status: workspace.agent.status, paused: deployment.paused, agentKeyEnabled, positions, vaultBalance0G: formatEther(vaultBalance) });

  if (positions > 0) throw new Error(`ABORT: ${positions} positions still open — do not remove.`);
  if (agentKeyEnabled !== false) throw new Error("ABORT: agentKeyEnabled is not false — do not remove (disable-key first).");

  log("remove", { action: "begin", disableTx });
  const removed = await removeSingleOgAgentRecord(agentId, deployment, owner, disableTx);
  log("remove", { removed: Boolean(removed), agentId });

  const amount0G = formatEther(vaultBalance);
  if (BigInt(Math.floor(Number(amount0G) * 1e18)) > 0n) {
    log("withdraw", { amount0G });
    const w = await withdrawMainnetVaultNative({ owner, amount0G });
    log("withdraw", { txHash: w.txHash, amount0G: w.amount0G, balanceBefore0G: w.balanceBefore0G, balanceAfter0G: w.balanceAfter0G });
  } else {
    log("withdraw", { skipped: "vault-balance-zero" });
  }

  log("done", { agentId, note: "Agent retired: positions closed, key disabled, record removed (read-only), vault native withdrawn to owner." });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});