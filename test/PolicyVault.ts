import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";
import {
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
const ROUTE_USDC = keccak256(stringToHex("4LPHA_0G_ROUTE_W0G_USDC"));
const ROUTE_LINK = keccak256(stringToHex("4LPHA_0G_ROUTE_W0G_USDC_LINK"));
const ROUTE_BLOCKED = keccak256(stringToHex("4LPHA_0G_ROUTE_BLOCKED"));
const AUDIT_ROOT = keccak256(stringToHex("audit-root"));
const MODEL_HASH = keccak256(stringToHex("model-metadata"));
const ZERO_HASH = `0x${"00".repeat(32)}` as Hex;

type VaultLike = {
  address: Address;
  abi: Abi;
};

describe("0G PolicyVault", async function () {
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
    const [owner, executor, other] = await viem.getWalletClients();
    const registry = await viem.deployContract("ProofRegistry", [owner.account.address]);
    const token = await viem.deployContract("MockAssetToken", [owner.account.address]);
    const adapter = await viem.deployContract("MockDexAdapter", [
      owner.account.address,
      token.address,
      parseEther("2"),
      parseEther("0.5"),
    ]);
    await token.write.setMinter([adapter.address]);

    const vault = await viem.deployContract("PolicyVault", [
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

    return { owner, executor, other, registry, token, adapter, vault };
  }

  async function latestDeadline() {
    const latest = await networkHelpers.time.latest();
    return BigInt(latest + 600);
  }

  type ProofRegistryLike = {
    write: {
      acceptProof: (args: readonly [Hex, Hex, Hex, Hex, string, Hex, string]) => Promise<Hex>;
    };
  };

  async function acceptProof(registry: ProofRegistryLike, request: { actionHash: Hex; policySnapshotHash: Hex; vaultActionHash: Hex }) {
    await registry.write.acceptProof([
      request.actionHash,
      AUDIT_ROOT,
      request.policySnapshotHash,
      MODEL_HASH,
      `0g-storage://${request.actionHash.slice(2, 18)}`,
      request.vaultActionHash,
      "agent-proof-registry:test",
    ]);
  }

  async function buyRequest(
    vault: VaultLike,
    token: Address,
    amountIn = parseEther("0.1"),
    amountOutMin = amountIn,
    poolId = POOL_ID,
    quotedAmountOut = amountIn,
  ) {
    const policySnapshotHash = await publicClient.readContract({
      address: vault.address,
      abi: vault.abi,
      functionName: "policyHash",
    }) as Hex;
    const draft = {
      tokenIn: ZERO_ADDRESS,
      tokenOut: getAddress(token),
      amountIn,
      quotedAmountOut,
      amountOutMin,
      deadline: await latestDeadline(),
      nonce: nonceCounter++,
      poolId,
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

  async function sellRequest(vault: VaultLike, token: Address, amountIn = parseEther("0.2")) {
    const policySnapshotHash = await publicClient.readContract({
      address: vault.address,
      abi: vault.abi,
      functionName: "policyHash",
    }) as Hex;
    const draft = {
      tokenIn: getAddress(token),
      tokenOut: ZERO_ADDRESS,
      amountIn,
      quotedAmountOut: parseEther("0.1"),
      amountOutMin: parseEther("0.1"),
      deadline: await latestDeadline(),
      poolId: POOL_ID,
      nonce: nonceCounter++,
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

  async function sellRequestForPool(vault: VaultLike, token: Address, poolId: Hex, amountIn = parseEther("0.2")) {
    const base = await sellRequest(vault, token, amountIn);
    const draft = {
      ...base,
      poolId,
      vaultActionHash: ZERO_HASH,
      actionHash: ZERO_HASH,
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
      args: [vaultActionHash, AUDIT_ROOT, base.policySnapshotHash],
    }) as Hex;
    return { ...draft, vaultActionHash, actionHash };
  }

  function poolIdFromAddress(address: Address): Hex {
    return `0x${address.slice(2).padStart(64, "0")}` as Hex;
  }

  async function readVaultUint(vault: VaultLike, functionName: "dailySpent0G" | "openExposure0G") {
    return await publicClient.readContract({
      address: vault.address,
      abi: vault.abi,
      functionName,
    }) as bigint;
  }

  it("allows owner native deposit and owner-only withdrawal", async function () {
    const { owner, executor, vault } = await networkHelpers.loadFixture(deployFixture);

    await vault.write.depositNative({ value: parseEther("1") });
    assert.equal(await publicClient.getBalance({ address: vault.address }), parseEther("1"));

    await assert.rejects(vault.write.withdrawNative([parseEther("0.1")], { account: executor.account }));

    await vault.write.withdrawNative([parseEther("0.25")]);
    assert.equal(await publicClient.getBalance({ address: vault.address }), parseEther("0.75"));

    await vault.write.setPaused([true]);
    await vault.write.withdrawNative([parseEther("0.25")], { account: owner.account });
    assert.equal(await publicClient.getBalance({ address: vault.address }), parseEther("0.5"));
  });

  it("keeps factory vault creation owner-bound and one vault per owner", async function () {
    const { owner, executor, other, registry, adapter, token } = await networkHelpers.loadFixture(deployFixture);
    const factory = await viem.deployContract("PolicyVaultFactory");

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

    await factory.write.createVault(
      [
        other.account.address,
        executor.account.address,
        adapter.address,
        registry.address,
        basePolicy,
        [token.address],
        [POOL_ID],
        true,
      ],
      { account: other.account },
    );
    const otherVault = await factory.read.vaultOf([other.account.address]);
    assert.notEqual(otherVault, ZERO_ADDRESS);
    assert.notEqual(otherVault.toLowerCase(), ownerVault.toLowerCase());
  });

  it("creates factory vaults with unbounded user-selected limits and only allows later tightening", async function () {
    const { owner, executor, registry, adapter, token } = await networkHelpers.loadFixture(deployFixture);
    const factory = await viem.deployContract("PolicyVaultFactory");

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
    const createdVault = await viem.getContractAt("PolicyVault", ownerVault);
    const createdPolicy = await createdVault.read.policy();

    assert.equal(createdPolicy[0], UNBOUNDED_POLICY_LIMIT);
    assert.equal(createdPolicy[1], UNBOUNDED_POLICY_LIMIT);
    assert.equal(createdPolicy[2], UNBOUNDED_POLICY_LIMIT);
    assert.equal(createdPolicy[3], 0n);

    const tightenedPolicy = {
      ...basePolicy,
      perTradeCap0G: parseEther("1000"),
      dailyCap0G: parseEther("2000"),
      maxExposure0G: parseEther("3000"),
      cooldownSeconds: 60n,
      maxDeadlineWindowSeconds: 1800n,
      defaultMinOutBps: 6000,
    };
    await createdVault.write.tightenPolicy([tightenedPolicy]);
    const policyAfterTighten = await createdVault.read.policy();

    assert.equal(policyAfterTighten[0], tightenedPolicy.perTradeCap0G);
    assert.equal(policyAfterTighten[1], tightenedPolicy.dailyCap0G);
    assert.equal(policyAfterTighten[2], tightenedPolicy.maxExposure0G);
    assert.equal(policyAfterTighten[3], tightenedPolicy.cooldownSeconds);
    assert.equal(policyAfterTighten[4], tightenedPolicy.maxDeadlineWindowSeconds);
    assert.equal(policyAfterTighten[5], tightenedPolicy.defaultMinOutBps);

    await assert.rejects(
      createdVault.write.tightenPolicy([
        {
          ...tightenedPolicy,
          perTradeCap0G: tightenedPolicy.perTradeCap0G + 1n,
          dailyCap0G: tightenedPolicy.dailyCap0G + 1n,
          maxExposure0G: tightenedPolicy.maxExposure0G + 1n,
          cooldownSeconds: 0n,
          maxDeadlineWindowSeconds: tightenedPolicy.maxDeadlineWindowSeconds + 1n,
          defaultMinOutBps: tightenedPolicy.defaultMinOutBps - 1,
        },
      ]),
    );
  });

  it("requires accepted proof and rejects replayed action hashes", async function () {
    const { executor, registry, token, vault } = await networkHelpers.loadFixture(deployFixture);
    await vault.write.depositNative({ value: parseEther("1") });

    const request = await buyRequest(vault, token.address);

    await assert.rejects(vault.write.buy([request], { account: executor.account }));

    await acceptProof(registry, request);
    await vault.write.buy([request], { account: executor.account });

    await assert.rejects(vault.write.buy([request], { account: executor.account }));
  });

  it("rejects zero min-out and owner-approved price floor violations", async function () {
    const { executor, registry, token, vault } = await networkHelpers.loadFixture(deployFixture);
    await vault.write.depositNative({ value: parseEther("1") });

    const zeroMinRequest = await buyRequest(vault, token.address);
    await acceptProof(registry, zeroMinRequest);
    await assert.rejects(
      vault.write.buy([
        {
          ...zeroMinRequest,
          amountOutMin: 0n,
        },
      ], { account: executor.account }),
    );

    const lowFloorRequest = await buyRequest(vault, token.address, parseEther("0.1"), parseEther("0.049"));
    await acceptProof(registry, lowFloorRequest);
    await assert.rejects(
      vault.write.buy([lowFloorRequest], { account: executor.account }),
    );
  });

  it("leaves spend amount uncapped while enforcing the deadline window", async function () {
    const { executor, registry, token, vault } = await networkHelpers.loadFixture(deployFixture);
    await vault.write.depositNative({ value: parseEther("3") });

    const first = await buyRequest(vault, token.address, parseEther("1.1"), parseEther("1.1"));
    await acceptProof(registry, first);
    await vault.write.buy([first], { account: executor.account });

    const second = await buyRequest(vault, token.address, parseEther("1"), parseEther("1"));
    await acceptProof(registry, second);
    await vault.write.buy([second], { account: executor.account });

    const third = await buyRequest(vault, token.address, parseEther("0.1"), parseEther("0.1"));
    await acceptProof(registry, third);
    await vault.write.buy([third], { account: executor.account });
    assert.equal(await publicClient.getBalance({ address: vault.address }), parseEther("0.8"));

    const tooFar = await buyRequest(vault, token.address, parseEther("0.1"));
    const latest = BigInt(await networkHelpers.time.latest());
    const tooFarRequest = {
      ...tooFar,
      deadline: latest + 7200n,
    };
    const tooFarDraft = { ...tooFarRequest, vaultActionHash: ZERO_HASH, actionHash: ZERO_HASH };
    const tooFarVaultActionHash = await publicClient.readContract({
      address: vault.address,
      abi: vault.abi,
      functionName: "vaultActionHashFor",
      args: [true, tooFarDraft],
    }) as Hex;
    const tooFarFinal = {
      ...tooFarRequest,
      vaultActionHash: tooFarVaultActionHash,
      actionHash: await publicClient.readContract({
        address: vault.address,
        abi: vault.abi,
        functionName: "actionHashFor",
        args: [tooFarVaultActionHash, AUDIT_ROOT, tooFar.policySnapshotHash],
      }) as Hex,
    };
    await acceptProof(registry, tooFarFinal);
    await assert.rejects(
      vault.write.buy([tooFarFinal], { account: executor.account }),
    );
  });

  it("enforces finite trade caps, daily caps, cooldown, and exposure when configured", async function () {
    const { owner, executor, registry, token, adapter } = await networkHelpers.loadFixture(deployFixture);

    const cappedPolicy = {
      ...basePolicy,
      cooldownSeconds: 600n,
      dailyCap0G: parseEther("0.25"),
      maxExposure0G: parseEther("0.25"),
      perTradeCap0G: parseEther("0.2"),
    };
    const cappedVault = await viem.deployContract("PolicyVault", [
      owner.account.address,
      executor.account.address,
      adapter.address,
      registry.address,
      cappedPolicy,
      [token.address],
      [POOL_ID],
      true,
    ]);
    await cappedVault.write.depositNative({ value: parseEther("1") });

    const tooLarge = await buyRequest(cappedVault, token.address, parseEther("0.21"), parseEther("0.21"));
    await acceptProof(registry, tooLarge);
    await assert.rejects(cappedVault.write.buy([tooLarge], { account: executor.account }));

    const first = await buyRequest(cappedVault, token.address, parseEther("0.2"), parseEther("0.2"));
    await acceptProof(registry, first);
    await cappedVault.write.buy([first], { account: executor.account });
    assert.equal(await readVaultUint(cappedVault, "dailySpent0G"), parseEther("0.2"));
    assert.equal(await readVaultUint(cappedVault, "openExposure0G"), parseEther("0.2"));

    const cooldownBlocked = await sellRequest(cappedVault, token.address, parseEther("0.2"));
    await acceptProof(registry, cooldownBlocked);
    await assert.rejects(cappedVault.write.sell([cooldownBlocked], { account: executor.account }));

    await networkHelpers.time.increase(601);

    const exposureBlocked = await buyRequest(cappedVault, token.address, parseEther("0.06"), parseEther("0.06"));
    await acceptProof(registry, exposureBlocked);
    await assert.rejects(cappedVault.write.buy([exposureBlocked], { account: executor.account }));

    const sell = await sellRequest(cappedVault, token.address, parseEther("0.2"));
    await acceptProof(registry, sell);
    await cappedVault.write.sell([sell], { account: executor.account });
    assert.equal(await readVaultUint(cappedVault, "openExposure0G"), parseEther("0.1"));

    await networkHelpers.time.increase(601);

    const dailyBlocked = await buyRequest(cappedVault, token.address, parseEther("0.06"), parseEther("0.06"));
    await acceptProof(registry, dailyBlocked);
    await assert.rejects(cappedVault.write.buy([dailyBlocked], { account: executor.account }));

    await networkHelpers.time.increase(24 * 60 * 60 + 1);

    const nextWindow = await buyRequest(cappedVault, token.address, parseEther("0.06"), parseEther("0.06"));
    await acceptProof(registry, nextWindow);
    await cappedVault.write.buy([nextWindow], { account: executor.account });
    assert.equal(await readVaultUint(cappedVault, "dailySpent0G"), parseEther("0.06"));
  });

  it("allows executor sell through the narrow adapter and reduces position units", async function () {
    const { executor, registry, token, vault } = await networkHelpers.loadFixture(deployFixture);
    await vault.write.depositNative({ value: parseEther("1") });

    const buySetup = await buyRequest(vault, token.address);
    await acceptProof(registry, buySetup);
    await vault.write.buy([buySetup], { account: executor.account });
    assert.equal(await token.read.balanceOf([vault.address]), parseEther("0.2"));
    assert.equal(await vault.read.positionUnits([token.address]), parseEther("0.2"));

    const sell = await sellRequest(vault, token.address);
    await acceptProof(registry, sell);
    await vault.write.sell([sell], { account: executor.account });

    assert.equal(await token.read.balanceOf([vault.address]), 0n);
    assert.equal(await vault.read.positionUnits([token.address]), 0n);
  });

  it("routes native/token swaps through the narrow Uniswap V3 SwapRouter02 adapter", async function () {
    const [owner, executor] = await viem.getWalletClients();
    const registry = await viem.deployContract("ProofRegistry", [owner.account.address]);
    const token = await viem.deployContract("MockAssetToken", [owner.account.address]);
    const wrappedNative = await viem.deployContract("MockWrappedNative", [owner.account.address]);
    const router = await viem.deployContract("MockUniswapV3SwapRouter02", [
      wrappedNative.address,
      parseEther("2"),
      parseEther("0.5"),
    ]);
    await token.write.setMinter([router.address]);
    const factory = await viem.deployContract("MockUniswapV3Factory");
    const pool = await viem.deployContract("MockUniswapV3Pool", [wrappedNative.address, token.address, 10_000]);
    await factory.write.setPool([wrappedNative.address, token.address, 10_000, pool.address]);
    const adapter = await viem.deployContract("UniswapV3SwapRouter02Adapter", [
      router.address,
      factory.address,
      wrappedNative.address,
    ]);
    const poolId = poolIdFromAddress(pool.address);
    const vault = await viem.deployContract("PolicyVault", [
      owner.account.address,
      executor.account.address,
      adapter.address,
      registry.address,
      basePolicy,
      [token.address],
      [poolId],
      false,
    ]);

    await owner.sendTransaction({ to: router.address, value: parseEther("2") });
    await vault.write.depositNative({ value: parseEther("1") });

    const buy = await buyRequest(vault, token.address, parseEther("0.1"), parseEther("0.1"), poolId);
    await acceptProof(registry, buy);
    await vault.write.buy([buy], { account: executor.account });

    assert.equal(await token.read.balanceOf([vault.address]), parseEther("0.2"));
    assert.equal(await publicClient.getBalance({ address: vault.address }), parseEther("0.9"));

    const sell = await sellRequestForPool(vault, token.address, poolId, parseEther("0.2"));
    await acceptProof(registry, sell);
    await vault.write.sell([sell], { account: executor.account });

    assert.equal(await token.read.balanceOf([vault.address]), 0n);
    assert.equal(await publicClient.getBalance({ address: vault.address }), parseEther("1"));
  });

  it("routes native/token swaps through curated single-hop and multi-hop route ids", async function () {
    const [owner, executor] = await viem.getWalletClients();
    const registry = await viem.deployContract("ProofRegistry", [owner.account.address]);
    const usdc = await viem.deployContract("MockAssetToken", [owner.account.address]);
    const link = await viem.deployContract("MockAssetToken", [owner.account.address]);
    const wrappedNative = await viem.deployContract("MockWrappedNative", [owner.account.address]);
    const router = await viem.deployContract("MockUniswapV3RouteRouter", [
      wrappedNative.address,
      parseEther("2"),
      parseEther("0.5"),
    ]);
    await usdc.write.setMinter([router.address]);
    await link.write.setMinter([router.address]);

    const factory = await viem.deployContract("MockUniswapV3Factory");
    const usdcPool = await viem.deployContract("MockUniswapV3Pool", [wrappedNative.address, usdc.address, 10_000]);
    const linkPool = await viem.deployContract("MockUniswapV3Pool", [usdc.address, link.address, 3_000]);
    const blockedPool = await viem.deployContract("MockUniswapV3Pool", [wrappedNative.address, link.address, 10_000]);
    await factory.write.setPool([wrappedNative.address, usdc.address, 10_000, usdcPool.address]);
    await factory.write.setPool([usdc.address, link.address, 3_000, linkPool.address]);
    await factory.write.setPool([wrappedNative.address, link.address, 10_000, blockedPool.address]);

    const adapter = await viem.deployContract("CuratedUniswapV3RouteAdapter", [
      wrappedNative.address,
      [
        {
          routeId: ROUTE_USDC,
          router: router.address,
          factory: factory.address,
          routerKind: 1,
          path: [wrappedNative.address, usdc.address],
          fees: [10_000],
          pools: [usdcPool.address],
        },
        {
          routeId: ROUTE_LINK,
          router: router.address,
          factory: factory.address,
          routerKind: 1,
          path: [wrappedNative.address, usdc.address, link.address],
          fees: [10_000, 3_000],
          pools: [usdcPool.address, linkPool.address],
        },
        {
          routeId: ROUTE_BLOCKED,
          router: router.address,
          factory: factory.address,
          routerKind: 1,
          path: [wrappedNative.address, link.address],
          fees: [10_000],
          pools: [blockedPool.address],
        },
      ],
    ]);
    const vault = await viem.deployContract("PolicyVault", [
      owner.account.address,
      executor.account.address,
      adapter.address,
      registry.address,
      basePolicy,
      [usdc.address, link.address],
      [ROUTE_USDC, ROUTE_LINK],
      false,
    ]);

    await owner.sendTransaction({ to: router.address, value: parseEther("2") });
    await vault.write.depositNative({ value: parseEther("1") });

    const buyUsdc = await buyRequest(vault, usdc.address, parseEther("0.1"), parseEther("0.1"), ROUTE_USDC);
    await acceptProof(registry, buyUsdc);
    await vault.write.buy([buyUsdc], { account: executor.account });
    assert.equal(await usdc.read.balanceOf([vault.address]), parseEther("0.2"));

    const buyLink = await buyRequest(vault, link.address, parseEther("0.1"), parseEther("0.1"), ROUTE_LINK);
    await acceptProof(registry, buyLink);
    await vault.write.buy([buyLink], { account: executor.account });
    assert.equal(await link.read.balanceOf([vault.address]), parseEther("0.2"));

    const wrongRouteForToken = await buyRequest(vault, link.address, parseEther("0.1"), parseEther("0.1"), ROUTE_USDC);
    await acceptProof(registry, wrongRouteForToken);
    await assert.rejects(vault.write.buy([wrongRouteForToken], { account: executor.account }));

    const blockedRoute = await buyRequest(vault, link.address, parseEther("0.1"), parseEther("0.1"), ROUTE_BLOCKED);
    await acceptProof(registry, blockedRoute);
    await assert.rejects(vault.write.buy([blockedRoute], { account: executor.account }));

    const sellLink = await sellRequestForPool(vault, link.address, ROUTE_LINK, parseEther("0.2"));
    await acceptProof(registry, sellLink);
    await vault.write.sell([sellLink], { account: executor.account });

    assert.equal(await link.read.balanceOf([vault.address]), 0n);
    assert.equal(await publicClient.getBalance({ address: vault.address }), parseEther("0.9"));
  });

  it("rejects curated route deployment when factory and pool metadata do not match", async function () {
    const [owner] = await viem.getWalletClients();
    const token = await viem.deployContract("MockAssetToken", [owner.account.address]);
    const wrappedNative = await viem.deployContract("MockWrappedNative", [owner.account.address]);
    const router = await viem.deployContract("MockUniswapV3RouteRouter", [
      wrappedNative.address,
      parseEther("2"),
      parseEther("0.5"),
    ]);
    const factory = await viem.deployContract("MockUniswapV3Factory");
    const pool = await viem.deployContract("MockUniswapV3Pool", [wrappedNative.address, token.address, 3_000]);

    await assert.rejects(
      viem.deployContract("CuratedUniswapV3RouteAdapter", [
        wrappedNative.address,
        [
          {
            routeId: ROUTE_USDC,
            router: router.address,
            factory: factory.address,
            routerKind: 1,
            path: [wrappedNative.address, token.address],
            fees: [10_000],
            pools: [pool.address],
          },
        ],
      ]),
    );
  });

  it("blocks pause and revoke bypass attempts", async function () {
    const { executor, registry, token, vault } = await networkHelpers.loadFixture(deployFixture);
    await vault.write.depositNative({ value: parseEther("1") });

    const pausedRequest = await buyRequest(vault, token.address);
    await acceptProof(registry, pausedRequest);
    await vault.write.setPaused([true]);
    await assert.rejects(vault.write.buy([pausedRequest], { account: executor.account }));

    await vault.write.setPaused([false]);
    await vault.write.revokeExecutor();
    const revokedRequest = await buyRequest(vault, token.address);
    await acceptProof(registry, revokedRequest);
    await assert.rejects(vault.write.buy([revokedRequest], { account: executor.account }));
  });

  it("rejects malicious adapter return values that do not produce balance deltas", async function () {
    const { owner, executor, registry, token } = await networkHelpers.loadFixture(deployFixture);
    const malicious = await viem.deployContract("MaliciousAdapter");
    const vault = await viem.deployContract("PolicyVault", [
      owner.account.address,
      executor.account.address,
      malicious.address,
      registry.address,
      basePolicy,
      [token.address],
      [POOL_ID],
      true,
    ]);

    await vault.write.depositNative({ value: parseEther("1") });
    const request = await buyRequest(vault, token.address);
    await acceptProof(registry, request);

    await assert.rejects(vault.write.buy([request], { account: executor.account }));
  });

  it("blocks mock adapter when production/mainnet-style config disables mocks", async function () {
    const { owner, executor, registry, adapter, token } = await networkHelpers.loadFixture(deployFixture);
    await assert.rejects(
      viem.deployContract("PolicyVault", [
        owner.account.address,
        executor.account.address,
        adapter.address,
        registry.address,
        basePolicy,
        [token.address],
        [POOL_ID],
        false,
      ]),
    );
  });

  it("does not expose arbitrary execution or executor-selected recipient surfaces", async function () {
    const { vault } = await networkHelpers.loadFixture(deployFixture);
    const functionNames = vault.abi
      .filter((item) => item.type === "function")
      .map((item) => item.name as string);

    assert.equal(functionNames.includes("execute"), false);
    assert.equal(functionNames.includes("multicall"), false);
    assert.equal(functionNames.includes("delegatecall"), false);
    assert.equal(functionNames.some((name) => name.toLowerCase().includes("recipient")), false);
  });

  it("blocks reentrancy from a compromised contract executor adapter path", async function () {
    const { owner, registry, token } = await networkHelpers.loadFixture(deployFixture);
    const reenteringAdapter = await viem.deployContract("ReenteringAdapter");
    const vault = await viem.deployContract("PolicyVault", [
      owner.account.address,
      reenteringAdapter.address,
      reenteringAdapter.address,
      registry.address,
      basePolicy,
      [token.address],
      [POOL_ID],
      true,
    ]);

    await vault.write.depositNative({ value: parseEther("1") });
    const request = await buyRequest(vault, token.address);
    await acceptProof(registry, request);
    await assert.rejects(reenteringAdapter.write.triggerBuy([vault.address, request]));
  });

  it("binds accepted proofs to a specific vault action and blocks cross-vault replay", async function () {
    const { owner, executor, registry, token, adapter, vault } = await networkHelpers.loadFixture(deployFixture);
    const secondVault = await viem.deployContract("PolicyVault", [
      owner.account.address,
      executor.account.address,
      adapter.address,
      registry.address,
      basePolicy,
      [token.address],
      [POOL_ID],
      true,
    ]);
    await vault.write.depositNative({ value: parseEther("1") });
    await secondVault.write.depositNative({ value: parseEther("1") });

    const request = await buyRequest(vault, token.address);
    await acceptProof(registry, request);
    await assert.rejects(secondVault.write.buy([request], { account: executor.account }));
    await vault.write.buy([request], { account: executor.account });
  });

  it("enforces token and pool allowlists before adapter execution", async function () {
    const { executor, registry, token, vault } = await networkHelpers.loadFixture(deployFixture);
    const disallowedToken = await viem.deployContract("MockAssetToken", [executor.account.address]);
    await vault.write.depositNative({ value: parseEther("1") });

    const badTokenRequest = await buyRequest(vault, disallowedToken.address);
    await acceptProof(registry, badTokenRequest);
    await assert.rejects(vault.write.buy([badTokenRequest], { account: executor.account }));

    const badPoolRequest = await buyRequest(vault, token.address, parseEther("0.1"), parseEther("0.1"), keccak256(stringToHex("bad-pool")));
    await acceptProof(registry, badPoolRequest);
    await assert.rejects(vault.write.buy([badPoolRequest], { account: executor.account }));

    const disabledPoolRequest = await buyRequest(vault, token.address);
    await acceptProof(registry, disabledPoolRequest);
    await vault.write.disablePool([POOL_ID]);
    await assert.rejects(vault.write.buy([disabledPoolRequest], { account: executor.account }));
  });

  it("rejects incomplete proof metadata", async function () {
    const { registry, vault, token } = await networkHelpers.loadFixture(deployFixture);
    const request = await buyRequest(vault, token.address);
    await assert.rejects(
      registry.write.acceptProof([
        request.actionHash,
        AUDIT_ROOT,
        request.policySnapshotHash,
        ZERO_HASH,
        "0g-storage://root",
        request.vaultActionHash,
        "agent",
      ]),
    );
    await assert.rejects(
      registry.write.acceptProof([
        request.actionHash,
        AUDIT_ROOT,
        request.policySnapshotHash,
        MODEL_HASH,
        "",
        request.vaultActionHash,
        "agent",
      ]),
    );
  });
});
