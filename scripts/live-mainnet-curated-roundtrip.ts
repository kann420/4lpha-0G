import { join } from "node:path";

import dotenv from "dotenv";
import { formatEther, parseEther } from "viem";
import {
  executeCuratedTrade,
  maxScriptTrade0G,
  quoteCuratedTrade,
} from "../lib/agent/curated-trade";
import {
  readBoolEnv,
  readConfiguredVaultAddress,
  requireMainnetEnv,
  runIfDirect,
  writeJsonArtifact,
} from "./mainnet-vault-utils";

dotenv.config({ path: ".env.local", quiet: true });

async function main() {
  requireMainnetEnv("mainnet live curated route round-trip");
  if (!readBoolEnv("MAINNET_LIVE_ROUTE_TRADE_EXECUTE")) {
    throw new Error("Set MAINNET_LIVE_ROUTE_TRADE_EXECUTE=true to send live buy/sell transactions.");
  }

  const amount0G = process.env.MAINNET_LIVE_ROUTE_TRADE_BUY_0G?.trim() || "0.001";
  const amountWei = parseEther(amount0G);
  if (amountWei <= 0n || amountWei > maxScriptTrade0G()) {
    throw new Error(`MAINNET_LIVE_ROUTE_TRADE_BUY_0G must be greater than 0 and at most ${formatEther(maxScriptTrade0G())}.`);
  }

  const vaultAddress = readConfiguredVaultAddress();
  if (vaultAddress === null) {
    throw new Error("Set NEXT_PUBLIC_POLICY_VAULT_MAINNET_ADDRESS or POLICY_VAULT_MAINNET_ADDRESS.");
  }

  const tokenSymbol = process.env.MAINNET_LIVE_ROUTE_TRADE_TOKEN?.trim() || "USDC.e";
  const slippageBps = readBpsEnv("MAINNET_LIVE_ROUTE_TRADE_SLIPPAGE_BPS", 100);
  const mode = (process.env.MAINNET_LIVE_ROUTE_TRADE_MODE?.trim() || "roundtrip").toLowerCase();

  if (mode === "sell") {
    const sellAmount = process.env.MAINNET_LIVE_ROUTE_TRADE_SELL_AMOUNT?.trim();
    if (!sellAmount) {
      throw new Error("Set MAINNET_LIVE_ROUTE_TRADE_SELL_AMOUNT when MAINNET_LIVE_ROUTE_TRADE_MODE=sell.");
    }
    const sell = await executeCuratedTrade({
      amount: sellAmount,
      copilotAudit: {
        model: "live-mainnet-sell-script",
        policyContextHash: "script",
        promptHash: "script",
        responseHash: "script",
      },
      networkId: "mainnet",
      side: "sell",
      slippageBps,
      tokenSymbol,
      vaultAddress,
    });

    const outputPath = join(".data", "smoke", "mainnet-live-curated-sell.json");
    await writeJsonArtifact(outputPath, {
      sell: redactExecution(sell),
      tokenSymbol,
      vault: vaultAddress,
    });

    console.log("0G mainnet live curated route sell passed. Redacted artifact:", outputPath);
    console.log({
      route: sell.quote.route.label,
      sellTx: sell.executionTxHash,
      tokenSymbol,
      vault: vaultAddress,
    });
    return;
  }

  if (mode !== "roundtrip") {
    throw new Error("MAINNET_LIVE_ROUTE_TRADE_MODE must be roundtrip or sell.");
  }

  const buyQuote = await quoteCuratedTrade({
    amount: amount0G,
    networkId: "mainnet",
    side: "buy",
    slippageBps,
    tokenSymbol,
    vaultAddress,
  });

  const buy = await executeCuratedTrade({
    amount: amount0G,
    copilotAudit: {
      model: "live-mainnet-roundtrip-script",
      policyContextHash: "script",
      promptHash: "script",
      responseHash: "script",
    },
    networkId: "mainnet",
    routeId: buyQuote.route.id,
    side: "buy",
    slippageBps,
    vaultAddress,
  });

  const sell = await executeCuratedTrade({
    amount: buy.quote.amountOutMinFormatted,
    copilotAudit: {
      model: "live-mainnet-roundtrip-script",
      policyContextHash: "script",
      promptHash: "script",
      responseHash: "script",
    },
    networkId: "mainnet",
    routeId: buy.quote.route.id,
    side: "sell",
    slippageBps,
    vaultAddress,
  });

  const outputPath = join(".data", "smoke", "mainnet-live-curated-roundtrip.json");
  await writeJsonArtifact(outputPath, {
    buy: redactExecution(buy),
    sell: redactExecution(sell),
    tokenSymbol,
    vault: vaultAddress,
  });

  console.log("0G mainnet live curated route round-trip passed. Redacted artifact:", outputPath);
  console.log({
    buyTx: buy.executionTxHash,
    route: buy.quote.route.label,
    sellTx: sell.executionTxHash,
    tokenSymbol,
    vault: vaultAddress,
  });
}

function readBpsEnv(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1_000) {
    throw new Error(`${name} must be between 1 and 1000.`);
  }
  return parsed;
}

function redactExecution(execution: Awaited<ReturnType<typeof executeCuratedTrade>>) {
  return {
    actionHash: execution.actionHash,
    auditRoot: execution.auditRoot,
    executionTxHash: execution.executionTxHash,
    proofTxHash: execution.proofTxHash,
    quote: execution.quote,
    storageRef: execution.storageRef,
    vaultActionHash: execution.vaultActionHash,
  };
}

await runIfDirect(import.meta.url, main);

export { main };
