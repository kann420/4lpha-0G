import { join } from "node:path";

import {
  formatEther,
  formatUnits,
  getAddress,
  isHex,
  keccak256,
  parseEther,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import {
  CURATED_MAINNET_POLICY_VAULT_ROUTES,
  W0G_MAINNET,
  ZIA_MAINNET,
  type CuratedPolicyVaultRoute,
} from "../lib/contracts/curated-routes";
import {
  MOCK_ADAPTER_KIND,
  ROUTE_ADAPTER_KIND,
  ZERO_ADDRESS,
  ZERO_HASH,
  adapterAbi,
  assertMainnetRpc,
  createMainnetPublicClient,
  createMainnetWalletClient,
  erc20Abi,
  formatPolicy,
  normalizePolicy,
  policyVaultAbi,
  proofRegistryAbi,
  read0GAmountEnv,
  readBigIntEnv,
  readBoolEnv,
  readConfiguredVaultAddress,
  readFactoryVault,
  readMainnetVaultConfig,
  readOptional0GAmountEnv,
  readOptionalAddressEnv,
  readOptionalPrivateKeyOwner,
  readBpsEnv,
  requireBytecode,
  requireEnv,
  requireMainnetEnv,
  runIfDirect,
  sameAddress,
  waitForTx,
  writeJsonArtifact,
} from "./mainnet-vault-utils";

interface BuyTradeRequest {
  actionHash: Hex;
  amountIn: bigint;
  amountOutMin: bigint;
  auditRoot: Hex;
  deadline: bigint;
  nonce: bigint;
  policySnapshotHash: Hex;
  poolId: Hex;
  quotedAmountOut: bigint;
  tokenIn: Address;
  tokenOut: Address;
  vaultActionHash: Hex;
}

const quoterV2Abi = [
  {
    inputs: [
      { internalType: "bytes", name: "path", type: "bytes" },
      { internalType: "uint256", name: "amountIn", type: "uint256" },
    ],
    name: "quoteExactInput",
    outputs: [
      { internalType: "uint256", name: "amountOut", type: "uint256" },
      { internalType: "uint160[]", name: "sqrtPriceX96AfterList", type: "uint160[]" },
      { internalType: "uint32[]", name: "initializedTicksCrossedList", type: "uint32[]" },
      { internalType: "uint256", name: "gasEstimate", type: "uint256" },
    ],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

async function main() {
  requireMainnetEnv("mainnet trade smoke preflight");

  const publicClient = createMainnetPublicClient();
  const chainId = await assertMainnetRpc(publicClient);
  const config = readMainnetVaultConfig();

  await Promise.all([
    requireBytecode(publicClient, config.factory, "PolicyVaultFactory"),
    requireBytecode(publicClient, config.proofRegistry, "ProofRegistry"),
    requireBytecode(publicClient, config.adapter, "Policy Vault adapter"),
  ]);

  const configuredVault = readConfiguredVaultAddress();
  const explicitOwner = readOptionalAddressEnv("MAINNET_VAULT_OWNER_ADDRESS") ?? readOptionalPrivateKeyOwner();
  let owner = explicitOwner;
  let vault = configuredVault ?? ZERO_ADDRESS;
  if (configuredVault !== null) {
    await requireBytecode(publicClient, configuredVault, "Configured PolicyVault");
    owner = await publicClient.readContract({ address: configuredVault, abi: policyVaultAbi, functionName: "owner" });
    const factoryVault = await readFactoryVault(publicClient, config.factory, owner);
    if (!sameAddress(configuredVault, factoryVault)) {
      throw new Error("Configured mainnet vault is not the factory vault for its owner");
    }
  } else if (owner !== null) {
    vault = await readFactoryVault(publicClient, config.factory, owner);
  } else {
    throw new Error("Set NEXT_PUBLIC_POLICY_VAULT_MAINNET_ADDRESS, MAINNET_VAULT_OWNER_ADDRESS, or DEPLOYER_PRIVATE_KEY for trade preflight");
  }
  if (owner === null) {
    throw new Error("Unable to resolve mainnet vault owner");
  }

  if (vault === ZERO_ADDRESS) {
    throw new Error("No mainnet vault found. Run the discover/create scripts before trade preflight");
  }
  await requireBytecode(publicClient, vault, "PolicyVault");

  const [
    vaultOwner,
    vaultExecutor,
    vaultAdapter,
    vaultProofRegistry,
    mockAdapterAllowed,
    paused,
    executorRevoked,
    policyRaw,
    nativeBalance,
    dailySpent0G,
    dailyWindowStart,
    lastTradeAt,
    openExposure0G,
    adapterKind,
  ] = await Promise.all([
    publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "owner" }),
    publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "executor" }),
    publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "adapter" }),
    publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "proofRegistry" }),
    publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "mockAdapterAllowed" }),
    publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "paused" }),
    publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "executorRevoked" }),
    publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "policy" }),
    publicClient.getBalance({ address: vault }),
    publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "dailySpent0G" }),
    publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "dailyWindowStart" }),
    publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "lastTradeAt" }),
    publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "openExposure0G" }),
    publicClient.readContract({ address: config.adapter, abi: adapterAbi, functionName: "adapterKind" }),
  ]);
  const policy = normalizePolicy(policyRaw);

  if (!sameAddress(vaultOwner, owner)) {
    throw new Error("Resolved vault owner does not match the expected owner");
  }
  if (!sameAddress(vaultExecutor, config.executor)) {
    throw new Error("Vault executor does not match NEXT_PUBLIC_VAULT_EXECUTOR_MAINNET_ADDRESS");
  }
  if (!sameAddress(vaultAdapter, config.adapter)) {
    throw new Error("Vault adapter does not match NEXT_PUBLIC_POLICY_VAULT_ADAPTER_MAINNET_ADDRESS");
  }
  if (!sameAddress(vaultProofRegistry, config.proofRegistry)) {
    throw new Error("Vault proof registry does not match NEXT_PUBLIC_PROOF_REGISTRY_MAINNET_ADDRESS");
  }
  if (mockAdapterAllowed || adapterKind === MOCK_ADAPTER_KIND) {
    throw new Error("Mainnet trade preflight cannot use a mock adapter");
  }
  if (adapterKind !== ROUTE_ADAPTER_KIND) {
    throw new Error("Mainnet trade preflight expects the curated route adapter");
  }
  if (paused) {
    throw new Error("Vault is paused");
  }
  if (executorRevoked) {
    throw new Error("Vault executor is revoked");
  }

  const route = selectRoute();
  if (route.venue !== "ZIA") {
    throw new Error("Tiny mainnet trade smoke currently quotes ZIA routes only; choose a ZIA route");
  }
  await verifyRoute(publicClient, config.adapter, vault, route);

  const amountIn = readOptional0GAmountEnv("MAINNET_TRADE_SMOKE_BUY_0G");
  const baseReport = {
    adapter: config.adapter,
    adapterKind,
    chainId,
    executor: vaultExecutor,
    nativeBalance0G: formatEther(nativeBalance),
    owner: vaultOwner,
    policy: formatPolicy(policy),
    proofRegistry: vaultProofRegistry,
    route: {
      confidence: route.confidence,
      id: route.id,
      label: route.label,
      symbol: route.symbol,
      tokenOut: route.tokenOut,
      venue: route.venue,
    },
    vault,
  };

  if (amountIn === null) {
    const outputPath = join(".data", "smoke", "mainnet-trade-preflight.json");
    await writeJsonArtifact(outputPath, {
      ...baseReport,
      status: "ready-no-amount",
    });
    console.log("Mainnet trade preflight passed without an amount. No transaction sent. Redacted artifact:", outputPath);
    console.log({
      chainId,
      route: route.label,
      status: "ready-no-amount",
      vault,
    });
    console.log("Set MAINNET_TRADE_SMOKE_BUY_0G to quote and simulate a tiny buy.");
    return;
  }

  const maxAmount = read0GAmountEnv("MAINNET_TRADE_SMOKE_MAX_BUY_0G", "0.005");
  if (amountIn <= 0n || amountIn > maxAmount) {
    throw new Error("MAINNET_TRADE_SMOKE_BUY_0G must be greater than 0 and no larger than MAINNET_TRADE_SMOKE_MAX_BUY_0G");
  }
  if (nativeBalance < amountIn) {
    throw new Error("Vault native balance is below MAINNET_TRADE_SMOKE_BUY_0G");
  }

  const latestBlock = await publicClient.getBlock({ blockTag: "latest" });
  validatePolicyWindow({
    amountIn,
    dailySpent0G,
    dailyWindowStart,
    latestTimestamp: latestBlock.timestamp,
    lastTradeAt,
    openExposure0G,
    policy,
  });

  const tokenDecimals = await publicClient.readContract({
    address: route.tokenOut,
    abi: erc20Abi,
    functionName: "decimals",
  });
  const quotedAmountOut = await quoteZiaRoute(publicClient, route, amountIn);
  const vaultMinOutBps = Number(
    await publicClient.readContract({
      address: vault,
      abi: policyVaultAbi,
      functionName: "minOutBpsFor",
      args: [ZERO_ADDRESS, route.tokenOut],
    }),
  );
  const requestedMinOutBps = readBpsEnv("MAINNET_TRADE_SMOKE_MIN_OUT_BPS", vaultMinOutBps);
  const minOutBps = Math.max(vaultMinOutBps, requestedMinOutBps);
  const amountOutMin = (quotedAmountOut * BigInt(minOutBps)) / 10_000n;
  if (quotedAmountOut <= 0n || amountOutMin <= 0n) {
    throw new Error("Quoted output and amountOutMin must be nonzero");
  }

  const adapterSimulation = await publicClient.simulateContract({
    account: vault,
    address: config.adapter,
    abi: adapterAbi,
    functionName: "swapExactIn",
    args: [ZERO_ADDRESS, route.tokenOut, amountIn, amountOutMin, route.id],
    value: amountIn,
  });

  const execute = readBoolEnv("MAINNET_TRADE_SMOKE_EXECUTE");
  const deadlineSeconds = readBigIntEnv("MAINNET_TRADE_SMOKE_DEADLINE_SECONDS", 10n * 60n);
  if (deadlineSeconds <= 0n || deadlineSeconds > policy.maxDeadlineWindowSeconds) {
    throw new Error("MAINNET_TRADE_SMOKE_DEADLINE_SECONDS must be within the vault max deadline window");
  }
  const auditRoot = execute
    ? requireHex32Env("MAINNET_TRADE_SMOKE_AUDIT_ROOT")
    : keccak256(stringToHex(`4lpha-0g-mainnet-trade-smoke-preview:${vault}:${route.id}:${amountIn.toString()}`));
  const request = await buildBuyRequest({
    amountIn,
    amountOutMin,
    auditRoot,
    deadline: latestBlock.timestamp + deadlineSeconds,
    nonce: BigInt(Date.now()),
    publicClient,
    quotedAmountOut,
    route,
    vault,
  });
  const proofAccepted = await publicClient.readContract({
    address: config.proofRegistry,
    abi: proofRegistryAbi,
    functionName: "isAccepted",
    args: [request.actionHash, request.auditRoot, request.policySnapshotHash, request.vaultActionHash],
  });

  const preflightReport = {
    ...baseReport,
    amountIn0G: formatEther(amountIn),
    amountOutMin: amountOutMin.toString(),
    amountOutMinFormatted: formatUnits(amountOutMin, tokenDecimals),
    adapterSimulationAmountOut: adapterSimulation.result.toString(),
    adapterSimulationAmountOutFormatted: formatUnits(adapterSimulation.result, tokenDecimals),
    minOutBps,
    proofAccepted,
    quotedAmountOut: quotedAmountOut.toString(),
    quotedAmountOutFormatted: formatUnits(quotedAmountOut, tokenDecimals),
    request: {
      actionHash: request.actionHash,
      auditRoot: request.auditRoot,
      deadline: request.deadline.toString(),
      policySnapshotHash: request.policySnapshotHash,
      vaultActionHash: request.vaultActionHash,
    },
  };

  if (!execute) {
    const outputPath = join(".data", "smoke", "mainnet-trade-preflight.json");
    await writeJsonArtifact(outputPath, {
      ...preflightReport,
      status: "simulated-no-transaction",
    });
    console.log("Mainnet trade preflight simulated successfully. No transaction sent. Redacted artifact:", outputPath);
    console.log({
      amountIn0G: preflightReport.amountIn0G,
      amountOutMin: preflightReport.amountOutMinFormatted,
      chainId,
      route: route.label,
      status: "simulated-no-transaction",
      vault,
    });
    console.log("Set MAINNET_TRADE_SMOKE_EXECUTE=true plus proof metadata envs to accept proof and send the tiny buy.");
    return;
  }

  const modelMetadataHash = requireHex32Env("MAINNET_TRADE_SMOKE_MODEL_METADATA_HASH");
  const storageRef = requireEnv("MAINNET_TRADE_SMOKE_STORAGE_REF");
  if (!storageRef.startsWith("0g-storage://")) {
    throw new Error("MAINNET_TRADE_SMOKE_STORAGE_REF must be a 0g-storage:// reference");
  }
  const agentRef = process.env.MAINNET_TRADE_SMOKE_AGENT_REF?.trim() || "4lpha-0g-mainnet-trade-smoke";
  if (proofAccepted) {
    throw new Error("Trade smoke proof is already accepted; refusing to reuse action hash");
  }

  const { account: proofOwner, walletClient: proofWallet } = createMainnetWalletClient("DEPLOYER_PRIVATE_KEY");
  const proofRegistryOwner = await publicClient.readContract({
    address: config.proofRegistry,
    abi: proofRegistryAbi,
    functionName: "owner",
  });
  if (!sameAddress(proofOwner.address, proofRegistryOwner)) {
    throw new Error("DEPLOYER_PRIVATE_KEY must match ProofRegistry.owner() to accept the smoke proof");
  }

  const { account: executorAccount, walletClient: executorWallet } = createMainnetWalletClient("VAULT_EXECUTOR_PRIVATE_KEY");
  if (!sameAddress(executorAccount.address, vaultExecutor)) {
    throw new Error("VAULT_EXECUTOR_PRIVATE_KEY must match the vault executor");
  }

  const [proofOwnerBalance, executorBalance] = await Promise.all([
    publicClient.getBalance({ address: proofOwner.address }),
    publicClient.getBalance({ address: executorAccount.address }),
  ]);
  if (proofOwnerBalance < parseEther("0.001")) {
    throw new Error("Proof owner needs at least 0.001 0G for acceptProof gas");
  }
  if (executorBalance < parseEther("0.001")) {
    throw new Error("Executor needs at least 0.001 0G for buy gas");
  }

  const acceptProofTx = await proofWallet.writeContract({
    address: config.proofRegistry,
    abi: proofRegistryAbi,
    functionName: "acceptProof",
    args: [
      request.actionHash,
      request.auditRoot,
      request.policySnapshotHash,
      modelMetadataHash,
      storageRef,
      request.vaultActionHash,
      agentRef,
    ],
  });
  await waitForTx(publicClient, acceptProofTx, "acceptProof");

  const postProofBlock = await publicClient.getBlock({ blockTag: "latest" });
  if (postProofBlock.timestamp >= request.deadline) {
    throw new Error("Trade smoke deadline expired after proof acceptance; no buy was sent");
  }

  await publicClient.simulateContract({
    account: executorAccount.address,
    address: vault,
    abi: policyVaultAbi,
    functionName: "buy",
    args: [request],
  });
  const buyTx = await executorWallet.writeContract({
    address: vault,
    abi: policyVaultAbi,
    functionName: "buy",
    args: [request],
  });
  await waitForTx(publicClient, buyTx, "buy");

  const outputPath = join(".data", "smoke", "mainnet-trade-preflight.json");
  await writeJsonArtifact(outputPath, {
    ...preflightReport,
    status: "executed",
    tx: {
      acceptProof: acceptProofTx,
      buy: buyTx,
    },
  });
  console.log("Mainnet tiny buy smoke executed. Redacted artifact:", outputPath);
  console.log({
    acceptProof: acceptProofTx,
    amountIn0G: preflightReport.amountIn0G,
    buy: buyTx,
    route: route.label,
    vault,
  });
}

function selectRoute(): CuratedPolicyVaultRoute {
  const routeId = process.env.MAINNET_TRADE_SMOKE_ROUTE_ID?.trim();
  if (routeId !== undefined && routeId !== "") {
    if (!isHex(routeId, { strict: true }) || routeId.length !== 66) {
      throw new Error("MAINNET_TRADE_SMOKE_ROUTE_ID must be a bytes32 hex route id");
    }
    const byId = CURATED_MAINNET_POLICY_VAULT_ROUTES.find((route) => route.id.toLowerCase() === routeId.toLowerCase());
    if (byId === undefined) {
      throw new Error("MAINNET_TRADE_SMOKE_ROUTE_ID is not in the curated mainnet route registry");
    }
    return byId;
  }

  const requested = process.env.MAINNET_TRADE_SMOKE_ROUTE_SYMBOL?.trim() || "USDC.e";
  const bySymbol = CURATED_MAINNET_POLICY_VAULT_ROUTES.find(
    (route) => route.symbol.toLowerCase() === requested.toLowerCase() || route.label.toLowerCase() === requested.toLowerCase(),
  );
  if (bySymbol === undefined) {
    throw new Error("MAINNET_TRADE_SMOKE_ROUTE_SYMBOL did not match a curated mainnet route");
  }
  return bySymbol;
}

async function verifyRoute(
  publicClient: ReturnType<typeof createMainnetPublicClient>,
  adapter: Address,
  vault: Address,
  route: CuratedPolicyVaultRoute,
) {
  const [routeConfigured, routeInfo, tokenAllowed, poolAllowed] = await Promise.all([
    publicClient.readContract({ address: adapter, abi: adapterAbi, functionName: "routeConfigured", args: [route.id] }),
    publicClient.readContract({ address: adapter, abi: adapterAbi, functionName: "routeInfo", args: [route.id] }),
    publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "allowedTokens", args: [route.tokenOut] }),
    publicClient.readContract({ address: vault, abi: policyVaultAbi, functionName: "allowedPools", args: [route.id] }),
  ]);
  const [router, factory, routerKind, tokenIn, tokenOut] = routeInfo;
  if (!routeConfigured) {
    throw new Error("Selected route is not configured on the adapter");
  }
  if (!tokenAllowed || !poolAllowed) {
    throw new Error("Selected route token or route id is not allowed by the vault policy");
  }
  if (
    !sameAddress(router, route.router) ||
    !sameAddress(factory, route.factory) ||
    routerKind !== route.routerKind ||
    !sameAddress(tokenIn, W0G_MAINNET) ||
    !sameAddress(tokenOut, route.tokenOut)
  ) {
    throw new Error("Selected route metadata does not match the curated registry");
  }
}

function validatePolicyWindow({
  amountIn,
  dailySpent0G,
  dailyWindowStart,
  latestTimestamp,
  lastTradeAt,
  openExposure0G,
  policy,
}: {
  amountIn: bigint;
  dailySpent0G: bigint;
  dailyWindowStart: bigint;
  latestTimestamp: bigint;
  lastTradeAt: bigint;
  openExposure0G: bigint;
  policy: ReturnType<typeof normalizePolicy>;
}) {
  if (amountIn > policy.perTradeCap0G) {
    throw new Error("MAINNET_TRADE_SMOKE_BUY_0G exceeds vault per-trade cap");
  }
  if (openExposure0G + amountIn > policy.maxExposure0G) {
    throw new Error("MAINNET_TRADE_SMOKE_BUY_0G exceeds vault max exposure");
  }
  const currentDailySpent =
    dailyWindowStart === 0n || latestTimestamp >= dailyWindowStart + 24n * 60n * 60n ? 0n : dailySpent0G;
  if (currentDailySpent + amountIn > policy.dailyCap0G) {
    throw new Error("MAINNET_TRADE_SMOKE_BUY_0G exceeds vault daily cap");
  }
  if (policy.cooldownSeconds !== 0n && lastTradeAt !== 0n && latestTimestamp < lastTradeAt + policy.cooldownSeconds) {
    throw new Error("Vault cooldown is still active");
  }
}

async function quoteZiaRoute(
  publicClient: ReturnType<typeof createMainnetPublicClient>,
  route: CuratedPolicyVaultRoute,
  amountIn: bigint,
): Promise<bigint> {
  const result = await publicClient.readContract({
    address: ZIA_MAINNET.quoterV2,
    abi: quoterV2Abi,
    functionName: "quoteExactInput",
    args: [encodeV3Path(route.path, route.fees), amountIn],
  });
  return Array.isArray(result) ? result[0] : result;
}

async function buildBuyRequest({
  amountIn,
  amountOutMin,
  auditRoot,
  deadline,
  nonce,
  publicClient,
  quotedAmountOut,
  route,
  vault,
}: {
  amountIn: bigint;
  amountOutMin: bigint;
  auditRoot: Hex;
  deadline: bigint;
  nonce: bigint;
  publicClient: ReturnType<typeof createMainnetPublicClient>;
  quotedAmountOut: bigint;
  route: CuratedPolicyVaultRoute;
  vault: Address;
}): Promise<BuyTradeRequest> {
  const policySnapshotHash = await publicClient.readContract({
    address: vault,
    abi: policyVaultAbi,
    functionName: "policyHash",
  });
  const draft = {
    actionHash: ZERO_HASH,
    amountIn,
    amountOutMin,
    auditRoot,
    deadline,
    nonce,
    policySnapshotHash,
    poolId: route.id,
    quotedAmountOut,
    tokenIn: ZERO_ADDRESS,
    tokenOut: route.tokenOut,
    vaultActionHash: ZERO_HASH,
  };
  const vaultActionHash = await publicClient.readContract({
    address: vault,
    abi: policyVaultAbi,
    functionName: "vaultActionHashFor",
    args: [true, draft],
  });
  const actionHash = await publicClient.readContract({
    address: vault,
    abi: policyVaultAbi,
    functionName: "actionHashFor",
    args: [vaultActionHash, auditRoot, policySnapshotHash],
  });
  return {
    ...draft,
    actionHash,
    vaultActionHash,
  };
}

function encodeV3Path(path: readonly Address[], fees: readonly number[]): Hex {
  if (path.length < 2 || fees.length !== path.length - 1) {
    throw new Error("Invalid route path");
  }
  let encoded = getAddress(path[0]).toLowerCase();
  for (let i = 0; i < fees.length; i += 1) {
    encoded += fees[i].toString(16).padStart(6, "0");
    encoded += getAddress(path[i + 1]).slice(2).toLowerCase();
  }
  return encoded as Hex;
}

function requireHex32Env(name: string): Hex {
  const value = requireEnv(name);
  if (!isHex(value, { strict: true }) || value.length !== 66 || value === ZERO_HASH) {
    throw new Error(`${name} must be a nonzero bytes32 hex value`);
  }
  return value as Hex;
}

await runIfDirect(import.meta.url, main);

export { main };
