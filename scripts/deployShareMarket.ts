// Deploys ShareMarket (Phase K.4) and prints the .env block.
//
// Requires V3_3_<NETWORK>_SHOP_SHARES_ADDRESS — the address is baked
// into ShareMarket as immutable, so a redeploy is the only way to fix
// a wrong reference.
//
// No post-deploy wiring is needed: ShareMarket isn't an authorised
// depositor of the distributor and isn't the settler — sellers
// approve the market individually via shopShares.setApprovalForAll
// when they list their first share.

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

  console.log("Deploying ChainUs v3.3 ShareMarket...");
  console.log("Network name    :", connection.networkName);
  console.log("Deployer address:", deployerAddress);
  console.log("ShopShares      :", shares);

  const Factory = await ethers.getContractFactory("ShareMarket", deployer);
  const contract = await Factory.deploy(shares);
  const deploymentTx = contract.deploymentTransaction();
  if (deploymentTx === null) {
    throw new Error("ShareMarket deployment transaction was not found");
  }
  await contract.waitForDeployment();
  const address = await contract.getAddress();

  console.log("\nShareMarket address           :", address);
  console.log("ShareMarket deployment tx hash:", deploymentTx.hash);

  console.log("\n--- Paste into .env ---");
  console.log(`V3_3_${envNetwork}_SHARE_MARKET_ADDRESS=${address}`);
  console.log(`NEXT_PUBLIC_V3_3_${envNetwork}_SHARE_MARKET_ADDRESS=${address}`);
  console.log("--- End paste block ---\n");
  console.log("No wiring step: ShareMarket is permissionless. Sellers approve it on first list.");

  await connection.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
