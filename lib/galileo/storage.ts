import "server-only";

import { createPublicClient, http, isHex, type Hex } from "viem";

import { GALILEO_CHAIN_ID, resolveGalileoReadConfig, type GalileoReadConfig, type GalileoWriteConfig } from "@/lib/galileo/config";

export interface GalileoStorageProgress { rootHash: Hex; status: "prepared" | "submitted" | "uploaded"; txHash?: Hex; txSeq?: number }
export interface GalileoStorageResult { rootHash: Hex; storageRef: string; txHash: Hex; txSeq: number }

/**
 * Galileo-only Storage transport. The resolved deployer signer is deliberately
 * passed in by the caller: this service payer is not the proof attestor and
 * this module never reads generic or mainnet key variables.
 */
export async function uploadGalileoBytes(bytes: Uint8Array, input: Pick<GalileoWriteConfig, "storageIndexerUrl" | "storageRpcUrl" | "signers">, onProgress?: (progress: GalileoStorageProgress) => Promise<void> | void): Promise<GalileoStorageResult> {
  await assertGalileoStorageNetwork({ storageIndexerUrl: input.storageIndexerUrl, storageRpcUrl: input.storageRpcUrl });
  const [{ Indexer, MemData, Uploader, getFlowContract }, { ethers }] = await Promise.all([import("@0gfoundation/0g-storage-ts-sdk"), import("ethers")]);
  const file = new MemData(bytes);
  const [tree, treeError] = await file.merkleTree();
  if (treeError || !tree) throw treeError ?? new Error("Failed to compute Galileo Storage root.");
  const rootHash = tree.rootHash();
  if (!isHex(rootHash, { strict: true }) || rootHash.length !== 66) throw new Error("Galileo Storage returned an invalid root.");
  await onProgress?.({ rootHash: rootHash as Hex, status: "prepared" });
  const provider = new ethers.JsonRpcProvider(input.storageRpcUrl);
  const wallet = new ethers.Wallet(input.signers.deployer.privateKey, provider);
  const indexer = new Indexer(input.storageIndexerUrl);
  const [nodes, nodeError] = await indexer.selectNodes(1, "min");
  if (nodeError || nodes.length === 0) throw nodeError ?? new Error("Galileo Storage indexer returned no upload nodes.");
  const status = await nodes[0].getStatus();
  if (!status || Number(status.networkIdentity.chainId) !== GALILEO_CHAIN_ID) throw new Error("Galileo Storage node is not on chain 16602.");
  const flow = getFlowContract(status.networkIdentity.flowAddress, wallet);
  const uploader = new Uploader(nodes, input.storageRpcUrl, flow) as unknown as DirectUploader;
  const [submission, submissionError] = await file.createSubmission("0x", await wallet.getAddress());
  if (submissionError || !submission) throw submissionError ?? new Error("Failed to create Galileo Storage submission.");
  const [rawTxHash, txError] = await uploader.submitLogEntryNoReceipt(submission, {});
  if (txError || !isHex(rawTxHash, { strict: true })) throw txError ?? new Error("Galileo Storage returned an invalid transaction hash.");
  const txHash = rawTxHash as Hex;
  await onProgress?.({ rootHash: rootHash as Hex, status: "submitted", txHash });
  const receipt = await uploader.waitForReceipt(txHash, { Retries: 60, Interval: 2, MaxGasPrice: 0 });
  if (!receipt) throw new Error("Timed out waiting for Galileo Storage submission.");
  const log = receipt.logs.map((entry) => { try { return entry.address.toLowerCase() === status.networkIdentity.flowAddress.toLowerCase() ? flow.interface.parseLog(entry) : null; } catch { return null; } }).find((entry) => entry?.name === "Submit");
  if (!log) throw new Error("Galileo Storage receipt did not contain Submit.");
  const txSeq = Number(log.args.submissionIndex);
  const tasks = await uploader.splitTasks({ finalized: false, isCached: false, tx: { seq: txSeq, size: Number(log.args.length), startEntryIndex: Number(log.args.startPos) }, uploadedSegNum: 0 }, tree, { expectedReplica: 1, finalityRequired: false, taskSize: 1 });
  if (!tasks) throw new Error("Failed to create Galileo Storage upload tasks.");
  const results = await uploader.processTasksInParallel(file, tree, tasks, { Interval: 1, MaxGasPrice: 0, Retries: 60, TooManyDataRetries: 3 });
  const failed = results.find((result) => result instanceof Error);
  if (failed instanceof Error) throw failed;
  await onProgress?.({ rootHash: rootHash as Hex, status: "uploaded", txHash, txSeq });
  return { rootHash: rootHash as Hex, storageRef: `0g-storage:${rootHash}:tx:${txHash}:seq:${txSeq}`, txHash, txSeq };
}

export async function downloadAndVerifyGalileoBytes(storageRefOrRoot: string, expectedBytes: Uint8Array, config: Pick<GalileoReadConfig, "storageIndexerUrl" | "storageRpcUrl"> = resolveGalileoReadConfig()): Promise<boolean> {
  await assertGalileoStorageNetwork(config);
  const rootHash = extractRoot(storageRefOrRoot);
  const { Indexer } = await import("@0gfoundation/0g-storage-ts-sdk");
  const indexer = new Indexer(config.storageIndexerUrl);
  const [blob, error] = await indexer.downloadToBlob(rootHash, { proof: true });
  if (error || !blob) throw error ?? new Error("Galileo Storage download failed.");
  const actual = new Uint8Array(await blob.arrayBuffer());
  return actual.length === expectedBytes.length && actual.every((byte, index) => byte === expectedBytes[index]);
}

export async function assertGalileoStorageNetwork(config: Pick<GalileoReadConfig, "storageIndexerUrl" | "storageRpcUrl">): Promise<void> {
  const chainId = await createPublicClient({ transport: http(config.storageRpcUrl) }).getChainId();
  if (chainId !== GALILEO_CHAIN_ID) throw new Error("Galileo Storage RPC must point to chain 16602.");
  const { Indexer } = await import("@0gfoundation/0g-storage-ts-sdk");
  const [nodes, error] = await new Indexer(config.storageIndexerUrl).selectNodes(1, "min");
  if (error || nodes.length === 0) throw error ?? new Error("Galileo Storage indexer returned no nodes.");
  const status = await nodes[0].getStatus();
  if (!status || Number(status.networkIdentity.chainId) !== GALILEO_CHAIN_ID) throw new Error("Galileo Storage indexer selected a non-16602 node.");
}

function extractRoot(value: string): Hex {
  const match = value.match(/^0g-storage:(0x[0-9a-fA-F]{64}):tx:0x[0-9a-fA-F]{64}:seq:\d+$/u) ?? value.match(/^(0x[0-9a-fA-F]{64})$/u);
  if (!match || !isHex(match[1], { strict: true })) throw new Error("Galileo Storage reference is invalid.");
  return match[1] as Hex;
}

type DirectUploader = { processTasksInParallel(file: unknown, tree: unknown, tasks: unknown[], opts: { Interval: number; MaxGasPrice: number; Retries: number; TooManyDataRetries: number }): Promise<Array<Error | number | null>>; splitTasks(info: unknown, tree: unknown, opts: { expectedReplica: number; finalityRequired: boolean; taskSize: number }): Promise<unknown[] | null>; submitLogEntryNoReceipt(submission: unknown, opts: object): Promise<[string, Error | null]>; waitForReceipt(txHash: string, opts: { Interval: number; MaxGasPrice: number; Retries: number }): Promise<{ logs: Array<{ address: string; data: string; topics: readonly string[] }> } | null> };
