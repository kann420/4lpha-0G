import { getAddress, keccak256, stringToHex, type Address, type Hex } from "viem";

export const ROUTER_KIND_DEADLINE = 1;
export const ROUTER_KIND_NO_DEADLINE = 2;

export interface CuratedPolicyVaultRoute {
  confidence: "high" | "medium" | "experimental";
  factory: Address;
  fees: number[];
  id: Hex;
  label: string;
  path: Address[];
  pools: Address[];
  router: Address;
  routerKind: typeof ROUTER_KIND_DEADLINE | typeof ROUTER_KIND_NO_DEADLINE;
  symbol: string;
  tokenOut: Address;
  venue: "ZIA" | "Oku";
}

export const W0G_MAINNET = getAddress("0x1Cd0690fF9a693f5EF2dD976660a8dAFc81A109c");

export const ZIA_MAINNET = {
  factory: getAddress("0x6F3945Ab27296D1D66D8EEb042ff1B4fb2E0CE70"),
  quoterV2: getAddress("0x23b55293b7F06F6c332a0dDA3D88d8921218425B"),
  router: getAddress("0x18cCa38E51c4C339A6BD6e174025f08360FEEf30"),
} as const;

export const OKU_MAINNET = {
  factory: getAddress("0xcb2436774C3e191c85056d248EF4260ce5f27A9D"),
  quoterV2: getAddress("0xaa52bB8110fE38D0d2d2AF0B85C3A3eE622CA455"),
  router02: getAddress("0x807F4E281B7A3B324825C64ca53c69F0b418dE40"),
} as const;

export const MAINNET_TOKENS = {
  CBBTC: getAddress("0xa5613ac7f1E83a68719b1398c8F6aAA25581db82"),
  LINK: getAddress("0x76159c2b43ff6F630193e37EC68452169914C1Bb"),
  OUSDT: getAddress("0x1217BfE6c773EEC6cc4A38b5Dc45B92292B6E189"),
  SOL: getAddress("0x2b269F9deb4804C5A4BD97E4D951c775BEAA0cc5"),
  ST0G: getAddress("0x7bBC63D01CA42491c3E084C941c3E86e55951404"),
  USDC_E: getAddress("0x1f3AA82227281cA364bFb3d253B0f1af1Da6473E"),
  WBTC: getAddress("0x0555E30da8f98308EdB960aa94C0Db47230d2B9c"),
  WETH: getAddress("0x564770837Ef8bbF077cFe54E5f6106538c815B22"),
} as const;

const ZIA_POOLS = {
  OUSDT_USDC_E_100: getAddress("0x526df22afA26AcA3AF82eE24A114EA333C32851A"),
  USDC_E_CBBTC_10000: getAddress("0x23423bC4f93b0FF7960EEBe22FD45298854265e1"),
  USDC_E_LINK_3000: getAddress("0xBdb60e0C534Cd9db07Dd8560d74801f8fB5Cb2E3"),
  USDC_E_SOL_3000: getAddress("0x422b1FDE29a7560AB3A35248B3a23AE675F5E10f"),
  USDC_E_WETH_3000: getAddress("0x22b46CD7402773878B1D74A02037D83f58E942eC"),
  W0G_ST0G_3000: getAddress("0xd05AA6cAE0F4aB37c312Bcd09DAD90162B28F843"),
  W0G_USDC_E_10000: getAddress("0x159fe1d57b464eD60E2bfbBCA0dF444999131673"),
  W0G_WBTC_10000: getAddress("0x0D227571872B8305afd53B9Dbd384BDBcDE15F82"),
  W0G_WETH_10000: getAddress("0x8D3F4D8276F02C1dEEBC73348894e676026196CD"),
} as const;

const OKU_POOLS = {
  W0G_USDC_E_10000: getAddress("0xCE77377CDfEb967FF2Bb6f223AE74e1ae8DCFC71"),
  W0G_WBTC_10000: getAddress("0xf0766611cb1288186f74F401fDB5e606c4b23693"),
} as const;

export const CURATED_MAINNET_POLICY_VAULT_ROUTES = [
  ziaRoute("USDC.e", "W0G / USDC.e", [MAINNET_TOKENS.USDC_E], [10_000], [ZIA_POOLS.W0G_USDC_E_10000], "high"),
  ziaRoute("WETH", "W0G / USDC.e / WETH", [MAINNET_TOKENS.USDC_E, MAINNET_TOKENS.WETH], [10_000, 3_000], [ZIA_POOLS.W0G_USDC_E_10000, ZIA_POOLS.USDC_E_WETH_3000], "high"),
  ziaRoute("WBTC", "W0G / WBTC", [MAINNET_TOKENS.WBTC], [10_000], [ZIA_POOLS.W0G_WBTC_10000], "high"),
  ziaRoute("SOL", "W0G / USDC.e / SOL", [MAINNET_TOKENS.USDC_E, MAINNET_TOKENS.SOL], [10_000, 3_000], [ZIA_POOLS.W0G_USDC_E_10000, ZIA_POOLS.USDC_E_SOL_3000], "high"),
  ziaRoute("cbBTC", "W0G / USDC.e / cbBTC", [MAINNET_TOKENS.USDC_E, MAINNET_TOKENS.CBBTC], [10_000, 10_000], [ZIA_POOLS.W0G_USDC_E_10000, ZIA_POOLS.USDC_E_CBBTC_10000], "high"),
  ziaRoute("LINK", "W0G / USDC.e / LINK", [MAINNET_TOKENS.USDC_E, MAINNET_TOKENS.LINK], [10_000, 3_000], [ZIA_POOLS.W0G_USDC_E_10000, ZIA_POOLS.USDC_E_LINK_3000], "high"),
  ziaRoute("oUSDT", "W0G / USDC.e / oUSDT", [MAINNET_TOKENS.USDC_E, MAINNET_TOKENS.OUSDT], [10_000, 100], [ZIA_POOLS.W0G_USDC_E_10000, ZIA_POOLS.OUSDT_USDC_E_100], "medium"),
  ziaRoute("st0G", "W0G / st0G", [MAINNET_TOKENS.ST0G], [3_000], [ZIA_POOLS.W0G_ST0G_3000], "medium"),
  ziaRoute("WETH-direct", "W0G / WETH", [MAINNET_TOKENS.WETH], [10_000], [ZIA_POOLS.W0G_WETH_10000], "medium"),
  okuRoute("USDC.e-oku", "Oku W0G / USDC.e", [MAINNET_TOKENS.USDC_E], [10_000], [OKU_POOLS.W0G_USDC_E_10000], "medium"),
  okuRoute("WBTC-oku", "Oku W0G / WBTC", [MAINNET_TOKENS.WBTC], [10_000], [OKU_POOLS.W0G_WBTC_10000], "medium"),
] as const satisfies CuratedPolicyVaultRoute[];

export function uniqueCuratedMainnetTokens(): Address[] {
  return uniqueAddresses(CURATED_MAINNET_POLICY_VAULT_ROUTES.map((route) => route.tokenOut));
}

export function curatedMainnetRouteIds(): Hex[] {
  return CURATED_MAINNET_POLICY_VAULT_ROUTES.map((route) => route.id);
}

function ziaRoute(
  symbol: string,
  label: string,
  pathTail: Address[],
  fees: number[],
  pools: Address[],
  confidence: CuratedPolicyVaultRoute["confidence"],
): CuratedPolicyVaultRoute {
  return {
    confidence,
    factory: ZIA_MAINNET.factory,
    fees,
    id: routeId(`ZIA:${label}`),
    label,
    path: [W0G_MAINNET, ...pathTail],
    pools,
    router: ZIA_MAINNET.router,
    routerKind: ROUTER_KIND_DEADLINE,
    symbol,
    tokenOut: pathTail[pathTail.length - 1],
    venue: "ZIA",
  };
}

function okuRoute(
  symbol: string,
  label: string,
  pathTail: Address[],
  fees: number[],
  pools: Address[],
  confidence: CuratedPolicyVaultRoute["confidence"],
): CuratedPolicyVaultRoute {
  return {
    confidence,
    factory: OKU_MAINNET.factory,
    fees,
    id: routeId(`OKU:${label}`),
    label,
    path: [W0G_MAINNET, ...pathTail],
    pools,
    router: OKU_MAINNET.router02,
    routerKind: ROUTER_KIND_NO_DEADLINE,
    symbol,
    tokenOut: pathTail[pathTail.length - 1],
    venue: "Oku",
  };
}

function routeId(label: string): Hex {
  return keccak256(stringToHex(`4LPHA_0G_ROUTE:${label}`));
}

function uniqueAddresses(values: readonly Address[]): Address[] {
  const seen = new Set<string>();
  const result: Address[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
  }
  return result;
}
