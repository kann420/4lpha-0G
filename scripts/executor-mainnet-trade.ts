import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import dotenv from "dotenv";
import { getAddress, isAddress, isHex, type Address, type Hex } from "viem";
import {
  CURATED_MAINNET_POLICY_VAULT_ROUTES,
} from "../lib/contracts/curated-routes";
import {
  createMainnetExecutorClients,
  prepareMainnetPolicyVaultTrade,
  runMainnetPolicyVaultTrade,
  type PolicyVaultExecutorTradeInput,
  type PolicyVaultTradeSide,
  type PreparedExecutorTrade,
} from "../lib/executor/policy-vault-trade";

dotenv.config({ path: ".env.local", quiet: true });

const MAINNET_CHAIN_ID = 16661;
const ZERO_HASH = `0x${"00".repeat(32)}` as Hex;

interface RawTradePlan {
  agentRef?: string;
  amountIn?: string;
  amountOutMin?: string;
  auditRoot?: string;
  deadlineSeconds?: string;
  modelMetadataHash?: string;
  nonce?: string;
  quotedAmountOut?: string;
  routeId?: string;
  routeSymbol?: string;
  side?: string;
  storageRef?: string;
  token?: string;
  vault?: string;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}

requireMainnetRuntime();
const broadcast = args.broadcast && requireBroadcastEnv();
const rawPlan = await readRawTradePlan(args.planPath);
const input = buildTradeInput(rawPlan);
const clients = createMainnetExecutorClients({
  privateKey: requirePrivateKeyEnv("VAULT_EXECUTOR_PRIVATE_KEY"),
  rpcUrl: requireEnv("OG_RPC_URL"),
});

if (broadcast) {
  const result = await runMainnetPolicyVaultTrade({
    broadcast: true,
    clients,
    input,
  });
  const artifactPath = await writePreparedArtifact(result.prepared, {
    broadcast,
    proofTxHash: result.proofTxHash,
    tradeTxHash: result.tradeTxHash,
  });
  console.log("0G mainnet executor trade broadcast complete", {
    actionHash: result.prepared.request.actionHash,
    artifactPath,
    proofTxHash: result.proofTxHash ?? "already-accepted",
    route: result.prepared.route.label,
    side: result.prepared.side,
    tradeTxHash: result.tradeTxHash,
    vault: result.prepared.vault,
  });
} else {
  const prepared = await prepareMainnetPolicyVaultTrade(clients, input);
  const artifactPath = await writePreparedArtifact(prepared, { broadcast });
  console.log("0G mainnet executor trade prepared; no transaction was broadcast", {
    actionHash: prepared.request.actionHash,
    artifactPath,
    executor: prepared.executor,
    proofAlreadyAccepted: prepared.proofAlreadyAccepted,
    proofRegistryOwnerMatchesExecutor: prepared.accountCanAcceptProof,
    route: prepared.route.label,
    side: prepared.side,
    tradeFunctionName: prepared.tradeFunctionName,
    vault: prepared.vault,
  });
}

function parseArgs(argv: string[]) {
  const parsed = {
    broadcast: false,
    help: false,
    planPath: process.env.EXECUTOR_TRADE_PLAN_PATH,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--broadcast") {
      parsed.broadcast = true;
      continue;
    }
    if (arg === "--plan") {
      parsed.planPath = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--plan=")) {
      parsed.planPath = arg.slice("--plan=".length);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

async function readRawTradePlan(planPath: string | undefined): Promise<RawTradePlan> {
  if (planPath === undefined || planPath.trim() === "") {
    return {};
  }
  const content = await readFile(planPath, "utf8");
  return JSON.parse(content) as RawTradePlan;
}

function buildTradeInput(plan: RawTradePlan): PolicyVaultExecutorTradeInput {
  const side = readSide(plan.side ?? process.env.EXECUTOR_TRADE_SIDE);
  const route = readRoute(plan);
  const token = readOptionalAddress(plan.token ?? process.env.EXECUTOR_TRADE_TOKEN_ADDRESS);
  const vault = requireAddressValue(plan.vault ?? process.env.POLICY_VAULT_ADDRESS ?? process.env.NEXT_PUBLIC_POLICY_VAULT_MAINNET_ADDRESS, "vault");

  return {
    agentRef: requireStringValue(plan.agentRef ?? process.env.EXECUTOR_TRADE_AGENT_REF, "agentRef"),
    amountIn: requireBigIntValue(plan.amountIn ?? process.env.EXECUTOR_TRADE_AMOUNT_IN, "amountIn"),
    amountOutMin: readOptionalBigIntValue(plan.amountOutMin ?? process.env.EXECUTOR_TRADE_AMOUNT_OUT_MIN, "amountOutMin"),
    auditRoot: requireHex32Value(plan.auditRoot ?? process.env.EXECUTOR_TRADE_AUDIT_ROOT, "auditRoot"),
    deadlineSeconds: readOptionalBigIntValue(plan.deadlineSeconds ?? process.env.EXECUTOR_TRADE_DEADLINE_SECONDS, "deadlineSeconds"),
    modelMetadataHash: requireHex32Value(plan.modelMetadataHash ?? process.env.EXECUTOR_TRADE_MODEL_METADATA_HASH, "modelMetadataHash"),
    nonce: readOptionalBigIntValue(plan.nonce ?? process.env.EXECUTOR_TRADE_NONCE, "nonce"),
    quotedAmountOut: requireBigIntValue(plan.quotedAmountOut ?? process.env.EXECUTOR_TRADE_QUOTED_AMOUNT_OUT, "quotedAmountOut"),
    routeId: route.id,
    side,
    storageRef: requireStringValue(plan.storageRef ?? process.env.EXECUTOR_TRADE_STORAGE_REF, "storageRef"),
    token,
    vault,
  };
}

function requireMainnetRuntime() {
  if ((process.env.OG_NETWORK ?? "").toLowerCase() !== "mainnet") {
    throw new Error("Executor trade runner requires OG_NETWORK=mainnet");
  }
  if (Number(requireEnv("OG_CHAIN_ID")) !== MAINNET_CHAIN_ID) {
    throw new Error(`Executor trade runner requires OG_CHAIN_ID=${MAINNET_CHAIN_ID}`);
  }
  requireFlag("ENABLE_REAL_DEX_ADAPTER", true);
  requireFlag("ENABLE_MOCK_DEX_ADAPTER", false);
}

function requireBroadcastEnv() {
  const enabled = (process.env.EXECUTOR_TRADE_BROADCAST ?? "false").toLowerCase() === "true";
  if (!enabled) {
    throw new Error("Broadcast requires both --broadcast and EXECUTOR_TRADE_BROADCAST=true");
  }
  return true;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value.trim();
}

function requirePrivateKeyEnv(name: string): Hex {
  const value = requireEnv(name);
  if (!isHex(value, { strict: true }) || value.length !== 66) {
    throw new Error(`${name} must be a 32-byte hex private key`);
  }
  return value;
}

function requireFlag(name: string, expected: boolean) {
  const actual = (process.env[name] ?? "false").toLowerCase() === "true";
  if (actual !== expected) {
    throw new Error(`${name} must be ${String(expected)} for executor trade runner`);
  }
}

function readSide(value: string | undefined): PolicyVaultTradeSide {
  if (value === "buy" || value === "sell") {
    return value;
  }
  throw new Error("side must be buy or sell");
}

function readRoute(plan: RawTradePlan) {
  const routeId = plan.routeId ?? process.env.EXECUTOR_TRADE_ROUTE_ID;
  if (routeId !== undefined && routeId.trim() !== "") {
    const normalized = requireHex32Value(routeId, "routeId");
    const route = CURATED_MAINNET_POLICY_VAULT_ROUTES.find((candidate) => candidate.id.toLowerCase() === normalized.toLowerCase());
    if (route === undefined) {
      throw new Error("routeId is not in the curated mainnet ZIA/Oku route registry");
    }
    return route;
  }

  const routeSymbol = plan.routeSymbol ?? process.env.EXECUTOR_TRADE_ROUTE_SYMBOL;
  if (routeSymbol === undefined || routeSymbol.trim() === "") {
    throw new Error("Provide routeId or routeSymbol");
  }
  const route = CURATED_MAINNET_POLICY_VAULT_ROUTES.find((candidate) => candidate.symbol.toLowerCase() === routeSymbol.toLowerCase());
  if (route === undefined) {
    throw new Error(`Unknown curated routeSymbol: ${routeSymbol}`);
  }
  return route;
}

function requireAddressValue(value: string | undefined, label: string): Address {
  if (value === undefined || !isAddress(value)) {
    throw new Error(`${label} must be a valid EVM address`);
  }
  return getAddress(value);
}

function readOptionalAddress(value: string | undefined): Address | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  if (!isAddress(value)) {
    throw new Error("token must be a valid EVM address");
  }
  return getAddress(value);
}

function requireHex32Value(value: string | undefined, label: string): Hex {
  if (value === undefined || !isHex(value, { strict: true }) || value.length !== 66 || value === ZERO_HASH) {
    throw new Error(`${label} must be a nonzero bytes32 hex value`);
  }
  return value;
}

function requireStringValue(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  if (normalized === undefined || normalized === "") {
    throw new Error(`${label} is required`);
  }
  return normalized;
}

function requireBigIntValue(value: string | undefined, label: string): bigint {
  const parsed = readOptionalBigIntValue(value, label);
  if (parsed === undefined) {
    throw new Error(`${label} is required`);
  }
  return parsed;
}

function readOptionalBigIntValue(value: string | undefined, label: string): bigint | undefined {
  const normalized = value?.trim();
  if (normalized === undefined || normalized === "") {
    return undefined;
  }
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`${label} must be a non-negative base-unit integer string`);
  }
  return BigInt(normalized);
}

async function writePreparedArtifact(
  prepared: PreparedExecutorTrade,
  run: {
    broadcast: boolean;
    proofTxHash?: Hex;
    tradeTxHash?: Hex;
  },
) {
  const outputPath = join(".data", "executor", `mainnet-trade-${prepared.request.actionHash.slice(2, 10)}.json`);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    `${JSON.stringify(
      {
        adapter: prepared.adapter,
        broadcast: run.broadcast,
        executor: prepared.executor,
        proof: {
          alreadyAccepted: prepared.proofAlreadyAccepted,
          owner: prepared.proofRegistryOwner,
          ownerMatchesExecutor: prepared.accountCanAcceptProof,
          transaction: prepared.proofTransaction,
          txHash: run.proofTxHash,
        },
        proofRegistry: prepared.proofRegistry,
        request: prepared.request,
        route: {
          id: prepared.route.id,
          label: prepared.route.label,
          symbol: prepared.route.symbol,
          tokenOut: prepared.route.tokenOut,
          venue: prepared.route.venue,
        },
        side: prepared.side,
        trade: {
          functionName: prepared.tradeFunctionName,
          transaction: prepared.tradeTransaction,
          txHash: run.tradeTxHash,
        },
        vault: prepared.vault,
      },
      jsonReplacer,
      2,
    )}\n`,
    "utf8",
  );
  return outputPath;
}

function jsonReplacer(_key: string, value: unknown) {
  return typeof value === "bigint" ? value.toString() : value;
}

function printHelp() {
  console.log(`Prepare or run a 0G mainnet Policy Vault executor trade.

Dry-run prepare:
  npm run executor:trade:mainnet -- --plan .data/executor/trade-plan.json

Broadcast requires both gates:
  EXECUTOR_TRADE_BROADCAST=true npm run executor:trade:mainnet -- --plan .data/executor/trade-plan.json --broadcast

Plan JSON fields:
  side: "buy" | "sell"
  vault: PolicyVault address
  routeId or routeSymbol: curated ZIA/Oku route
  amountIn: base-unit integer string
  quotedAmountOut: base-unit integer string
  amountOutMin: optional base-unit integer string; vault minOutFor is used if omitted
  auditRoot, modelMetadataHash: nonzero bytes32
  storageRef, agentRef: proof metadata strings
`);
}
