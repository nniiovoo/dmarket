// Initializes ShopShares for shops minted in Phase K.1's migration.
//
// Walks shopId 1..nextShopId-1 on ShopNFT. For each shop:
//   - if shares are already initialized, skip
//   - if the current ShopNFT owner is the deployer, call
//     `initializeShares(shopId)` with the deployer wallet — minting 10k
//     shares to the deployer who can then distribute them off-chain
//     or via a follow-up tx
//   - if the current owner is anyone else, log a warning and skip:
//     only that owner can sign the initialization
//
// Idempotent: already-initialized shops are no-ops.
//
// Required env:
//   PRIVATE_KEY                                  deployer wallet
//   V3_3_<NETWORK>_SHOP_NFT_ADDRESS              from K.1
//   V3_3_<NETWORK>_SHOP_SHARES_ADDRESS           from K.2
//
// Run:
//   npx hardhat run scripts/initializeMigratedShops.ts --network arbitrumSepolia

import "dotenv/config";

import { network } from "hardhat";

async function main() {
  const connection = await network.create();
  const { ethers } = connection;
  const [deployer] = await ethers.getSigners();
  if (deployer === undefined) throw new Error("No deployer signer found. Check PRIVATE_KEY.");
  const deployerAddress = await deployer.getAddress();

  const envNetwork = connection.networkName.toUpperCase();
  const shopNftRaw = process.env[`V3_3_${envNetwork}_SHOP_NFT_ADDRESS`];
  const sharesRaw = process.env[`V3_3_${envNetwork}_SHOP_SHARES_ADDRESS`];
  if (!shopNftRaw || !sharesRaw) {
    throw new Error(
      `Both V3_3_${envNetwork}_SHOP_NFT_ADDRESS and V3_3_${envNetwork}_SHOP_SHARES_ADDRESS must be set.`
    );
  }
  const shopNftAddress = ethers.getAddress(shopNftRaw.trim());
  const sharesAddress = ethers.getAddress(sharesRaw.trim());

  console.log("Initializing ShopShares for migrated shops...");
  console.log("Network          :", connection.networkName);
  console.log("Deployer         :", deployerAddress);
  console.log("ShopNFT          :", shopNftAddress);
  console.log("ShopShares       :", sharesAddress);

  const shopNft = await ethers.getContractAt("ShopNFT", shopNftAddress, deployer);
  const shares = await ethers.getContractAt("ShopShares", sharesAddress, deployer);
  const total: bigint = await shares.TOTAL_SUPPLY();

  const nextShopId: bigint = await shopNft.nextShopId();
  if (nextShopId <= 1n) {
    console.log("No shops minted yet — nothing to do.");
    await connection.close();
    return;
  }

  let initialised = 0;
  let skipped = 0;
  let externallyOwned = 0;

  for (let id = 1n; id < nextShopId; id += 1n) {
    let owner: string;
    try {
      owner = await shopNft.ownerOf(id);
    } catch {
      console.log(`  [skip] shop #${id.toString()} — ownerOf reverted (token may have been burned).`);
      skipped += 1;
      continue;
    }

    const already: boolean = await shares.initialized(id);
    if (already) {
      console.log(`  [skip] shop #${id.toString()} already initialized (owner ${owner}).`);
      skipped += 1;
      continue;
    }

    if (owner.toLowerCase() !== deployerAddress.toLowerCase()) {
      console.warn(
        `  [warn] shop #${id.toString()} owned by ${owner} — only that wallet can call initializeShares.`
      );
      externallyOwned += 1;
      continue;
    }

    try {
      const tx = await shares.connect(deployer).initializeShares(id);
      const receipt = await tx.wait();
      if (!receipt) throw new Error("no receipt");
      console.log(
        `  [init] shop #${id.toString()} → ${total.toString()} shares to ${deployerAddress} (tx ${receipt.hash})`
      );
      initialised += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  [err ] shop #${id.toString()}: ${msg}`);
    }
  }

  console.log("\n--- Summary ---");
  console.log(`Initialised        : ${initialised}`);
  console.log(`Skipped (done/burn): ${skipped}`);
  console.log(`Externally-owned   : ${externallyOwned}`);
  console.log("---------------\n");

  await connection.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
