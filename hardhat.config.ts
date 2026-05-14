import "dotenv/config";

import { configVariable, defineConfig } from "hardhat/config";
import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers";

function getCliNetworkName(): string | undefined {
  const networkFlagIndex = process.argv.indexOf("--network");

  if (networkFlagIndex >= 0) {
    return process.argv[networkFlagIndex + 1];
  }

  const networkFlag = process.argv.find((arg) => arg.startsWith("--network="));
  return networkFlag?.split("=")[1];
}

const selectedNetwork = getCliNetworkName();
const explorerApiKey =
  selectedNetwork === "amoy"
    ? configVariable("POLYGONSCAN_API_KEY")
    : selectedNetwork === "arbitrumSepolia"
      ? configVariable("ARBISCAN_API_KEY")
      : configVariable("ETHERSCAN_API_KEY");

export default defineConfig({
  plugins: [hardhatToolboxMochaEthers],
  solidity: {
    version: "0.8.24",
    settings: {
      // viaIR enables the Yul-based optimization pipeline. Compiles a bit slower
      // but saves 5–25% gas on complex contracts. Worth it for everything beyond
      // toy examples.
      viaIR: true,
      optimizer: {
        enabled: true,
        // 200 is the balanced default. For one-off ultra-cheap deploys you can
        // temporarily flip this to 1 to shrink deploy bytecode at the cost of
        // making future user txs more expensive.
        runs: 200
      }
    }
  },
  networks: {
    sepolia: {
      type: "http",
      chainType: "l1",
      chainId: 11155111,
      url: configVariable("SEPOLIA_RPC_URL"),
      accounts: [configVariable("PRIVATE_KEY")]
    },
    amoy: {
      type: "http",
      chainType: "generic",
      chainId: 80002,
      url: configVariable("AMOY_RPC_URL"),
      accounts: [configVariable("PRIVATE_KEY")]
    },
    arbitrumSepolia: {
      type: "http",
      // Arbitrum is an L2 rollup — Hardhat's "l1" chainType doesn't apply.
      chainType: "generic",
      chainId: 421614,
      url: configVariable("ARBITRUM_SEPOLIA_RPC_URL"),
      accounts: [configVariable("PRIVATE_KEY")]
    }
  },
  verify: {
    etherscan: {
      apiKey: explorerApiKey
    }
  }
});
