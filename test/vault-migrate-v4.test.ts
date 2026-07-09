import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getAddress, parseEther, zeroAddress, type Address, type Hex } from "viem";

import {
  deployMainnetV4VaultTrio,
  finalizeWalletOwnedV4Migration,
  hashVaultInventory,
  inventoryV3Vault,
  rescueLpNftPreserve,
  retireV3Vault,
  type V3VaultInventory,
  type V4VaultTrio,
  type VaultMigrateV4State,
} from "../lib/agent/vault-migrate-v4";
import { poolIdFromAddress, ZIA_LP_MAINNET } from "../lib/contracts/zia-lp";

const OWNER = getAddress("0x1000000000000000000000000000000000000001");
const EXECUTOR = getAddress("0x1000000000000000000000000000000000000002");
const ADAPTER = getAddress("0x1000000000000000000000000000000000000003");
const LP_ADAPTER = getAddress("0x1000000000000000000000000000000000000004");
const PROOF = getAddress("0x1000000000000000000000000000000000000005");
const REGISTRY = getAddress("0x1000000000000000000000000000000000000006");
const OLD_VAULT = getAddress("0xfd391E8FFC423E2b7493Ea64C517957688B60BF5");
const SWAP = getAddress("0x2000000000000000000000000000000000000001");
const LP_ENTRY = getAddress("0x2000000000000000000000000000000000000002");
const LP_EXIT = getAddress("0x2000000000000000000000000000000000000003");
const TOKEN = getAddress("0x3000000000000000000000000000000000000001");
const POOL = getAddress("0x159fe1d57b464eD60E2bfbBCA0dF444999131673");
const POOL_ID = poolIdFromAddress(POOL);
const AGENT_KEY = `0x${"11".repeat(32)}` as Hex;
const ZERO_HASH = `0x${"00".repeat(32)}` as Hex;
const MAX_UINT256 = 2n ** 256n - 1n;

describe("vault-migrate-v4 orchestration", () => {
  it("adopts a registry trio before deploying new V4 vaults (F-6)", async () => {
    withV4Env();
    const calls: string[] = [];
    const runtime = makeRuntime({
      readContract: async ({ address, functionName }) => {
        calls.push(`${functionName}:${address}`);
        if (functionName === "vaultOf") return [SWAP, LP_ENTRY, LP_EXIT];
        if (functionName === "owner") return OWNER;
        if (functionName === "executor") return EXECUTOR;
        if (functionName === "swapAdapter") return ADAPTER;
        if (functionName === "lpAdapter") return LP_ADAPTER;
        if (functionName === "proofRegistry") return PROOF;
        if (functionName === "lpExitVault") return LP_EXIT;
        throw new Error(`unexpected read ${functionName}`);
      },
      deployContract: async () => {
        throw new Error("deploy must not be called when registry slots are already populated");
      },
      writeContract: async () => {
        throw new Error("write must not be called when registry slots are already populated");
      },
    });
    const state = { oldVault: OLD_VAULT, updatedAt: new Date(0).toISOString() } satisfies VaultMigrateV4State;
    const trio = await deployMainnetV4VaultTrio(runtime, OWNER, {}, state);
    assert.deepEqual(trio, { swapVault: SWAP, lpEntryVault: LP_ENTRY, lpExitVault: LP_EXIT });
    assert.deepEqual(state.v4Trio, trio);
    // The idempotent adopt path must read vaultOf to discover the registered trio,
    // then re-read after the (skipped) deploy/register steps to verify. The exact
    // count is an implementation detail — the real idempotency guarantee (no deploy,
    // no register when slots are populated) is asserted by the throwing mocks above.
    assert.ok(
      calls.filter((call) => call.startsWith("vaultOf")).length >= 2,
      "vaultOf must be read to adopt the registered trio",
    );
  });

  it("inventories V3 NFTs from NFPM Transfer logs and probes required selectors (F-7/MIG-2)", async () => {
    process.env.AGENT_IDENTITY_MAINNET_ADDRESS = "0x058c5F4C72810D7D4Fc0bEF3875a8f779DE7E59c";
    process.env.POLICY_VAULT_V3_MAINNET_FROM_BLOCK = "1";
    const runtime = makeRuntime({
      getBlockNumber: async () => 10n,
      getBalance: async () => parseEther("1"),
      getLogs: async ({ event, fromBlock, toBlock, args }) => {
        assert.equal(fromBlock, 1n);
        assert.equal(toBlock, 10n);
        assert.ok(args?.to === OLD_VAULT || args?.from === OLD_VAULT);
        if (event.name !== "Transfer") return [];
        return [{ args: { from: zeroAddress, to: OLD_VAULT, tokenId: 23n } }];
      },
      readContract: async ({ address, functionName, args }) => {
        if (functionName === "ownerOf" && args?.[0] === MAX_UINT256) throw Object.assign(new Error("NonexistentToken"), { data: "0x7e273289" });
        if (functionName === "ownerOf") return OLD_VAULT;
        if (functionName === "lpNftOwner") return "0xac218cc9a1a4ecb993d03ed10dcef9bf1a3d9df09001ad51895d2128693a8613";
        if (functionName === "lpNftPool") return POOL_ID;
        if (functionName === "lpNftTickLower") return -120;
        if (functionName === "lpNftTickUpper") return 120;
        if (functionName === "lpNftDeployedNative") return parseEther("0.5");
        if (functionName === "balanceOf" && address === TOKEN) return 0n;
        if (functionName === "balanceOf") return 0n;
        throw new Error(`unexpected read ${functionName}`);
      },
    });
    const inventory = await inventoryV3Vault(runtime, OLD_VAULT, ["agent-0g-mainnet-23"]);
    assert.equal(inventory.selectorProbe.lpNftOwner, true);
    assert.equal(inventory.selectorProbe.lpNftPool, true);
    assert.equal(inventory.selectorProbe.lpNftTickLower, true);
    assert.equal(inventory.selectorProbe.lpNftTickUpper, true);
    assert.equal(inventory.selectorProbe.lpNftDeployedNative, true);
    assert.equal(inventory.nfts.length, 1);
    assert.equal(inventory.nfts[0].tokenId, "23");
    assert.equal(inventory.nfts[0].stage, "undecided");
    assert.equal(hashVaultInventory(inventory).length, 66);
  });

  it("refuses to scan V3 NFPM Transfer logs from block 0 before any log query", async () => {
    process.env.AGENT_IDENTITY_MAINNET_ADDRESS = "0x058c5F4C72810D7D4Fc0bEF3875a8f779DE7E59c";
    process.env.POLICY_VAULT_V3_MAINNET_FROM_BLOCK = "0";
    let logQueries = 0;
    const runtime = makeRuntime({
      getBlockNumber: async () => 10n,
      getLogs: async () => {
        logQueries += 1;
        return [];
      },
    });
    await assert.rejects(
      inventoryV3Vault(runtime, OLD_VAULT, []),
      /Inventory fromBlock is unavailable|Refusing to enumerate NFPM Transfer logs from block 0/,
    );
    assert.equal(logQueries, 0);
  });

  it("resumes preserve from deployer custody and imports into V4 LpEntry (MIG-3)", async () => {
    const writes: string[] = [];
    let nftOwner: Address = OWNER;
    let v4Owner: Hex = ZERO_HASH;
    const trio = { swapVault: SWAP, lpEntryVault: LP_ENTRY, lpExitVault: LP_EXIT };
    const runtime = makeRuntime({
      getBlock: async () => ({ timestamp: 100n }),
      readContract: async ({ functionName, args }) => {
        if (functionName === "ownerOf" && args?.[0] === MAX_UINT256) throw Object.assign(new Error("NonexistentToken"), { data: "0x7e273289" });
        if (functionName === "ownerOf") return nftOwner;
        if (functionName === "allowedLpPools") return true;
        if (functionName === "agentKeyEnabled") return true;
        if (functionName === "policy") return migrationLpPolicy();
        if (functionName === "lpDailySpent0G") return 0n;
        if (functionName === "lpDailyWindowStart") return 0n;
        if (functionName === "openLpExposure0G") return 0n;
        if (functionName === "lpNftOwner") return v4Owner;
        if (functionName === "lpNftPool") return POOL_ID;
        if (functionName === "lpNftDeployedNative") return parseEther("0.5");
        throw new Error(`unexpected read ${functionName}`);
      },
      writeContract: async ({ functionName }) => {
        writes.push(functionName);
        if (functionName === "safeTransferFrom") nftOwner = LP_ENTRY;
        if (functionName === "importLpNft") v4Owner = AGENT_KEY;
        return nextHash(writes.length);
      },
    });
    const state = { oldVault: OLD_VAULT, v4Trio: trio, updatedAt: new Date(0).toISOString() } satisfies VaultMigrateV4State;
    const result = await rescueLpNftPreserve(runtime, OLD_VAULT, LP_ENTRY, ZIA_LP_MAINNET.nonfungiblePositionManager, 23n, AGENT_KEY, POOL_ID, { tickLower: -120, tickUpper: 120 }, parseEther("0.5"), state);
    assert.equal(result.stage, "imported");
    assert.deepEqual(writes, ["safeTransferFrom", "importLpNft"]);
    assert.equal(state.nftStages?.["23"], "imported");
  });

  it("halts preserve before any NFT move when preflight fails (F-3)", async () => {
    const writes: string[] = [];
    const trio = { swapVault: SWAP, lpEntryVault: LP_ENTRY, lpExitVault: LP_EXIT };
    const runtime = makeRuntime({
      getBlock: async () => ({ timestamp: 100n }),
      readContract: async ({ functionName, args }) => {
        if (functionName === "ownerOf" && args?.[0] === MAX_UINT256) throw Object.assign(new Error("NonexistentToken"), { data: "0x7e273289" });
        if (functionName === "ownerOf") return OLD_VAULT;
        if (functionName === "allowedLpPools") return false;
        if (functionName === "agentKeyEnabled") return true;
        if (functionName === "policy") return migrationLpPolicy();
        if (functionName === "lpDailySpent0G") return 0n;
        if (functionName === "lpDailyWindowStart") return 0n;
        if (functionName === "openLpExposure0G") return 0n;
        if (functionName === "lpNftOwner") return ZERO_HASH;
        throw new Error(`unexpected read ${functionName}`);
      },
      writeContract: async ({ functionName }) => {
        writes.push(functionName);
        return nextHash(writes.length);
      },
    });
    const state = { oldVault: OLD_VAULT, v4Trio: trio, updatedAt: new Date(0).toISOString() } satisfies VaultMigrateV4State;
    await assert.rejects(
      rescueLpNftPreserve(runtime, OLD_VAULT, LP_ENTRY, ZIA_LP_MAINNET.nonfungiblePositionManager, 23n, AGENT_KEY, POOL_ID, { tickLower: -120, tickUpper: 120 }, parseEther("0.5"), state),
      /not allowlisted/,
    );
    assert.deepEqual(writes, []);
  });

  it("blocks V3 retirement if a new NFT arrives after reviewed inventory (F-2)", async () => {
    const inventory = {
      oldVault: OLD_VAULT,
      nativeBalance0G: "0",
      tokenBalances: [],
      selectorProbe: { lpNftOwner: true, lpNftPool: true, lpNftTickLower: true, lpNftTickUpper: true, lpNftDeployedNative: true },
      fromBlock: "0",
      scannedToBlock: "10",
      nfts: [{ tokenId: "23", stage: "imported", decision: "preserve", staked: false, agentKey: AGENT_KEY, poolId: POOL_ID, deployedNative0G: parseEther("0.5").toString() }],
    } satisfies V3VaultInventory;
    const writes: string[] = [];
    const runtime = makeRuntime({
      getBlockNumber: async () => 12n,
      getLogs: async () => [{ args: { from: zeroAddress, to: OLD_VAULT, tokenId: 99n } }],
      readContract: async ({ functionName }) => {
        // retireV3Vault reads paused/executorRevoked first (pause+revoke land before the
        // re-scan, closing the executor-mint window — Finding #3), then re-scans and throws
        // on the new NFT before reaching any per-NFT postcondition read.
        if (functionName === "paused") return false;
        if (functionName === "executorRevoked") return false;
        throw new Error(`unexpected read ${functionName}`);
      },
      writeContract: async ({ functionName }) => {
        writes.push(functionName);
        return nextHash(writes.length);
      },
    });
    const state = {
      oldVault: OLD_VAULT,
      v4Trio: { swapVault: SWAP, lpEntryVault: LP_ENTRY, lpExitVault: LP_EXIT },
      inventory,
      nftStages: { "23": "imported" },
      updatedAt: new Date(0).toISOString(),
    } satisfies VaultMigrateV4State;
    await assert.rejects(retireV3Vault(runtime, OLD_VAULT, state), /New NFT/);
    // Pause + revoke must land BEFORE the stale-inventory throw (Finding #3 ordering).
    assert.ok(writes.includes("setPaused"), "retire must pause V3 before the re-scan");
    assert.ok(writes.includes("revokeExecutor"), "retire must revoke the executor before the re-scan");
  });

  it("finalizes wallet-owned V4 after post-migration inventory no longer matches the plan hash", async () => {
    withV4Env();
    process.env.OG_NETWORK = "mainnet";
    process.env.OG_CHAIN_ID = "16661";
    process.env.ENABLE_MAINNET_DEPLOY = "true";
    process.env.ENABLE_REAL_DEX_ADAPTER = "true";
    process.env.ENABLE_MOCK_DEX_ADAPTER = "false";
    process.env.MAINNET_ALLOW_MOCK_LP_ADAPTER = "false";
    process.env.AGENT_IDENTITY_MAINNET_ADDRESS = "0x058c5F4C72810D7D4Fc0bEF3875a8f779DE7E59c";
    process.env.POLICY_VAULT_V3_MAINNET_FROM_BLOCK = "1";
    const sourceVault = getAddress("0x4000000000000000000000000000000000000001");
    const runtime = makeRuntime({
      getBalance: async () => 0n,
      getBlockNumber: async () => 10n,
      getLogs: async () => [],
      readContract: async ({ address, functionName, args }) => {
        if (functionName === "vaultOf") return [SWAP, LP_ENTRY, LP_EXIT];
        if (functionName === "owner") return OWNER;
        if (functionName === "executor") return EXECUTOR;
        if (functionName === "swapAdapter") return ADAPTER;
        if (functionName === "lpAdapter") return LP_ADAPTER;
        if (functionName === "proofRegistry") return PROOF;
        if (functionName === "lpExitVault") return LP_EXIT;
        if (functionName === "paused") return true;
        if (functionName === "executorRevoked") return true;
        if (functionName === "ownerOf" && args?.[0] === MAX_UINT256) {
          throw Object.assign(new Error("NonexistentToken"), { data: "0x7e273289" });
        }
        if (functionName === "balanceOf") return 0n;
        if (functionName === "agentKeyEnabled") return true;
        throw new Error(`unexpected read ${functionName} at ${address}`);
      },
    });

    const result = await finalizeWalletOwnedV4Migration({
      completedTxs: [],
      inventoryHash: ZERO_HASH,
      owner: OWNER,
      planHash: ZERO_HASH,
      sourceVault,
      sourceVersion: 3,
      v4Trio: { swapVault: SWAP, lpEntryVault: LP_ENTRY, lpExitVault: LP_EXIT },
    }, runtime);

    assert.equal(result.inventoryHash, ZERO_HASH);
    assert.deepEqual(result.v4Trio, { swapVault: SWAP, lpEntryVault: LP_ENTRY, lpExitVault: LP_EXIT });
    assert.deepEqual(result.repointedAgents, []);
    assert.equal(result.retired, true);
  });
});

function withV4Env() {
  process.env.NEXT_PUBLIC_POLICY_VAULT_ADAPTER_MAINNET_ADDRESS = ADAPTER;
  process.env.NEXT_PUBLIC_VAULT_EXECUTOR_MAINNET_ADDRESS = EXECUTOR;
  process.env.NEXT_PUBLIC_POLICY_VAULT_ZIA_LP_ADAPTER_V4_MAINNET_ADDRESS = LP_ADAPTER;
  process.env.NEXT_PUBLIC_PROOF_REGISTRY_MAINNET_ADDRESS = PROOF;
  process.env.NEXT_PUBLIC_POLICY_VAULT_V4_REGISTRY_MAINNET_ADDRESS = REGISTRY;
}

function migrationLpPolicy() {
  return {
    perLpActionCap0G: parseEther("1000000"),
    lpDailyCap0G: parseEther("1000000"),
    maxLpExposure0G: 2n ** 256n - 1n,
    cooldownSecondsLp: 0n,
    lpMinOutBps: 9500,
    minLiquidityFloor: 1n,
    allowStaking: true,
  };
}

function makeRuntime(overrides: {
  deployContract?: (request: any) => Promise<Hex>;
  getBalance?: (request: any) => Promise<bigint>;
  getBlock?: () => Promise<{ timestamp: bigint }>;
  getBlockNumber?: () => Promise<bigint>;
  getChainId?: () => Promise<number>;
  getLogs?: (request: any) => Promise<any[]>;
  readContract?: (request: any) => Promise<any>;
  writeContract?: (request: any) => Promise<Hex>;
}): any {
  let writeCount = 0;
  return {
    chain: { id: 16661, name: "0G Mainnet", nativeCurrency: { name: "0G", symbol: "0G", decimals: 18 }, rpcUrls: { default: { http: ["http://localhost"] } } },
    deployer: { address: OWNER },
    publicClient: {
      getBalance: overrides.getBalance ?? (async () => 0n),
      getBlock: overrides.getBlock ?? (async () => ({ timestamp: 0n })),
      getBlockNumber: overrides.getBlockNumber ?? (async () => 0n),
      getChainId: overrides.getChainId ?? (async () => 16661),
      getLogs: overrides.getLogs ?? (async () => []),
      getTransactionReceipt: async () => ({ status: "success", blockNumber: 1n, contractAddress: null }),
      readContract: overrides.readContract ?? (async () => {
        throw new Error("unexpected readContract");
      }),
      simulateContract: async (request: any) => ({ request }),
    },
    walletClient: {
      deployContract: overrides.deployContract ?? (async () => nextHash(++writeCount)),
      writeContract: async (request: any) => {
        writeCount += 1;
        return overrides.writeContract ? overrides.writeContract(request) : nextHash(writeCount);
      },
    },
  };
}

function nextHash(index: number): Hex {
  return `0x${index.toString(16).padStart(64, "0")}` as Hex;
}
