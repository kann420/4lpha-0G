import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { consumeActionNonce, issueActionNonce } from "../lib/copilot/action-nonce-store";
import { buildCopilotActionConsentMessage } from "../lib/copilot/wallet-access";
import { validateCopilotActionConsent } from "../lib/copilot/wallet-gate";

const account = privateKeyToAccount(generatePrivateKey());
const chainId = 16661;
const vault = "0x599bf69f54BAEF47C3A23cA85C5BC1Ef74868D29";
const agentId = "agent-0g-mainnet-1";
const poolAddress = "0xD9c8f2B074f71eD6510C87210e41E52E7B5753fE";
const otherPoolAddress = "0xf0996dc8Ff4d6Fb3b09f2bAf944d246FbBFD3f6c";

async function main() {
  const issue = issueActionNonce({ address: account.address, scope: "lp-mint" });
  const message = buildCopilotActionConsentMessage({
    address: account.address,
    agentId,
    amount0G: "0.01",
    chainId,
    networkId: "mainnet",
    action: "lp-mint",
    vault,
    poolAddress,
    tickLower: -1000,
    tickUpper: 1000,
    nonce: issue.nonce,
    expiresAt: issue.expiresAt,
  });
  const signature = await account.signMessage({ message });
  const wallet = { address: account.address, chainId, message, signature };

  const valid = await validateCopilotActionConsent(wallet, "mainnet", chainId, {
    action: "lp-mint",
    vault,
    agentId,
    poolAddress,
    tickLower: -1000,
    tickUpper: 1000,
    amount0G: "0.01",
    nonce: issue.nonce,
    expiresAt: issue.expiresAt,
  });
  assert(valid === undefined, "valid lp-mint consent passes");

  const replayFirst = consumeActionNonce({
    address: account.address,
    expiresAt: issue.expiresAt,
    nonce: issue.nonce,
    scope: "lp-mint",
  });
  assert(replayFirst === undefined, "issued nonce consumes once");
  const replaySecond = consumeActionNonce({
    address: account.address,
    expiresAt: issue.expiresAt,
    nonce: issue.nonce,
    scope: "lp-mint",
  });
  assert(replaySecond?.code === "consent_replayed", "replayed nonce is rejected");

  const mismatchIssue = issueActionNonce({ address: account.address, scope: "lp-mint" });
  const mismatchMessage = buildCopilotActionConsentMessage({
    address: account.address,
    agentId,
    amount0G: "0.01",
    chainId,
    networkId: "mainnet",
    action: "lp-mint",
    vault,
    poolAddress,
    tickLower: -1000,
    tickUpper: 1000,
    nonce: mismatchIssue.nonce,
    expiresAt: mismatchIssue.expiresAt,
  });
  const mismatchSignature = await account.signMessage({ message: mismatchMessage });
  const mismatch = await validateCopilotActionConsent(
    { address: account.address, chainId, message: mismatchMessage, signature: mismatchSignature },
    "mainnet",
    chainId,
    {
      action: "lp-mint",
      vault,
      agentId,
      poolAddress: otherPoolAddress,
      tickLower: -1000,
      tickUpper: 1000,
      amount0G: "0.01",
      nonce: mismatchIssue.nonce,
      expiresAt: mismatchIssue.expiresAt,
    },
  );
  assert(mismatch?.code === "wallet_signature_invalid", "pool mismatch is rejected");

  console.log("All action-consent smoke checks passed.");
}

function assert(value: boolean, message: string) {
  if (!value) throw new Error(`ASSERT FAILED: ${message}`);
  console.log(`ok: ${message}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
