// Adds the V3.1 EvidenceRegistry as a consumer of the existing Chainlink
// Functions subscription. The V3.1 registry uses the SAME subscription
// (FUNCTIONS_SUBSCRIPTION_ID) as the V3 marketplace/registry — there's no
// reason to fragment them on testnet.
//
// Required env (root .env):
//   PRIVATE_KEY                                admin of the subscription
//   ARBITRUM_SEPOLIA_RPC_URL  (or matching one for your --network)
//   FUNCTIONS_SUBSCRIPTION_ID
//   V3_1_{NETWORK}_EVIDENCE_REGISTRY_ADDRESS
//
// Usage:
//   npx hardhat run scripts/addEvidenceRegistryConsumerV3_1.ts --network arbitrumSepolia

import { network } from "hardhat";

const ROUTER_ADDRESSES: Record<string, string> = {
  sepolia: "0xb83E47C2bC239B3bf370bc41e1459A34b41238D0",
  amoy: "0xC22a79eBA640940ABB6dF0f7982cc119578E11De",
  arbitrumSepolia: "0x234a5fb5Bd614a7AA2FfAB244D603abFA0Ac5C5C"
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
    `V3_1_${connection.networkName.toUpperCase()}_EVIDENCE_REGISTRY_ADDRESS`
  );

  const router = new ethers.Contract(routerAddress, ROUTER_ABI, admin);

  console.log("Subscription:        ", subscriptionId.toString());
  console.log("Adding consumer:     ", registryAddress, "(EvidenceRegistry V3.1)");

  // Idempotency: if already a consumer, addConsumer reverts. Detect first.
  const existing = await router.getSubscription(subscriptionId);
  const already = (existing.consumers as string[]).some(
    (c) => c.toLowerCase() === registryAddress.toLowerCase()
  );
  if (already) {
    console.log("\nAlready a consumer. No action taken.");
    await connection.close();
    return;
  }

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
