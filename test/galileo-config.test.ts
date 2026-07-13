import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GALILEO_CHAIN_ID, assertGalileoRoute, resolveGalileoReadConfig, resolveGalileoWriteConfig } from "../lib/galileo/config";
import { resolveGalileoTradeRouteBoundary } from "../lib/galileo/route-boundary";

const address = (digit: string) => `0x${digit.repeat(40)}`;
const key = (digit: string) => `0x${digit.repeat(64)}`;

function galileoEnv(): Record<string, string> {
  return {
    OG_NETWORK: "testnet",
    OG_CHAIN_ID: "16602",
    OG_GALILEO_RPC_URL: "https://galileo.example/rpc",
    OG_GALILEO_STORAGE_RPC_URL: "https://galileo.example/storage-rpc",
    OG_GALILEO_STORAGE_INDEXER_URL: "https://galileo.example/indexer",
    ENABLE_GALILEO_DEPLOY: "false",
    ENABLE_GALILEO_TRADE: "false",
    GALILEO_DEPLOYER_PRIVATE_KEY: key("1"),
    GALILEO_PROOF_ATTESTOR_PRIVATE_KEY: key("2"),
    GALILEO_VAULT_ATTESTOR_PRIVATE_KEY: key("3"),
    GALILEO_VAULT_EXECUTOR_PRIVATE_KEY: key("4"),
    PROOF_REGISTRY_GALILEO_ADDRESS: address("1"),
    NEXT_PUBLIC_VAULT_REGISTRY_V4_GALILEO_ADDRESS: address("2"),
    NEXT_PUBLIC_GALILEO_SANDBOX_TOKEN_ADDRESS: address("3"),
    NEXT_PUBLIC_GALILEO_SANDBOX_POOL_ADDRESS: address("4"),
    NEXT_PUBLIC_GALILEO_SANDBOX_ADAPTER_ADDRESS: address("5"),
  };
}

describe("Galileo server configuration isolation", () => {
  it("uses only explicit Galileo settings, never generic or mainnet fallback values", () => {
    const config = resolveGalileoReadConfig({
      ...galileoEnv(),
      OG_RPC_URL: "https://mainnet.example/rpc",
      DEPLOYER_PRIVATE_KEY: key("a"),
      OG_MAINNET_RPC_URL: "https://mainnet.example/dedicated-rpc",
    });
    assert.equal(config.chainId, GALILEO_CHAIN_ID);
    assert.equal(config.rpcUrl, "https://galileo.example/rpc");
  });

  it("fails closed without the Galileo RPC even when a generic RPC is present", () => {
    const env = galileoEnv();
    delete env.OG_GALILEO_RPC_URL;
    env.OG_RPC_URL = "https://generic.example/rpc";
    assert.throws(() => resolveGalileoReadConfig(env), /OG_GALILEO_RPC_URL/);
  });

  it("requires exactly the Galileo route tuple before configuration can be resolved", () => {
    assert.doesNotThrow(() => assertGalileoRoute("testnet", 16602));
    assert.throws(() => assertGalileoRoute("testnet", 16661), /networkId=testnet/);
    assert.throws(() => assertGalileoRoute("mainnet", 16602), /networkId=testnet/);
    assert.throws(() => assertGalileoRoute(undefined, undefined), /networkId=testnet/);
  });

  it("rejects a cross-network route before it attempts Galileo configuration", () => {
    const result = resolveGalileoTradeRouteBoundary(
      { networkId: "testnet", chainId: 16661 },
      {},
    );
    assert.deepEqual(result, {
      ok: false,
      mode: "unavailable",
      status: 400,
      code: "invalid_galileo_network",
      message: "Galileo trades require networkId=testnet and chainId=16602.",
    });
  });

  it("returns safe preview-only/unavailable states without exposing deployment configuration", () => {
    const disabled = resolveGalileoTradeRouteBoundary({ networkId: "testnet", chainId: 16602 }, galileoEnv());
    assert.equal(disabled.ok, false);
    if (!disabled.ok) {
      assert.equal(disabled.mode, "preview_only");
      assert.equal(disabled.code, "galileo_trade_disabled");
    }

    const unavailable = resolveGalileoTradeRouteBoundary({ networkId: "testnet", chainId: 16602 }, {});
    assert.equal(unavailable.ok, false);
    if (!unavailable.ok) {
      assert.equal(unavailable.mode, "unavailable");
      assert.equal(unavailable.code, "galileo_trade_unavailable");
    }
  });

  it("requires role separation and explicit feature gates for writes", () => {
    const env = galileoEnv();
    const config = resolveGalileoWriteConfig(env);
    assert.equal(config.tradeEnabled, false);
    assert.equal(config.deployEnabled, false);

    env.GALILEO_VAULT_EXECUTOR_PRIVATE_KEY = env.GALILEO_DEPLOYER_PRIVATE_KEY;
    assert.throws(() => resolveGalileoWriteConfig(env), /must be distinct/);

    const missingGate = galileoEnv();
    delete missingGate.ENABLE_GALILEO_TRADE;
    assert.throws(() => resolveGalileoWriteConfig(missingGate), /ENABLE_GALILEO_TRADE/);
  });
});
