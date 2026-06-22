import { createPublicClient, http, isHex, type Hex } from "viem";

const MAINNET_CHAIN_ID = 16661;

export interface ZeroGStorageProgress {
  rootHash: Hex;
  status: "prepared" | "submitted" | "uploaded";
  txHash?: Hex;
  txSeq?: number;
}

export interface ZeroGStorageUploadResult {
  rootHash: Hex;
  storageRef: string;
  txHash: Hex;
  txSeq: number;
}

export async function uploadBytesTo0GStorage(
  encoded: Uint8Array,
  onProgress?: (progress: ZeroGStorageProgress) => Promise<void> | void,
): Promise<ZeroGStorageUploadResult> {
  const indexerUrl = requireEnv("OG_STORAGE_INDEXER_URL");
  const rpcUrl = requireEnv("OG_STORAGE_RPC_URL");
  const privateKey = readPrivateKeyEnv("DEPLOYER_PRIVATE_KEY");
  const [{ Indexer, MemData, Uploader, getFlowContract }, { ethers }] = await Promise.all([
    import("@0gfoundation/0g-storage-ts-sdk"),
    import("ethers"),
  ]);

  const client = createPublicClient({ transport: http(rpcUrl) });
  const chainId = await client.getChainId();
  if (chainId !== MAINNET_CHAIN_ID) {
    throw new Error(`0G Storage RPC must point to chain ${MAINNET_CHAIN_ID}.`);
  }

  const file = new MemData(encoded);
  const [tree, treeError] = await file.merkleTree();
  if (treeError !== null || tree === null) {
    throw treeError ?? new Error("Failed to compute 0G Storage root.");
  }
  const rootHash = tree.rootHash();
  if (!isHex(rootHash, { strict: true }) || rootHash.length !== 66) {
    throw new Error("0G Storage returned an invalid local root.");
  }
  await onProgress?.({ rootHash: rootHash as Hex, status: "prepared" });

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);
  const indexer = new Indexer(indexerUrl);
  const [nodes, nodeError] = await indexer.selectNodes(1, "min");
  if (nodeError !== null || nodes.length === 0) {
    throw nodeError ?? new Error("0G Storage indexer returned no upload nodes.");
  }
  const status = await nodes[0].getStatus();
  if (status === null || Number(status.networkIdentity.chainId) !== MAINNET_CHAIN_ID) {
    throw new Error("0G Storage node status was unavailable or on the wrong chain.");
  }

  const flow = getFlowContract(status.networkIdentity.flowAddress, wallet);
  const uploader = new Uploader(nodes, rpcUrl, flow) as unknown as DirectUploader;
  const [submission, submissionError] = await file.createSubmission("0x", await wallet.getAddress());
  if (submissionError !== null || submission === null) {
    throw submissionError ?? new Error("Failed to create 0G Storage submission.");
  }

  const [submittedTxHash, txError] = await uploader.submitLogEntryNoReceipt(submission, {});
  if (txError !== null) {
    throw txError;
  }
  if (!isHex(submittedTxHash, { strict: true })) {
    throw new Error("0G Storage returned an invalid transaction hash.");
  }
  const txHash = submittedTxHash as Hex;
  await onProgress?.({ rootHash: rootHash as Hex, status: "submitted", txHash });

  const receipt = await uploader.waitForReceipt(txHash, { Retries: 60, Interval: 2, MaxGasPrice: 0 });
  if (receipt === null) {
    throw new Error(`Timed out waiting for 0G Storage receipt: ${txHash}`);
  }
  const parsedLog = receipt.logs
    .map((log) => {
      try {
        return log.address.toLowerCase() === status.networkIdentity.flowAddress.toLowerCase()
          ? flow.interface.parseLog(log)
          : null;
      } catch {
        return null;
      }
    })
    .find((log) => log?.name === "Submit");
  if (!parsedLog) {
    throw new Error("0G Storage submit receipt did not contain a Submit event.");
  }

  const txSeq = Number(parsedLog.args.submissionIndex);
  const info = {
    finalized: false,
    isCached: false,
    tx: {
      seq: txSeq,
      size: Number(parsedLog.args.length),
      startEntryIndex: Number(parsedLog.args.startPos),
    },
    uploadedSegNum: 0,
  };
  const tasks = await uploader.splitTasks(info, tree, {
    expectedReplica: 1,
    finalityRequired: false,
    taskSize: 1,
  });
  if (tasks === null) {
    throw new Error("Failed to create 0G Storage upload tasks.");
  }
  const results = await uploader.processTasksInParallel(file, tree, tasks, {
    Interval: 1,
    MaxGasPrice: 0,
    Retries: 60,
    TooManyDataRetries: 3,
  });
  const failed = results.find((result) => result instanceof Error);
  if (failed instanceof Error) {
    throw failed;
  }
  await onProgress?.({ rootHash: rootHash as Hex, status: "uploaded", txHash, txSeq });

  return {
    rootHash: rootHash as Hex,
    storageRef: `0g-storage:${rootHash}:tx:${txHash}:seq:${txSeq}`,
    txHash,
    txSeq,
  };
}

type DirectUploader = {
  processTasksInParallel: (
    file: unknown,
    tree: unknown,
    tasks: unknown[],
    retryOpts: { Interval: number; MaxGasPrice: number; Retries: number; TooManyDataRetries: number },
  ) => Promise<Array<Error | number | null>>;
  splitTasks: (
    info: unknown,
    tree: unknown,
    opts: { expectedReplica: number; finalityRequired: boolean; taskSize: number },
  ) => Promise<unknown[] | null>;
  submitLogEntryNoReceipt: (submission: unknown, opts: object) => Promise<[string, Error | null]>;
  waitForReceipt: (
    txHash: string,
    opts: { Interval: number; MaxGasPrice: number; Retries: number },
  ) => Promise<{ logs: Array<{ address: string; data: string; topics: readonly string[] }> } | null>;
};

function readPrivateKeyEnv(name: string): Hex {
  const value = requireEnv(name);
  if (!isHex(value, { strict: true }) || value.length !== 66) {
    throw new Error(`${name} must be a 32-byte private key hex string.`);
  }
  return value as Hex;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}
