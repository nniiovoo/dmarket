// Wires an already-deployed V3 marketplace to an already-deployed
// EvidenceRegistry. Owner-only call. If the marketplace owner is a
// TimelockController (M5 production setup), this script will revert —
// in that case schedule the call through the multisig UI.
//
// Required env (root .env):
//   PRIVATE_KEY                                marketplace owner
//   SEPOLIA_RPC_URL or AMOY_RPC_URL
//   V3_{NETWORK}_MARKETPLACE_ADDRESS
//   V3_{NETWORK}_EVIDENCE_REGISTRY_ADDRESS
//
// Usage:
//   npx hardhat run scripts/wireMarketplaceToEvidenceRegistry.ts --network sepolia

import { network } from "hardhat";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

async function main() {
  const connection = await network.create();
  const { ethers } = connection;
  const networkName = connection.networkName;
  const upper = networkName.toUpperCase();

  const [owner] = await ethers.getSigners();
  if (!owner) throw new Error("No signer; check PRIVATE_KEY");

  const marketplaceAddress = requireEnv(`V3_${upper}_MARKETPLACE_ADDRESS`);
  const registryAddress = requireEnv(`V3_${upper}_EVIDENCE_REGISTRY_ADDRESS`);

  console.log("Wiring marketplace -> evidence registry");
  console.log("  network:    ", networkName);
  console.log("  marketplace:", marketplaceAddress);
  console.log("  registry:   ", registryAddress);
  console.log("  caller:     ", await owner.getAddress());

  const marketplace = await ethers.getContractAt("EscrowMarketplaceV3", marketplaceAddress, owner);

  const currentRegistry = await marketplace.evidenceRegistry();
  if (currentRegistry.toLowerCase() === registryAddress.toLowerCase()) {
    console.log("\nAlready wired. No action taken.");
    await connection.close();
    return;
  }

  console.log("\nCalling setEvidenceRegistry...");
  const tx = await marketplace.setEvidenceRegistry(registryAddress);
  console.log("  tx hash:", tx.hash);
  await tx.wait();

  const newRegistry = await marketplace.evidenceRegistry();
  console.log("\nDone. marketplace.evidenceRegistry() =", newRegistry);

  await connection.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
