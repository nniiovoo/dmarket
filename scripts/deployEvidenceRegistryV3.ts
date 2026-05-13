// Deploys EvidenceRegistryV3 alongside an already-deployed V3 marketplace.
// The registry is a standalone Chainlink Functions consumer — it reads the
// marketplace's Order struct on-chain but does not depend on the vault.
//
// Required env (root .env):
//   PRIVATE_KEY                                deployer
//   SEPOLIA_RPC_URL or AMOY_RPC_URL
//   V3_{NETWORK}_MARKETPLACE_ADDRESS           already-deployed V3 marketplace
//
// Optional env:
//   FUNCTIONS_ROUTER_ADDRESS                   override router (defaults to
//                                              the known Sepolia/Amoy address)
//
// Usage:
//   npx hardhat run scripts/deployEvidenceRegistryV3.ts --network sepolia
//   npx hardhat run scripts/deployEvidenceRegistryV3.ts --network amoy

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { network } from "hardhat";

const FUNCTIONS_ROUTER: Record<string, string> = {
  sepolia: "0xb83E47C2bC239B3bf370bc41e1459A34b41238D0",
  amoy: "0xC22a79eBA640940ABB6dF0f7982cc119578E11De"
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

function envUpper(networkName: string): string {
  return networkName.toUpperCase();
}

async function main() {
  const connection = await network.create();
  const { ethers } = connection;
  const networkName = connection.networkName;

  const router = process.env.FUNCTIONS_ROUTER_ADDRESS ?? FUNCTIONS_ROUTER[networkName];
  if (!router) {
    throw new Error(`Unsupported network for Functions router: ${networkName}`);
  }

  const marketplaceAddress = requireEnv(`V3_${envUpper(networkName)}_MARKETPLACE_ADDRESS`);

  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    throw new Error("No signer; check PRIVATE_KEY in .env");
  }

  // Initial source: read the same delivery-status JS as the marketplace uses.
  // EvidenceRegistry can be updated independently later via setRequestSource.
  const sourcePath = join(process.cwd(), "chainlink/functions/deliveryStatus.js");
  const initialSource = readFileSync(sourcePath, "utf8");

  console.log("Deploying EvidenceRegistryV3");
  console.log("  network:       ", networkName);
  console.log("  deployer:      ", await deployer.getAddress());
  console.log("  marketplace:   ", marketplaceAddress);
  console.log("  router:        ", router);
  console.log("  initial source:", initialSource.length, "chars");

  const Registry = await ethers.getContractFactory("EvidenceRegistryV3", deployer);
  const registry = await Registry.deploy(marketplaceAddress, router, initialSource);
  const deployTx = registry.deploymentTransaction();
  if (deployTx === null) {
    throw new Error("Registry deployment transaction was not found");
  }

  await registry.waitForDeployment();
  const registryAddress = await registry.getAddress();

  console.log("\nDeployment complete.");
  console.log("  EvidenceRegistry:    ", registryAddress);
  console.log("  Deployment tx hash:  ", deployTx.hash);
  console.log("\nAdd to .env:");
  console.log(`  V3_${envUpper(networkName)}_EVIDENCE_REGISTRY_ADDRESS=${registryAddress}`);
  console.log("\nNext steps:");
  console.log("  1. scripts/addEvidenceRegistryConsumer.ts   — register as Functions consumer");
  console.log("  2. scripts/configureEvidenceRegistryV3.ts   — upload secrets, set Chainlink config");

  await connection.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
