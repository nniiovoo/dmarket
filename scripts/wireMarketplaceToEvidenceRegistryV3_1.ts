// Wires an already-deployed V3.1 marketplace to its dedicated EvidenceRegistry
// instance. Owner-only call. V3.1 marketplace inherits setEvidenceRegistry
// from V3.
//
// Pre-flight sanity check: confirms registry.marketplace() === V3.1 marketplace
// before calling setEvidenceRegistry — otherwise the marketplace would be
// pointed at a registry that's bound to a different (likely V3) marketplace,
// and submitEvidence would revert with the wrong-marketplace error.
//
// Required env (root .env):
//   PRIVATE_KEY                                marketplace owner
//   ARBITRUM_SEPOLIA_RPC_URL  (or matching one for your --network)
//   V3_1_{NETWORK}_MARKETPLACE_ADDRESS
//   V3_1_{NETWORK}_EVIDENCE_REGISTRY_ADDRESS
//
// Usage:
//   npx hardhat run scripts/wireMarketplaceToEvidenceRegistryV3_1.ts --network arbitrumSepolia

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

  const marketplaceAddress = requireEnv(`V3_1_${upper}_MARKETPLACE_ADDRESS`);
  const registryAddress = requireEnv(`V3_1_${upper}_EVIDENCE_REGISTRY_ADDRESS`);

  console.log("Wiring V3.1 marketplace -> evidence registry");
  console.log("  network:    ", networkName);
  console.log("  marketplace:", marketplaceAddress, "(V3.1)");
  console.log("  registry:   ", registryAddress, "(V3.1)");
  console.log("  caller:     ", await owner.getAddress());

  // Sanity check: the registry must be bound to THIS marketplace at deploy.
  const registry = await ethers.getContractAt("EvidenceRegistryV3", registryAddress, owner);
  const registryMarketplace = (await registry.marketplace()) as string;
  if (registryMarketplace.toLowerCase() !== marketplaceAddress.toLowerCase()) {
    throw new Error(
      `Registry is bound to a different marketplace.\n` +
        `  registry.marketplace() = ${registryMarketplace}\n` +
        `  expected (V3.1)        = ${marketplaceAddress}\n` +
        `Refusing to wire — you almost certainly want to deploy a fresh V3.1 registry.`
    );
  }
  console.log("\n✓ Registry is bound to the V3.1 marketplace.");

  // V3.1 marketplace inherits setEvidenceRegistry from V3. Use the V3 ABI
  // (no V3.1-only ABI for this method since the interface didn't change).
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
  console.log("\nDone. V3.1 marketplace.evidenceRegistry() =", newRegistry);

  await connection.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
