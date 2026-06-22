import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import { keccak256, stringToBytes, stringToHex, type Hex } from "viem";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
const ZERO_HASH = `0x${"00".repeat(32)}` as Hex;

describe("0G AgenticID", async function () {
  const { viem, networkHelpers } = await network.create();

  async function deployFixture() {
    const [owner, agentOwner, executor, receiver] = await viem.getWalletClients();
    const verifier = await viem.deployContract("MockAgentDataVerifier");
    const identity = await viem.deployContract("AgenticID", [
      owner.account.address,
      "4lpha 0G Agentic ID",
      "4OGAI",
      verifier.address,
    ]);
    return { owner, agentOwner, executor, receiver, verifier, identity };
  }

  function iData(label: string, value: string) {
    return {
      dataDescription: label,
      dataHash: keccak256(stringToBytes(value)),
    };
  }

  function proof(oldDataHash: Hex, newDataHash: Hex) {
    return {
      accessProof: {
        encryptedPubKey: stringToHex("receiver-key"),
        newDataHash,
        nonce: stringToHex(`access-${newDataHash.slice(2, 8)}`),
        oldDataHash,
        proof: stringToHex("access-proof"),
      },
      ownershipProof: {
        encryptedPubKey: stringToHex("receiver-key"),
        newDataHash,
        nonce: stringToHex(`owner-${newDataHash.slice(2, 8)}`),
        oldDataHash,
        oracleType: 0,
        proof: stringToHex("ownership-proof"),
        sealedKey: stringToHex("sealed-key"),
      },
    };
  }

  it("mints a single Agentic ID and authorizes the vault executor", async function () {
    const { agentOwner, executor, identity } = await networkHelpers.loadFixture(deployFixture);
    const data = [iData("0G Storage audit bundle", "audit-root"), iData("Policy snapshot", "policy")];

    await identity.write.mintAgent([
      agentOwner.account.address,
      data,
      "0g-storage:root:tx:0xabc",
      "agentic-id:4lpha-0g:single-mainnet-agent",
      "0x000000000000000000000000000000000000dEaD",
      executor.account.address,
    ]);

    assert.equal((await identity.read.ownerOf([1n])).toLowerCase(), agentOwner.account.address.toLowerCase());
    const record = await identity.read.agentRecord([1n]);
    assert.equal(record[1], "0x000000000000000000000000000000000000dEaD");
    assert.equal(record[2].toLowerCase(), executor.account.address.toLowerCase());

    const authorized = await identity.read.authorizedUsersOf([1n]);
    assert.deepEqual(
      authorized.map((value) => value.toLowerCase()),
      [executor.account.address.toLowerCase()],
    );

    const storedData = await identity.read.intelligentDataOf([1n]);
    assert.equal(storedData.length, 2);
    assert.equal(storedData[0].dataHash, data[0].dataHash);
  });

  it("allows only the owner or approved operator to manage usage and transfer", async function () {
    const { agentOwner, executor, identity, receiver } = await networkHelpers.loadFixture(deployFixture);
    const data = [iData("Agent metadata", "metadata-root")];
    await identity.write.mintAgent([
      agentOwner.account.address,
      data,
      "0g-storage:root:tx:0xabc",
      "agentic-id:test",
      "0x000000000000000000000000000000000000dEaD",
      executor.account.address,
    ]);

    await assert.rejects(
      identity.write.authorizeUsage([1n, receiver.account.address], { account: executor.account }),
    );

    await identity.write.authorizeUsage([1n, receiver.account.address], { account: agentOwner.account });
    let authorized = await identity.read.authorizedUsersOf([1n]);
    assert.deepEqual(
      authorized.map((value) => value.toLowerCase()),
      [executor.account.address.toLowerCase(), receiver.account.address.toLowerCase()],
    );

    await identity.write.revokeAuthorization([1n, receiver.account.address], { account: agentOwner.account });
    authorized = await identity.read.authorizedUsersOf([1n]);
    assert.deepEqual(
      authorized.map((value) => value.toLowerCase()),
      [executor.account.address.toLowerCase()],
    );

    const newHash = keccak256(stringToBytes("metadata-root-rekeyed"));
    await identity.write.iTransfer(
      [receiver.account.address, 1n, [proof(data[0].dataHash, newHash)]],
      { account: agentOwner.account },
    );

    assert.equal((await identity.read.ownerOf([1n])).toLowerCase(), receiver.account.address.toLowerCase());
    const storedData = await identity.read.intelligentDataOf([1n]);
    assert.equal(storedData[0].dataHash, newHash);
    authorized = await identity.read.authorizedUsersOf([1n]);
    assert.deepEqual(authorized, []);
  });

  it("rejects bad metadata, missing verifier proof path, and unknown tokens", async function () {
    const { agentOwner, executor, identity, receiver } = await networkHelpers.loadFixture(deployFixture);

    await assert.rejects(
      identity.write.mintAgent([
        agentOwner.account.address,
        [{ dataDescription: "bad", dataHash: ZERO_HASH }],
        "0g-storage:root",
        "agentic-id:test",
        "0x000000000000000000000000000000000000dEaD",
        executor.account.address,
      ]),
    );

    await assert.rejects(identity.read.ownerOf([999n]));

    await identity.write.setVerifier([ZERO_ADDRESS]);
    const data = [iData("Agent metadata", "metadata-root")];
    await identity.write.mintAgent([
      agentOwner.account.address,
      data,
      "0g-storage:root",
      "agentic-id:test",
      "0x000000000000000000000000000000000000dEaD",
      executor.account.address,
    ]);

    await assert.rejects(
      identity.write.iTransfer(
        [receiver.account.address, 1n, [proof(data[0].dataHash, keccak256(stringToBytes("next")))]],
        { account: agentOwner.account },
      ),
    );
  });
});
