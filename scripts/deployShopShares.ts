// Deploys ShopShares (Phase K.2) and prints the .env block.
//
// Requires V3_3_<NETWORK>_SHOP_NFT_ADDRESS to already be set in .env —
// the address is baked into ShopShares as immutable, so a redeploy is
// the only way to fix a wrong reference. Run scripts/deployShopNFT.ts
// first if the address is missing.
//
// Defaults:
//   - baseUri = https://chainus.org/api/shop-shares/{id}.json
//     (override via V3_3_<NETWORK>_SHARES_BASE_URI)
//
// Owner stays at deployer (Ownable2Step). Initialization of shares is
// per-shop; existing migrated shops use scripts/initializeMigratedShops.ts.

import { network } from "hardhat";

const DEFAULT_BASE_URI = "https://chainus.org/api/shop-shares/{id}.json";

async function main() {
  const connection = await network.create();
  const { ethers } = connection;
  const [deployer] = await ethers.getSigners();
  if (deployer === undefined) {
    throw new Error("No deployer signer found. Check PRIVATE_KEY in your .env file.");
  }

  const deployerAddress = await deployer.getAddress();
  const envNetwork = connection.networkName.toUpperCase();

  const shopNftRaw = process.env[`V3_3_${envNetwork}_SHOP_NFT_ADDRESS`];
  if (!shopNftRaw || shopNftRaw.trim() === "") {
    throw new Error(
      `V3_3_${envNetwork}_SHOP_NFT_ADDRESS is not set — run scripts/deployShopNFT.ts first.`
    );
  }
  const shopNft = ethers.getAddress(shopNftRaw.trim());

  const baseUriRaw = process.env[`V3_3_${envNetwork}_SHARES_BASE_URI`];
  const baseUri = baseUriRaw && baseUriRaw.trim() !== "" ? baseUriRaw.trim() : DEFAULT_BASE_URI;

  console.log("Deploying ChainUs v3.3 ShopShares...");
  console.log("Network name      :", connection.networkName);
  console.log("Deployer address  :", deployerAddress);
  console.log("ShopNFT (linked)  :", shopNft);
  console.log("Base URI          :", baseUri);

  const Factory = await ethers.getContractFactory("ShopShares", deployer);
  const contract = await Factory.deploy(shopNft, baseUri);
  const deploymentTx = contract.deploymentTransaction();
  if (deploymentTx === null) {
    throw new Error("ShopShares deployment transaction was not found");
  }
  await contract.waitForDeployment();
  const address = await contract.getAddress();

  console.log("\nShopShares address          :", address);
  console.log("ShopShares deployment tx hash:", deploymentTx.hash);

  console.log("\n--- Paste into .env ---");
  console.log(`V3_3_${envNetwork}_SHOP_SHARES_ADDRESS=${address}`);
  console.log(`NEXT_PUBLIC_V3_3_${envNetwork}_SHOP_SHARES_ADDRESS=${address}`);
  console.log("--- End paste block ---\n");

  await connection.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
