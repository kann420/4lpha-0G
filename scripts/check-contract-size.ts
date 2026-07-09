import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ARTIFACT_ROOT = join(process.cwd(), "artifacts", "contracts");
const HARD_CAP_BYTES = 24_576;
const LP_TARGET_BYTES = 23_000;

const requiredContracts = new Set([
  "PolicyVaultV4Swap",
  "PolicyVaultV4LpEntry",
  "PolicyVaultV4LpExit",
  "VaultRegistryV4",
  "ZiaLpAdapterV4",
]);

interface ContractArtifact {
  contractName?: string;
  deployedBytecode?: string;
}

interface SizeRow {
  contractName: string;
  size: number;
  hardCapPass: boolean;
  lpTargetPass: boolean;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".json") && !entry.name.endsWith(".dbg.json")) {
      out.push(fullPath);
    }
  }
  return out;
}

function deployedSize(artifact: ContractArtifact): number | null {
  const bytecode = artifact.deployedBytecode;
  if (typeof bytecode !== "string" || bytecode === "0x") {
    return null;
  }
  return (bytecode.length - 2) / 2;
}

if (!existsSync(ARTIFACT_ROOT)) {
  console.error(`Missing Hardhat artifact directory: ${ARTIFACT_ROOT}`);
  console.error("Run npx hardhat compile before the size probe.");
  process.exit(1);
}

const rows: SizeRow[] = [];
for (const file of walk(ARTIFACT_ROOT)) {
  const artifact = JSON.parse(readFileSync(file, "utf8")) as ContractArtifact;
  if (artifact.contractName === undefined || !requiredContracts.has(artifact.contractName)) {
    continue;
  }
  const size = deployedSize(artifact);
  if (size === null) {
    continue;
  }
  rows.push({
    contractName: artifact.contractName,
    size,
    hardCapPass: size < HARD_CAP_BYTES,
    lpTargetPass: size < LP_TARGET_BYTES,
  });
}

rows.sort((a, b) => a.contractName.localeCompare(b.contractName));

console.log("V4 contract size probe");
console.log(`Hard cap: < ${HARD_CAP_BYTES} bytes`);
console.log(`LP target: < ${LP_TARGET_BYTES} bytes for PolicyVaultV4LpEntry and PolicyVaultV4LpExit`);
console.log("");
console.log("Contract                  Bytes   <23000B   <24576B");
console.log("------------------------  ------  --------  --------");

let failed = false;
for (const row of rows) {
  const enforceLpTarget = row.contractName === "PolicyVaultV4LpEntry" || row.contractName === "PolicyVaultV4LpExit";
  const pass = row.hardCapPass && (!enforceLpTarget || row.lpTargetPass);
  failed ||= !pass;
  const size = String(row.size).padStart(6, " ");
  const lp = enforceLpTarget ? (row.lpTargetPass ? "PASS" : "FAIL") : "n/a";
  const hard = row.hardCapPass ? "PASS" : "FAIL";
  console.log(`${row.contractName.padEnd(24, " ")}  ${size}  ${lp.padEnd(8, " ")}  ${hard}`);
}

const missing = [...requiredContracts].filter((name) => !rows.some((row) => row.contractName === name));
if (missing.length > 0) {
  failed = true;
  console.log("");
  console.log(`Missing artifacts: ${missing.join(", ")}`);
}

if (failed) {
  console.log("");
  console.log("V4 contract size probe: FAIL");
  process.exit(1);
}

console.log("");
console.log("V4 contract size probe: PASS");
