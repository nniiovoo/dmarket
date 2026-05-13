// Adds the V3 marketplace as a consumer of the Chainlink Functions
// subscription. The Functions UI lets you do this manually; this script is
// here so you can script the full pipeline.
//
// Required env (root .env):
//   PRIVATE_KEY                       admin of the subscription (same wallet that created it)
//   SEPOLIA_RPC_URL or AMOY_RPC_URL
//   FUNCTIONS_SUBSCRIPTION_ID
//   V3_{NETWORK}_MARKETPLACE_ADDRESS
//
// Usage:
//   npx hardhat run scripts/addFunctionsConsumer.ts --network sepolia

import { network } from "hardhat";

const ROUTER_ADDRESSES: Record<string, string> = {
  sepolia: "0xb83E47C2bC239B3bf370bc41e1459A34b41238D0",
  amoy: "0xC22a79eBA640940ABB6dF0f7982cc119578E11De"
};

// Minimal Router ABI surface we touch.
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
  const marketplaceAddress = requireEnv(`V3_${connection.networkName.toUpperCase()}_MARKETPLACE_ADDRESS`);

  const router = new ethers.Contract(routerAddress, ROUTER_ABI, admin);

  console.log("Subscription:", subscriptionId.toString());
  console.log("Adding consumer:", marketplaceAddress);

  const tx = await router.addConsumer(subscriptionId, marketplaceAddress);
  console.log("Tx submitted:", tx.hash);
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
