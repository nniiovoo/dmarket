// Adds the EvidenceRegistryV3 as a consumer of the existing Chainlink
// Functions subscription (the same one the V3 marketplace uses). Required
// before the registry can fire requests.
//
// Required env (root .env):
//   PRIVATE_KEY                                admin of the subscription
//   SEPOLIA_RPC_URL or AMOY_RPC_URL
//   FUNCTIONS_SUBSCRIPTION_ID
//   V3_{NETWORK}_EVIDENCE_REGISTRY_ADDRESS
//
// Usage:
//   npx hardhat run scripts/addEvidenceRegistryConsumer.ts --network sepolia

import { network } from "hardhat";

const ROUTER_ADDRESSES: Record<string, string> = {
  sepolia: "0xb83E47C2bC239B3bf370bc41e1459A34b41238D0",
  amoy: "0xC22a79eBA640940ABB6dF0f7982cc119578E11De"
};

const ROUTER_ABI = [
  "function addConsumer(uint64 subscriptionId, address consumer) external",
  "function getSubscription(uint64 subscriptionId) external view returns (uint96 balance, address owner, address[] memory consumers)"
];

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
  const routerAddress = ROUTER_ADDRESSES[connection.networkName];

  if (!routerAddress) {
    throw new Error(`Unsupported network: ${connection.networkName}`);
  }

  const [admin] = await ethers.getSigners();
  if (!admin) {
    throw new Error("No signer; check PRIVATE_KEY in .env");
  }

  const subscriptionId = BigInt(requireEnv("FUNCTIONS_SUBSCRIPTION_ID"));
  const registryAddress = requireEnv(
    `V3_${connection.networkName.toUpperCase()}_EVIDENCE_REGISTRY_ADDRESS`
  );

  const router = new ethers.Contract(routerAddress, ROUTER_ABI, admin);

  console.log("Subscription:        ", subscriptionId.toString());
  console.log("Adding consumer:     ", registryAddress, "(EvidenceRegistry)");

  const tx = await router.addConsumer(subscriptionId, registryAddress);
  console.log("Tx submitted:        ", tx.hash);
  await tx.wait();
  console.log("Confirmed.");

  const subscription = await router.getSubscription(subscriptionId);
  console.log("Subscription owner:    ", subscription.owner);
  console.log("Subscription balance:  ", subscription.balance.toString(), "(juels)");
  console.log("Subscription consumers:", subscription.consumers);

  await connection.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
