import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { keccak256, stringToHex, type Address } from "viem";

import { advanceGalileoTrade, claimGalileoTrade, listReconcilableGalileoTrades, patchGalileoTrade, readGalileoTrade, settleGalileoTrade } from "../lib/galileo/ledger";

// Covers the authoritative crash-recovery ledger writes that back reconcileGalileoTrade:
// a tx handle can be recorded without a state transition, a non-terminal record can be
// settled to a terminal state from any stage, and a terminal record is frozen.
describe("Galileo trade reconciliation ledger", () => {
  const owner = "0x1111111111111111111111111111111111111111" as Address;
  const withRoot = (run: (opts: { rootDir: string }) => void) => {
    const opts = { rootDir: mkdtempSync(join(tmpdir(), "galileo-reconcile-")) };
    try { run(opts); } finally { rmSync(opts.rootDir, { recursive: true, force: true }); }
  };
  const toTradeSubmitted = (opts: { rootDir: string }, req: string) => {
    claimGalileoTrade({ agentRef: "a", clientRequestId: req, owner, payloadDigest: keccak256(stringToHex(req)) }, opts);
    const action = keccak256(stringToHex(`action-${req}`));
    advanceGalileoTrade({ owner, agentRef: "a", clientRequestId: req, state: "storage_verified" }, opts);
    advanceGalileoTrade({ owner, agentRef: "a", clientRequestId: req, state: "proof_submitted", actionHash: action }, opts);
    advanceGalileoTrade({ owner, agentRef: "a", clientRequestId: req, state: "proof_accepted" }, opts);
    advanceGalileoTrade({ owner, agentRef: "a", clientRequestId: req, state: "trade_submitted" }, opts);
    return action;
  };

  it("records a tx handle without changing state (crash-safe outbox)", () => {
    withRoot((opts) => {
      toTradeSubmitted(opts, "r1");
      const txHash = keccak256(stringToHex("tradeTx"));
      patchGalileoTrade({ owner, agentRef: "a", clientRequestId: "r1", patch: { tradeTxHash: txHash } }, opts);
      const record = readGalileoTrade({ owner, agentRef: "a", clientRequestId: "r1" }, opts);
      assert.equal(record?.state, "trade_submitted");
      assert.equal(record?.tradeTxHash, txHash);
    });
  });

  it("settles a non-terminal record to confirmed and then freezes it", () => {
    withRoot((opts) => {
      toTradeSubmitted(opts, "r2");
      const confirmed = settleGalileoTrade({ owner, agentRef: "a", clientRequestId: "r2", state: "confirmed" }, opts);
      assert.equal(confirmed.state, "confirmed");
      // A terminal record can no longer be reconciled/settled.
      assert.throws(() => settleGalileoTrade({ owner, agentRef: "a", clientRequestId: "r2", state: "failed" }, opts), /cannot be reconciled/u);
      assert.equal(listReconcilableGalileoTrades(opts).find((r) => r.clientRequestId === "r2"), undefined);
    });
  });

  it("settles an earlier-stage record to failed and drops it from the recovery sweep", () => {
    withRoot((opts) => {
      claimGalileoTrade({ agentRef: "a", clientRequestId: "r3", owner, payloadDigest: keccak256(stringToHex("r3")) }, opts);
      advanceGalileoTrade({ owner, agentRef: "a", clientRequestId: "r3", state: "storage_verified" }, opts);
      assert.equal(listReconcilableGalileoTrades(opts).some((r) => r.clientRequestId === "r3"), true);
      const failed = settleGalileoTrade({ owner, agentRef: "a", clientRequestId: "r3", state: "failed" }, opts);
      assert.equal(failed.state, "failed");
      assert.equal(listReconcilableGalileoTrades(opts).some((r) => r.clientRequestId === "r3"), false);
    });
  });
});
