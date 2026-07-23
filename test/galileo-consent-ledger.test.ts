import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { privateKeyToAccount } from "viem/accounts";

import { assertGalileoRequestBoundary, buildGalileoConsentMessage, verifyAndConsumeGalileoConsent, verifyGalileoConsent } from "../lib/galileo/consent";
import { claimTradeAndConsume, consumeGalileoPrepare, galileoTradePayloadDigest, issueGalileoPrepare, listVerifiedGalileoAgents, persistVerifiedGalileoAgent, readGalileoPrepare, type GalileoLedgerOptions } from "../lib/galileo/ledger";
import { buildGalileoAgentMetadata, canonicalJson } from "../lib/galileo/metadata";

const account = privateKeyToAccount(`0x${"1".repeat(64)}`);
const vault = `0x${"2".repeat(40)}` as const;

function ledger(): { cleanup: () => void; options: GalileoLedgerOptions } {
  const rootDir = mkdtempSync(join(tmpdir(), "4lpha-galileo-ledger-"));
  return { cleanup: () => rmSync(rootDir, { force: true, recursive: true }), options: { rootDir } };
}

describe("Galileo consent and durable ledger", () => {
  it("derives the local agent reference/key and stores only a nonce hash", () => {
    const test = ledger();
    try {
      const issue = issueGalileoPrepare({
        action: "deploy",
        config: { clientRequestId: "deploy-ledger-1", filters: ["capital-guard"], name: "Galileo scout", owner: account.address, vault },
        owner: account.address,
      }, test.options);
      const stored = readGalileoPrepare(issue.prepareId, test.options);
      assert.ok(issue.agentRef?.startsWith("galileo-"));
      assert.match(issue.agentKey ?? "", /^0x[0-9a-f]{64}$/u);
      assert.equal(stored?.nonceHash.length, 66);
      assert.notEqual(stored?.nonceHash, issue.nonce);
      assert.equal(stored?.configDigest, issue.configDigest);
    } finally {
      test.cleanup();
    }
  });

  it("verifies only the exact expiring Galileo action message and consumes it once", async () => {
    const test = ledger();
    try {
      const issue = issueGalileoPrepare({
        action: "deploy",
        config: { clientRequestId: "deploy-ledger-2", filters: ["capital-guard"], name: "Galileo scout", owner: account.address, vault },
        owner: account.address,
      }, test.options);
      const message = buildGalileoConsentMessage({
        action: "deploy",
        agentRef: issue.agentRef,
        configDigest: issue.configDigest,
        expiresAt: issue.expiresAt,
        nonce: issue.nonce,
        owner: account.address,
        vault,
      });
      const signature = await account.signMessage({ message });
      const wallet = { address: account.address, chainId: 16602, message, signature };
      const consumed = await verifyAndConsumeGalileoConsent({ action: "deploy", nonce: issue.nonce, prepareId: issue.prepareId, wallet }, test.options);
      assert.ok(consumed.consumedAt);
      await assert.rejects(() => verifyAndConsumeGalileoConsent({ action: "deploy", nonce: issue.nonce, prepareId: issue.prepareId, wallet }, test.options), /already used/u);
    } finally {
      test.cleanup();
    }
  });

  it("makes duplicate consent consumption atomic across callers", () => {
    const test = ledger();
    try {
      const issue = issueGalileoPrepare({ action: "workspace-read", owner: account.address }, test.options);
      const consume = () => consumeGalileoPrepare({ action: "workspace-read", nonce: issue.nonce, owner: account.address, prepareId: issue.prepareId }, test.options);
      assert.doesNotThrow(consume);
      assert.throws(consume, /already used/u);
    } finally {
      test.cleanup();
    }
  });

  it("binds every normalized trade field and atomically claims then consumes its consent", async () => {
    const test = ledger();
    try {
      const unsignedTrade = {
        adapter: `0x${"a".repeat(40)}` as const,
        agentKey: `0x${"b".repeat(64)}` as const,
        agentRef: "galileo-trade-1",
        amountIn: "1000000000000000",
        chainId: 16602 as const,
        clientRequestId: "trade-ledger-1",
        minOut: "1",
        networkId: "testnet" as const,
        policyHash: `0x${"c".repeat(64)}` as const,
        poolId: `0x${"d".repeat(64)}` as const,
        quoteBlock: "123",
        quoteExpiry: Math.floor(Date.now() / 1000) + 60,
        reserveNative: "1000000000000000000",
        reserveToken: "1000000",
        side: "buy" as const,
        trustedQuote: "990",
        vault,
      };
      const issue = issueGalileoPrepare({
        action: "trade",
        owner: account.address,
        trade: { ...unsignedTrade, payloadDigest: galileoTradePayloadDigest(account.address, unsignedTrade) },
      }, test.options);
      assert.ok(issue.trade);
      const message = buildGalileoConsentMessage({ action: "trade", agentRef: issue.agentRef, configDigest: issue.configDigest, expiresAt: issue.expiresAt, nonce: issue.nonce, owner: account.address, trade: issue.trade });
      for (const expected of ["Agent key:", "Adapter:", "Pool ID:", "Policy hash:", "Amount in:", "Trusted quote:", "Minimum out:", "Quote block:", "Native reserve:", "Token reserve:", "Request ID:", "Payload digest:"]) assert.match(message, new RegExp(expected, "u"));
      const wallet = { address: account.address, chainId: 16602, message, signature: await account.signMessage({ message }) };
      await verifyGalileoConsent({ action: "trade", nonce: issue.nonce, prepareId: issue.prepareId, wallet }, test.options);
      const first = claimTradeAndConsume({ nonce: issue.nonce, owner: account.address, prepareId: issue.prepareId }, test.options);
      assert.equal(first.replay, false);
      assert.equal(first.record.state, "claimed");
      const retry = claimTradeAndConsume({ nonce: issue.nonce, owner: account.address, prepareId: issue.prepareId }, test.options);
      assert.equal(retry.replay, true);
      assert.equal(retry.record.clientRequestId, unsignedTrade.clientRequestId);

      const changedUnsignedTrade = { ...unsignedTrade, amountIn: "1000000000000001" };
      const changed = issueGalileoPrepare({
        action: "trade",
        owner: account.address,
        trade: { ...changedUnsignedTrade, payloadDigest: galileoTradePayloadDigest(account.address, changedUnsignedTrade) },
      }, test.options);
      const changedMessage = buildGalileoConsentMessage({ action: "trade", agentRef: changed.agentRef, configDigest: changed.configDigest, expiresAt: changed.expiresAt, nonce: changed.nonce, owner: account.address, trade: changed.trade });
      const changedWallet = { address: account.address, chainId: 16602, message: changedMessage, signature: await account.signMessage({ message: changedMessage }) };
      await verifyGalileoConsent({ action: "trade", nonce: changed.nonce, prepareId: changed.prepareId, wallet: changedWallet }, test.options);
      assert.throws(() => claimTradeAndConsume({ nonce: changed.nonce, owner: account.address, prepareId: changed.prepareId }, test.options), /different Galileo trade data/u);
    } finally {
      test.cleanup();
    }
  });

  it("builds canonical redacted metadata without authorization material", () => {
    const metadata = buildGalileoAgentMetadata({
      agentKey: `0x${"3".repeat(64)}`,
      agentRef: "galileo-local-1",
      authorizationDigest: `0x${"4".repeat(64)}`,
      configurationDigest: `0x${"5".repeat(64)}`,
      createdAt: "2026-07-12T00:00:00.000Z",
      filters: ["proof-strict", "capital-guard"],
      name: "Galileo scout",
      owner: account.address,
      runtime: { maxPositions: 2, slippageBps: 50 },
      vault,
    });
    assert.equal(metadata.json, canonicalJson(metadata.value));
    assert.equal(new TextDecoder().decode(metadata.bytes), metadata.json);
    assert.doesNotMatch(metadata.json, /signature|nonce|private|secret|cookie/iu);
    assert.match(metadata.digest, /^0x[0-9a-f]{64}$/u);
  });

  it("only exposes a local agent record after verified Storage evidence", () => {
    const test = ledger();
    try {
      persistVerifiedGalileoAgent({
        agentKey: `0x${"3".repeat(64)}`,
        agentRef: "galileo-local-1",
        chainId: 16602,
        createdAt: "2026-07-12T00:00:00.000Z",
        owner: account.address,
        storageRef: "galileo://verified-reference",
        storageRoot: `0x${"4".repeat(64)}`,
        storageVerified: true,
        vault,
      }, test.options);
      assert.equal(listVerifiedGalileoAgents(account.address, test.options).length, 1);
    } finally {
      test.cleanup();
    }
  });

  it("rejects an absent or cross-network origin before any Galileo config resolution", () => {
    const request = new Request("http://localhost:3000/api/agents/galileo/consent", { headers: { origin: "http://localhost:3000" } });
    assert.doesNotThrow(() => assertGalileoRequestBoundary(request, { networkId: "testnet", chainId: 16602 }, { NEXT_PUBLIC_APP_URL: "http://localhost:3000" }));
    assert.throws(() => assertGalileoRequestBoundary(request, { networkId: "mainnet", chainId: 16602 }, {}), /networkId=testnet/u);
    assert.throws(() => assertGalileoRequestBoundary(new Request(request.url), { networkId: "testnet", chainId: 16602 }, { NEXT_PUBLIC_APP_URL: "http://localhost:3000" }), /configured app origin/u);
  });
});
