import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import {
  encodeAbiParameters,
  getAddress,
  keccak256,
  parseEther,
  stringToHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
const POOL_ID = keccak256(stringToHex("4LPHA_0G_MOCK_POOL"));
const AUDIT_ROOT = keccak256(stringToHex("v2-audit-root"));
const MODEL_HASH = keccak256(stringToHex("v2-model-metadata"));
const ZERO_HASH = `0x${"00".repeat(32)}` as Hex;

type VaultLike = {
  address: Address;
  abi: Abi;
};

describe("0G PolicyVaultV2", async function () {
  const { viem, networkHelpers } = await network.create();
  const publicClient = await viem.getPublicClient();
  let nonceCounter = 1n;
  const UNBOUNDED_POLICY_LIMIT = (1n << 256n) - 1n;

  const basePolicy = {
    perTradeCap0G: UNBOUNDED_POLICY_LIMIT,
    dailyCap0G: UNBOUNDED_POLICY_LIMIT,
    maxExposure0G: UNBOUNDED_POLICY_LIMIT,
    cooldownSeconds: 0n,
    maxDeadlineWindowSeconds: 3600n,
    defaultMinOutBps: 5000,
  };

  async function deployFixture() {
    const [owner, executor, other, identity] = await viem.getWalletClients();
    const registry = await viem.deployContract("ProofRegistry", [owner.account.address]);
    const token = await viem.deployContract("MockAssetToken", [owner.account.address]);
    const adapter = await viem.deployContract("MockDexAdapter", [
      owner.account.address,
      token.address,
      parseEther("2"),
      parseEther("0.5"),
    ]);
    await token.write.setMinter([adapter.address]);

    const vault = await viem.deployContract("PolicyVaultV2", [
      owner.account.address,
      executor.account.address,
      adapter.address,
      registry.address,
      basePolicy,
      [token.address],
      [POOL_ID],
      true,
    ]);
    await owner.sendTransaction({ to: adapter.address, value: parseEther("2") });

    const agentA = agentKey(identity.account.address, 1n);
    const agentB = agentKey(identity.account.address, 2n);

    return { owner, executor, other, identity, registry, token, adapter, vault, agentA, agentB };
  }

  async function latestDeadline() {
    const latest = await networkHelpers.time.latest();
    return BigInt(latest + 600);
  }

  async function acceptProof(registry: { write: { acceptProof: (args: readonly [Hex, Hex, Hex, Hex, string, Hex, string]) => Promise<Hex> } }, request: { actionHash: Hex; policySnapshotHash: Hex; vaultActionHash: Hex }) {
    await registry.write.acceptProof([
      request.actionHash,
      AUDIT_ROOT,
      request.policySnapshotHash,
      MODEL_HASH,
      `0g-storage://${request.actionHash.slice(2, 18)}`,
      request.vaultActionHash,
      "agent-proof-registry:v2-test",
    ]);
  }

  async function buyRequest(
    vault: VaultLike,
    token: Address,
    agentKey_: Hex,
    amountIn = parseEther("0.1"),
    nonce = nonceCounter++,
  ) {
    const policySnapshotHash = await publicClient.readContract({
      address: vault.address,
      abi: vault.abi,
      functionName: "policyHash",
    }) as Hex;
    const quotedAmountOut = amountIn * 2n;
    const draft = {
      tokenIn: ZERO_ADDRESS,
      tokenOut: getAddress(token),
      amountIn,
      quotedAmountOut,
      amountOutMin: quotedAmountOut / 2n,
      deadline: await latestDeadline(),
      nonce,
      agentKey: agentKey_,
      poolId: POOL_ID,
      vaultActionHash: ZERO_HASH,
      actionHash: ZERO_HASH,
      policySnapshotHash,
      auditRoot: AUDIT_ROOT,
    };
    const vaultActionHash = await publicClient.readContract({
      address: vault.address,
      abi: vault.abi,
      functionName: "vaultActionHashFor",
      args: [true, draft],
    }) as Hex;
    const actionHash = await publicClient.readContract({
      address: vault.address,
      abi: vault.abi,
      functionName: "actionHashFor",
      args: [vaultActionHash, AUDIT_ROOT, policySnapshotHash],
    }) as Hex;
    return { ...draft, vaultActionHash, actionHash };
  }

  async function sellRequest(vault: VaultLike, token: Address, agentKey_: Hex, amountIn: bigint, nonce = nonceCounter++) {
    const policySnapshotHash = await publicClient.readContract({
      address: vault.address,
      abi: vault.abi,
      functionName: "policyHash",
    }) as Hex;
    const quotedAmountOut = amountIn / 2n;
    const draft = {
      tokenIn: getAddress(token),
      tokenOut: ZERO_ADDRESS,
      amountIn,
      quotedAmountOut,
      amountOutMin: quotedAmountOut / 2n,
      deadline: await latestDeadline(),
      nonce,
      agentKey: agentKey_,
      poolId: POOL_ID,
      vaultActionHash: ZERO_HASH,
      actionHash: ZERO_HASH,
      policySnapshotHash,
      auditRoot: AUDIT_ROOT,
    };
    const vaultActionHash = await publicClient.readContract({
      address: vault.address,
      abi: vault.abi,
      functionName: "vaultActionHashFor",
      args: [false, draft],
    }) as Hex;
    const actionHash = await publicClient.readContract({
      address: vault.address,
      abi: vault.abi,
      functionName: "actionHashFor",
      args: [vaultActionHash, AUDIT_ROOT, policySnapshotHash],
    }) as Hex;
    return { ...draft, vaultActionHash, actionHash };
  }

  it("keeps positions isolated by agent key inside one vault", async function () {
    const { owner, executor, registry, token, vault, agentA, agentB } = await networkHelpers.loadFixture(deployFixture);

    await vault.write.setAgentKeysEnabled([[agentA, agentB], true], { account: owner.account });
    await vault.write.depositNative({ account: owner.account, value: parseEther("1") });

    const buyA = await buyRequest(vault, token.address, agentA, parseEther("0.1"));
    await acceptProof(registry, buyA);
    await vault.write.buy([buyA], { account: executor.account });

    const buyB = await buyRequest(vault, token.address, agentB, parseEther("0.05"));
    await acceptProof(registry, buyB);
    await vault.write.buy([buyB], { account: executor.account });

    assert.equal(await vault.read.positionUnits([token.address]), parseEther("0.3"));
    assert.equal(await vault.read.agentPositionUnits([agentA, token.address]), parseEther("0.2"));
    assert.equal(await vault.read.agentPositionUnits([agentB, token.address]), parseEther("0.1"));
    assert.equal(await vault.read.agentOpenPositionCount([agentA]), 1n);
    assert.equal(await vault.read.agentOpenPositionCount([agentB]), 1n);

    const tooMuchForB = await sellRequest(vault, token.address, agentB, parseEther("0.2"));
    await acceptProof(registry, tooMuchForB);
    await assert.rejects(vault.write.sell([tooMuchForB], { account: executor.account }));

    const sellB = await sellRequest(vault, token.address, agentB, parseEther("0.1"));
    await acceptProof(registry, sellB);
    await vault.write.sell([sellB], { account: executor.account });

    assert.equal(await vault.read.positionUnits([token.address]), parseEther("0.2"));
    assert.equal(await vault.read.agentPositionUnits([agentA, token.address]), parseEther("0.2"));
    assert.equal(await vault.read.agentPositionUnits([agentB, token.address]), 0n);
    assert.equal(await vault.read.agentOpenPositionCount([agentB]), 0n);
  });

  it("blocks trading while an agent key is disabled", async function () {
    const { owner, executor, registry, token, vault, agentA } = await networkHelpers.loadFixture(deployFixture);

    const blockedBuy = await buyRequest(vault, token.address, agentA, parseEther("0.1"));
    await acceptProof(registry, blockedBuy);
    await assert.rejects(vault.write.buy([blockedBuy], { account: executor.account }));

    await vault.write.setAgentKeyEnabled([agentA, true], { account: owner.account });
    await vault.write.depositNative({ account: owner.account, value: parseEther("1") });
    const buy = await buyRequest(vault, token.address, agentA, parseEther("0.1"));
    await acceptProof(registry, buy);
    await vault.write.buy([buy], { account: executor.account });

    await vault.write.setAgentKeyEnabled([agentA, false], { account: owner.account });
    const blockedSell = await sellRequest(vault, token.address, agentA, parseEther("0.2"));
    await acceptProof(registry, blockedSell);
    await assert.rejects(vault.write.sell([blockedSell], { account: executor.account }));
  });

  it("binds proofs to the agent key", async function () {
    const { token, vault, agentA, agentB } = await networkHelpers.loadFixture(deployFixture);
    const nonce = 42n;
    const first = await buyRequest(vault, token.address, agentA, parseEther("0.1"), nonce);
    const second = await buyRequest(vault, token.address, agentB, parseEther("0.1"), nonce);

    assert.notEqual(first.vaultActionHash, second.vaultActionHash);
    assert.notEqual(first.actionHash, second.actionHash);
  });

  it("keeps FactoryV2 owner-bound and one V2 vault per owner", async function () {
    const { owner, executor, other, registry, adapter, token } = await networkHelpers.loadFixture(deployFixture);
    const factory = await viem.deployContract("PolicyVaultFactoryV2");

    assert.equal(await factory.read.VERSION(), 2n);
    await assert.rejects(
      factory.write.createVault(
        [
          owner.account.address,
          executor.account.address,
          adapter.address,
          registry.address,
          basePolicy,
          [token.address],
          [POOL_ID],
          true,
        ],
        { account: other.account },
      ),
    );

    await factory.write.createVault([
      owner.account.address,
      executor.account.address,
      adapter.address,
      registry.address,
      basePolicy,
      [token.address],
      [POOL_ID],
      true,
    ]);

    const ownerVault = await factory.read.vaultOf([owner.account.address]);
    assert.notEqual(ownerVault, ZERO_ADDRESS);
    await assert.rejects(
      factory.write.createVault([
        owner.account.address,
        executor.account.address,
        adapter.address,
        registry.address,
        basePolicy,
        [token.address],
        [POOL_ID],
        true,
      ]),
    );
  });
});

function agentKey(identityAddress: Address, tokenId: bigint): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { name: "identityAddress", type: "address" },
        { name: "tokenId", type: "uint256" },
      ],
      [identityAddress, tokenId],
    ),
  );
}
