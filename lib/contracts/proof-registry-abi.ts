import type { Abi } from "viem";

/**
 * ProofRegistry ABI.
 *
 * `acceptProof` is `onlyOwner` and stores a `Proof` keyed by `actionHash`:
 *   acceptProof(bytes32 actionHash, bytes32 auditRoot, bytes32 policySnapshotHash,
 *                bytes32 modelMetadataHash, string storageRef,
 *                bytes32 vaultActionHash, string agentRef)
 *
 * All five bytes32 fields reject bytes32(0); both strings reject empty;
 * `actionHash` must be unique (reverts ProofAlreadyAccepted).
 *
 * Shared by server-side proof anchoring paths.
 */
export const proofRegistryAbi = [
  {
    inputs: [],
    name: "owner",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "bytes32", name: "actionHash", type: "bytes32" },
      { internalType: "bytes32", name: "auditRoot", type: "bytes32" },
      { internalType: "bytes32", name: "policySnapshotHash", type: "bytes32" },
      { internalType: "bytes32", name: "modelMetadataHash", type: "bytes32" },
      { internalType: "string", name: "storageRef", type: "string" },
      { internalType: "bytes32", name: "vaultActionHash", type: "bytes32" },
      { internalType: "string", name: "agentRef", type: "string" },
    ],
    name: "acceptProof",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "bytes32", name: "actionHash", type: "bytes32" }],
    name: "proofFor",
    outputs: [
      {
        components: [
          { internalType: "bytes32", name: "auditRoot", type: "bytes32" },
          { internalType: "bytes32", name: "policySnapshotHash", type: "bytes32" },
          { internalType: "bytes32", name: "modelMetadataHash", type: "bytes32" },
          { internalType: "bytes32", name: "vaultActionHash", type: "bytes32" },
          { internalType: "string", name: "storageRef", type: "string" },
          { internalType: "string", name: "agentRef", type: "string" },
          { internalType: "uint64", name: "acceptedAt", type: "uint64" },
        ],
        internalType: "struct ProofRegistry.Proof",
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "bytes32", name: "actionHash", type: "bytes32" },
      { internalType: "bytes32", name: "auditRoot", type: "bytes32" },
      { internalType: "bytes32", name: "policySnapshotHash", type: "bytes32" },
      { internalType: "bytes32", name: "vaultActionHash", type: "bytes32" },
    ],
    name: "isAccepted",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
] as const satisfies Abi;
