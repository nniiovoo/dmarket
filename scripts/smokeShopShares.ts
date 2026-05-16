// On-chain smoke for ShopShares (Phase K.2).
//
// Walks the operator-facing happy path:
//   1. adminMint a fresh ShopNFT to the deployer (so the deployer is the
//      shop owner — required to call initializeShares).
//   2. initializeShares: deployer receives 10,000 shares of the new shopId.
//   3. safeTransferFrom: deployer sends 100 shares to SELLER_PRIVATE_KEY's
//      address, leaving 9,900.
//
// Required env:
//   PRIVATE_KEY                                       deployer + ShopNFT owner
//   SELLER_PRIVATE_KEY                                used only for its derived address
//   V3_3_<NETWORK>_SHOP_NFT_ADDRESS                   from K.1 deploy
//   V3_3_<NETWORK>_SHOP_SHARES_ADDRESS                from K.2 deploy
//
// Run:
//   npx hardhat run scripts/smokeShopShares.ts --network arbitrumSepolia

import "dotenv/config";

import { network } from "hardhat";

const SHARES_TO_TRANSFER = 100n;

async function main() {
  const connection = await network.create();
  const { ethers } = connection;

  const [deployer] = await ethers.getSigners();
  if (deployer === undefined) throw new Error("No deployer signer found. Check PRIVATE_KEY.");
  const deployerAddress = await deployer.getAddress();

  const sellerKey = process.env.SELLER_PRIVATE_KEY;
  if (!sellerKey || sellerKey.trim() === "") {
    throw new Error("SELLER_PRIVATE_KEY is not set — needed only for its derived address.");
  }
  const sellerAddress = new ethers.Wallet(sellerKey).address;

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

  console.log("ShopShares smoke");
  console.log("Network        :", connection.networkName);
  console.log("ShopNFT        :", shopNftAddress);
  console.log("ShopShares     :", sharesAddress);
  console.log("Deployer       :", deployerAddress);
  console.log("Seller (target):", sellerAddress);

  const shopNft = await ethers.getContractAt("ShopNFT", shopNftAddress, deployer);
  const shares = await ethers.getContractAt("ShopShares", sharesAddress, deployer);

  const total: bigint = await shares.TOTAL_SUPPLY();
  console.log("TOTAL_SUPPLY   :", total.toString());

  // 1) Either reuse the deployer's existing shop, or admin-mint a fresh
  //    one so the smoke can run repeatedly without dying when the
  //    deployer already owns one.
  let shopId: bigint = await shopNft.shopIdOf(deployerAddress);
  let adminMintTxHash = "";
  if (shopId === 0n) {
    console.log("\n[adminMint] Owner-minting a fresh shop to the deployer...");
    const tx = await shopNft
      .connect(deployer)
      .adminMint(deployerAddress, "K.2 Smoke Shop", "ShopShares smoke", "");
    const receipt = await tx.wait();
    if (!receipt) throw new Error("no receipt for adminMint");
    adminMintTxHash = receipt.hash;
    shopId = await shopNft.shopIdOf(deployerAddress);
    if (shopId === 0n) throw new Error("adminMint completed but shopIdOf returned 0");
    console.log(`  tx     : ${adminMintTxHash}`);
    console.log(`  shopId : ${shopId.toString()}`);
  } else {
    console.log(`\n[adminMint] Deployer already owns shop #${shopId.toString()} — reusing.`);
  }

  // 2) initializeShares. Idempotent in the sense that "already done" is
  //    treated as a successful pre-condition, but the on-chain function
  //    itself reverts on a second call — so we check first.
  let initTxHash = "";
  const alreadyInitialized: boolean = await shares.initialized(shopId);
  if (alreadyInitialized) {
    console.log(`\n[initializeShares] Shop #${shopId.toString()} is already initialized — skipping.`);
  } else {
    console.log(`\n[initializeShares] Minting ${total.toString()} shares of #${shopId.toString()} to deployer...`);
    const tx = await shares.connect(deployer).initializeShares(shopId);
    const receipt = await tx.wait();
    if (!receipt) throw new Error("no receipt for initializeShares");
    initTxHash = receipt.hash;
    console.log(`  tx : ${initTxHash}`);
  }

  const deployerBalAfterInit: bigint = await shares.balanceOf(deployerAddress, shopId);
  if (!alreadyInitialized && deployerBalAfterInit !== total) {
    throw new Error(`Expected deployer to hold ${total} shares, got ${deployerBalAfterInit}`);
  }
  console.log(`  deployer balance: ${deployerBalAfterInit.toString()}`);

  // 3) Send SHARES_TO_TRANSFER to the seller address. Repeated runs
  //    accumulate at the seller — acceptable for a smoke.
  console.log(`\n[safeTransferFrom] Sending ${SHARES_TO_TRANSFER.toString()} shares to ${sellerAddress}...`);
  const transferTx = await shares
    .connect(deployer)
    .safeTransferFrom(deployerAddress, sellerAddress, shopId, SHARES_TO_TRANSFER, "0x");
  const transferReceipt = await transferTx.wait();
  if (!transferReceipt) throw new Error("no receipt for safeTransferFrom");

  const finalDeployer: bigint = await shares.balanceOf(deployerAddress, shopId);
  const finalSeller: bigint = await shares.balanceOf(sellerAddress, shopId);
  console.log(`  tx : ${transferReceipt.hash}`);
  console.log(`  deployer balance: ${finalDeployer.toString()}`);
  console.log(`  seller   balance: ${finalSeller.toString()}`);

  // Sum sanity check across the two known holders.
  const summed = finalDeployer + finalSeller;
  if (summed !== total) {
    throw new Error(
      `Expected ${total} total shares across deployer+seller; got ${summed.toString()}.` +
        " (Possible third-party holder from prior smokes — that's also fine; check on-chain.)"
    );
  }

  console.log("\n────────────────────────────────────────────");
  console.log("Phase K.2 smoke: PASS");
  console.log(`  shopId            : ${shopId.toString()}`);
  console.log(`  adminMint tx      : ${adminMintTxHash || "(reused existing shop)"}`);
  console.log(`  initializeShares  : ${initTxHash || "(already initialized)"}`);
  console.log(`  transfer tx       : ${transferReceipt.hash}`);
  console.log(`  final balances    : deployer=${finalDeployer.toString()} seller=${finalSeller.toString()}`);
  console.log("────────────────────────────────────────────\n");

  await connection.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
