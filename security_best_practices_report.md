# Security Best Practices Report

Date: 2026-06-20

## Executive Summary

Mainnet Policy Vault is deployed and the app now points at a fresh factory for user-selected policy limits at vault creation. The previous capped factory was smoke-tested with real 0G and fully withdrawn. The highest-risk findings from the vault work are fixed: owner vault squatting, mock/mainnet adapter misuse, incomplete policy enforcement, weak mainnet readiness checks, and single-pool routing limits. No critical or high unresolved vault issue is known after the current verification pass. Remaining risks are operational: proof-registry key custody, public launch rate limiting, and ongoing review of curated route liquidity.

## Fixed Findings

1. High: arbitrary vault creation for another owner.
   Impact: an attacker could create the first vault for a user wallet and cause the UI to resolve a hostile vault.
   Fix: `PolicyVaultFactory.createVault` now requires `msg.sender == owner` and sets a sentinel before deployment.
   Evidence: `contracts/PolicyVaultFactory.sol:23`, `contracts/PolicyVaultFactory.sol:31`, `contracts/PolicyVaultFactory.sol:40`; test `keeps factory vault creation owner-bound and one vault per owner`.

2. High: mainnet adapter and price-floor logic could not be reviewed as a real DEX path.
   Impact: pointing mainnet at a mock/no-op/raw adapter could strand or drain vault funds.
   Fix: added `CuratedUniswapV3RouteAdapter`, which supports only constructor-curated 0G/W0G routes through ZIA/TradeGPT and Oku Uniswap V3 routers. The executor can choose a route id already allowlisted by the vault, but cannot provide arbitrary calldata, routers, pools, targets, or recipients. `TradeRequest.quotedAmountOut` lets the vault enforce slippage bps against quote output units instead of incorrectly comparing output tokens to native input units.
   Evidence: `contracts/CuratedUniswapV3RouteAdapter.sol:48`, `contracts/CuratedUniswapV3RouteAdapter.sol:152`, `contracts/CuratedUniswapV3RouteAdapter.sol:276`, `contracts/PolicyVault.sol:30`, `contracts/PolicyVault.sol:431`; test `routes native/token swaps through curated single-hop and multi-hop route ids`.

3. High: policy fields existed but were not enforced consistently.
   Impact: if proof/executor control failed, finite caps/cooldown would not constrain repeated spend.
   Fix: buy path enforces per-trade cap, daily cap, cooldown, and max exposure; sell path observes cooldown and reduces tracked exposure.
   Evidence: `contracts/PolicyVault.sol:252`, `contracts/PolicyVault.sol:273`, `contracts/PolicyVault.sol:455`; test `enforces finite trade caps, daily caps, cooldown, and exposure when configured`.

4. Medium: mainnet frontend and tooling lacked real readiness checks.
   Impact: users could see misleading mainnet state or create with incomplete config.
   Fix: mainnet creation is readiness-gated, `allowMockAdapter=false`, and `scripts/check-mainnet-vault-config.ts` verifies chain, bytecode, adapter kind, router/W0G, every curated route id, factory pool registration, token pairs, fees, and visible pool liquidity.
   Evidence: `scripts/check-mainnet-vault-config.ts:265`, `scripts/check-mainnet-vault-config.ts:311`; `npm run check:vault:mainnet` passed.

## Existing Controls

- Secrets remain server/local only; no Router key or private key is exposed through `NEXT_PUBLIC_*`.
- Copilot route validates request schema, caps body size, rate-limits locally, and calls 0G Compute Router server-side only.
- Contracts enforce owner-only withdraw/rescue/pause/revoke, no generic execute/delegatecall/multicall, immutable adapter, token/pool allowlists, proof binding, replay protection, deadline window, nonzero min-out, balance-delta checks, and mock-adapter blocking on chain `16661`.
- Mainnet funding smoke is explicit, capped by `MAINNET_SMOKE_DEPOSIT_0G <= 0.05`, and does not revoke executor unless separately enabled.

## Current Mainnet Evidence

- Core deployed: active factory `0x9bcb67fe731c6eb1ed0c51f1b821100cc8ce25c4`, proof registry `0xfe87d95b76e297bb28b0ec4dd72b15cfc2b14e7a`.
- Curated route adapter deployed: `0xfaa8a8e03307dd901054e16ee89189d006dbf6db`.
- Reviewed primary router paths: ZIA/TradeGPT router `0x18cCa38E51c4C339A6BD6e174025f08360FEEf30`, ZIA factory `0x6F3945Ab27296D1D66D8EEb042ff1B4fb2E0CE70`, Oku `SwapRouter02` `0x807F4E281B7A3B324825C64ca53c69F0b418dE40`, Oku factory `0xcb2436774C3e191c85056d248EF4260ce5f27A9D`, W0G `0x1Cd0690fF9a693f5EF2dD976660a8dAFc81A109c`.
- Curated final assets: USDC.e, WETH, WBTC, SOL, cbBTC, LINK, oUSDT, and st0G across 11 immutable route ids.
- Previous capped factory `0x573f8b229f5d3692ef23c02c44e2902c2d52d103` real funding smoke passed for vault `0xe61C757c03f7454905eaED99748F78e9430B5e79`: create, deposit `0.001` 0G, pause, resume, withdraw; final on-chain vault balance is `0`.
- Active factory deployment block: `36625275`. No vault was auto-created on the active factory so the owner can choose limits in the UI before signing.

## Open Risks

1. ProofRegistry ownership is still single-operator unless moved to multisig/timelock.
2. Copilot rate limiting is in-memory/demo-grade; use durable per-wallet/session quotas before public launch.
3. The curated ZIA/Oku pools are live and verified, but liquidity and token risk can change over time.
4. `.env.local` contains live secrets by design. Rotate any key that is copied, synced, screenshotted, or committed.

## Verification

- `npx hardhat compile` passed.
- `npx hardhat test` passed: 19 tests.
- `npx tsc --noEmit --pretty false` passed.
- `npm run lint` passed.
- `npm run build` passed.
- `npm run smoke:preflight:mainnet` passed.
- `npm run check:vault:mainnet` passed.
- `npm run smoke:vault:mainnet` passed earlier with real 0G deposit/withdraw on the previous capped factory.
- `npm run deploy:vault:mainnet:adapter` passed and deployed the active curated route adapter.
- `npm run deploy:vault:mainnet:factory` passed and deployed the active user-limit factory.
