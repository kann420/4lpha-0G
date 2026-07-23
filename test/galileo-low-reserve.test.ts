import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseEther } from "viem";

import { crossesBuyReserveFloor } from "../lib/galileo/executor";

// The 0.25 0G / 250 mUSDC operational floor blocks a BUY that would drain the sandbox pool
// too far; a SELL is never subject to it (previewGalileoTrade only calls this for buys).
describe("Galileo buy-only reserve floor", () => {
  const M = 1_000_000n; // 1 mUSDC (6 decimals)

  it("allows a buy that keeps both reserves above the floor", () => {
    assert.equal(crossesBuyReserveFloor(parseEther("1"), parseEther("0.001"), 1000n * M, 10n * M), false);
  });

  it("blocks a buy that would push the token reserve below 250 mUSDC", () => {
    // tokenReserve 255 mUSDC, quote 10 mUSDC out -> 245 mUSDC < 250 floor.
    assert.equal(crossesBuyReserveFloor(parseEther("1"), parseEther("0.01"), 255n * M, 10n * M), true);
  });

  it("blocks a buy while the native reserve is under 0.25 0G", () => {
    assert.equal(crossesBuyReserveFloor(parseEther("0.2"), parseEther("0.01"), 1000n * M, 10n * M), true);
  });

  it("treats exactly the floor as acceptable (strict less-than boundary)", () => {
    // tokenReserve - quote == 250 mUSDC exactly, native + in == 0.25 0G exactly.
    assert.equal(crossesBuyReserveFloor(parseEther("0.24"), parseEther("0.01"), 260n * M, 10n * M), false);
  });
});
