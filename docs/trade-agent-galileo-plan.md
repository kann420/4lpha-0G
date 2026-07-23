# Plan: Production-Like Trade Agent on 0G Galileo Testnet

## 1. Objective and Locked Principles

- Build a real-transaction Trade Agent on 0G Galileo, chain ID `16602`, consisting of:
  - A Galileo-specific, quote-aware V4 Swap Vault.
  - Reserve-backed sandbox AMM.
  - 0G Storage.
  - ProofRegistry.
  - A Galileo-local agent record and on-chain vault agent key.
- Galileo network parameters must follow the official [0G Chain configuration](https://build.0g.ai/chain).
- The LP Agent remains a mock rehearsal on testnet and is outside this scope.
- No mainnet transactions, deployments, migrations, contract upgrades, or state changes are permitted.
- Mainnet UI and pure logic may be reused, but all Galileo RPCs, keys, addresses, deployment artifacts, registries, and stateful server modules must be isolated.
- Galileo agent records are not ERC-7857 Agentic IDs. This scope must not deploy, mint, authorize, revoke, or wire an Agentic ID/verifier on Galileo, and it must not make a mainnet read or write for identity purposes.
- Save this approved plan to `D:\4lpha-0G\docs\trade-agent-galileo-plan.md` as the first implementation action. The file has not been created during Plan Mode because workspace mutations are not permitted.

## 2. Mainnet Isolation and Root Policy Compliance

### Agent identity policy

Do not modify `AGENTS.md`. Its mainnet-only Agentic ID requirement remains authoritative.

- Galileo uses a server-generated local `agentRef` plus a vault `agentKey`; neither is an ERC-7857 identity and neither may be labelled as one in the UI, API, Storage bundle, or evidence.
- The server derives the key with a domain-separated hash of the Galileo chain ID, canonical vault, owner, and server-generated agent reference. The client never supplies an agent key or agent reference.
- The owner enables or disables this exact key on the Galileo vault. In this scope, disabling the key and revoking the executor are the actual trading kill switches; no identity authorization is represented as trading authority.
- The Galileo code path must not import `contracts/AgenticID.sol`, `lib/contracts/agentic-id.ts`, mainnet identity addresses, or any identity/verifier environment variable.

### Galileo sandbox adapter policy

Add a Galileo sandbox exception to the DEX adapter rules:

- A reserve-backed sandbox adapter is permitted on public Galileo testnet only when:
  - Swaps change real on-chain reserves.
  - Quotes include real price impact.
  - The adapter is contract-enforced to run only on chain ID `16602`.
  - The adapter accepts calls only from an on-chain-attested canonical Galileo Swap Vault with the expected executor, ProofRegistry, adapter, token, pool ID, and `allowMockAdapter=false` configuration.
  - Direct EOA calls, fake `owner()` contracts, and registry entries that have not passed the configuration attestation revert.
  - The UI labels it as sandbox liquidity.
- It must not be presented as Zia liquidity, public market liquidity, or mainnet liquidity.
- `MockDexAdapter` remains forbidden in public testnet configuration.
- `PolicyVaultV4SwapGalileo` must be deployed with `allowMockAdapter=false`.

### Environment isolation

Add Galileo-specific variables:

- Network and Storage:
  - `OG_GALILEO_RPC_URL`.
  - `OG_GALILEO_STORAGE_RPC_URL`.
  - `OG_GALILEO_STORAGE_INDEXER_URL`.
- Server-only signers:
  - `GALILEO_DEPLOYER_PRIVATE_KEY`.
  - `GALILEO_PROOF_ATTESTOR_PRIVATE_KEY`.
  - `GALILEO_VAULT_ATTESTOR_PRIVATE_KEY`.
  - `GALILEO_VAULT_EXECUTOR_PRIVATE_KEY`.
- Feature gates:
  - `ENABLE_GALILEO_DEPLOY=false`.
  - `ENABLE_GALILEO_TRADE=false`.
- Contract addresses:
  - `PROOF_REGISTRY_GALILEO_ADDRESS`.
  - `NEXT_PUBLIC_VAULT_REGISTRY_V4_GALILEO_ADDRESS`.
  - `NEXT_PUBLIC_GALILEO_SANDBOX_TOKEN_ADDRESS`.
  - `NEXT_PUBLIC_GALILEO_SANDBOX_POOL_ADDRESS`.
  - `NEXT_PUBLIC_GALILEO_SANDBOX_ADAPTER_ADDRESS`.

Galileo modules must never read:

- `*_MAINNET_*` variables.
- Mainnet deployment artifacts.
- Mainnet agent registries.
- Generic `DEPLOYER_PRIVATE_KEY`.
- Generic `OG_RPC_URL` or `OG_CHAIN_ID` as a fallback.
- Generic address variables as fallback.

Every Galileo write path must verify all of the following before simulation or broadcast:

- `OG_NETWORK=testnet`.
- Configured chain ID equals `16602`.
- Live RPC `eth_chainId` equals `16602`.
- Mainnet deployment flags are disabled.
- Required Galileo-specific addresses and keys are present.
- Each configured contract address has bytecode on Galileo.
- Runtime bytecode hash, immutable/configuration reads, and cross-contract pointers match the approved Galileo deployment artifact.
- The deployer, ProofRegistry attestor, vault attestor, and vault executor resolve to distinct addresses. `ProofRegistry.owner()` must equal the dedicated proof attestor, never the executor.

Any mismatch must stop execution before a transaction is constructed or submitted.

### Process and route isolation

- Add a dedicated `ogGalileo` Hardhat network that reads only `OG_GALILEO_RPC_URL` and `GALILEO_DEPLOYER_PRIVATE_KEY`; it must have no generic or mainnet fallback. Do not reuse the current generic `ogGalileo` configuration or legacy `smoke-galileo.ts`.
- Add a simulated `hardhatGalileo` network with chain ID `16602`. Sandbox contract tests must run there; a normal local chain must prove the adapter and Galileo vault reject the wrong chain.
- A browser write must require explicit `networkId=testnet` and `chainId=16602` before any module resolves a signer, RPC URL, address, or persisted record. Missing, unknown, or mismatched values fail closed; no testnet-shaped request may enter a mainnet module.
- Browser POST routes use a strict configured Origin allowlist and no wildcard CORS. Internal workers use server-only module calls, never the browser route.
- Service-wallet sponsorship is restricted to a server-controlled enrolled/canary owner set with per-owner, per-IP, and global quotas before any Storage upload or chain write. Enrollment and quotas are never accepted from the request body.

## 3. Galileo Contracts and Deployment

### Shared testnet infrastructure

Deploy a new dedicated stack. Do not reuse the old Galileo mock vault or legacy proof records.

Deployment order:

1. `ProofRegistry`.
2. `GalileoVaultRegistryV4`.
3. `GalileoDemoUSDC`.
4. `GalileoSandboxPool`.
5. `GalileoSandboxSwapAdapter`.
6. Set the adapter on the pool through a one-time owner call.
7. Seed pool liquidity.
8. Transfer `ProofRegistry` ownership to the dedicated proof attestor and configure the dedicated vault attestor.

Persist the resulting addresses and transaction hashes in:

`D:\4lpha-0G\.data\deployments\galileo-trade-stack.json`

The deployment artifact must include:

- Schema version.
- Chain ID.
- Deployer address.
- Deployment block.
- Every contract address.
- Every deployment/configuration transaction hash.
- Pool ID.
- Initial reserves.
- Runtime bytecode hashes and expected configuration/codehash attestations.
- Separate deployer, proof-attestor, vault-attestor, and executor addresses plus ownership-transfer transaction hashes.
- A declaration that the artifact contains no secrets, signatures, RPC credentials, or mainnet identifiers.

### GalileoDemoUSDC

- Name must visibly identify it as a Galileo test token.
- Symbol: `mUSDC`.
- Decimals: `6`.
- Maximum supply: `1,000,000 mUSDC`.
- Provide an on-chain faucet:
  - `10 mUSDC` per wallet.
  - One claim every 24 hours.
- Faucet tokens are wallet demo assets only.
- Transferring faucet tokens into a vault must not increase the vault’s `positionUnits`; only inventory acquired through a vault `buy` is sellable by the agent.

### GalileoSandboxPool

- Support only native 0G ↔ mUSDC.
- Use a constant-product reserve formula.
- Swap fee: `30 bps`.
- Quotes must derive from current on-chain reserves.
- Minimum-output enforcement is mandatory.
- Only the configured sandbox adapter may call the swap function.
- Adapter configuration is one-time and cannot be replaced.
- The pool and adapter use reentrancy guards and internal accounted reserves. Every swap checks exact input receipt, exact output transfer, reserve deltas, and the constant-product/fee invariant.
- Direct native transfers revert where EVM semantics permit; forced native/token donations never change accounted reserves or become withdrawable swap output.
- Liquidity is seeded once and locked, or every later owner top-up must be strictly ratio-preserving against accounted reserves. There is no owner withdrawal or unbalanced liquidity operation that can move the price.
- Initial target reserves:
  - `1 0G`.
  - `1,000 mUSDC`.
- Operational warning thresholds:
  - Native reserve below `0.25 0G`.
  - mUSDC reserve below `250 mUSDC`.

Required pool surface:

- `setAdapter(address)` — owner-only, one-time.
- `addLiquidity(uint256 tokenAmount)` — owner-only and payable.
- `quoteExactIn(address tokenIn, uint256 amountIn)`.
- `swapExactIn(address tokenIn, uint256 amountIn, uint256 amountOutMin)` — adapter-only.

- The pool exposes enough immutable/read-only configuration for the vault and deployment verifier to prove token, fee, adapter, and accounted reserve values.

### GalileoSandboxSwapAdapter

- Implement `IPolicyVaultAdapter` plus a Galileo-only trusted `quoteExactIn` read surface used by the vault in the same transaction as the swap.
- Adapter kind:
  - A dedicated Galileo sandbox identifier.
  - Must not equal the existing mock adapter kind.
- Pool ID:
  - `keccak256("4LPHA_GALILEO_0G_MUSDC_V1")`.
- Support only:
  - Native 0G → mUSDC.
  - mUSDC → native 0G.
- Reject every other pair and pool ID.
- Reject every caller except an attested `PolicyVaultV4SwapGalileo` whose registry attestation commits to its runtime code hash, owner, executor, this adapter, this ProofRegistry, mUSDC, sandbox pool ID, and `allowMockAdapter=false`.
- Do not treat the current `VaultRegistryV4.owner()` check as sufficient attestation. `GalileoVaultRegistryV4` performs the config/codehash check before recording the vault, and exposes an immutable attestation predicate for the adapter.
- Recipient is always the calling vault.
- The executor cannot select a recipient.
- For sells:
  - Pull the exact token input from the vault.
  - Approve the pool for the exact amount.
  - Reset approval to zero after the swap.
  - Forward the exact native output back to the calling vault.
- Constructor and swap entrypoint must revert unless `block.chainid == 16602`.
- Pool and adapter contracts must be tested on a simulated chain configured with chain ID `16602`.

### Galileo-specific contract boundary

- Reuse `ProofRegistry` only as a newly deployed Galileo instance, with ownership transferred to the dedicated proof attestor.
- Do not reuse `PolicyVaultV4Swap` unchanged. Deploy a separate `PolicyVaultV4SwapGalileo` with the same deny-by-default V4 policy surface plus these mandatory fixes:
  - It validates the agent key in both `buy` and `sell`; a disabled key cannot open or liquidate a position.
  - It obtains the sandbox adapter/pool quote in the same transaction, rejects a request quote that differs from that trusted quote, and derives the policy min-out floor from the trusted quote rather than executor input.
  - It rejects a nonzero min-out below `max(vaultMinOutFor(trustedQuote), userSignedMinOut)` and does not accept a caller-selected recipient, pool, token pair, or adapter.
  - It is deployed and callable only on chain ID `16602`.
- Deploy `GalileoVaultRegistryV4`, not the ownership-only `VaultRegistryV4`, so adapter access is gated by an explicit canonical-vault configuration attestation.
- No Galileo `AgenticID`, verifier, transfer path, identity address, or identity metadata is deployed or configured.

## 4. Per-User V4 Swap Vault

### Vault creation

- The connected user wallet deploys its own `PolicyVaultV4SwapGalileo`.
- Server-side deployment is not used because the constructor requires `initialOwner == msg.sender`.
- Only the Swap vault is deployed on Galileo.
- No V4 LP Entry or LP Exit vault is deployed.
- Constructor configuration:
  - Owner: connected wallet.
  - Executor: Galileo executor address.
  - Adapter: Galileo sandbox adapter.
  - Proof registry: Galileo ProofRegistry.
  - Allowed token: mUSDC.
  - Allowed pool: Galileo sandbox pool ID.
  - Mock adapter allowed: `false`.
  - Vault registry: GalileoVaultRegistryV4.
- After deployment, the owner requests a read-only config verification and the dedicated vault attestor records the exact canonical vault configuration in `GalileoVaultRegistryV4`. The adapter remains unusable until this attestation exists.
- Creation must be resumable:
  - Read the registry first.
  - Reuse an already registered and correctly configured vault.
  - Never deploy a second vault when a valid one already exists.

### Default vault policy

- Per-trade cap: `0.01 0G`.
- Daily cap: `0.05 0G`.
- Maximum exposure: `0.05 0G`.
- Cooldown: `15 seconds`.
- Maximum deadline window: `300 seconds`.
- Default minimum output: `9900 bps`.
- UI default buy amount: `0.001 0G`.
- UI maximum slippage input: `100 bps`.
- For an exact-in request, `amountOutMin` is the nonzero maximum of the on-chain trusted-quote vault floor and the owner-signed user-slippage floor. The executor may reject or re-preview a stale quote, but may never lower either floor.

### Funding model

- The user obtains Galileo 0G from the official faucet.
- The user pays for:
  - Vault deployment.
  - Registry registration.
  - Deposit and owner-control transactions.
  - mUSDC faucet claim.
- There is no general application gas sponsor.
- Galileo service wallets pay only for their existing roles:
  - ProofRegistry acceptance.
  - Executor buy/sell transactions.
- Sponsorship is limited to enrolled canary owners and bounded server-side quotas; the public UI never turns either service wallet into an unmetered relay.

## 5. Galileo Agent Record and Audit Metadata

### Dedicated Galileo server path

Add a server-only Galileo module and `POST /api/agents/galileo/deploy`. Do not loosen, import, or reuse `assertMainnetDeployEnv`.

The flow has a prepare step that creates a server-owned agent reference/key and a deployment action-consent record. The final request may include only the exact prepared values and must include:

- Strictly validated agent configuration and runtime settings, with explicit size, count, decimal, and allowlist bounds.
- Connected owner address.
- Explicit `networkId=testnet` and chain ID `16602`.
- A server-issued, short-lived, single-use deployment action consent.
- A high-entropy `clientRequestId` bound to the canonical deployment payload digest.

The signed consent binds the application domain, `16602`, owner, canonical vault, server-generated `agentRef`, derived `agentKey`, configuration/runtime digest, adapter/pool/proof-registry configuration digest, client request ID, nonce, and expiry. A generic Copilot wallet-access signature is never accepted for deployment or any funds-moving action.

Before consuming consent, uploading Storage data, or touching a service wallet, the server must:

- Validate the strict request schema and exact prepared payload digest.
- Validate the signature, expiry, Origin, enrolled-sponsor eligibility, and nonce.
- Atomically claim the `(testnet, owner, clientRequestId)` idempotency record in a durable store. The record stores the canonical digest and state; the same key with a different digest returns `409`.
- Verify that the owner has an attested Galileo Swap Vault and that the vault code hash/version, owner, executor, adapter, ProofRegistry, mUSDC, pool ID, mock flag, pause/revoke state, and attestation all match the approved stack.
- Enforce the local per-owner agent quota only after the above checks. The quota is a service-sponsorship limit, not an identity claim.

### Agent metadata Storage upload

Upload a deterministic, redacted metadata bundle containing only:

- Schema version, network ID, chain ID, server-generated local `agentRef`, and derived `agentKey`.
- Agent name and bounded filters, runtime limits, owner/vault/executor addresses, policy hash, adapter/pool IDs, redacted model/provider metadata, and creation timestamp.
- The canonical prepared configuration digest and an authorization digest, never a raw authorization artifact.

The bundle must never contain a wallet signature or signed message, authorization nonce, cookie, header, private key, RPC credential, API key, raw prompt, unredacted provider payload, or mainnet identifier. The same exclusion applies to logs, local artifacts, API responses, and errors. The proof-bound vault request nonce may appear only as an action field, never as a wallet-authorization artifact.

The Galileo Storage uploader must:

- Use `@0gfoundation/0g-storage-ts-sdk` and only Galileo Storage RPC/indexer configuration.
- Serialize with a versioned canonical serializer, calculate the bound audit root from those exact UTF-8 bytes, upload, download with proof verification, and compare bytes byte-for-byte.
- Persist the verified audit root, Storage root/reference, transaction hash, sequence, and verification result only after the comparison succeeds.

If upload or verified retrieval fails, mark the durable idempotency record blocked, create no agent record, and return a sanitized blocked response.

### Local agent record and arming

After verified Storage retrieval, persist a Galileo-local record in `.data/agents/galileo-agents.json` containing the exact Storage reference, audit root, local `agentRef`, derived key, vault, executor, and verification state. The record is not an Agentic ID and has no ERC-7857 address or token ID.

- The owner then calls `setAgentKeyEnabled(agentKey, true)` on `PolicyVaultV4SwapGalileo`.
- The agent is armed only after server-side on-chain confirmation that the exact key is enabled and the vault remains attested, unpaused, and unrevokeed.
- Mainnet agent registries, mainnet identity modules, and browser/session rehearsal records must never be read or written by this path.

## 6. Live Trade Pipeline

### Preview

The Galileo preview path must read live:

- Pool reserves and quote.
- Vault native balance.
- Vault policy.
- Daily usage.
- Cooldown.
- Open exposure.
- Allowed token and pool.
- Agent-key status.
- Sellable inventory for the selected agent key.

The preview must calculate:

- Quoted output.
- Price impact.
- Pool fee.
- User slippage floor.
- Vault `minOutFor` floor.
- Final nonzero `amountOutMin`.
- Policy decision and blocking reason.

### Execute

`POST /api/agent/trade` remains the UI-facing endpoint.

For an explicit `networkId=testnet` and `chainId=16602`, it dispatches through a fail-closed route boundary to a new Galileo-only V4 executor module. It must never fall through to `executeStubAgentTrade`, a generic executor ABI, or a mainnet module. The mainnet branch is reached only by an explicit mainnet request and remains unchanged.

The Galileo executor uses only the `PolicyVaultV4SwapGalileo` ABI, including the mandatory `agentKey` field. It rejects an omitted, zero, mismatched, or disabled key before a proof or trade transaction is constructed.

Testnet execution requires:

- A short-lived, single-use, action-specific owner consent; generic wallet-access proof is rejected.
- Owner and vault match.
- Armed agent key.
- `clientRequestId`.
- A verified Galileo configuration/attestation and on-chain role separation.
- A rate limit of five valid executions per enrolled wallet per minute, plus global and trusted-proxy IP limits before expensive Storage or chain work.
- This UI route supports manual, exactly consented trades only. No cron/background autonomous execution is in this Galileo scope.

The signed consent and idempotency record bind the exact normalized tuple:

- Owner.
- Canonical vault, local agent reference, and agent key.
- `networkId=testnet`, chain ID `16602`, adapter, pool ID, and vault policy hash.
- Side, amount in, trusted quote, nonzero minimum output, and quote block/reserve snapshot.
- Request ID, payload digest, server-issued nonce, and expiry.

A durable state machine atomically claims `(testnet, owner, agentRef, clientRequestId)` before Storage, proof, or executor side effects. It records `claimed`, `storage_verified`, `proof_submitted`, `proof_accepted`, `trade_submitted`, `confirmed`, or terminal failure with transaction hashes. A duplicate with the same digest returns the stored/in-flight result; the same key with a different digest returns `409`. Crash recovery reconciles receipts before doing another write. A JSON read-modify-write store or process-local map is not sufficient.

### Required execution order

Each buy or sell must perform these steps:

1. Parse a strict bounded request, verify the exact Galileo route boundary and Origin, validate the owner consent, and atomically claim its idempotency record.
2. Read an on-chain reserve/quote snapshot and validate vault balance, caps, cooldown, exposure, token, pool, attestation, pause/revoke state, and agent key.
3. Calculate the nonzero `amountOutMin` as the maximum of the vault trusted-quote floor and signed user floor. Build the canonical request/configuration digest and require an exact signature match.
4. Build a redacted, canonically serialized trade audit bundle that includes the exact request, trusted quote, quote block/reserves, policy hash, agent key, and no secret or raw signature material.
5. Upload the exact bundle to Galileo Storage, download it with proof verification, compare bytes byte-for-byte, and bind the resulting verified audit root/reference.
6. Re-read the vault policy, attestation, agent key, and trusted quote immediately before proof acceptance. If any signed or policy-bound value changed, mark the attempt stale before spending ProofRegistry gas.
7. Calculate `vaultActionHash` and `actionHash` using the exact verified audit root and request.
8. Submit `ProofRegistry.acceptProof` with the dedicated proof-attestor signer, then wait for a successful receipt.
9. Read both `isAccepted(...)` and `proofFor(actionHash)`; compare every field against the expected audit root, policy hash, model metadata hash, vault action hash, canonical Storage reference, and local agent reference.
10. Revalidate the trusted quote, policy, key, and reserve state after the proof receipt. If stale, do not submit a trade and do not reuse the proof for another payload.
11. Submit `PolicyVaultV4SwapGalileo.buy` or `.sell` with the Galileo executor, wait for a successful receipt, parse the expected trade event, and verify vault/pool/token balance deltas.
12. Persist the complete evidence artifact and transition the durable record to its terminal status.

If Storage or proof acceptance fails:

- Do not submit the vault transaction.

If proof acceptance succeeds but the trade fails:

- Persist the failed attempt.
- Do not reuse the proof for a modified trade.
- A retry requires a new action consent, nonce, canonical audit bundle/root, action hash, and `clientRequestId`; an old signature cannot authorize it.

### Evidence model

Each completed trade must persist and expose:

- Storage root.
- Storage reference.
- Storage upload transaction.
- ProofRegistry transaction.
- Trade transaction.
- Action hash.
- Vault action hash.
- Policy snapshot hash.
- Agent reference and agent key.
- Quote and minimum output.
- Quote block number and reserve snapshot.
- Executed amount.
- Galileo block number.
- Verification status.

`ProofRegistry.isAccepted` is only the vault admission check; it does not independently bind the Storage reference, agent reference, or model metadata in its boolean return. The server must compare `proofFor(actionHash)` field-by-field and verify the canonical Storage bytes/root before exposing evidence. The UI labels the Storage link as server-verified evidence unless a future contract explicitly binds the reference.

Evidence artifacts and API responses never contain raw wallet consent text/signatures, service-wallet details, secret configuration, or raw provider errors.

The API metadata for testnet changes from `stub` to `wired`.

## 7. Public APIs, Types and State

### APIs

- `GET /api/agents?networkId=testnet&ownerAddress=...`
  - Returns only public, redacted Galileo chain evidence and uses `Cache-Control: no-store`.
  - It never returns runtime settings, filters, private record fields, or a signed artifact, and it never accepts a wallet signature in the URL.
- `POST /api/agents/galileo/workspace`
  - Returns the private Galileo workspace after a server-issued, expiring signed read challenge; it is `no-store` and Origin-checked.
- `POST /api/agents/galileo/deploy`
  - Verifies a deployment action consent, uploads verified metadata, and creates only a local Galileo agent record.
- `POST /api/agents/galileo/consent`
  - Creates a server-owned prepare record and one-time deployment/trade consent nonce; it never accepts an arbitrary agent key or config digest from the client.
- `POST /api/agent/trade`
  - Testnet preview and exactly consented real execution, with explicit `networkId=testnet` and `chainId=16602`.
  - Mainnet authorization and execution behavior remain unchanged.
- Existing mainnet-only low-level quote and execute routes remain mainnet-only.

### Types

Extend deployment and workspace records with:

- `networkId`.
- `chainId`.
- Vault address and version.
- Local agent reference, derived agent key, enable transaction, and vault-attestation reference.
- Storage root and reference.
- Proof and trade evidence.
- Sandbox route metadata.
- Canonical request/configuration digest, consent expiry, and idempotency status without any raw signature or nonce secret.

Existing mainnet records that lack network fields may be normalized as mainnet in memory, but must not be rewritten as part of this feature.

### State separation

Use separate stores:

- `.data/deployments/galileo-trade-stack.json`.
- `.data/agents/galileo-agents.json`.
- `.data/trades/galileo/`.
- A durable, atomic Galileo idempotency ledger outside browser/session storage.

No Galileo module may write:

- `mainnet-agents.json`.
- Mainnet V4 migration state.
- Mainnet deployment artifacts.
- Mainnet trade artifacts.
- Generic action-nonce or runtime JSON stores for authorization/idempotency.

## 8. UI Integration

### Fund/Vault UI

Reuse only the mainnet presentation. Implement a separate Galileo Swap-only wallet hook/module that pins chain ID `16602` and re-checks the registry, pool, adapter, and bytecode/configuration before every wallet transaction; do not conditionally reuse the mainnet V4 trio deployment hook.

- Create V4 Swap Vault.
- Register the vault.
- Deposit testnet 0G.
- Withdraw native 0G.
- Pause and unpause.
- Revoke executor.
- Enable and disable agent keys.
- Display policy and live balances.
- Display sandbox pool reserves and health.
- Provide an mUSDC faucet action.

### Agents UI

- Replace sessionStorage rehearsal records for Trading Agents with the Galileo server roster.
- Keep LP Agent rehearsal records unchanged.
- Reuse the mainnet Agent creation and detail layout.
- Show:
  - Local Galileo agent reference, explicitly labelled non-ERC-7857.
  - Vault address.
  - Agent-key state.
  - Storage root and verification state.
  - ProofRegistry evidence.
  - Buy/sell history.
  - Galileo explorer links.
- Required label:
  - `GALILEO TESTNET · REAL TX · SANDBOX LIQUIDITY`
- Forbidden claims:
  - Real money.
  - Mainnet liquidity.
  - Zia testnet pool.
  - Production DEX liquidity.
  - Agentic ID, ERC-7857 identity, TEE/ZKP identity transfer, or any mainnet identity claim.

### Trade UI

- Preview live quote and price impact.
- Show pool reserves, fee, slippage and vault minimum output.
- Require the exact short-lived owner action consent before manual execute and show the signed amount, minimum output, expiry, and agent key before signing.
- Disable execution when:
  - Agent key is not enabled.
  - Vault is paused or revoked.
  - Storage is unavailable.
  - Policy or liquidity checks fail.
- Disable new buys when a pre- or post-trade reserve would cross an operational floor. Do not use the native-reserve warning to blanket-block sells: an exit remains available when its own trusted quote, nonzero min-out, and actual liquidity checks pass. Owner withdrawal remains available independently.
- Show separate links for:
  - Storage upload.
  - Proof acceptance.
  - Trade transaction.
- Build explorer and Storage links only from allowlisted configured Galileo origins plus encoded hashes/references; never assign a persisted Storage reference directly to an `href`.

Verify desktop and mobile layouts.

## 9. Testing and Acceptance

### Contract tests

Run on a simulated network configured with chain ID `16602`.

Test:

- Constant-product quote correctness.
- 30 bps fee.
- Buy and sell reserve deltas.
- Minimum-output rejection.
- Insufficient-liquidity rejection.
- Unsupported token pair.
- Unsupported pool ID.
- Unauthorized pool caller.
- Direct EOA adapter caller rejection.
- Fake `owner()` vault and unattested/wrong-config vault rejection.
- Faucet mUSDC cannot enter through the adapter or drain/manipulate pool reserves outside an attested vault.
- Wrong-chain adapter rejection.
- Exact approval and reset-to-zero behavior.
- Fixed recipient behavior.
- Reentrancy protection.
- Accounted-reserve behavior under direct donations/forced native transfer, ratio-breaking liquidity, and exact input/output delta failures.
- One-time or ratio-preserving locked liquidity behavior.
- Faucet cap and cooldown.
- Faucet balances cannot inflate vault position accounting.
- Existing V4 policy tests:
  - Per-trade cap.
  - Daily cap.
  - Cooldown.
  - Exposure.
  - Replay protection.
  - Proof requirement.
  - Pause.
  - Revoke.
  - Malicious token and adapter behavior.
  - Disabled agent key rejects both a new buy and a sell of inventory acquired before disablement.
  - A malicious executor cannot weaken the floor with `quotedAmountOut=1` and `amountOutMin=1`.
  - A stale trusted quote rejects rather than executing at a lower floor.
  - Attestation/config/codehash mismatches reject before the adapter or vault can move value.
  - Proof attestor, vault attestor, executor, and deployer cannot perform each other's privileged write.
  - Buy reserve floors block new exposure, while a valid low-reserve sell and owner withdrawal remain possible.

### Server tests

Test that:

- Galileo config cannot resolve mainnet keys or addresses.
- Galileo Hardhat, Storage, executor, and UI modules cannot read generic RPC/key/address fallback variables or import mainnet/testnet-rehearsal modules.
- An RPC reporting chain ID `16661` fails before broadcast.
- Missing Galileo feature gates fail before broadcast.
- Missing, unknown, or cross-network route input fails before any config/signer resolution; a testnet-shaped request never reaches a mainnet module or stub executor.
- Storage root matches the downloaded bytes.
- Canonical Storage bytes contain none of the forbidden secret/signature fields.
- `proofFor` fields, not only `isAccepted`, match the exact audit root, canonical Storage reference, agent reference, model hash, and vault hashes.
- Proof acceptance occurs before the vault call.
- Deployment and execution reject generic wallet-access signatures and accept only correct, expiring, single-use action consents.
- The Galileo executor rejects a V2/generic ABI request or an omitted, zero, mismatched, or disabled V4 agent key before proof acceptance.
- Concurrent duplicate requests, changed-payload duplicate requests, and restart recovery do not create duplicate Storage, proof, or trade side effects.
- Public workspace reads return only redacted data with `no-store`; private workspace reads require an expiring signed challenge and no signature appears in URLs.
- Mainnet trade dispatch remains unchanged.

Run:

- `npm run contracts:compile`.
- `npm run contracts:test`.
- `npx tsc --noEmit`.
- `npm run build`.

### Live Galileo acceptance

The feature is not complete until a new integrated smoke run succeeds:

1. Deploy the dedicated Galileo stack.
2. Verify bytecode and configuration for every address on chain ID `16602`.
3. Deploy and register a user V4 Swap Vault.
4. Deposit a small amount of Galileo 0G.
5. Upload and verify an Agent metadata bundle.
6. Create the local Galileo agent record and enable its derived agent key.
7. Execute a signed buy of mUSDC with `0.001 0G`.
8. Verify the exact Storage bundle and every `proofFor` field.
9. Verify the V4 buy event, trusted quote, and balance deltas.
10. Disable the key and prove that both buy and sell fail; re-enable only on this disposable vault for the exit test.
11. Sell the acquired mUSDC back to native 0G.
12. Verify the second Storage bundle, proof, trade, and idempotency terminal record.
13. Test low-reserve behavior: a buy is blocked while an independently valid sell remains available.
14. Test pause and unpause.
15. Test withdraw.
16. Test irreversible executor revocation on a disposable vault only.
17. Verify the complete flow in the desktop and mobile UI.

### No-mainnet acceptance

- Do not run any `*:mainnet` script.
- Do not select the `ogMainnet` Hardhat network.
- Do not call any mainnet write endpoint.
- Run the Galileo process with no mainnet RPC, key, address, registry, or write-enable variable available; test that its config resolver rejects their presence or attempted fallback.
- Every submitted transaction must report runtime chain ID `16602`.
- Every transaction link must use the Galileo explorer.
- Mainnet deployment artifacts, agent registries and migration state must remain byte-for-byte unchanged.
- Final delivery must include an evidence table containing:
  - Contract deployment transactions.
  - Storage roots.
  - Vault-attestation transaction.
  - Agent-key enable transaction.
  - Proof transactions.
  - Buy and sell transactions.
  - Chain ID for every transaction.

## 10. Rollout

1. Save this plan to `docs/trade-agent-galileo-plan.md`.
2. Update `.env.example` with Galileo-only placeholders; leave `AGENTS.md` mainnet-only identity policy unchanged.
3. Add contract, role-separation, consent, idempotency, and configuration-isolation tests.
4. Implement and test the quote-aware Galileo vault, attested registry, sandbox token, pool, and adapter locally on `hardhatGalileo`.
5. Deploy shared Galileo infrastructure with `ENABLE_GALILEO_TRADE=false`.
6. Implement Galileo Storage, local-agent-record, consent, durable idempotency, and workspace modules.
7. Implement per-user Swap Vault creation.
8. Implement preview and execution pipeline.
9. Port the mainnet UI to the network-aware testnet path.
10. Run the complete live Galileo smoke using a canary wallet.
11. Enable `ENABLE_GALILEO_TRADE=true` only after the integrated Storage → ProofRegistry → V4 buy/sell flow passes.
12. Keep the LP Agent testnet path in rehearsal mode.

## Assumptions

- The selected execution backend is a reserve-backed sandbox AMM, not full Uniswap V3.
- Users obtain Galileo 0G from the official faucet.
- The application provides no general gas sponsorship; service-wallet proof/execution sponsorship is limited to enrolled canary owners and bounded quotas.
- A standalone Galileo Storage upload/download has already been verified, but the integrated trade pipeline is not considered verified until the new live acceptance run succeeds.
- A new ProofRegistry, quote-aware Galileo vault, attested registry, and sandbox stack are used to avoid mixing real evidence with legacy placeholder records.
- The LP Agent remains mock-only on testnet.
- No mainnet transaction is required for any implementation, deployment, verification, or acceptance step in this plan.
