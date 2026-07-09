#!/usr/bin/env node
import { parseArgs } from "node:util";

import { config as loadEnv } from "dotenv";
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  isAddress,
  parseAbi,
  parseEther,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

loadEnv({ path: ".env.local" });
loadEnv();

const { values } = parseArgs({
  options: {
    "lp-entry": { type: "string" },
    swap: { type: "string" },
    target: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});

const lpEntry = values["lp-entry"];
const swap = values.swap;
const target0G = values.target;

if (!lpEntry || !isAddress(lpEntry)) {
  throw new Error("--lp-entry must be a valid address.");
}
if (swap && !isAddress(swap)) {
  throw new Error("--swap must be a valid address.");
}
if (!target0G || !/^\d+(\.\d{1,18})?$/u.test(target0G)) {
  throw new Error("--target must be a positive decimal with <= 18 fractional digits.");
}

const rpcUrl = process.env.OG_RPC_URL?.trim();
const privateKey = process.env.DEPLOYER_PRIVATE_KEY?.trim();
if (!rpcUrl) {
  throw new Error("OG_RPC_URL is required.");
}
if (!privateKey || !/^0x[0-9a-fA-F]{64}$/u.test(privateKey)) {
  throw new Error("DEPLOYER_PRIVATE_KEY must be a 32-byte private key hex string.");
}

const account = privateKeyToAccount(privateKey);
const chain = {
  id: 16661,
  name: "0G Mainnet",
  nativeCurrency: { decimals: 18, name: "0G", symbol: "0G" },
  rpcUrls: { default: { http: [rpcUrl] } },
};

const abi = parseAbi([
  "function depositNative() payable",
  "function owner() view returns (address)",
]);

const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });

const target = parseEther(target0G);
if (target <= 0n) {
  throw new Error("--target must be > 0.");
}

const [owner, entryBefore, swapBefore, ownerBefore] = await Promise.all([
  publicClient.readContract({ address: lpEntry, abi, functionName: "owner" }),
  publicClient.getBalance({ address: lpEntry }),
  swap ? publicClient.getBalance({ address: swap }) : Promise.resolve(undefined),
  publicClient.getBalance({ address: account.address }),
]);

if (owner.toLowerCase() !== account.address.toLowerCase()) {
  throw new Error(`DEPLOYER_PRIVATE_KEY controls ${account.address}, but LP Entry owner is ${owner}.`);
}

const before = {
  account: account.address,
  lpEntry,
  swap,
  target0G,
  entryBefore0G: formatEther(entryBefore),
  swapBefore0G: swapBefore === undefined ? undefined : formatEther(swapBefore),
  ownerBefore0G: formatEther(ownerBefore),
};
console.log(JSON.stringify({ before }, null, 2));

if (entryBefore >= target) {
  console.log(JSON.stringify({ skipped: true, reason: "LP Entry already funded", entryBalance0G: formatEther(entryBefore) }, null, 2));
  process.exit(0);
}

const missing = target - entryBefore;
const gasBuffer = parseEther("0.001");
if (ownerBefore < missing + gasBuffer) {
  throw new Error(`Owner balance ${formatEther(ownerBefore)} 0G is below missing deposit ${formatEther(missing)} 0G plus gas buffer.`);
}

const simulation = await publicClient.simulateContract({
  account: account.address,
  address: lpEntry,
  abi,
  functionName: "depositNative",
  args: [],
  value: missing,
});

if (values["dry-run"]) {
  console.log(JSON.stringify({ dryRun: true, depositAmount0G: formatEther(missing) }, null, 2));
  process.exit(0);
}

const depositTxHash = await walletClient.writeContract({
  ...simulation.request,
  account,
  chain,
  value: missing,
});
console.log(JSON.stringify({ depositTxHash, depositAmount0G: formatEther(missing) }, null, 2));

const receipt = await publicClient.waitForTransactionReceipt({
  hash: depositTxHash,
  confirmations: 1,
  timeout: 180_000,
});
if (receipt.status !== "success") {
  throw new Error(`depositNative reverted: ${depositTxHash}`);
}

const [entryAfter, swapAfter, ownerAfter] = await Promise.all([
  publicClient.getBalance({ address: lpEntry }),
  swap ? publicClient.getBalance({ address: swap }) : Promise.resolve(undefined),
  publicClient.getBalance({ address: account.address }),
]);

console.log(JSON.stringify({
  after: {
    status: receipt.status,
    blockNumber: receipt.blockNumber.toString(),
    entryAfter0G: formatEther(entryAfter),
    swapAfter0G: swapAfter === undefined ? undefined : formatEther(swapAfter),
    ownerAfter0G: formatEther(ownerAfter),
  },
}, null, 2));
