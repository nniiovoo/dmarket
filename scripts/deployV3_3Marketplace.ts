// Deploys EscrowMarketplaceV3_3 (Phase K.3b) and prints the .env block.
//
// Requires V3_3_<NETWORK>_SHOP_NFT_ADDRESS and
// V3_3_<NETWORK>_REVENUE_DISTRIBUTOR_ADDRESS — both baked into v3.3
// marketplace as immutable (shopNft) / mutable (distributor) references.
//
// After deploy, run scripts/wireV3_3.ts to authorise the new
// marketplace as a depositor on the distributor.
//
// The deploy script also allow-lists mUSD on Arbitrum Sepolia when the
// V3_2_<NETWORK>_MOCK_USD_ADDRESS env var is present, mirroring v3.2's
// initial allowlist so the new marketplace can accept the same testnet
// stablecoin without a manual second tx.

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

  const shopNftRaw = process.env[`V3_3_${envNetwork}_SHOP_NFT_ADDRESS`];
  const distRaw = process.env[`V3_3_${envNetwork}_REVENUE_DISTRIBUTOR_ADDRESS`];
  if (!shopNftRaw || !distRaw) {
    throw new Error(
      `V3_3_${envNetwork}_SHOP_NFT_ADDRESS and V3_3_${envNetwork}_REVENUE_DISTRIBUTOR_ADDRESS must both be set.`
    );
  }
  const shopNft = ethers.getAddress(shopNftRaw.trim());
  const distributor = ethers.getAddress(distRaw.trim());

  console.log("Deploying ChainUs v3.3 EscrowMarketplaceV3_3...");
  console.log("Network name        :", connection.networkName);
  console.log("Deployer address    :", deployerAddress);
  console.log("ShopNFT (linked)    :", shopNft);
  console.log("Distributor (linked):", distributor);

  const Factory = await ethers.getContractFactory("EscrowMarketplaceV3_3", deployer);
  const contract = await Factory.deploy(shopNft, distributor);
  const deploymentTx = contract.deploymentTransaction();
  if (deploymentTx === null) {
    throw new Error("EscrowMarketplaceV3_3 deployment transaction was not found");
  }
  await contract.waitForDeployment();
  const address = await contract.getAddress();

  console.log("\nv3.3 marketplace address           :", address);
  console.log("v3.3 marketplace deployment tx hash:", deploymentTx.hash);

  // Mirror v3.2's mUSD allowlist if the env var is present.
  const musdRaw = process.env[`V3_2_${envNetwork}_MOCK_USD_ADDRESS`];
  if (musdRaw && musdRaw.trim() !== "") {
    const musd = ethers.getAddress(musdRaw.trim());
    const tx = await contract.connect(deployer).setAcceptedToken(musd, true);
    const receipt = await tx.wait();
    console.log(`setAcceptedToken(mUSD = ${musd}) tx: ${receipt!.hash}`);
  } else {
    console.log(`setAcceptedToken(mUSD): skipped — V3_2_${envNetwork}_MOCK_USD_ADDRESS not set`);
  }

  console.log("\n--- Paste into .env ---");
  console.log(`V3_3_${envNetwork}_MARKETPLACE_ADDRESS=${address}`);
  console.log(`NEXT_PUBLIC_V3_3_${envNetwork}_MARKETPLACE_ADDRESS=${address}`);
  console.log("--- End paste block ---\n");
  console.log("Next step: scripts/wireV3_3.ts --network <network> to authorise the marketplace as a depositor.");

  await connection.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
