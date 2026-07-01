import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import dotenv from "dotenv";
import { defineConfig } from "hardhat/config";

dotenv.config({ path: ".env.local", quiet: true });

const configuredPrivateKeys = [process.env.DEPLOYER_PRIVATE_KEY]
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
        settings: {
          evmVersion: "cancun",
          viaIR: true,
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
      production: {
        version: "0.8.24",
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
    },
    ogGalileo: {
      type: "http",
      chainType: "l1",
      url: process.env.OG_RPC_URL ?? "https://evmrpc-testnet.0g.ai",
      accounts: configuredPrivateKeys,
    },
    ogMainnet: {
      type: "http",
      chainType: "l1",
      url: process.env.OG_RPC_URL ?? "https://evmrpc.0g.ai",
      accounts: configuredPrivateKeys,
    },
  },
});
