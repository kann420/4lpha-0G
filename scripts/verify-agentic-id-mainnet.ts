import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { getAddress, isAddress, zeroAddress, type Address, type Hex } from "viem";

import { agentMintedEvent, agenticIdAbi } from "../lib/contracts/agentic-id";
import { assertMainnetRpc, createMainnetPublicClient } from "./mainnet-vault-utils";

const CANDIDATES = [
  "0x058c5F4C72810D7D4Fc0bEF3875a8f779DE7E59c",
  "0xa6c5723f024f207311060f4d0976f85a6a069064",
] as const satisfies readonly Address[];

const ACTIVE_TOKEN_IDS = [7n, 8n, 9n, 10n, 11n, 12n] as const;
const ERC165_INTERFACE_ID = "0x01ffc9a7" as const;
const IERC7857_INTERFACE_ID = "0xee5a526e" as const;
const IERC7857_METADATA_INTERFACE_ID = "0xaa18b754" as const;
const IERC7857_DATA_VERIFIER_INTERFACE_ID = "0xdf630116" as const;
const ARTIFACT_PATH = join(".data", "deployments", "mainnet-agentic-id.json");

const erc165Abi = [
  {
    type: "function",
    name: "supportsInterface",
    inputs: [{ name: "interfaceId", type: "bytes4" }],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
] as const;

interface AgenticIdArtifact {
  agenticId?: Address;
  address?: Address;
  chainId?: number;
  deployer?: Address;
  txHash?: Hex;
}

interface CandidateReport {
  address: Address;
  bytecodePresent: boolean;
  supportsErc165: boolean;
  supportsIERC7857: boolean;
  supportsIERC7857Metadata: boolean;
  name: string | null;
  symbol: string | null;
  nextTokenId: string | null;
  verifier: Address | null;
  verifierSupportsDataVerifier: boolean | null;
  mintedTokenIds: string[];
  creatorAddresses: Address[];
  includesActiveRoster: boolean;
  matchesArtifactDeployer: boolean;
  matchesArtifactAddress: boolean;
  canonicalEligible: boolean;
}

async function main() {
  const publicClient = createMainnetPublicClient();
  const chainId = await assertMainnetRpc(publicClient);
  const artifact = await readArtifact();
  const artifactBlock = await readArtifactFromBlock(publicClient, artifact);
  const fromBlock = 0n;

  const reports: CandidateReport[] = [];
  for (const candidate of CANDIDATES) {
    reports.push(await inspectCandidate(publicClient, getAddress(candidate), artifact, fromBlock));
  }

  const canonical = chooseCanonical(reports);
  console.log("AgenticID mainnet verification");
  console.log({
    chainId,
    fromBlock: fromBlock.toString(),
    artifactBlock: artifactBlock?.toString() ?? null,
    artifactAgenticId: artifact?.agenticId ?? artifact?.address ?? null,
    artifactDeployer: artifact?.deployer ?? null,
  });
  console.table(
    reports.map((report) => ({
      address: report.address,
      bytecode: report.bytecodePresent,
      erc165: report.supportsErc165,
      ierc7857: report.supportsIERC7857,
      metadata: report.supportsIERC7857Metadata,
      name: report.name,
      symbol: report.symbol,
      nextTokenId: report.nextTokenId,
      verifier: report.verifier,
      verifierDataVerifier: report.verifierSupportsDataVerifier,
      mintedTokenIds: report.mintedTokenIds.join(","),
      includesActiveRoster: report.includesActiveRoster,
      matchesArtifactDeployer: report.matchesArtifactDeployer,
      matchesArtifactAddress: report.matchesArtifactAddress,
      canonicalEligible: report.canonicalEligible,
    })),
  );
  console.log("Reconciliation:");
  console.log({
    canonical: canonical?.address ?? null,
    expectedActiveRosterTokenIds: ACTIVE_TOKEN_IDS.map((tokenId) => tokenId.toString()),
    decisionRule:
      "canonical = bytecode + ERC-165/IERC7857/IERC7857Metadata + AgentMinted tokenIds 7-12; tiebreaker = artifact deployer/address match",
    dataVerifierNote:
      "IERC7857DataVerifier (0xdf630116) is checked only on verifier(), not on the identity contract.",
  });
  if (canonical) {
    console.log("Manual pin step after review:");
    console.log(`AGENT_IDENTITY_MAINNET_ADDRESS=${canonical.address}`);
    console.log("If .data/deployments/mainnet-agentic-id.json is stale, reconcile its agenticId field manually after review.");
  } else {
    console.log("No canonical candidate selected. Do not proceed to V4 deploy/migration until AgenticID is pinned.");
  }
}

async function inspectCandidate(
  publicClient: ReturnType<typeof createMainnetPublicClient>,
  address: Address,
  artifact: AgenticIdArtifact | null,
  fromBlock: bigint,
): Promise<CandidateReport> {
  const bytecode = await publicClient.getBytecode({ address }).catch(() => undefined);
  const bytecodePresent = Boolean(bytecode && bytecode !== "0x");
  const [supportsErc165, supportsIERC7857, supportsIERC7857Metadata] = await Promise.all([
    readSupportsInterface(publicClient, address, ERC165_INTERFACE_ID),
    readSupportsInterface(publicClient, address, IERC7857_INTERFACE_ID),
    readSupportsInterface(publicClient, address, IERC7857_METADATA_INTERFACE_ID),
  ]);
  const [name, symbol, nextTokenId, verifier] = await Promise.all([
    readContractString(publicClient, address, "name"),
    readContractString(publicClient, address, "symbol"),
    readContractBigint(publicClient, address, "nextTokenId"),
    readContractAddress(publicClient, address, "verifier"),
  ]);
  const verifierSupportsDataVerifier =
    verifier && verifier !== zeroAddress
      ? await readSupportsInterface(publicClient, verifier, IERC7857_DATA_VERIFIER_INTERFACE_ID).catch(() => null)
      : null;
  const logs = bytecodePresent
    ? await publicClient.getLogs({ address, event: agentMintedEvent, fromBlock, toBlock: "latest" }).catch(() => [])
    : [];
  const mintedTokenIds = Array.from(
    new Set(
      logs
        .map((log) => log.args.tokenId)
        .filter((tokenId): tokenId is bigint => typeof tokenId === "bigint")
        .map((tokenId) => tokenId.toString()),
    ),
  ).sort((left, right) => Number(BigInt(left) - BigInt(right)));
  const creatorAddresses = Array.from(
    new Set(
      logs
        .map((log) => log.args.creator)
        .filter((creator): creator is Address => Boolean(creator && isAddress(creator)))
        .map((creator) => getAddress(creator)),
    ),
  );
  const includesActiveRoster = ACTIVE_TOKEN_IDS.every((tokenId) => mintedTokenIds.includes(tokenId.toString()));
  const artifactDeployer = readArtifactAddress(artifact?.deployer);
  const artifactAddress = readArtifactAddress(artifact?.agenticId ?? artifact?.address);
  const matchesArtifactDeployer = Boolean(
    artifactDeployer && creatorAddresses.some((creator) => creator.toLowerCase() === artifactDeployer.toLowerCase()),
  );
  const matchesArtifactAddress = Boolean(artifactAddress && artifactAddress.toLowerCase() === address.toLowerCase());
  return {
    address,
    bytecodePresent,
    supportsErc165,
    supportsIERC7857,
    supportsIERC7857Metadata,
    name,
    symbol,
    nextTokenId: nextTokenId?.toString() ?? null,
    verifier,
    verifierSupportsDataVerifier,
    mintedTokenIds,
    creatorAddresses,
    includesActiveRoster,
    matchesArtifactDeployer,
    matchesArtifactAddress,
    canonicalEligible: bytecodePresent && supportsErc165 && supportsIERC7857 && supportsIERC7857Metadata && includesActiveRoster,
  };
}

function chooseCanonical(reports: CandidateReport[]): CandidateReport | null {
  const eligible = reports.filter((report) => report.canonicalEligible);
  if (eligible.length === 0) return null;
  eligible.sort((left, right) => score(right) - score(left));
  return eligible[0];
}

function score(report: CandidateReport): number {
  return (report.matchesArtifactDeployer ? 2 : 0) + (report.matchesArtifactAddress ? 1 : 0);
}

async function readSupportsInterface(
  publicClient: ReturnType<typeof createMainnetPublicClient>,
  address: Address,
  interfaceId: Hex,
): Promise<boolean> {
  return Boolean(
    await publicClient.readContract({
      address,
      abi: erc165Abi,
      functionName: "supportsInterface",
      args: [interfaceId],
    }).catch(() => false),
  );
}

async function readContractString(
  publicClient: ReturnType<typeof createMainnetPublicClient>,
  address: Address,
  functionName: "name" | "symbol",
): Promise<string | null> {
  const value = await publicClient.readContract({ address, abi: agenticIdAbi, functionName }).catch(() => null);
  return typeof value === "string" ? value : null;
}

async function readContractBigint(
  publicClient: ReturnType<typeof createMainnetPublicClient>,
  address: Address,
  functionName: "nextTokenId",
): Promise<bigint | null> {
  const value = await publicClient.readContract({ address, abi: agenticIdAbi, functionName }).catch(() => null);
  return typeof value === "bigint" ? value : null;
}

async function readContractAddress(
  publicClient: ReturnType<typeof createMainnetPublicClient>,
  address: Address,
  functionName: "verifier",
): Promise<Address | null> {
  const value = await publicClient.readContract({ address, abi: agenticIdAbi, functionName }).catch(() => null);
  return typeof value === "string" && isAddress(value) ? getAddress(value) : null;
}

async function readArtifact(): Promise<AgenticIdArtifact | null> {
  try {
    const parsed = JSON.parse(await readFile(ARTIFACT_PATH, "utf8")) as AgenticIdArtifact;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function readArtifactFromBlock(
  publicClient: ReturnType<typeof createMainnetPublicClient>,
  artifact: AgenticIdArtifact | null,
): Promise<bigint> {
  if (!artifact?.txHash) return 0n;
  const receipt = await publicClient.getTransactionReceipt({ hash: artifact.txHash }).catch(() => null);
  return receipt?.blockNumber ?? 0n;
}

function readArtifactAddress(value: string | undefined): Address | null {
  return value && isAddress(value) ? getAddress(value) : null;
}

main().catch((error) => {
  console.error(`AgenticID mainnet verification failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
