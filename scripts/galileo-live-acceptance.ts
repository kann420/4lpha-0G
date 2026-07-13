/**
 * Live Galileo acceptance smoke (canary). Drives the REAL server executor
 * (previewGalileoTrade / executeGalileoTrade) end-to-end against the deployed
 * Galileo testnet stack: deploy a disposable user vault, attest, deposit, upload
 * a verified agent metadata bundle to 0G Storage, enable the agent key, then run
 * a signed buy and sell, pause, and withdraw. Run with:
 *   node --conditions=react-server --import tsx/esm scripts/galileo-live-acceptance.ts
 * (inline OG_NETWORK=testnet OG_CHAIN_ID=16602 ENABLE_MAINNET_DEPLOY=false).
 *
 * This is a testnet-only, disposable-vault acceptance harness. It never touches
 * mainnet, and ENABLE_GALILEO_TRADE is not required (it calls the executor module
 * directly, not the gated HTTP route).
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPublicClient, createWalletClient, formatEther, http, keccak256, parseEther, stringToHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { galileoVaultAbi, galileoVaultDeploymentAbi, galileoVaultDeploymentBytecode, galileoVaultRegistryAbi } from "../lib/contracts/policy-vault-v4-galileo";
import { resolveGalileoWriteConfig, assertGalileoWritePreflight } from "../lib/galileo/config";
import { buildGalileoAgentMetadata } from "../lib/galileo/metadata";
import { uploadGalileoBytes, downloadAndVerifyGalileoBytes } from "../lib/galileo/storage";
import { deriveGalileoAgentKey, galileoTradePayloadDigest, persistVerifiedGalileoAgent, type GalileoPreparedTrade } from "../lib/galileo/ledger";
import { issueGalileoConsent, buildGalileoConsentMessage } from "../lib/galileo/consent";
import { previewGalileoTrade, executeGalileoTrade } from "../lib/galileo/executor";

const POOL_ID = keccak256(stringToHex("4LPHA_GALILEO_0G_MUSDC_V1"));
const step = (n: string) => console.log(`\n=== ${n} ===`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitReceipt(client: ReturnType<typeof createPublicClient>, hash: Hex, label: string) {
  for (let i = 0; i < 90; i++) {
    try { const r = await client.getTransactionReceipt({ hash }); if (r) { if (r.status !== "success") throw new Error(`${label} reverted (${hash})`); return r; } } catch (e) { if (String(e).includes("reverted")) throw e; }
    await sleep(3000);
  }
  throw new Error(`Timed out waiting for ${label} receipt ${hash}`);
}

async function main() {
  const config = resolveGalileoWriteConfig();
  await assertGalileoWritePreflight(config);
  const rpc = config.rpcUrl;
  const galileoChain = { id: 16602, name: "0G Galileo", nativeCurrency: { name: "0G", symbol: "0G", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } } as const;
  const pub = createPublicClient({ chain: galileoChain, transport: http(rpc) });
  const ownerAccount = privateKeyToAccount(config.signers.deployer.privateKey); // canary owner = deployer wallet (funded)
  const owner = ownerAccount.address as Address;
  const ownerWallet = createWalletClient({ account: ownerAccount, chain: galileoChain, transport: http(rpc) });
  console.log("chainId", await pub.getChainId(), "| canary owner", owner, "| balance", formatEther(await pub.getBalance({ address: owner })), "0G");

  // --- 1-2. Resolve the user's Swap vault: reuse an already-attested one (the registry
  // enforces one vault per owner), otherwise deploy + attest a fresh disposable vault. ---
  step("1-2. resolve user vault (reuse if already attested)");
  const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
  const existing = await pub.readContract({ address: config.addresses.vaultRegistry, abi: galileoVaultRegistryAbi, functionName: "vaultOf", args: [owner] }) as Address;
  let vault: Address;
  if (existing && existing.toLowerCase() !== ZERO_ADDR) {
    vault = existing;
    console.log("reusing attested vault", vault);
  } else {
    const policy = { perTradeCap0G: parseEther("0.01"), dailyCap0G: parseEther("0.05"), maxExposure0G: parseEther("0.05"), cooldownSeconds: 0n, maxDeadlineWindowSeconds: 300n, defaultMinOutBps: 9900 } as const;
    const deployHash = await ownerWallet.deployContract({ abi: galileoVaultDeploymentAbi, bytecode: galileoVaultDeploymentBytecode, args: [owner, config.signers.executor.address, config.addresses.adapter, config.addresses.proofRegistry, policy, config.addresses.sandboxToken, POOL_ID, config.addresses.vaultRegistry] });
    vault = (await waitReceipt(pub, deployHash, "vault deploy")).contractAddress as Address;
    const attestorWallet = createWalletClient({ account: privateKeyToAccount(config.signers.vaultAttestor.privateKey), chain: galileoChain, transport: http(rpc) });
    await waitReceipt(pub, await attestorWallet.writeContract({ address: config.addresses.vaultRegistry, abi: galileoVaultRegistryAbi, functionName: "attestVault", args: [vault] }), "attestVault");
    console.log("deployed + attested vault", vault);
  }
  assert(await pub.readContract({ address: config.addresses.vaultRegistry, abi: galileoVaultRegistryAbi, functionName: "isAttestedVault", args: [vault] }), "vault must be attested");

  // --- 3. Deposit native 0G ---
  step("3. deposit 0.02 0G");
  const depositHash = await ownerWallet.writeContract({ address: vault, abi: galileoVaultAbi, functionName: "depositNative", args: [], value: parseEther("0.02") });
  await waitReceipt(pub, depositHash, "deposit");
  console.log("vault balance", formatEther(await pub.getBalance({ address: vault })), "0G");

  // --- 4. Upload a verified agent metadata bundle to 0G Storage + persist local record ---
  step("4. agent metadata -> 0G Storage (upload + byte-verify)");
  const agentRef = `galileo-canary-${randomUUID()}`;
  const agentKey = deriveGalileoAgentKey(agentRef);
  const meta = buildGalileoAgentMetadata({ agentKey, agentRef, authorizationDigest: keccak256(stringToHex(`auth:${agentRef}`)), configurationDigest: keccak256(stringToHex(`cfg:${agentRef}`)), createdAt: new Date().toISOString(), filters: ["canary"], name: "Galileo Canary Agent", owner, poolId: POOL_ID, vault });
  const uploaded = await uploadGalileoBytes(meta.bytes, config);
  const ok = await downloadAndVerifyGalileoBytes(uploaded.storageRef, meta.bytes, config);
  if (!ok) throw new Error("Storage byte-verify failed");
  console.log("storage root", uploaded.rootHash, "| ref", uploaded.storageRef);
  persistVerifiedGalileoAgent({ agentKey, agentRef, chainId: 16602, createdAt: new Date().toISOString(), owner, storageRef: uploaded.storageRef, storageRoot: uploaded.rootHash, storageVerified: true, vault, adapter: config.addresses.adapter, executor: config.signers.executor.address, proofRegistry: config.addresses.proofRegistry, modelMetadata: { algorithm: "sha256", digest: meta.digest, provider: "galileo-canary" }, storageTxHash: uploaded.txHash, storageTxSeq: uploaded.txSeq });

  // --- 5. Enable the agent key on the vault ---
  step("5. enable agent key");
  const enableHash = await ownerWallet.writeContract({ address: vault, abi: galileoVaultAbi, functionName: "setAgentKeyEnabled", args: [agentKey, true] });
  await waitReceipt(pub, enableHash, "setAgentKeyEnabled");

  // --- helper: run one signed trade through the real executor ---
  async function runTrade(side: "buy" | "sell", amountIn: bigint) {
    step(`trade: ${side} ${side === "buy" ? formatEther(amountIn) + " 0G" : amountIn + " mUSDC"}`);
    const clientRequestId = `canary-${side}-${randomUUID()}`;
    const base = { agentRef, amountIn, clientRequestId, owner, side, vault } as const;
    // 1st preview to get the quote; then derive a 1% user floor and re-preview.
    const p0 = await previewGalileoTrade({ ...base, userMinOut: 1n }, config);
    const userMinOut = (p0.quote * 9900n) / 10_000n > 0n ? (p0.quote * 9900n) / 10_000n : 1n;
    const preview = await previewGalileoTrade({ ...base, userMinOut }, config);
    console.log("quote", preview.quote.toString(), "| amountOutMin", preview.amountOutMin.toString(), "| decision", preview.decision, preview.blockedReason ?? "");
    if (preview.decision !== "allow") throw new Error(`preview blocked: ${preview.blockedReason}`);
    const quoteExpiry = Math.floor(Date.now() / 1000) + 240;
    const tradeNoDigest: Omit<GalileoPreparedTrade, "payloadDigest"> = {
      adapter: config.addresses.adapter, agentKey, agentRef, amountIn: amountIn.toString(), chainId: 16602, clientRequestId,
      minOut: preview.amountOutMin.toString(), networkId: "testnet", poolId: POOL_ID, policyHash: preview.policyHash,
      quoteBlock: preview.pool.quoteBlock.toString(), quoteExpiry, reserveNative: preview.pool.nativeReserve.toString(),
      reserveToken: preview.pool.tokenReserve.toString(), side, trustedQuote: preview.quote.toString(), vault,
    };
    const payloadDigest = galileoTradePayloadDigest(owner, tradeNoDigest);
    const trade: GalileoPreparedTrade = { ...tradeNoDigest, payloadDigest };
    const issue = issueGalileoConsent({ action: "trade", trade, owner });
    const message = buildGalileoConsentMessage({ action: "trade", agentRef, expiresAt: issue.expiresAt, nonce: issue.nonce, owner, trade: issue.trade ?? trade });
    const signature = await ownerWallet.signMessage({ message });
    const exec = await executeGalileoTrade({ ...base, userMinOut }, { nonce: issue.nonce, prepareId: issue.prepareId, wallet: { address: owner, chainId: 16602, message, signature } }, config);
    console.log(`OK ${side}: storageRoot ${exec.storageRoot} | proofTx ${exec.proofTxHash} | tradeTx ${exec.tradeTxHash}`);
    return exec;
  }

  // --- 6. Signed buy 0.001 0G ---
  const buy = await runTrade("buy", parseEther("0.001"));
  const tokenAbi = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }] as const;
  const held = await pub.readContract({ address: config.addresses.sandboxToken, abi: tokenAbi, functionName: "balanceOf", args: [vault] }) as bigint;
  console.log("vault mUSDC after buy:", held.toString());

  // --- 7. Signed sell of the acquired mUSDC ---
  const sell = await runTrade("sell", held);

  // --- 8. Pause / unpause + owner withdraw ---
  step("8. pause + unpause");
  await waitReceipt(pub, await ownerWallet.writeContract({ address: vault, abi: galileoVaultAbi, functionName: "setPaused", args: [true] }), "pause");
  await waitReceipt(pub, await ownerWallet.writeContract({ address: vault, abi: galileoVaultAbi, functionName: "setPaused", args: [false] }), "unpause");
  step("9. owner withdraw all native");
  const bal = await pub.getBalance({ address: vault });
  await waitReceipt(pub, await ownerWallet.writeContract({ address: vault, abi: galileoVaultAbi, functionName: "withdrawNative", args: [bal] }), "withdraw");
  console.log("vault balance after withdraw:", formatEther(await pub.getBalance({ address: vault })), "0G");

  step("EVIDENCE TABLE (chainId 16602)");
  console.table({
    vault, agentRef,
    buyStorageRoot: buy.storageRoot, buyProofTx: buy.proofTxHash, buyTradeTx: buy.tradeTxHash,
    sellStorageRoot: sell.storageRoot, sellProofTx: sell.proofTxHash, sellTradeTx: sell.tradeTxHash,
  });
  console.log("\nLIVE GALILEO ACCEPTANCE PASSED");
}

main().catch((e) => { console.error("\nACCEPTANCE FAILED:", e instanceof Error ? e.message : e); process.exitCode = 1; });
