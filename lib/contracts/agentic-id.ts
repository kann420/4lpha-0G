import { parseAbiItem, type Address, type Hex } from "viem";

export interface AgenticIdIntelligentData {
  dataDescription: string;
  dataHash: Hex;
}

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
] as const;

export const agentMintedEvent = parseAbiItem(
  "event AgentMinted(uint256 indexed tokenId, address indexed creator, address indexed owner, address vault, address executor, string agentRef, string storageRef)",
);

export function agenticIdExplorerLabel(identity: Address, tokenId: string): string {
  return `${identity.slice(0, 6)}...${identity.slice(-4)} #${tokenId}`;
}
