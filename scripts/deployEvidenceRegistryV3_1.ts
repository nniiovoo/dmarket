// Deploys EvidenceRegistryV3 alongside an already-deployed V3.1 marketplace.
// Same contract source as the V3 registry — we just deploy a SECOND instance
// pointed at the V3.1 marketplace. constructor binds the marketplace, so the
// two registry instances are independent.
//
// Required env (root .env):
//   PRIVATE_KEY                                deployer
//   ARBITRUM_SEPOLIA_RPC_URL  (or matching one for your --network)
//   V3_1_{NETWORK}_MARKETPLACE_ADDRESS         already-deployed V3.1 marketplace
//
// Optional env:
//   FUNCTIONS_ROUTER_ADDRESS                   override Chainlink Functions router
//
// Usage:
//   npx hardhat run scripts/deployEvidenceRegistryV3_1.ts --network arbitrumSepolia

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { network } from "hardhat";

const FUNCTIONS_ROUTER: Record<string, string> = {
  sepolia: "0xb83E47C2bC239B3bf370bc41e1459A34b41238D0",
  amoy: "0xC22a79eBA640940ABB6dF0f7982cc119578E11De",
  arbitrumSepolia: "0x234a5fb5Bd614a7AA2FfAB244D603abFA0Ac5C5C"
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

  const marketplaceAddress = requireEnv(`V3_1_${envUpper(networkName)}_MARKETPLACE_ADDRESS`);

  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    throw new Error("No signer; check PRIVATE_KEY in .env");
  }

  // Initial source: same delivery-status JS the V3 registry uses. V3.1
  // marketplace event signatures match V3, so the JS is identical.
  const sourcePath = join(process.cwd(), "chainlink/functions/deliveryStatus.js");
  const initialSource = readFileSync(sourcePath, "utf8");

  console.log("Deploying EvidenceRegistryV3 (pointed at V3.1 marketplace)");
  console.log("  network:       ", networkName);
  console.log("  deployer:      ", await deployer.getAddress());
  console.log("  marketplace:   ", marketplaceAddress, "(V3.1)");
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
  console.log("  EvidenceRegistry (V3.1):", registryAddress);
  console.log("  Deployment tx hash:     ", deployTx.hash);
  console.log("\nAdd to .env:");
  console.log(`  V3_1_${envUpper(networkName)}_EVIDENCE_REGISTRY_ADDRESS=${registryAddress}`);
  console.log(`  NEXT_PUBLIC_V3_1_${envUpper(networkName)}_EVIDENCE_REGISTRY_ADDRESS=${registryAddress}`);
  console.log("\nNext steps:");
  console.log("  1. scripts/wireMarketplaceToEvidenceRegistryV3_1.ts — point marketplace at this registry");
  console.log("  2. scripts/addEvidenceRegistryConsumerV3_1.ts       — register as Functions consumer");
  console.log("  3. scripts/configureEvidenceRegistryV3_1.ts         — upload secrets, set Chainlink config");

  await connection.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
