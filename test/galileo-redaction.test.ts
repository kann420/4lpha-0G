import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { keccak256, stringToHex, type Address, type Hex } from "viem";

import { buildTradeAudit } from "../lib/galileo/executor";
import type { GalileoPreparedTrade } from "../lib/galileo/ledger";

// The audit bundle uploaded to 0G Storage must be an allowlist-only DTO: no wallet
// signature, authorization nonce, cookie, private key, raw prompt, or mainnet identifier
// may ever survive into the stored bytes, regardless of what the input object carries.
describe("Galileo trade audit redaction", () => {
  const SIG = `0xdeadbeef${"11".repeat(64)}`;
  const AUTH_NONCE = "authorization-nonce-supersecret";
  const COOKIE = "session=topsecretcookievalue";
  const PK = `0x${"ab".repeat(32)}`;
  const MAINNET = "0xMAINNET_ONLY_SECRET_MARKER";
  const RAW_PROMPT = "system: you are a secret prompt";

  const base: GalileoPreparedTrade = {
    adapter: "0x1111111111111111111111111111111111111111",
    agentKey: keccak256(stringToHex("agent")),
    agentRef: "galileo-redaction",
    amountIn: "1000000000000000",
    chainId: 16602,
    clientRequestId: "req-redaction",
    minOut: "990000",
    networkId: "testnet",
    payloadDigest: keccak256(stringToHex("digest")),
    poolId: keccak256(stringToHex("4LPHA_GALILEO_0G_MUSDC_V1")),
    policyHash: keccak256(stringToHex("policy")),
    quoteBlock: "42",
    quoteExpiry: 1_234_567_890,
    reserveNative: "1000000000000000000",
    reserveToken: "1000000000",
    side: "buy",
    trustedQuote: "996006",
    vault: "0x2222222222222222222222222222222222222222",
  };
  const modelHash = keccak256(stringToHex("model")) as Hex;

  it("emits only allowlisted keys and drops injected secret fields byte-for-byte", () => {
    // Inject secret-looking fields that must never survive the allowlist DTO.
    const poisoned = { ...base, signature: SIG, authorizationNonce: AUTH_NONCE, cookie: COOKIE, privateKey: PK, mainnetAddress: MAINNET, rawPrompt: RAW_PROMPT } as unknown as GalileoPreparedTrade;
    const { bytes, value } = buildTradeAudit(poisoned, 1_234_567_000, base.vault as Address, modelHash, { amountOutMin: 990_000n, vaultMinOut: 986_045n });
    const text = new TextDecoder().decode(bytes);

    assert.deepEqual(Object.keys(value).sort(), ["chainId", "executor", "modelMetadataHash", "networkId", "quote", "request", "schemaVersion", "verification"]);
    assert.deepEqual(Object.keys((value as Record<string, Record<string, unknown>>).request).sort(), ["adapter", "agentKey", "agentRef", "amountIn", "clientRequestId", "deadline", "minOut", "policyHash", "poolId", "side", "trustedQuote", "vault"]);

    for (const secret of [SIG, AUTH_NONCE, COOKIE, PK, MAINNET, RAW_PROMPT]) assert.ok(!text.includes(secret), `leaked secret value: ${secret}`);
    for (const key of ["signature", "authorization", "cookie", "privateKey", "mainnet", "prompt"]) assert.ok(!new RegExp(key, "iu").test(text), `forbidden key present: ${key}`);
    // The bundle carries no authorization nonce field at all (only allowlisted values).
    assert.ok(!/"nonce"/iu.test(text), "unexpected nonce field");
  });
});
