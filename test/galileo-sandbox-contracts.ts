import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { keccak256, parseEther, stringToHex, type Hex } from "viem";

const ZERO = "0x0000000000000000000000000000000000000000" as const;
const POOL_ID = keccak256(stringToHex("4LPHA_GALILEO_0G_MUSDC_V1"));
const AUDIT = keccak256(stringToHex("galileo-audit"));
const MODEL = keccak256(stringToHex("galileo-model"));
const ZERO_HASH = `0x${"00".repeat(32)}` as Hex;

describe("Galileo sandbox contracts", async () => {
  const { viem } = await network.create("hardhatGalileo");
  const publicClient = await viem.getPublicClient();

  async function fixture() {
    const [owner, executor, other] = await viem.getWalletClients();
    assert.equal(await publicClient.getChainId(), 16602, "run this suite with --network hardhatGalileo");
    const proof = await viem.deployContract("ProofRegistry", [owner.account.address]);
    const token = await viem.deployContract("GalileoDemoUSDC", [owner.account.address]);
    const pool = await viem.deployContract("GalileoSandboxPool", [owner.account.address, token.address]);
    const artifact = JSON.parse(fs.readFileSync("artifacts/contracts/PolicyVaultV4SwapGalileo.sol/PolicyVaultV4SwapGalileo.json", "utf8"));
    const codeHash = keccak256(artifact.deployedBytecode as Hex);
    const registry = await viem.deployContract("GalileoVaultRegistryV4", [owner.account.address, codeHash, executor.account.address, ZERO, proof.address, token.address, POOL_ID]);
    const finalAdapter = await viem.deployContract("GalileoSandboxSwapAdapter", [pool.address, token.address, registry.address]);
    await registry.write.configureAdapter([finalAdapter.address], { account: owner.account });
    await pool.write.setAdapter([finalAdapter.address], { account: owner.account });
    await token.write.mintForPool([owner.account.address, 1_000_000_000n], { account: owner.account });
    await token.write.approve([pool.address, 1_000_000_000n], { account: owner.account });
    await pool.write.addLiquidity([1_000_000_000n], { account: owner.account, value: parseEther("1") });
    const policy = { perTradeCap0G: parseEther("0.01"), dailyCap0G: parseEther("0.05"), maxExposure0G: parseEther("0.05"), cooldownSeconds: 0n, maxDeadlineWindowSeconds: 300n, defaultMinOutBps: 9900 };
    const vault = await viem.deployContract("PolicyVaultV4SwapGalileo", [owner.account.address, executor.account.address, finalAdapter.address, proof.address, policy, token.address, POOL_ID, registry.address], { account: owner.account });
    await registry.write.attestVault([vault.address], { account: owner.account });
    return { owner, executor, other, token, pool, finalAdapter, vault };
  }

  it("uses Galileo chain ID, a 30 bps constant-product quote, and locked ratio liquidity", async () => {
    const { owner, token, pool } = await fixture();
    const amountIn = parseEther("0.01");
    const quote = await pool.read.quoteExactIn([ZERO, amountIn]);
    const expected = (1_000_000_000n * (amountIn * 9970n)) / (parseEther("1") * 10_000n + amountIn * 9970n);
    assert.equal(quote, expected);
    await assert.rejects(pool.write.addLiquidity([1n], { account: owner.account, value: 1n }));
    assert.equal(await token.read.symbol(), "mUSDC");
  });

  it("rejects direct pool and EOA adapter calls before any reserve movement", async () => {
    const { owner, pool, finalAdapter } = await fixture();
    await assert.rejects(pool.write.swapExactIn([ZERO, 1n, 1n], { account: owner.account, value: 1n }));
    await assert.rejects(finalAdapter.write.swapExactIn([ZERO, "0x0000000000000000000000000000000000000001", 1n, 1n, POOL_ID], { account: owner.account, value: 1n }));
  });

  it("derives the floor from the trusted quote and rejects a disabled key for both buy and sell", async () => {
    const { owner, executor, token, finalAdapter, vault } = await fixture();
    const amountIn = parseEther("0.001");
    const quote = await finalAdapter.read.quoteExactIn([ZERO, amountIn]);
    const deadline = BigInt((await publicClient.getBlock()).timestamp) + 120n;
    const disabled = keccak256(stringToHex("disabled-galileo-agent"));
    const request = { tokenIn: ZERO, tokenOut: token.address, amountIn, quotedAmountOut: quote, amountOutMin: 1n, deadline, nonce: 1n, agentKey: disabled, poolId: POOL_ID, vaultActionHash: ZERO_HASH, actionHash: ZERO_HASH, policySnapshotHash: ZERO_HASH, auditRoot: AUDIT };
    await assert.rejects(vault.write.buy([request], { account: executor.account }));
    const sellRequest = { ...request, tokenIn: token.address, tokenOut: ZERO };
    await assert.rejects(vault.write.sell([sellRequest], { account: executor.account }));
    await vault.write.setAgentKeyEnabled([disabled, true], { account: owner.account });
    await assert.rejects(vault.write.buy([request], { account: executor.account }));
  });

  it("rejects attestVault when the vault runtime codehash does not match the registry expectation", async () => {
    const [owner, executor] = await viem.getWalletClients();
    const proof = await viem.deployContract("ProofRegistry", [owner.account.address]);
    const token = await viem.deployContract("GalileoDemoUSDC", [owner.account.address]);
    const pool = await viem.deployContract("GalileoSandboxPool", [owner.account.address, token.address]);
    // A registry that expects a different implementation codehash must reject an
    // otherwise correctly-configured, real vault (look-alike / drifted deploy).
    const wrongCodeHash = keccak256(stringToHex("not-the-galileo-vault-bytecode"));
    const registry = await viem.deployContract("GalileoVaultRegistryV4", [owner.account.address, wrongCodeHash, executor.account.address, ZERO, proof.address, token.address, POOL_ID]);
    const adapter = await viem.deployContract("GalileoSandboxSwapAdapter", [pool.address, token.address, registry.address]);
    await registry.write.configureAdapter([adapter.address], { account: owner.account });
    const policy = { perTradeCap0G: parseEther("0.01"), dailyCap0G: parseEther("0.05"), maxExposure0G: parseEther("0.05"), cooldownSeconds: 0n, maxDeadlineWindowSeconds: 300n, defaultMinOutBps: 9900 };
    const vault = await viem.deployContract("PolicyVaultV4SwapGalileo", [owner.account.address, executor.account.address, adapter.address, proof.address, policy, token.address, POOL_ID, registry.address], { account: owner.account });
    await assert.rejects(registry.write.attestVault([vault.address], { account: owner.account }));
  });
});
