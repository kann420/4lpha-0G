import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import dotenv from "dotenv";
import { defineConfig } from "hardhat/config";

dotenv.config({ path: ".env.local", quiet: true });

const galileoPrivateKeys = [process.env.GALILEO_DEPLOYER_PRIVATE_KEY]
  .filter((value): value is string => value !== undefined && value !== "")
  .filter((value, index, values) => values.indexOf(value) === index);

const mainnetPrivateKeys = [process.env.DEPLOYER_PRIVATE_KEY]
  .filter((value): value is string => value !== undefined && value !== "")
  .filter((value, index, values) => values.indexOf(value) === index);

export default defineConfig({
  plugins: [hardhatToolboxViemPlugin],
  chainDescriptors: {
    16602: {
      name: "0G Galileo",
      chainType: "l1",
      blockExplorers: {
        etherscan: {
          name: "0G Chain Scan Galileo",
          url: "https://chainscan-galileo.0g.ai",
          apiUrl: "https://chainscan-galileo.0g.ai/open/api",
        },
      },
    },
    16661: {
      name: "0G Mainnet",
      chainType: "l1",
      blockExplorers: {
        etherscan: {
          name: "0G Chain Scan",
          url: "https://chainscan.0g.ai",
          apiUrl: "https://chainscan.0g.ai/open/api",
        },
      },
    },
  },
  verify: {
    etherscan: {
      apiKey: process.env.OG_CHAINSCAN_API_KEY ?? "PLACEHOLDER",
    },
  },
  solidity: {
    profiles: {
      default: {
        version: "0.8.24",
        // Prefer the in-process WASM solc on this Windows host: spawning the copied native
        // solc.exe from the workspace-local cache fails with EPERM. WASM solc runs in-process
        // (no child spawn), which is portable and avoids the EPERM. Same for the production profile.
        preferWasm: true,
        settings: {
          evmVersion: "cancun",
          viaIR: true,
          optimizer: {
            enabled: true,
            // PolicyVaultV3 fits EIP-170's 24KB cap at runs=200 (23810B), runs=500 (23947B),
            // and runs=1 (23598B). Default to runs=200 for runtime-gas-friendlier bytecode;
            // see docs/vault-v3-plan.md section 0. A bytecode-size guard should remeasure on
            // every contract edit.
            runs: 200,
          },
        },
      },
      production: {
        version: "0.8.24",
        preferWasm: true,
        settings: {
          evmVersion: "cancun",
          viaIR: true,
          optimizer: {
            enabled: true,
            runs: 500,
          },
        },
      },
    },
  },
  networks: {
    hardhatMainnet: {
      type: "edr-simulated",
      chainType: "l1",
      // V3 singleton + factory embed exceeds EIP-170's 24KB cap; the simulated net relaxes it
      // so tests can exercise the full contract. 0G mainnet still enforces 24KB on every deploy,
      // which governs the real shipping scope — see docs/vault-v3-plan.md.
      allowUnlimitedContractSize: true,
      // Deploying a 33.6KB contract costs ~22M gas; raise the block + tx cap above the EDR default (16.7M).
      blockGasLimit: 60_000_000,
      transactionGasCap: 60_000_000,
    },
    hardhatGalileo: {
      type: "edr-simulated",
      chainType: "l1",
      chainId: 16602,
      allowUnlimitedContractSize: true,
      blockGasLimit: 60_000_000,
      transactionGasCap: 60_000_000,
    },
    ogGalileo: {
      type: "http",
      chainType: "l1",
      // Deliberately no OG_RPC_URL / DEPLOYER_PRIVATE_KEY fallback. The invalid
      // placeholder fails before a network request when a caller forgot to set
      // the Galileo-specific endpoint.
      url: process.env.OG_GALILEO_RPC_URL ?? "https://missing-galileo-rpc.invalid",
      accounts: galileoPrivateKeys.length === 0 ? [] : galileoPrivateKeys,
    },
    ogMainnet: {
      type: "http",
      chainType: "l1",
      url: process.env.OG_RPC_URL ?? "https://evmrpc.0g.ai",
      accounts: mainnetPrivateKeys.length === 0 ? [] : mainnetPrivateKeys,
    },
  },
});
