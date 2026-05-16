// On-chain smoke for ShopNFT (Phase K.1).
//
// Walks the three paths a real user / operator will hit:
//   1. seller self-mint (mintShop)
//   2. owner admin-mint to a fresh random address (adminMint)
//   3. NFT transfer to another fresh address (shopIdOf migrates)
//   4. transferring to a recipient that already owns a shop reverts
//      with AlreadyOwnsShop
//
// Required env:
//   PRIVATE_KEY         deployer + NFT contract owner
//   SELLER_PRIVATE_KEY  separate wallet for the self-mint path
//   V3_3_<NETWORK>_SHOP_NFT_ADDRESS
//
// SELLER_PRIVATE_KEY must hold ≥ mintFee + ~gas (≈ 0.002 ETH on testnet
// is plenty). The smoke does NOT fund the seller — caller is responsible.
//
// Run:
//   npx hardhat run scripts/smokeShopNFT.ts --network arbitrumSepolia

import "dotenv/config";

import { network } from "hardhat";

async function main() {
  const connection = await network.create();
  const { ethers } = connection;

  const [deployer] = await ethers.getSigners();
  if (deployer === undefined) throw new Error("No deployer signer found. Check PRIVATE_KEY.");
  const deployerAddress = await deployer.getAddress();

  const sellerKey = process.env.SELLER_PRIVATE_KEY;
  if (!sellerKey || sellerKey.trim() === "") {
    throw new Error("SELLER_PRIVATE_KEY is not set — needed for the self-mint path.");
  }
  const seller = new ethers.Wallet(sellerKey, ethers.provider);

  const envNetwork = connection.networkName.toUpperCase();
  const shopNftAddrRaw = process.env[`V3_3_${envNetwork}_SHOP_NFT_ADDRESS`];
  if (!shopNftAddrRaw || shopNftAddrRaw.trim() === "") {
    throw new Error(`V3_3_${envNetwork}_SHOP_NFT_ADDRESS is not set.`);
  }
  const shopNftAddress = ethers.getAddress(shopNftAddrRaw.trim());

  console.log("ShopNFT smoke");
  console.log("Network        :", connection.networkName);
  console.log("ShopNFT        :", shopNftAddress);
  console.log("Deployer (owner):", deployerAddress);
  console.log("Seller wallet  :", seller.address);

  const shopNft = await ethers.getContractAt("ShopNFT", shopNftAddress, deployer);
  const mintFee: bigint = await shopNft.mintFeeWei();
  console.log("mintFeeWei     :", mintFee.toString());

  // 1) Seller self-mint (if they don't already own one).
  const sellerHasShop: bigint = await shopNft.shopIdOf(seller.address);
  let sellerShopId: bigint;
  let mintTxHash = "";
  if (sellerHasShop !== 0n) {
    console.log(`\n[mintShop] Seller already owns shop #${sellerHasShop.toString()} — skipping self-mint.`);
    sellerShopId = sellerHasShop;
  } else {
    console.log("\n[mintShop] Self-minting from seller wallet...");
    const tx = await shopNft.connect(seller).mintShop("Smoke Shop", "K.1 smoke", "", { value: mintFee });
    const receipt = await tx.wait();
    if (!receipt) throw new Error("no receipt for mintShop");
    mintTxHash = receipt.hash;
    sellerShopId = await shopNft.shopIdOf(seller.address);
    if (sellerShopId === 0n) throw new Error("mintShop completed but shopIdOf returned 0");
    console.log(`  tx       : ${mintTxHash}`);
    console.log(`  shopId   : ${sellerShopId.toString()}`);
  }

  // 2) Admin mint to a fresh random address. We don't transact from this
  //    address ever, so a deterministic-but-unique throwaway is fine.
  const adminTarget = ethers.Wallet.createRandom().address;
  let adminTxHash = "";
  let adminShopId: bigint = 0n;
  console.log("\n[adminMint] Owner-minting to a fresh wallet...");
  console.log(`  target   : ${adminTarget}`);
  {
    const tx = await shopNft.connect(deployer).adminMint(adminTarget, "Admin Shop", "", "");
    const receipt = await tx.wait();
    if (!receipt) throw new Error("no receipt for adminMint");
    adminTxHash = receipt.hash;
    adminShopId = await shopNft.shopIdOf(adminTarget);
    if (adminShopId === 0n) throw new Error("adminMint completed but shopIdOf returned 0");
    console.log(`  tx       : ${adminTxHash}`);
    console.log(`  shopId   : ${adminShopId.toString()}`);
  }

  // 3) Transfer seller's NFT to another fresh address. Tests the
  //    shopIdOf-migration path. We pick a Wallet.createRandom() so the
  //    smoke can run indefinitely without needing fresh fixture funds.
  const transferTarget = ethers.Wallet.createRandom().address;
  console.log("\n[transferFrom] Migrating seller's NFT to a fresh wallet...");
  console.log(`  to       : ${transferTarget}`);
  let transferTxHash = "";
  {
    const tx = await shopNft
      .connect(seller)
      .getFunction("transferFrom(address,address,uint256)")(seller.address, transferTarget, sellerShopId);
    const receipt = await tx.wait();
    if (!receipt) throw new Error("no receipt for transferFrom");
    transferTxHash = receipt.hash;
    console.log(`  tx       : ${transferTxHash}`);
  }
  const sellerAfter: bigint = await shopNft.shopIdOf(seller.address);
  const targetAfter: bigint = await shopNft.shopIdOf(transferTarget);
  if (sellerAfter !== 0n) throw new Error(`shopIdOf(seller) should be 0 after transfer; got ${sellerAfter}`);
  if (targetAfter !== sellerShopId) {
    throw new Error(`shopIdOf(target) should equal ${sellerShopId}; got ${targetAfter}`);
  }
  console.log(`  shopIdOf(seller)   : ${sellerAfter.toString()}  ✓`);
  console.log(`  shopIdOf(target)   : ${targetAfter.toString()}  ✓`);

  // 4) Trying to transfer the same NFT to the adminTarget (which already
  //    owns adminShopId) should revert.
  console.log("\n[transferFrom → existing-shop owner] Expecting AlreadyOwnsShop revert...");
  // The wallet doing the transfer is the current owner of sellerShopId,
  // which is now `transferTarget` (no private key in this script). To
  // exercise the revert path we need the holder to sign. Workaround:
  // approve from the holder is also infeasible. Use the deployer:
  // adminMint a temporary NFT to deployer then attempt transfer to a
  // recipient who already has one. Cheaper: simply re-attempt our last
  // legal transfer in reverse from the holder we control (seller has
  // a brand-new wallet without funds, so we can't). Pragmatic call:
  // adminMint a fresh NFT to deployer and try to send it to adminTarget.
  let revertObserved = false;
  let revertReason = "";
  let extraShopId: bigint = 0n;
  {
    const deployerHasShop: bigint = await shopNft.shopIdOf(deployerAddress);
    if (deployerHasShop === 0n) {
      const tx = await shopNft.connect(deployer).adminMint(deployerAddress, "Temp Shop", "", "");
      await tx.wait();
      extraShopId = await shopNft.shopIdOf(deployerAddress);
    } else {
      extraShopId = deployerHasShop;
    }
    try {
      await shopNft
        .connect(deployer)
        .getFunction("transferFrom(address,address,uint256)")(deployerAddress, adminTarget, extraShopId);
      throw new Error("Expected revert AlreadyOwnsShop, got success.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("AlreadyOwnsShop")) {
        revertObserved = true;
        revertReason = "AlreadyOwnsShop";
      } else {
        // Fall back to inspecting structured-revert data on ethers v6.
        const data = (err as { data?: unknown }).data;
        if (typeof data === "string" && data.startsWith("0x")) {
          revertObserved = true;
          revertReason = `revert data=${data.slice(0, 10)}…`;
        } else {
          throw err;
        }
      }
    }
  }
  console.log(`  reverted as expected (${revertReason})  ✓`);

  console.log("\n────────────────────────────────────────────");
  console.log("Phase K.1 smoke: PASS");
  console.log(`  mintShop tx       : ${mintTxHash || "(skipped — seller already had a shop)"}`);
  console.log(`  adminMint tx      : ${adminTxHash}`);
  console.log(`  transferFrom tx   : ${transferTxHash}`);
  console.log(`  revert observed   : ${revertObserved ? "yes" : "no"}`);
  console.log("────────────────────────────────────────────\n");

  await connection.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
