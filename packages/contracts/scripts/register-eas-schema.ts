/**
 * Register the TrustGraph attestation schema on EAS (Optimism).
 *
 * Schema: (uint256 confidence, string context)
 * Revocable: true
 *
 * Usage:
 *   DEPLOYER_KEY=0x... npx hardhat run scripts/register-eas-schema.ts --network opSepolia
 *
 * EAS contracts on Optimism:
 *   SchemaRegistry: 0x4200000000000000000000000000000000000020
 *   EAS:            0x4200000000000000000000000000000000000021
 */

import { ethers } from "hardhat";

// EAS SchemaRegistry on Optimism (and OP Sepolia)
const SCHEMA_REGISTRY_ADDRESS = "0x4200000000000000000000000000000000000020";

// Minimal ABI for SchemaRegistry.register()
const SCHEMA_REGISTRY_ABI = [
  "function register(string calldata schema, address resolver, bool revocable) external returns (bytes32)",
  "event Registered(bytes32 indexed uid, address indexed registerer, tuple(bytes32 uid, address resolver, bool revocable, string schema) schema)",
];

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Registering schema with account:", deployer.address);

  const registry = new ethers.Contract(
    SCHEMA_REGISTRY_ADDRESS,
    SCHEMA_REGISTRY_ABI,
    deployer
  );

  const schema = "uint256 confidence, string context";
  const resolver = ethers.ZeroAddress; // No resolver — open attestation
  const revocable = true;

  console.log(`\nSchema:    "${schema}"`);
  console.log(`Resolver:  ${resolver} (none)`);
  console.log(`Revocable: ${revocable}`);

  const tx = await registry.register(schema, resolver, revocable);
  console.log(`\nTx hash: ${tx.hash}`);
  console.log("Waiting for confirmation...");

  const receipt = await tx.wait();

  // Extract schema UID from the Registered event
  const registeredEvent = receipt?.logs?.find((log: any) => {
    try {
      const parsed = registry.interface.parseLog({ topics: log.topics as string[], data: log.data });
      return parsed?.name === "Registered";
    } catch {
      return false;
    }
  });

  if (registeredEvent) {
    const parsed = registry.interface.parseLog({
      topics: registeredEvent.topics as string[],
      data: registeredEvent.data,
    });
    const uid = parsed?.args?.[0];
    console.log(`\nSchema UID: ${uid}`);
    console.log("\nSave this UID — you'll need it for attestations.");
  } else {
    // Fallback: compute the UID deterministically
    // EAS schema UID = keccak256(abi.encodePacked(schema, resolver, revocable))
    const encoded = ethers.solidityPacked(
      ["string", "address", "bool"],
      [schema, resolver, revocable]
    );
    const uid = ethers.keccak256(encoded);
    console.log(`\nSchema UID (computed): ${uid}`);
    console.log("(Could not extract from event — verify on easscan.org)");
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
