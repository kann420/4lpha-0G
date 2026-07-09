import fs from "node:fs";
import path from "node:path";

const contracts = [
  ["PolicyVaultV4LpEntry", "policyVaultV4LpEntryBytecode"],
  ["PolicyVaultV4LpExit", "policyVaultV4LpExitBytecode"],
  ["PolicyVaultV4Swap", "policyVaultV4SwapBytecode"],
];

let output = `// Generated from Hardhat artifacts. Contract bytecode is public deployment data, not a secret.
import type { Hex } from "viem";

`;

for (const [contractName, exportName] of contracts) {
  const artifactPath = path.join("artifacts", "contracts", `${contractName}.sol`, `${contractName}.json`);
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  if (!artifact.bytecode || artifact.bytecode === "0x") {
    throw new Error(`${contractName} bytecode is missing. Run Hardhat compile first.`);
  }
  output += `export const ${exportName} = ${JSON.stringify(artifact.bytecode)} as Hex;\n\n`;
}

const targetPath = path.join("lib", "contracts", "policy-vault-v4-bytecode.ts");
fs.writeFileSync(targetPath, output);
console.log(`${path.resolve(targetPath)} ${fs.statSync(targetPath).size}`);
