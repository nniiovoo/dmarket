// Deploys ShopNFT (Phase K.1) and prints the .env block.
//
// Network: pass via Hardhat's --network flag. Designed for
// `arbitrumSepolia` for the testnet rollout; runs against the local
// network too if you want to dry-run.
//
// Defaults:
//   - mintFeeWei = 0.001 ETH (env override: V3_3_<NETWORK>_SHOP_MINT_FEE_WEI)
//   - feeRecipient = deployer (env override:
//                    V3_3_<NETWORK>_SHOP_FEE_RECIPIENT)
//
// Owner stays at deployer (Ownable2Step). Migration runs after deploy
// via scripts/migrateSellersToShopNFT.ts.

import { network } from "hardhat";

const DEFAULT_MINT_FEE_WEI_ETH = "0.001";

async function main() {
  const connection = await network.create();
  const { ethers } = connection;
  const [deployer] = await ethers.getSigners();
  if (deployer === undefined) {
    throw new Error("No deployer signer found. Check PRIVATE_KEY in your .env file.");
  }

  const deployerAddress = await deployer.getAddress();
  const envNetwork = connection.networkName.toUpperCase();

  const mintFeeRaw = process.env[`V3_3_${envNetwork}_SHOP_MINT_FEE_WEI`];
  const mintFeeWei =
    mintFeeRaw && mintFeeRaw.trim() !== ""
      ? BigInt(mintFeeRaw)
      : ethers.parseEther(DEFAULT_MINT_FEE_WEI_ETH);

  const feeRecipientRaw = process.env[`V3_3_${envNetwork}_SHOP_FEE_RECIPIENT`];
  const feeRecipient =
    feeRecipientRaw && feeRecipientRaw.trim() !== ""
      ? ethers.getAddress(feeRecipientRaw.trim())
      : deployerAddress;

  console.log("Deploying ChainUs v3.3 ShopNFT...");
  console.log("Network name      :", connection.networkName);
  console.log("Deployer address  :", deployerAddress);
  console.log("mintFeeWei        :", mintFeeWei.toString(), `(${ethers.formatEther(mintFeeWei)} ETH)`);
  console.log("feeRecipient      :", feeRecipient);

  const Factory = await ethers.getContractFactory("ShopNFT", deployer);
  const contract = await Factory.deploy(mintFeeWei, feeRecipient);
  const deploymentTx = contract.deploymentTransaction();
  if (deploymentTx === null) {
    throw new Error("ShopNFT deployment transaction was not found");
  }
  await contract.waitForDeployment();
  const address = await contract.getAddress();

  console.log("\nShopNFT address           :", address);
  console.log("ShopNFT deployment tx hash:", deploymentTx.hash);

  console.log("\n--- Paste into .env ---");
  console.log(`V3_3_${envNetwork}_SHOP_NFT_ADDRESS=${address}`);
  console.log(`NEXT_PUBLIC_V3_3_${envNetwork}_SHOP_NFT_ADDRESS=${address}`);
  console.log("--- End paste block ---\n");

  await connection.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
