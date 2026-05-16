// Deploys RevenueDistributor (Phase K.3a) and prints the .env block.
//
// Requires V3_3_<NETWORK>_SHOP_SHARES_ADDRESS — the distributor binds
// the shares contract as immutable, so a wrong reference forces a
// redeploy. Run scripts/deployShopShares.ts (or its re-deploy
// successor) first.
//
// After deploy, run scripts/wireV3_3.ts to set the distributor as the
// shares settler so the transfer-hook fires on every share movement.

import { network } from "hardhat";

async function main() {
  const connection = await network.create();
  const { ethers } = connection;
  const [deployer] = await ethers.getSigners();
  if (deployer === undefined) {
    throw new Error("No deployer signer found. Check PRIVATE_KEY in your .env file.");
  }
  const deployerAddress = await deployer.getAddress();
  const envNetwork = connection.networkName.toUpperCase();

  const sharesRaw = process.env[`V3_3_${envNetwork}_SHOP_SHARES_ADDRESS`];
  if (!sharesRaw || sharesRaw.trim() === "") {
    throw new Error(
      `V3_3_${envNetwork}_SHOP_SHARES_ADDRESS is not set — deploy ShopShares first.`
    );
  }
  const shares = ethers.getAddress(sharesRaw.trim());

  console.log("Deploying ChainUs v3.3 RevenueDistributor...");
  console.log("Network name      :", connection.networkName);
  console.log("Deployer address  :", deployerAddress);
  console.log("ShopShares (linked):", shares);

  const Factory = await ethers.getContractFactory("RevenueDistributor", deployer);
  const contract = await Factory.deploy(shares);
  const deploymentTx = contract.deploymentTransaction();
  if (deploymentTx === null) {
    throw new Error("RevenueDistributor deployment transaction was not found");
  }
  await contract.waitForDeployment();
  const address = await contract.getAddress();

  console.log("\nRevenueDistributor address           :", address);
  console.log("RevenueDistributor deployment tx hash:", deploymentTx.hash);

  console.log("\n--- Paste into .env ---");
  console.log(`V3_3_${envNetwork}_REVENUE_DISTRIBUTOR_ADDRESS=${address}`);
  console.log(`NEXT_PUBLIC_V3_3_${envNetwork}_REVENUE_DISTRIBUTOR_ADDRESS=${address}`);
  console.log("--- End paste block ---\n");
  console.log("Next step: run scripts/wireV3_3.ts --network <network> to set settler.");

  await connection.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
