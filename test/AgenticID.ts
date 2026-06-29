import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { artifacts, network } from "hardhat";
import { keccak256, slice, stringToBytes, stringToHex, type Hex } from "viem";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
const ZERO_HASH = `0x${"00".repeat(32)}` as Hex;
const ERC165_INTERFACE_ID = "0x01ffc9a7" as Hex;
const INVALID_INTERFACE_ID = "0xffffffff" as Hex;

function selector(signature: string): Hex {
  return slice(keccak256(stringToBytes(signature)), 0, 4);
}

function xorBytes4(values: Hex[]): Hex {
  const result = values.reduce((acc, value) => acc ^ BigInt(value), 0n);
  return `0x${result.toString(16).padStart(8, "0")}` as Hex;
}

// Expand an ABI input type to its canonical signature form. Structs become
// expanded tuples (matching how solc computes function selectors); enums appear
// as uint8 in the compiled ABI. This keeps the interfaceId computation in sync
// with the contract's `type(I).interfaceId` without hand-maintaining signatures.
interface AbiInput {
  type: string;
  name: string;
  internalType?: string;
  components?: AbiInput[];
}
function canonicalType(input: AbiInput): string {
  if (input.components && (input.type === "tuple" || input.type === "tuple[]")) {
    const inner = input.components.map(canonicalType).join(",");
    const suffix = input.type.endsWith("[]") ? "[]" : "";
    return `(${inner})${suffix}`;
  }
  return input.type;
}
function functionSignature(fn: { name: string; inputs: AbiInput[] }): string {
  return `${fn.name}(${fn.inputs.map(canonicalType).join(",")})`;
}
async function interfaceIdOf(contractName: string): Promise<Hex> {
  const { abi } = await artifacts.readArtifact(contractName);
  const selectors = abi
    .filter((item) => item.type === "function")
    .map((fn) => selector(functionSignature(fn as unknown as { name: string; inputs: AbiInput[] })));
  return xorBytes4(selectors);
}

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

  it("clones an Agentic ID to a new owner with a fresh data hash", async function () {
    const { agentOwner, executor, receiver, identity } = await networkHelpers.loadFixture(deployFixture);
    const data = [iData("Agent metadata", "metadata-root")];
    await identity.write.mintAgent([
      agentOwner.account.address,
      data,
      "0g-storage:root:tx:0xabc",
      "agentic-id:clone-test",
      "0x000000000000000000000000000000000000dEaD",
      executor.account.address,
    ]);

    const newHash = keccak256(stringToBytes("metadata-root-cloned"));
    await identity.write.iClone(
      [receiver.account.address, 1n, [proof(data[0].dataHash, newHash)]],
      { account: agentOwner.account },
    );

    assert.equal((await identity.read.ownerOf([2n])).toLowerCase(), receiver.account.address.toLowerCase());
    const clonedData = await identity.read.intelligentDataOf([2n]);
    assert.equal(clonedData[0].dataHash, newHash);
    assert.equal(await identity.read.balanceOf([receiver.account.address]), 1n);
    // The original token is preserved by iClone.
    assert.equal((await identity.read.ownerOf([1n])).toLowerCase(), agentOwner.account.address.toLowerCase());
  });

  it("delegates access to a hot-wallet assistant", async function () {
    const { agentOwner, receiver, identity } = await networkHelpers.loadFixture(deployFixture);
    await identity.write.delegateAccess([receiver.account.address], { account: agentOwner.account });
    assert.equal(
      (await identity.read.getDelegateAccess([agentOwner.account.address])).toLowerCase(),
      receiver.account.address.toLowerCase(),
    );
  });

  it("manages per-token approvals and operator approvals", async function () {
    const { agentOwner, receiver, identity } = await networkHelpers.loadFixture(deployFixture);
    const data = [iData("Agent metadata", "metadata-root")];
    await identity.write.mintAgent([
      agentOwner.account.address,
      data,
      "0g-storage:root:tx:0xabc",
      "agentic-id:approval-test",
      "0x000000000000000000000000000000000000dEaD",
      agentOwner.account.address,
    ]);

    await identity.write.approve([receiver.account.address, 1n], { account: agentOwner.account });
    assert.equal(
      (await identity.read.getApproved([1n])).toLowerCase(),
      receiver.account.address.toLowerCase(),
    );

    await identity.write.setApprovalForAll([receiver.account.address, true], { account: agentOwner.account });
    assert.equal(await identity.read.isApprovedForAll([agentOwner.account.address, receiver.account.address]), true);
  });

  it("reports ERC-165 support for the canonical ERC-7857 interfaces only", async function () {
    const { identity } = await networkHelpers.loadFixture(deployFixture);
    const ierc7857Id = await interfaceIdOf("IERC7857");
    const metadataId = await interfaceIdOf("IERC7857Metadata");
    const verifierId = await interfaceIdOf("IERC7857DataVerifier");
    assert.equal(await identity.read.supportsInterface([ERC165_INTERFACE_ID]), true);
    assert.equal(await identity.read.supportsInterface([ierc7857Id]), true);
    assert.equal(await identity.read.supportsInterface([metadataId]), true);
    // AgenticID is not a verifier; it must not claim IERC7857DataVerifier support.
    assert.equal(await identity.read.supportsInterface([verifierId]), false);
    assert.equal(await identity.read.supportsInterface([INVALID_INTERFACE_ID]), false);
  });
});
