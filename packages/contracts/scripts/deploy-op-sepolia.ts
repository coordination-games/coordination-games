import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Balance:", ethers.formatEther(balance), "ETH");

  if (balance === 0n) {
    throw new Error("Deployer has no ETH balance");
  }

  // --- MockUSDC: reuse existing if it has code, otherwise deploy ---
  const previousUsdcAddr = "0x6fD5C48597625912cbcB676084b8D813F47Eda00";
  let usdcAddr: string;

  const usdcCode = await ethers.provider.getCode(previousUsdcAddr);
  if (usdcCode !== "0x") {
    console.log("\nReusing existing MockUSDC at", previousUsdcAddr);
    usdcAddr = previousUsdcAddr;
  } else {
    console.log("\n--- Deploying MockUSDC ---");
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const usdc = await MockUSDC.deploy();
    await usdc.waitForDeployment();
    usdcAddr = await usdc.getAddress();
    console.log("MockUSDC deployed:", usdcAddr);
  }

  // --- Use canonical ERC-8004 registry on OP Sepolia ---
  const erc8004Addr = "0x8004A818BFB912233c491871b3d84c89A494BD9e";

  const code = await ethers.provider.getCode(erc8004Addr);
  if (code === "0x") {
    throw new Error("Canonical ERC-8004 not found at " + erc8004Addr + " — aborting");
  }
  console.log("\nCanonical ERC-8004 confirmed at", erc8004Addr, `(${code.length} bytes of code)`);

  // --- Predict addresses for circular deps ---
  // Same pattern as deploy-local.ts: predict all 3 addresses from current nonce
  const deployerNonce = await ethers.provider.getTransactionCount(deployer.address);
  const registryAddr = ethers.getCreateAddress({ from: deployer.address, nonce: deployerNonce });
  const creditsAddr = ethers.getCreateAddress({ from: deployer.address, nonce: deployerNonce + 1 });
  const gameAnchorAddr = ethers.getCreateAddress({ from: deployer.address, nonce: deployerNonce + 2 });

  console.log("\nPredicted addresses:");
  console.log("  Registry:", registryAddr);
  console.log("  Credits:", creditsAddr);
  console.log("  GameAnchor:", gameAnchorAddr);

  // Use deployer as treasury, vault, and admin for testnet
  const treasury = deployer.address;
  const vault = deployer.address;
  const admin = deployer.address;
  const relayer = deployer.address; // deployer is also relayer on testnet

  // --- Deploy CoordinationRegistry ---
  console.log("\n--- Deploying CoordinationRegistry ---");
  const CoordinationRegistry = await ethers.getContractFactory("CoordinationRegistry");
  const registry = await CoordinationRegistry.deploy(
    erc8004Addr,
    usdcAddr,
    creditsAddr,
    treasury
  );
  await registry.waitForDeployment();
  const actualRegistryAddr = await registry.getAddress();
  console.log("CoordinationRegistry deployed:", actualRegistryAddr);

  if (actualRegistryAddr !== registryAddr) {
    throw new Error(`Registry address mismatch: expected ${registryAddr}, got ${actualRegistryAddr}`);
  }

  // --- Deploy CoordinationCredits ---
  console.log("\n--- Deploying CoordinationCredits ---");
  const CoordinationCredits = await ethers.getContractFactory("CoordinationCredits");
  const credits = await CoordinationCredits.deploy(
    erc8004Addr,
    usdcAddr,
    registryAddr,
    gameAnchorAddr,
    treasury,
    vault,
    admin
  );
  await credits.waitForDeployment();
  const actualCreditsAddr = await credits.getAddress();
  console.log("CoordinationCredits deployed:", actualCreditsAddr);

  if (actualCreditsAddr !== creditsAddr) {
    throw new Error(`Credits address mismatch: expected ${creditsAddr}, got ${actualCreditsAddr}`);
  }

  // --- Deploy GameAnchor ---
  console.log("\n--- Deploying GameAnchor ---");
  const GameAnchor = await ethers.getContractFactory("GameAnchor");
  const gameAnchor = await GameAnchor.deploy(creditsAddr, relayer, admin);
  await gameAnchor.waitForDeployment();
  const actualGameAnchorAddr = await gameAnchor.getAddress();
  console.log("GameAnchor deployed:", actualGameAnchorAddr);

  if (actualGameAnchorAddr !== gameAnchorAddr) {
    throw new Error(`GameAnchor address mismatch: expected ${gameAnchorAddr}, got ${actualGameAnchorAddr}`);
  }

  // --- Summary ---
  console.log("\n========================================");
  console.log("  OP Sepolia Deployment Complete!");
  console.log("========================================");
  console.log("Network:              OP Sepolia (chain 11155420)");
  console.log("Deployer:            ", deployer.address);
  console.log("MockUSDC:            ", usdcAddr);
  console.log("ERC-8004 (canonical):", erc8004Addr);
  console.log("CoordinationRegistry:", actualRegistryAddr);
  console.log("CoordinationCredits: ", actualCreditsAddr);
  console.log("GameAnchor:          ", actualGameAnchorAddr);
  console.log("Treasury:            ", treasury);
  console.log("Vault:               ", vault);
  console.log("Relayer:             ", relayer);
  console.log("Admin:               ", admin);
  console.log("========================================\n");

  // --- Save deployment info ---
  const deployment = {
    network: "op-sepolia",
    chainId: 11155420,
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    contracts: {
      MockUSDC: usdcAddr,
      ERC8004: {
        address: erc8004Addr,
        type: "canonical",
      },
      CoordinationRegistry: actualRegistryAddr,
      CoordinationCredits: actualCreditsAddr,
      GameAnchor: actualGameAnchorAddr,
    },
    roles: {
      treasury,
      vault,
      relayer,
      admin,
    },
  };

  const deploymentsDir = path.join(__dirname, "deployments");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }
  const outPath = path.join(deploymentsDir, "op-sepolia.json");
  fs.writeFileSync(outPath, JSON.stringify(deployment, null, 2) + "\n");
  console.log("Deployment info saved to:", outPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
