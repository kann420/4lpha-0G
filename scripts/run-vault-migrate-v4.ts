import { getAddress, isAddress, isHex, type Hex } from "viem";

import { makeDeployerRuntime } from "../lib/agent/lp/lp-deploy";
import {
  hashPerNftDecisions,
  runVaultMigrateV4FullFlow,
  type PerNftDecision,
  type V4VaultTrio,
} from "../lib/agent/vault-migrate-v4";

async function main() {
  const oldVaultRaw = process.env.OLD_VAULT?.trim();
  if (!oldVaultRaw || !isAddress(oldVaultRaw)) {
    throw new Error("Set OLD_VAULT to one of the approved legacy V3 vault addresses.");
  }
  const oldVault = getAddress(oldVaultRaw);
  const runtime = makeDeployerRuntime();
  const owner = runtime.deployer.address;
  const execute = (process.env.MAINNET_V4_EXECUTE ?? "").toLowerCase() === "true";

  if (!execute) {
    const result = await runVaultMigrateV4FullFlow({ owner, oldVault, confirmedSteps: [] });
    console.log("V4 migration inventory review required. No legacy vault funds or NFTs were moved.");
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const inventoryHash = process.env.INVENTORY_HASH?.trim();
  if (!inventoryHash || !isHex(inventoryHash, { strict: true }) || inventoryHash.length !== 66) {
    throw new Error("Set INVENTORY_HASH to the phase-1 inventory hash.");
  }
  const decisions = parseDecisions(process.env.PER_NFT_DECISIONS);
  const trio = parseTrio();
  console.log("V4 migration execute request:");
  console.log({ oldVault, inventoryHash, perNftDecisionsHash: hashPerNftDecisions(decisions), trio });
  const result = await runVaultMigrateV4FullFlow({
    owner,
    oldVault,
    confirmedSteps: ["migrate-v4-execute"],
    inventoryHash: inventoryHash as Hex,
    perNftDecisions: decisions,
    v4Trio: trio,
  });
  console.log(JSON.stringify(result, null, 2));
}

function parseDecisions(raw: string | undefined): Record<string, PerNftDecision> {
  if (!raw?.trim()) throw new Error("Set PER_NFT_DECISIONS to JSON, e.g. {\"23\":\"preserve\"}.");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("PER_NFT_DECISIONS must be a JSON object.");
  }
  const result: Record<string, PerNftDecision> = {};
  for (const [tokenId, decision] of Object.entries(parsed)) {
    if (!/^\d+$/u.test(tokenId)) throw new Error(`Invalid tokenId key in PER_NFT_DECISIONS: ${tokenId}`);
    if (decision !== "preserve" && decision !== "exit") {
      throw new Error(`Invalid decision for token ${tokenId}: ${String(decision)}`);
    }
    result[tokenId] = decision;
  }
  return result;
}

function parseTrio(): V4VaultTrio {
  const swap = readAddressEnv("V4_SWAP_ADDRESS");
  const lpEntry = readAddressEnv("V4_LP_ENTRY_ADDRESS");
  const lpExit = readAddressEnv("V4_LP_EXIT_ADDRESS");
  return { swapVault: swap, lpEntryVault: lpEntry, lpExitVault: lpExit };
}

function readAddressEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value || !isAddress(value)) throw new Error(`Set ${name} to the reviewed V4 trio address.`);
  return getAddress(value);
}

main().catch((error) => {
  console.error(`V4 vault migration driver failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
