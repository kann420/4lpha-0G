const smokeName = process.argv[2] ?? "";

const supported = new Set([
  "compute",
  "storage",
  "galileo-proof",
  "deposit-swap",
  "deposit-lp",
  "policy-swap",
  "policy-lp",
  "buy",
  "sell",
  "pause",
  "revoke",
  "withdraw",
  "lp-lifecycle",
  "lp-v4",
  "lp-partial",
  "sweep",
]);

if (!supported.has(smokeName)) {
  console.error(`Unknown V4 smoke '${smokeName}'.`);
  process.exitCode = 1;
} else {
  console.log(`V4 smoke '${smokeName}' is registered. Live execution remains a manual Phase 4 gate.`);
}
