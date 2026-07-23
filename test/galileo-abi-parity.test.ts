import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { keccak256, parseEther, stringToHex, type Address, type Hex } from "viem";

import { galileoVaultAbi } from "../lib/contracts/policy-vault-v4-galileo";
import { GALILEO_CHAIN_ID, GALILEO_NETWORK_ID } from "../lib/galileo/config";
import { hashAction, hashPolicy, hashVaultAction } from "../lib/galileo/executor";
import type { GalileoPreparedTrade } from "../lib/galileo/ledger";

// This suite is the safety net the audit flagged as missing: a single wrong
// ABI type (e.g. defaultMinOutBps as uint256 instead of uint16, or a wrong
// field order) silently makes every on-chain trade revert. It proves the TS
// hash encoders in lib/galileo/executor.ts match the on-chain vault helpers
// byte-for-byte for both buy and sell.

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const POOL_ID = keccak256(stringToHex("4LPHA_GALILEO_0G_MUSDC_V1"));
const AUDIT = keccak256(stringToHex("galileo-parity-audit"));
const AGENT_KEY = keccak256(stringToHex("galileo-parity-agent-key"));
const PAYLOAD_DIGEST = keccak256(stringToHex("galileo-parity-payload-digest"));
const ZERO_HASH = `0x${"00".repeat(32)}` as Hex;

// Must mirror executor.ts contractNonce() exactly.
const NONCE = BigInt(`0x${PAYLOAD_DIGEST.slice(2, 18)}`);

describe("Galileo ABI hash parity (TS vs on-chain)", async () => {
  const { viem } = await network.create("hardhatGalileo");
  const publicClient = await viem.getPublicClient();

  async function fixture() {
    const [owner, executor] = await viem.getWalletClients();
    assert.equal(await publicClient.getChainId(), 16602, "run with --network hardhatGalileo");
    const proof = await viem.deployContract("ProofRegistry", [owner.account.address]);
    const token = await viem.deployContract("GalileoDemoUSDC", [owner.account.address]);
    const pool = await viem.deployContract("GalileoSandboxPool", [owner.account.address, token.address]);
    const artifact = JSON.parse(fs.readFileSync("artifacts/contracts/PolicyVaultV4SwapGalileo.sol/PolicyVaultV4SwapGalileo.json", "utf8"));
    const codeHash = keccak256(artifact.deployedBytecode as Hex);
    const registry = await viem.deployContract("GalileoVaultRegistryV4", [owner.account.address, codeHash, executor.account.address, ZERO, proof.address, token.address, POOL_ID]);
    const adapter = await viem.deployContract("GalileoSandboxSwapAdapter", [pool.address, token.address, registry.address]);
    await registry.write.configureAdapter([adapter.address], { account: owner.account });
    await pool.write.setAdapter([adapter.address], { account: owner.account });
    await token.write.mintForPool([owner.account.address, 1_000_000_000n], { account: owner.account });
    await token.write.approve([pool.address, 1_000_000_000n], { account: owner.account });
    await pool.write.addLiquidity([1_000_000_000n], { account: owner.account, value: parseEther("1") });
    const policy = { perTradeCap0G: parseEther("0.01"), dailyCap0G: parseEther("0.05"), maxExposure0G: parseEther("0.05"), cooldownSeconds: 0n, maxDeadlineWindowSeconds: 300n, defaultMinOutBps: 9900 };
    const vault = await viem.deployContract("PolicyVaultV4SwapGalileo", [owner.account.address, executor.account.address, adapter.address, proof.address, policy, token.address, POOL_ID, registry.address], { account: owner.account });
    await registry.write.attestVault([vault.address], { account: owner.account });
    return { owner, executor, proof, token, pool, adapter, vault, policy };
  }

  async function assertSideParity(side: "buy" | "sell") {
    const f = await fixture();
    const isBuy = side === "buy";
    const tokenIn = isBuy ? ZERO : (f.token.address as Address);
    const tokenOut = isBuy ? (f.token.address as Address) : ZERO;
    const amountIn = isBuy ? parseEther("0.001") : 500_000n; // 0.001 0G in / 0.5 mUSDC in
    const quote = await f.adapter.read.quoteExactIn([tokenIn, amountIn]);
    const minOut = (quote * 9900n) / 10_000n;
    const deadline = BigInt((await publicClient.getBlock()).timestamp) + 120n;

    // --- policyHash parity ---
    const policyHashOnchain = await f.vault.read.policyHash();
    const policyHashTs = hashPolicy(f.policy);
    assert.equal(policyHashTs, policyHashOnchain, `${side}: policyHash mismatch`);

    // --- vaultActionHash parity ---
    const onchainRequest = { tokenIn, tokenOut, amountIn, quotedAmountOut: quote, amountOutMin: minOut, deadline, nonce: NONCE, agentKey: AGENT_KEY, poolId: POOL_ID, vaultActionHash: ZERO_HASH, actionHash: ZERO_HASH, policySnapshotHash: policyHashOnchain, auditRoot: AUDIT };
    const vaultActionHashOnchain = await f.vault.read.vaultActionHashFor([isBuy, onchainRequest]);

    const prepared: GalileoPreparedTrade = {
      adapter: f.adapter.address as Address,
      agentKey: AGENT_KEY,
      agentRef: "galileo-parity",
      amountIn: amountIn.toString(),
      chainId: GALILEO_CHAIN_ID,
      clientRequestId: "parity-request-id",
      minOut: minOut.toString(),
      networkId: GALILEO_NETWORK_ID,
      payloadDigest: PAYLOAD_DIGEST,
      poolId: POOL_ID,
      policyHash: policyHashOnchain,
      quoteBlock: "0",
      quoteExpiry: Number(deadline),
      reserveNative: parseEther("1").toString(),
      reserveToken: "1000000000",
      side,
      trustedQuote: quote.toString(),
      vault: f.vault.address as Address,
    };
    const vaultActionHashTs = hashVaultAction({
      ...prepared,
      auditRoot: AUDIT,
      deadline: Number(deadline),
      executor: f.executor.account.address as Address,
      owner: f.owner.account.address as Address,
      proofRegistry: f.proof.address as Address,
      token: f.token.address as Address,
    });
    assert.equal(vaultActionHashTs, vaultActionHashOnchain, `${side}: vaultActionHash mismatch`);

    // --- actionHash parity ---
    const actionHashOnchain = await f.vault.read.actionHashFor([vaultActionHashOnchain, AUDIT, policyHashOnchain]);
    const actionHashTs = hashAction(vaultActionHashTs, AUDIT, policyHashOnchain);
    assert.equal(actionHashTs, actionHashOnchain, `${side}: actionHash mismatch`);
  }

  it("keeps the TradeExecuted ABI fragment identical to the compiled artifact", () => {
    const artifact = JSON.parse(fs.readFileSync("artifacts/contracts/PolicyVaultV4SwapGalileo.sol/PolicyVaultV4SwapGalileo.json", "utf8"));
    const artifactEvent = artifact.abi.find((item: { name?: string; type: string }) => item.type === "event" && item.name === "TradeExecuted");
    const sharedEvent = galileoVaultAbi.find((item) => item.type === "event" && item.name === "TradeExecuted");

    assert.deepEqual(sharedEvent, artifactEvent);
  });

  it("matches on-chain policyHash, vaultActionHash, and actionHash for a buy", async () => {
    await assertSideParity("buy");
  });

  it("matches on-chain policyHash, vaultActionHash, and actionHash for a sell", async () => {
    await assertSideParity("sell");
  });
});
