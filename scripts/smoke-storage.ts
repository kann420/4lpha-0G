import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { Indexer, MemData } from "@0gfoundation/0g-storage-ts-sdk";
import dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config({ path: ".env.local", quiet: true });

const GALILEO_CHAIN_ID = 16602;
const MAINNET_CHAIN_ID = 16661;
const GALILEO_INDEXER_HOST = "indexer-storage-testnet-turbo.0g.ai";
const MAINNET_INDEXER_HOST = "indexer-storage-turbo.0g.ai";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function expectedIndexerHost(chainId: number) {
  return chainId === MAINNET_CHAIN_ID ? MAINNET_INDEXER_HOST : GALILEO_INDEXER_HOST;
}

function assertSingleUpload(
  result:
    | { txHash: string; rootHash: string; txSeq: number }
    | { txHashes: string[]; rootHashes: string[]; txSeqs: number[] },
) {
  if ("rootHash" in result) {
    return result;
  }
  if (result.rootHashes.length !== 1 || result.txHashes.length !== 1) {
    throw new Error("Unexpected fragmented upload result for tiny smoke payload");
  }
  return {
    rootHash: result.rootHashes[0],
    txHash: result.txHashes[0],
    txSeq: result.txSeqs[0],
  };
}

const chainId = Number(requireEnv("OG_CHAIN_ID"));
const rpcUrl = requireEnv("OG_STORAGE_RPC_URL");
const indexerUrl = requireEnv("OG_STORAGE_INDEXER_URL");
const privateKey = requireEnv("DEPLOYER_PRIVATE_KEY");

if (![GALILEO_CHAIN_ID, MAINNET_CHAIN_ID].includes(chainId)) {
  throw new Error(`Unsupported OG_CHAIN_ID ${chainId}`);
}
if (chainId === MAINNET_CHAIN_ID && (process.env.ENABLE_MAINNET_DEPLOY ?? "false").toLowerCase() !== "true") {
  throw new Error("Mainnet storage smoke requires ENABLE_MAINNET_DEPLOY=true");
}

const indexerHost = new URL(indexerUrl).host;
if (indexerHost !== expectedIndexerHost(chainId)) {
  throw new Error(`Storage indexer host ${indexerHost} does not match OG_CHAIN_ID ${chainId}`);
}

const provider = new ethers.JsonRpcProvider(rpcUrl);
const liveNetwork = await provider.getNetwork();
if (Number(liveNetwork.chainId) !== chainId) {
  throw new Error(`Storage RPC chain mismatch: expected ${chainId}, got ${liveNetwork.chainId.toString()}`);
}

const wallet = new ethers.Wallet(privateKey, provider);
const payload = {
  app: "4lpha-0g",
  kind: "policy-vault-storage-smoke",
  chainId,
  createdAt: new Date().toISOString(),
  redacted: true,
  fields: ["auditRoot", "policySnapshotHash", "vaultActionHash"],
};
const encoded = new TextEncoder().encode(`${JSON.stringify(payload)}\n`);
const file = new MemData(encoded);
const [tree, treeErr] = await file.merkleTree();
if (treeErr !== null || tree === null) {
  throw treeErr ?? new Error("Failed to compute storage Merkle root");
}
const expectedRoot = tree.rootHash();
if (expectedRoot === null) {
  throw new Error("Storage Merkle root was null");
}

const indexer = new Indexer(indexerUrl);
const [uploadResult, uploadErr] = await indexer.upload(file, rpcUrl, wallet);
if (uploadErr !== null) {
  throw uploadErr;
}
const singleUpload = assertSingleUpload(uploadResult);
if (singleUpload.rootHash !== expectedRoot) {
  throw new Error(`Root mismatch: SDK upload ${singleUpload.rootHash}, local ${expectedRoot}`);
}

const [blob, downloadErr] = await indexer.downloadToBlob(singleUpload.rootHash, { proof: true });
if (downloadErr !== null) {
  throw downloadErr;
}
const downloaded = new Uint8Array(await blob.arrayBuffer());
if (Buffer.compare(Buffer.from(downloaded), Buffer.from(encoded)) !== 0) {
  throw new Error("Downloaded bytes do not match uploaded audit payload");
}

const outputPath = join(".data", "storage-smoke", "last-result.json");
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(
  outputPath,
  `${JSON.stringify(
    {
      chainId,
      indexerHost,
      rootHash: singleUpload.rootHash,
      txHash: singleUpload.txHash,
      txSeq: singleUpload.txSeq,
      bytes: encoded.length,
    },
    null,
    2,
  )}\n`,
  "utf8",
);

console.log("0G Storage smoke passed. Redacted artifact:", outputPath);
console.log({
  chainId,
  rootHash: singleUpload.rootHash,
  txHash: singleUpload.txHash,
  bytes: encoded.length,
});
