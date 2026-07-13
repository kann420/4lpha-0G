import { artifacts, network } from "hardhat";
import { getAddress, keccak256, parseEther, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { GALILEO_CHAIN_ID, GALILEO_LOCAL_STACK_ARTIFACT_PATH, GALILEO_POOL_ID, GALILEO_STACK_ARTIFACT_PATH, GALILEO_STACK_SCHEMA_VERSION, writeGalileoTradeStackArtifact } from "./galileo-trade-stack-artifact";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
const INITIAL_NATIVE_RESERVE = parseEther("1");
const INITIAL_TOKEN_RESERVE = 1_000_000_000n; // 1,000 mUSDC (6 decimals)
const LOCAL_TEST_ONLY = (process.env.GALILEO_LOCAL_DEPLOY_TEST_ONLY ?? "false").toLowerCase() === "true";

function requireEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}
function requireFlag(name: string, expected: boolean) {
  if (((process.env[name] ?? "false").toLowerCase() === "true") !== expected) throw new Error(`${name} must be ${expected}`);
}
function assertDistinct(addresses: readonly Address[]) {
  if (new Set(addresses.map((address) => address.toLowerCase())).size !== addresses.length) throw new Error("Galileo deployer, proof attestor, vault attestor, and executor must be distinct addresses");
}
async function artifactFor(name: string): Promise<{ abi: Abi; bytecode: Hex; deployedBytecode: Hex }> {
  const artifact = await artifacts.readArtifact(name);
  if (artifact.bytecode === "0x" || artifact.deployedBytecode === "0x") throw new Error(`Missing bytecode for ${name}`);
  return { abi: artifact.abi as Abi, bytecode: artifact.bytecode as Hex, deployedBytecode: artifact.deployedBytecode as Hex };
}

async function main() {
  const connection = await network.create();
  const { viem } = connection;
  const publicClient = await viem.getPublicClient();
  const chainId = await publicClient.getChainId();
  if (chainId !== GALILEO_CHAIN_ID) throw new Error(`Galileo deploy requires chain ${GALILEO_CHAIN_ID}, got ${chainId}`);

  let expectedRoles: { deployer: Address; proofAttestor: Address; vaultAttestor: Address; executor: Address };
  if (LOCAL_TEST_ONLY) {
    if (connection.networkName !== "hardhatGalileo") throw new Error("GALILEO_LOCAL_DEPLOY_TEST_ONLY is permitted only on hardhatGalileo");
    const wallets = await viem.getWalletClients();
    if (wallets.length < 4 || !wallets[0].account || !wallets[1].account || !wallets[2].account || !wallets[3].account) throw new Error("hardhatGalileo needs four deterministic wallets");
    expectedRoles = { deployer: wallets[0].account.address, proofAttestor: wallets[1].account.address, vaultAttestor: wallets[2].account.address, executor: wallets[3].account.address };
  } else {
    if (connection.networkName !== "ogGalileo") throw new Error("Live Galileo deploy is permitted only on the isolated ogGalileo network");
    if ((process.env.OG_NETWORK ?? "").toLowerCase() !== "testnet") throw new Error("Galileo deploy requires OG_NETWORK=testnet");
    if (Number(requireEnv("OG_CHAIN_ID")) !== GALILEO_CHAIN_ID) throw new Error(`Galileo deploy requires OG_CHAIN_ID=${GALILEO_CHAIN_ID}`);
    requireEnv("OG_GALILEO_RPC_URL");
    requireFlag("ENABLE_GALILEO_DEPLOY", true);
    requireFlag("ENABLE_MAINNET_DEPLOY", false);
    const [wallet] = await viem.getWalletClients();
    if (!wallet.account) throw new Error("GALILEO_DEPLOYER_PRIVATE_KEY did not provide a deployer wallet");
    expectedRoles = {
      deployer: wallet.account.address,
      proofAttestor: privateKeyToAccount(requireEnv("GALILEO_PROOF_ATTESTOR_PRIVATE_KEY") as Hex).address,
      vaultAttestor: privateKeyToAccount(requireEnv("GALILEO_VAULT_ATTESTOR_PRIVATE_KEY") as Hex).address,
      executor: privateKeyToAccount(requireEnv("GALILEO_VAULT_EXECUTOR_PRIVATE_KEY") as Hex).address,
    };
  }
  assertDistinct(Object.values(expectedRoles));
  const artifactPath = LOCAL_TEST_ONLY ? GALILEO_LOCAL_STACK_ARTIFACT_PATH : GALILEO_STACK_ARTIFACT_PATH;
  const [deployer] = await viem.getWalletClients();
  if (!deployer.account || deployer.account.address.toLowerCase() !== expectedRoles.deployer.toLowerCase()) throw new Error("Configured Galileo deployer does not match the selected wallet");

  // The public Galileo RPC serves receipts with a lag that trips viem's default
  // waitForTransactionReceipt. Poll getTransactionReceipt manually and tolerate
  // transient "not found"/RPC errors so a mined tx is not treated as failed.
  const waitReceipt = async (hash: Hex) => {
    for (let attempt = 0; attempt < 90; attempt++) {
      try {
        const receipt = await publicClient.getTransactionReceipt({ hash });
        if (receipt) return receipt;
      } catch { /* receipt not visible yet on this node */ }
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
    throw new Error(`Timed out waiting for Galileo receipt ${hash}`);
  };
  const deploy = async (name: string, args: readonly unknown[]) => {
    const artifact = await artifactFor(name);
    const hash = await deployer.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args });
    const receipt = await waitReceipt(hash);
    if (!receipt.contractAddress) throw new Error(`${name} deploy receipt has no contract address`);
    return { address: getAddress(receipt.contractAddress), hash, block: receipt.blockNumber, abi: artifact.abi, templateCodeHash: keccak256(artifact.deployedBytecode) };
  };
  const write = async (address: Address, abi: Abi, functionName: string, args: readonly unknown[], value?: bigint) => {
    const hash = await deployer.writeContract({ address, abi, functionName, args, ...(value === undefined ? {} : { value }) });
    await waitReceipt(hash);
    return hash;
  };

  const proof = await deploy("ProofRegistry", [expectedRoles.deployer]);
  const token = await deploy("GalileoDemoUSDC", [expectedRoles.deployer]);
  const pool = await deploy("GalileoSandboxPool", [expectedRoles.deployer, token.address]);
  const vaultTemplate = await artifactFor("PolicyVaultV4SwapGalileo");
  const registry = await deploy("GalileoVaultRegistryV4", [expectedRoles.deployer, keccak256(vaultTemplate.deployedBytecode), expectedRoles.executor, ZERO_ADDRESS, proof.address, token.address, GALILEO_POOL_ID]);
  const adapter = await deploy("GalileoSandboxSwapAdapter", [pool.address, token.address, registry.address]);

  const configureRegistryAdapter = await write(registry.address, registry.abi, "configureAdapter", [adapter.address]);
  const setPoolAdapter = await write(pool.address, pool.abi, "setAdapter", [adapter.address]);
  const mintPoolToken = await write(token.address, token.abi, "mintForPool", [expectedRoles.deployer, INITIAL_TOKEN_RESERVE]);
  const approvePoolToken = await write(token.address, token.abi, "approve", [pool.address, INITIAL_TOKEN_RESERVE]);
  const seedPoolLiquidity = await write(pool.address, pool.abi, "addLiquidity", [INITIAL_TOKEN_RESERVE], INITIAL_NATIVE_RESERVE);
  const transferProofRegistryOwnership = await write(proof.address, proof.abi, "transferOwnership", [expectedRoles.proofAttestor]);
  const transferVaultRegistryOwnership = await write(registry.address, registry.abi, "transferOwnership", [expectedRoles.vaultAttestor]);

  const contractAddresses = { proofRegistry: proof.address, vaultRegistry: registry.address, token: token.address, pool: pool.address, adapter: adapter.address };
  const codeEntries = await Promise.all(Object.entries(contractAddresses).map(async ([name, address]) => {
    const bytecode = await publicClient.getBytecode({ address });
    if (!bytecode || bytecode === "0x") throw new Error(`${name} has no runtime bytecode after deployment`);
    return [name, keccak256(bytecode)] as const;
  }));
  const [proofOwner, registryOwner, registryAdapter, poolAdapter, nativeReserve, tokenReserve] = await Promise.all([
    publicClient.readContract({ address: proof.address, abi: proof.abi, functionName: "owner" }),
    publicClient.readContract({ address: registry.address, abi: registry.abi, functionName: "owner" }),
    publicClient.readContract({ address: registry.address, abi: registry.abi, functionName: "expectedAdapter" }),
    publicClient.readContract({ address: pool.address, abi: pool.abi, functionName: "adapter" }),
    publicClient.readContract({ address: pool.address, abi: pool.abi, functionName: "nativeReserve" }),
    publicClient.readContract({ address: pool.address, abi: pool.abi, functionName: "tokenReserve" }),
  ]);
  const checkedProofOwner = getAddress(proofOwner as Address);
  const checkedRegistryOwner = getAddress(registryOwner as Address);
  const checkedRegistryAdapter = getAddress(registryAdapter as Address);
  const checkedPoolAdapter = getAddress(poolAdapter as Address);
  if (checkedProofOwner.toLowerCase() !== expectedRoles.proofAttestor.toLowerCase() || checkedRegistryOwner.toLowerCase() !== expectedRoles.vaultAttestor.toLowerCase() || checkedRegistryAdapter.toLowerCase() !== adapter.address.toLowerCase() || checkedPoolAdapter.toLowerCase() !== adapter.address.toLowerCase() || nativeReserve !== INITIAL_NATIVE_RESERVE || tokenReserve !== INITIAL_TOKEN_RESERVE) throw new Error("Post-deploy Galileo stack configuration verification failed");

  const runtimeCodeHashes = Object.fromEntries(codeEntries) as {
    proofRegistry: Hex; vaultRegistry: Hex; token: Hex; pool: Hex; adapter: Hex;
  };
  await writeGalileoTradeStackArtifact({
    schemaVersion: GALILEO_STACK_SCHEMA_VERSION, network: "testnet", chainId, deploymentBlock: proof.block.toString(), deployer: expectedRoles.deployer,
    declaration: { containsNoSecrets: true, containsNoSignatures: true, containsNoRpcCredentials: true, containsNoMainnetIdentifiers: true },
    roles: { proofAttestor: expectedRoles.proofAttestor, vaultAttestor: expectedRoles.vaultAttestor, executor: expectedRoles.executor }, contracts: contractAddresses,
    pool: { id: GALILEO_POOL_ID, initialNativeReserve: INITIAL_NATIVE_RESERVE.toString(), initialTokenReserve: INITIAL_TOKEN_RESERVE.toString(), feeBps: 30 },
    runtimeCodeHashes: { ...runtimeCodeHashes, vaultRuntimeTemplate: keccak256(vaultTemplate.deployedBytecode) },
    configuration: { proofRegistryOwner: checkedProofOwner, vaultRegistryOwner: checkedRegistryOwner, poolAdapter: checkedPoolAdapter, registryAdapter: checkedRegistryAdapter },
    transactions: { proofRegistry: proof.hash, vaultRegistry: registry.hash, token: token.hash, pool: pool.hash, adapter: adapter.hash, configureRegistryAdapter, setPoolAdapter, mintPoolToken, approvePoolToken, seedPoolLiquidity, transferProofRegistryOwnership, transferVaultRegistryOwnership },
  }, artifactPath);
  console.log(`${LOCAL_TEST_ONLY ? "Local Hardhat Galileo" : "Galileo testnet"} stack deployed and verified: ${artifactPath}`);
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
