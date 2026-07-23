import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Address } from "viem";

import { recordGalileoRateHit } from "../lib/galileo/ledger";

// The relay budget must be durable (survives a process boundary) — each call re-reads and
// re-writes the shared file, so N sequential calls model N separate worker instances.
describe("Galileo durable rate limiter", () => {
  const owner = "0x1111111111111111111111111111111111111111" as Address;
  const ip = "203.0.113.7";
  const withRoot = (run: (opts: { rootDir: string }) => void) => {
    const opts = { rootDir: mkdtempSync(join(tmpdir(), "galileo-rate-")) };
    try { run(opts); } finally { rmSync(opts.rootDir, { recursive: true, force: true }); }
  };

  it("allows 5 wallet hits per minute and rejects the 6th, persisting across reads", () => {
    withRoot((opts) => {
      const now = 1_000_000;
      for (let i = 0; i < 5; i++) assert.equal(recordGalileoRateHit({ owner, ip, now, walletMax: 5 }, opts).allowed, true, `hit ${i}`);
      const sixth = recordGalileoRateHit({ owner, ip, now, walletMax: 5 }, opts);
      assert.equal(sixth.allowed, false);
      assert.equal(sixth.reason, "wallet");
    });
  });

  it("prunes the window so hits older than a minute no longer count", () => {
    withRoot((opts) => {
      for (let i = 0; i < 5; i++) recordGalileoRateHit({ owner, ip, now: 1_000_000, walletMax: 5 }, opts);
      // 61s later the earlier window has expired.
      assert.equal(recordGalileoRateHit({ owner, ip, now: 1_061_001, walletMax: 5 }, opts).allowed, true);
    });
  });

  it("isolates the budget per wallet", () => {
    withRoot((opts) => {
      const other = "0x2222222222222222222222222222222222222222" as Address;
      for (let i = 0; i < 5; i++) recordGalileoRateHit({ owner, ip: "198.51.100.1", now: 1_000_000, walletMax: 5, ipMax: 999 }, opts);
      assert.equal(recordGalileoRateHit({ owner: other, ip: "198.51.100.2", now: 1_000_000, walletMax: 5, ipMax: 999 }, opts).allowed, true);
    });
  });
});
