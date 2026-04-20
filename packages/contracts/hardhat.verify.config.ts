import type { HardhatUserConfig } from 'hardhat/config';
import '@nomicfoundation/hardhat-verify';

const config: HardhatUserConfig = {
  solidity: {
    version: '0.8.20',
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    opSepolia: {
      url: process.env.OP_SEPOLIA_RPC || 'https://sepolia.optimism.io',
      chainId: 11155420,
    },
  },
  etherscan: {
    apiKey: process.env.OP_ETHERSCAN_KEY || 'empty',
    customChains: [
      {
        network: 'opSepolia',
        chainId: 11155420,
        urls: {
          apiURL: 'https://api.etherscan.io/v2/api?chainid=11155420',
          browserURL: 'https://sepolia-optimism.etherscan.io',
        },
      },
    ],
  },
};

export default config;
