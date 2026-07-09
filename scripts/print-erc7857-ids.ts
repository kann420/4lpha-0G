// One-off: compute the EIP-7857 interface IDs (type(IERC7857).interfaceId,
// type(IERC7857Metadata).interfaceId) from the compiled ABIs so they can be
// pinned in the server-side AgenticID verification. Run with: npx hardhat run
// scripts/print-erc7857-ids.ts --network hardhatMainnet  (network unused; just
// to satisfy hardhat's runner).  Outputs the two bytes4 IDs.
import { getFunctionSelector, type Abi } from "viem";
import { readFileSync } from "node:fs";

function xorBytes4(a: string, b: string): string {
  const ai = BigInt(a);
  const bi = BigInt(b);
  return "0x" + (ai ^ bi).toString(16).padStart(8, "0");
}

function interfaceIdFromAbi(abi: Abi): string {
  let id = "0x00000000";
  for (const item of abi) {
    if (item.type !== "function") continue;
    const sel = getFunctionSelector(item);
    id = xorBytes4(id, sel);
  }
  return id;
}

function loadAbi(path: string): Abi {
  const json = JSON.parse(readFileSync(path, "utf8")) as { abi: Abi };
  return json.abi;
}

const base = "artifacts/contracts/interfaces";
const i7857 = interfaceIdFromAbi(loadAbi(`${base}/IERC7857.sol/IERC7857.json`));
const i7857Meta = interfaceIdFromAbi(loadAbi(`${base}/IERC7857Metadata.sol/IERC7857Metadata.json`));
const i7857Verifier = interfaceIdFromAbi(loadAbi(`${base}/IERC7857DataVerifier.sol/IERC7857DataVerifier.json`));

console.log("IERC7857            interfaceId =", i7857);
console.log("IERC7857Metadata    interfaceId =", i7857Meta);
console.log("IERC7857DataVerifier interfaceId =", i7857Verifier);
console.log("ERC-165              interfaceId = 0x01ffc9a7");