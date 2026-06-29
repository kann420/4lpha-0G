import { parseAbiItem, type Address, type Hex } from "viem";

export interface AgenticIdIntelligentData {
  dataDescription: string;
  dataHash: Hex;
}

/**
 * ERC-7857 oracle type used by TransferValidityProofs. The re-key transfer path
 * (iTransfer/iClone) requires a real TEE or ZKP verifier producing these proofs;
 * that path is intentionally disabled in the server layer until a real verifier
 * is wired (see AGENTS.md). The types below are exposed for documentation and
 * future enablement only — they are NOT used by any production write path today.
 */
export type AgenticIdOracleType = "TEE" | "ZKP";

export interface AgenticIdAccessProof {
  oldDataHash: Hex;
  newDataHash: Hex;
  nonce: Hex;
  encryptedPubKey: Hex;
  proof: Hex;
}

export interface AgenticIdOwnershipProof {
  oracleType: AgenticIdOracleType;
  oldDataHash: Hex;
  newDataHash: Hex;
  sealedKey: Hex;
  encryptedPubKey: Hex;
  nonce: Hex;
  proof: Hex;
}

export interface AgenticIdTransferValidityProof {
  accessProof: AgenticIdAccessProof;
  ownershipProof: AgenticIdOwnershipProof;
}

/**
 * Production ABI for the 4lpha 0G AgenticID contract (canonical ERC-7857).
 *
 * Exposes the identity-creation path (mint, authorizeUsage, revokeAuthorization,
 * delegateAccess) and the read surface (ownerOf, agentRecord, intelligentDataOf,
 * authorizedUsersOf, getApproved, isApprovedForAll, getDelegateAccess, balanceOf,
 * name, symbol, verifier, nextTokenId). iTransfer/iClone are deliberately OMITTED
 * from this export: the re-key transfer path requires real TEE/ZKP
 * TransferValidityProofs and is disabled until a verifier is wired. Do not add
 * iTransfer/iClone here without routing through a real, mainnet-gated verifier.
 */
export const agenticIdAbi = [
  {
    inputs: [],
    name: "nextTokenId",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "to", type: "address" },
      {
        components: [
          { internalType: "string", name: "dataDescription", type: "string" },
          { internalType: "bytes32", name: "dataHash", type: "bytes32" },
        ],
        internalType: "struct IntelligentData[]",
        name: "iDatas",
        type: "tuple[]",
      },
      { internalType: "string", name: "storageRef", type: "string" },
      { internalType: "string", name: "agentRef", type: "string" },
      { internalType: "address", name: "vault", type: "address" },
      { internalType: "address", name: "executor", type: "address" },
    ],
    name: "mintAgent",
    outputs: [{ internalType: "uint256", name: "tokenId", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "tokenId", type: "uint256" }],
    name: "agentRecord",
    outputs: [
      { internalType: "address", name: "tokenOwner", type: "address" },
      { internalType: "address", name: "vault", type: "address" },
      { internalType: "address", name: "executor", type: "address" },
      { internalType: "string", name: "storageRef", type: "string" },
      { internalType: "string", name: "agentRef", type: "string" },
      { internalType: "uint64", name: "mintedAt", type: "uint64" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "tokenId", type: "uint256" }],
    name: "ownerOf",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "tokenId", type: "uint256" }],
    name: "authorizedUsersOf",
    outputs: [{ internalType: "address[]", name: "", type: "address[]" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "tokenId", type: "uint256" }],
    name: "intelligentDataOf",
    outputs: [
      {
        components: [
          { internalType: "string", name: "dataDescription", type: "string" },
          { internalType: "bytes32", name: "dataHash", type: "bytes32" },
        ],
        internalType: "struct IntelligentData[]",
        name: "",
        type: "tuple[]",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "uint256", name: "tokenId", type: "uint256" },
      { internalType: "address", name: "user", type: "address" },
    ],
    name: "authorizeUsage",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "uint256", name: "tokenId", type: "uint256" },
      { internalType: "address", name: "user", type: "address" },
    ],
    name: "revokeAuthorization",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "assistant", type: "address" }],
    name: "delegateAccess",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "tokenId", type: "uint256" }],
    name: "getApproved",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "tokenOwner", type: "address" },
      { internalType: "address", name: "operator", type: "address" },
    ],
    name: "isApprovedForAll",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "user", type: "address" }],
    name: "getDelegateAccess",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "address", name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "name",
    outputs: [{ internalType: "string", name: "", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "symbol",
    outputs: [{ internalType: "string", name: "", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "verifier",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "uint256", name: "tokenId", type: "uint256" },
      { indexed: true, internalType: "address", name: "creator", type: "address" },
      { indexed: true, internalType: "address", name: "owner", type: "address" },
      { indexed: false, internalType: "address", name: "vault", type: "address" },
      { indexed: false, internalType: "address", name: "executor", type: "address" },
      { indexed: false, internalType: "string", name: "agentRef", type: "string" },
      { indexed: false, internalType: "string", name: "storageRef", type: "string" },
    ],
    name: "AgentMinted",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "uint256", name: "tokenId", type: "uint256" },
      { indexed: false, internalType: "bytes32[]", name: "oldDataHashes", type: "bytes32[]" },
      { indexed: false, internalType: "bytes32[]", name: "newDataHashes", type: "bytes32[]" },
    ],
    name: "AgentDataUpdated",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [{ indexed: true, internalType: "address", name: "verifier", type: "address" }],
    name: "VerifierUpdated",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "from", type: "address" },
      { indexed: true, internalType: "address", name: "to", type: "address" },
      { indexed: true, internalType: "uint256", name: "tokenId", type: "uint256" },
    ],
    name: "Transfer",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: false, internalType: "uint256", name: "tokenId", type: "uint256" },
      { indexed: true, internalType: "address", name: "from", type: "address" },
      { indexed: true, internalType: "address", name: "to", type: "address" },
    ],
    name: "Transferred",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "from", type: "address" },
      { indexed: true, internalType: "address", name: "to", type: "address" },
      { indexed: true, internalType: "uint256", name: "tokenId", type: "uint256" },
    ],
    name: "Authorization",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "from", type: "address" },
      { indexed: true, internalType: "address", name: "to", type: "address" },
      { indexed: true, internalType: "uint256", name: "tokenId", type: "uint256" },
    ],
    name: "AuthorizationRevoked",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "uint256", name: "tokenId", type: "uint256" },
      { indexed: true, internalType: "uint256", name: "newTokenId", type: "uint256" },
      { indexed: false, internalType: "address", name: "from", type: "address" },
      { indexed: false, internalType: "address", name: "to", type: "address" },
    ],
    name: "Cloned",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "user", type: "address" },
      { indexed: true, internalType: "address", name: "assistant", type: "address" },
    ],
    name: "DelegateAccess",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "to", type: "address" },
      { indexed: true, internalType: "uint256", name: "tokenId", type: "uint256" },
      { indexed: false, internalType: "bytes[]", name: "sealedKeys", type: "bytes[]" },
    ],
    name: "PublishedSealedKey",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "from", type: "address" },
      { indexed: true, internalType: "address", name: "to", type: "address" },
      { indexed: true, internalType: "uint256", name: "tokenId", type: "uint256" },
    ],
    name: "Approval",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "address", name: "owner", type: "address" },
      { indexed: true, internalType: "address", name: "operator", type: "address" },
      { indexed: false, internalType: "bool", name: "approved", type: "bool" },
    ],
    name: "ApprovalForAll",
    type: "event",
  },
] as const;

export const agentMintedEvent = parseAbiItem(
  "event AgentMinted(uint256 indexed tokenId, address indexed creator, address indexed owner, address vault, address executor, string agentRef, string storageRef)",
);

export const authorizationEvent = parseAbiItem(
  "event Authorization(address indexed from, address indexed to, uint256 indexed tokenId)",
);

export const authorizationRevokedEvent = parseAbiItem(
  "event AuthorizationRevoked(address indexed from, address indexed to, uint256 indexed tokenId)",
);

export const transferredEvent = parseAbiItem(
  "event Transferred(uint256 tokenId, address indexed from, address indexed to)",
);

export function agenticIdExplorerLabel(identity: Address, tokenId: string): string {
  return `${identity.slice(0, 6)}...${identity.slice(-4)} #${tokenId}`;
}