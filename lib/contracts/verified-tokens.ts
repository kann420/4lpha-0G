import { getAddress, type Address } from "viem";
import { MAINNET_TOKENS } from "@/lib/contracts/curated-routes";
import type { AiScanVerifiedTokenProfile } from "@/lib/types/ai-scan";

const TRADEGPT_VERIFICATION_SOURCE = "TradeGPT curated Policy Vault token registry";

export const VERIFIED_MAINNET_TOKEN_PROFILES: Record<string, AiScanVerifiedTokenProfile> = {
  [MAINNET_TOKENS.USDC_E.toLowerCase()]: {
    address: MAINNET_TOKENS.USDC_E,
    badgeLabel: "Verified",
    category: "Bridged stablecoin",
    comparison: {
      nativeLabel: "Native USDC",
      rows: [
        {
          label: "Asset type",
          native: "Circle-native USDC",
          verified: "Bridge-native / wrapped USDC exposure",
        },
        {
          label: "Issuer / backing path",
          native: "Circle direct issuance",
          verified: "Across-style bridge route backed by USDC liquidity",
        },
        {
          label: "Contract reference",
          native: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
          verified: MAINNET_TOKENS.USDC_E,
        },
        {
          label: "Primary use",
          native: "General DeFi, payments, lending, institutional rails",
          verified: "Fast cross-chain transfer liquidity and 0G vault routes",
        },
      ],
      verifiedLabel: "USDC.e",
    },
    name: "USDC.e Token",
    notes: [
      "The .e suffix normally indicates a bridge-native or wrapped USDC variant, not Circle's native USDC contract.",
      "This profile is allowlisted for 4lpha Policy Vault routing, so owner() alone is treated as an operational note, not a safety downgrade.",
      "Live execution still requires nonzero amountOutMin, configured slippage limits, and the selected vault route.",
    ],
    protocol: "Across Protocol style bridge asset",
    recommendation:
      "Treat USDC.e as a verified vault asset. Prefer the configured W0G / USDC.e route, require nonzero amountOutMin, and keep normal vault slippage controls enabled.",
    summary:
      "USDC.e is the verified bridge-native USDC exposure used by 4lpha Policy Vault routes on 0G. It is distinct from Circle-native USDC and should be evaluated as an allowlisted route asset, not as an unknown token.",
    symbol: "USDC.e",
    verificationSource: TRADEGPT_VERIFICATION_SOURCE,
  },
  [MAINNET_TOKENS.WETH.toLowerCase()]: verifiedProfile({
    address: MAINNET_TOKENS.WETH,
    category: "Wrapped blue-chip asset",
    name: "WETH Token",
    protocol: "Wrapped Ether",
    recommendation:
      "Use the configured W0G / USDC.e / WETH or W0G / WETH route through the Policy Vault with nonzero amountOutMin and normal slippage limits.",
    summary:
      "WETH is a verified vault token for wrapped ETH exposure on 0G. It is allowlisted for reviewed 4lpha routes and should be treated as a catalog asset.",
    symbol: "WETH",
  }),
  [MAINNET_TOKENS.WBTC.toLowerCase()]: verifiedProfile({
    address: MAINNET_TOKENS.WBTC,
    category: "Wrapped blue-chip asset",
    name: "WBTC Token",
    protocol: "Wrapped Bitcoin",
    recommendation:
      "Use the configured W0G / WBTC route through the Policy Vault with nonzero amountOutMin and normal slippage limits.",
    summary:
      "WBTC is a verified vault token for wrapped BTC exposure on 0G. It is allowlisted for reviewed 4lpha routes and should be treated as a catalog asset.",
    symbol: "WBTC",
  }),
  [MAINNET_TOKENS.SOL.toLowerCase()]: verifiedProfile({
    address: MAINNET_TOKENS.SOL,
    category: "Bridged ecosystem asset",
    name: "SOL Token",
    protocol: "Bridged SOL route asset",
    recommendation:
      "Use the configured W0G / USDC.e / SOL route through the Policy Vault with nonzero amountOutMin and normal slippage limits.",
    summary:
      "SOL is a verified vault token for SOL exposure on 0G. It is allowlisted for reviewed 4lpha routes and should be treated as a catalog asset.",
    symbol: "SOL",
  }),
  [MAINNET_TOKENS.CBBTC.toLowerCase()]: verifiedProfile({
    address: MAINNET_TOKENS.CBBTC,
    category: "Wrapped blue-chip asset",
    name: "cbBTC Token",
    protocol: "Coinbase wrapped BTC",
    recommendation:
      "Use the configured W0G / USDC.e / cbBTC route through the Policy Vault with nonzero amountOutMin and normal slippage limits.",
    summary:
      "cbBTC is a verified vault token for BTC exposure on 0G. It is allowlisted for reviewed 4lpha routes and should be treated as a catalog asset.",
    symbol: "cbBTC",
  }),
  [MAINNET_TOKENS.LINK.toLowerCase()]: verifiedProfile({
    address: MAINNET_TOKENS.LINK,
    category: "Oracle network asset",
    name: "LINK Token",
    protocol: "Chainlink",
    recommendation:
      "Use the configured W0G / USDC.e / LINK route through the Policy Vault with nonzero amountOutMin and normal slippage limits.",
    summary:
      "LINK is a verified vault token for Chainlink exposure on 0G. It is allowlisted for reviewed 4lpha routes and should be treated as a catalog asset.",
    symbol: "LINK",
  }),
  [MAINNET_TOKENS.OUSDT.toLowerCase()]: verifiedProfile({
    address: MAINNET_TOKENS.OUSDT,
    category: "Bridged stablecoin",
    name: "oUSDT Token",
    protocol: "Bridged USDT route asset",
    recommendation:
      "Use the configured W0G / USDC.e / oUSDT route through the Policy Vault with nonzero amountOutMin and normal slippage limits.",
    summary:
      "oUSDT is a verified vault token for bridged USDT exposure on 0G. It is allowlisted for reviewed 4lpha routes and should be treated as a catalog asset.",
    symbol: "oUSDT",
  }),
  [MAINNET_TOKENS.ST0G.toLowerCase()]: verifiedProfile({
    address: MAINNET_TOKENS.ST0G,
    category: "Liquid staking asset",
    name: "st0G Token",
    protocol: "Staked 0G route asset",
    recommendation:
      "Use the configured W0G / st0G route through the Policy Vault with nonzero amountOutMin and normal slippage limits.",
    summary:
      "st0G is a verified vault token for staked 0G exposure. It is allowlisted for reviewed 4lpha routes and should be treated as a catalog asset.",
    symbol: "st0G",
  }),
};

export function getVerifiedMainnetTokenProfile(address: Address): AiScanVerifiedTokenProfile | undefined {
  return VERIFIED_MAINNET_TOKEN_PROFILES[getAddress(address).toLowerCase()];
}

function verifiedProfile({
  address,
  category,
  name,
  protocol,
  recommendation,
  summary,
  symbol,
}: {
  address: Address;
  category: string;
  name: string;
  protocol: string;
  recommendation: string;
  summary: string;
  symbol: string;
}): AiScanVerifiedTokenProfile {
  return {
    address,
    badgeLabel: "Verified",
    category,
    name,
    notes: [
      "This token is included in the 4lpha curated Policy Vault registry.",
      "Owner(), proxy hints, or incomplete holder data are treated as operational notes unless critical exploit evidence is present.",
      "Live execution still requires nonzero amountOutMin, configured slippage limits, and the selected vault route.",
    ],
    protocol,
    recommendation,
    summary,
    symbol,
    verificationSource: TRADEGPT_VERIFICATION_SOURCE,
  };
}
