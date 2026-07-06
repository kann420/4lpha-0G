# Zia / TradeGPT Partner API

This is the safe public-repo reference for the partner-only Zia / TradeGPT API
used by the 0G-native LP Agent and one-click LP MVP. Do not commit the real host
URL, full request URLs, private docs, keys, or partner access details.

## Configuration

- `ZIA_TRADEGPT_API_BASE_URL=`: set the real partner-only base URL in
  `.env.local` or deployment secrets.
- `ZIA_TRADEGPT_API_TIMEOUT_MS=10000`
- Chain: 0G mainnet only for these endpoints, `chainId=16661`
- Keep API access server-side. Do not call these endpoints directly from client
  components.
- Rate limits are modest; handle `429` with a short retry/backoff.

## Capabilities

The partner API currently covers:

- Pool discovery and single-pool lookup.
- Token metadata and token price lookup.
- Swap route planning for balancing single-sided LP deposits before minting.
- LP vault staking metadata shared by Zia for pools that currently have a vault.

Keep endpoint paths and schemas in the server module that wraps the API, and
avoid exposing full upstream URLs in UI, logs, screenshots, docs, fixtures, or
client bundles.

## Endpoint Paths

Use `ZIA_TRADEGPT_API_BASE_URL` as the base URL. Do not commit the real host.

```text
GET /pools?chainId=16661
GET /pools/{poolAddress}?chainId=16661
GET /tokens?chainId=16661
GET /tokens?chainId=16661&includePrices=true
GET /token?symbol=W0G&chainId=16661
GET /token?address={tokenAddress}&chainId=16661
POST /route
```

The route endpoint expects JSON. Keep request construction server-side and use
the user's wallet or vault address as `recipient`; the all-zero address
placeholder returns `400`.

Observed request wire shape:

- `chainId`
- `inTokenAddress`, `outTokenAddress`
- `amount`
- `amountTokenSide` (`INPUT` when `amount` is the input token quantity)
- `recipient`
- `slippageTolerance` as a decimal fraction from `0` to `1` (`0.005` for 50 bps)

## Observed Pool Shape

Use pool responses for LP discovery, ranking, filters, and detail pages.

- `id`
- `name`
- `poolAddress`
- `npmAddress`
- `chainId`
- `feeTier`
- `isActive`
- `token0`, `token1`: `symbol`, `address`, `decimals`, `priceUSD`
- `metrics`: `tvlUSD`, `volume30d`, `volume24h`, `liquidity`, `token0Amount`, `token1Amount`
- `apr`: `total`, `trading`, `staking`

Important: Zia said advertised APR comes from staking rewards. Minting an LP
position alone is not enough to receive the advertised APR; the position must be
staked in the relevant vault.

## Observed Token Shape

Use token responses for token metadata, aliases, logos, and USD pricing.

- `address`
- `decimals`
- `symbol`
- `name`
- `slug`
- `chainId`
- `aliases`
- `logoUrl`
- `isNative`
- `price`
- `priceChange24h`

## Observed Route Shape

Use route responses for partner route planning. For PolicyVaultV3 LP min-floor
calculation, do not use `/route` output unless the returned path and fee exactly
match the LP adapter's `exactInputSingle` pool; the live executor quotes the
exact pool with Zia QuoterV2 to mirror the adapter. Use the real user wallet or
vault address as `recipient`; the all-zero address placeholder returns `400`.

- `chainId`
- `inToken`, `outToken` (some responses may return `inTokenAddress`,
  `outTokenAddress`; normalize these aliases server-side)
- `amount`
- `amountTokenSide`
- `hooks`
- `commands`
- `inputs`
- `expectedOutAmount`
- `slippageTolerance`
- `amountIn`
- `amountOut`
- `amountOutMin`
- `path`
- `isMultiHop`
- `encodedPath`
- `intermediateTokens`
- `fee`
- `fees`
- `priceImpact`
- `routingSource`
- `fallbackReason`

## Known Zia Contracts

From Zia docs:

- `UniswapV3Factory`: `0x6F3945Ab27296D1D66D8EEb042ff1B4fb2E0CE70`
- `NonfungiblePositionManager`: `0x5143ba6007C197b4cF66c20601b9dB97E0F98c6A`
- `NonfungibleTokenPositionDescriptor`: `0xEaD94c93e7398B68e3DeDd639340A535dABBd7f2`
- `SwapRouter`: `0x18cCa38E51c4C339A6BD6e174025f08360FEEf30`
- `QuoterV2`: `0x23b55293b7F06F6c332a0dDA3D88d8921218425B`
- `TickLens`: `0xAEA8Bfd12ec08622444E6112ec7089aC2ceFBba5`

The API pool response also returns `npmAddress`; prefer the API value for the
selected pool if it differs, then verify bytecode and ABI compatibility before
using it.

## Zia LP Vault Stake Flow

After the LP is minted, it is a Uniswap V3 position NFT. For any pool with a Zia
vault, approve the matching vault for that NFT, then deposit the NFT into the
vault:

```solidity
NonfungiblePositionManager.approve(vaultAddress, tokenId);
ZiaVault(vaultAddress).deposit(tokenId);
```

After deposit, `NonfungiblePositionManager.ownerOf(tokenId)` returns the vault
contract, not the original wallet. Use `ZiaVault.depositorOf(tokenId)` to map a
vaulted position back to the user/wallet.

### Zia Vault ABI

```solidity
function deposit(uint256 tokenId) external;
function withdraw(uint256 tokenId) external;
function depositorOf(uint256 tokenId) external view returns (address);
function getDepositedTokenIds(address depositor) external view returns (uint256[]);
function depositedCountOf(address depositor) external view returns (uint256);
function liquidityOf(uint256 tokenId) external view returns (uint128);
```

Use:

- `deposit(tokenId)` to stake the LP NFT into the pool's Zia vault.
- `withdraw(tokenId)` for manual withdraw from the vault.
- `getDepositedTokenIds(wallet)` for staked-position tracking UI.
- `depositorOf(tokenId)` to prove the wallet that owns a vaulted position.
- `liquidityOf(tokenId)` to display vaulted position liquidity.

### Pool Vaults

These are the pool-to-vault mappings currently shared by Zia.

| Pool | Fee | Pool address | Vault address |
| --- | --- | --- | --- |
| USDC/W0G | 1% | `0x159fe1d57b464eD60E2bfbBCA0dF444999131673` | `0x9585354Ff9778813eACD5850498185c932bB99E9` |
| W0G/WETH | 1% | `0x8d3f4d8276f02c1deebc73348894e676026196cd` | `0xEb7e8e43D81311d4667361186F6207F5225AC55c` |
| WBTC/W0G | 1% | `0x0d227571872b8305afd53b9dbd384bdbcde15f82` | `0x20d8E9163F2e8C00982250498D6728c229cE5fA9` |
| USDC/USDT | 0.01% | `0x526df22afa26aca3af82ee24a114ea333c32851a` | `0x55e036e6b57134b147b395c48e77b0c30d4c978d` |
| USDC/WETH | 0.3% | `0x22b46cd7402773878b1d74a02037d83f58e942ec` | `0xa5091727aA86eb031DA4CcD050CAD53321c18Bab` |
| USDC/LINK | 0.3% | `0xBdb60e0C534Cd9db07Dd8560d74801f8fB5Cb2E3` | `0x6e64cddc2d85cdd287002bf1c1eec649973f8595` |
| USDC/SOL | 0.3% | `0x422b1fde29a7560ab3a35248b3a23AE675F5E10f` | `0x6265A754bFd1F21408202D70d926CC3Fc094CF39` |
| W0G/USDC | 0.3% | `0x23336572435ec92d25ef0dd2d468b2a1abf7bb4f` | `0xBB4D91Ce1eA8434A419549319E4C0b08F3671225` |
| WBTC/USDC | 0.3% | `0xd356377752c708621d23c8d886fe2f5ca5f9cec2` | `0xb7ACB2Ed1F4Fb8f16846B7b3f2C8C608660aF1D3` |
| W0G/WBTC | 0.3% | `0xf6c606f70bec81bc0c4e82c83ac16ca0e5331262` | `0x1385512e094b29ea5984A8756339F4D92f9ec438` |
| W0G/WETH | 0.3% | `0x20a96caf06e0ce4e9cb30f75999a6c21a484cd49` | `0x95a20c19fE0DAf01bfB9195C3a36b43A9b59406f` |

## LP MVP Flow

1. Fetch pools from the partner API.
2. Filter active pools by token allowlist, TVL, APR, and user-selected risk settings.
3. Fetch token prices from the partner API.
4. If the user deposits single-sided `0G`, wrap to `W0G`, quote the exact LP
   pool swap with Zia QuoterV2, then mint a position through the
   Zia `NonfungiblePositionManager`.
5. Approve the matching Zia vault for the minted `tokenId`.
6. Deposit the `tokenId` into the matching Zia vault.
7. Track staked token IDs with `getDepositedTokenIds(wallet)`.
8. Store the agent decision and transaction plan in 0G Storage and anchor the
   proof hash on 0G Chain.
9. For v1, support manual `withdraw(tokenId)` and a planned/manual zap-out path
   back to `0G`.

## Missing Information To Request From Zia

- Claim rewards method, if rewards are not auto-accounted or auto-claimed.
- Pending rewards view method.
- Reward token metadata.
- Whether `withdraw(tokenId)` auto-claims rewards or only returns the LP NFT.
- Cooldown, lockup, or penalty rules, if any.
- Any recommended tick range strategy or whether full-range positions are
  acceptable for the hackathon MVP.
- Confirm whether pools omitted from the vault table have no staking vault yet
  or were simply left out of the partner note.
