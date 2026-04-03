import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as fs from "fs";
import * as path from "path";

// Load relayer key from persistent storage or env var
function getDeployerKey(): string[] {
  if (process.env.DEPLOYER_KEY) {
    return [process.env.DEPLOYER_KEY];
  }
  const keyPath = "/app/.borg/persistent/coordination-games/relayer-key.json";
  try {
    if (fs.existsSync(keyPath)) {
      const keyData = JSON.parse(fs.readFileSync(keyPath, "utf8"));
      return [keyData.privateKey];
    }
  } catch {}
  return [];
}

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    localhost: {
      url: "http://127.0.0.1:8545",
    },
    opSepolia: {
      url: process.env.OP_SEPOLIA_RPC || "https://sepolia.optimism.io",
      chainId: 11155420,
      accounts: getDeployerKey(),
    },
  },
  etherscan: {
    apiKey: {
      opSepolia: process.env.OP_ETHERSCAN_KEY || "empty",
    },
    customChains: [
      {
        network: "opSepolia",
        chainId: 11155420,
        urls: {
          apiURL: "https://api-sepolia-optimistic.etherscan.io/api",
          browserURL: "https://sepolia-optimism.etherscan.io",
        },
      },
    ],
  },
};

export default config;
