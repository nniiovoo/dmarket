// End-to-end smoke for the M.1 partial-fill ShareMarket.
//
// Walks:
//   1. seller (SELLER_PRIVATE_KEY) needs a shop with initialised shares.
//      If shopIdOf(seller) == 0, mint one. If shop exists but shares
//      aren't initialised, call initializeShares.
//   2. seller setApprovalForAll(shareMarket, true).
//   3. seller createListing(shopId, 1000, NATIVE, 1e15) — 1000 tokens
//      at 0.001 ETH each.
//   4. deployer funds buyer1 + buyer2 with enough ETH for one partial
//      fill each + gas (we mint fresh wallets every run so the smoke
//      starts from a clean slate).
//   5. buyer1.fillListing(listingId, 300, value=3e17) → buyer1=300,
//      remaining=700, Active.
//   6. buyer2.fillListing(listingId, 700, value=7e17) → buyer2=700,
//      remaining=0, Filled.
//
// Required env:
//   PRIVATE_KEY                                      buyer1 funder + deployer
//   SELLER_PRIVATE_KEY                               seller (must own a shop or be able to mint one)
//   ARBITRUM_SEPOLIA_RPC_URL                         live RPC
//   V3_3_<NETWORK>_SHOP_NFT_ADDRESS
//   V3_3_<NETWORK>_SHOP_SHARES_ADDRESS
//   V3_3_<NETWORK>_SHARE_MARKET_ADDRESS              the M.1 redeploy
//
// Run:
//   npx hardhat run scripts/smokeShareMarketPartialFill.ts --network arbitrumSepolia

import "dotenv/config";

import { network } from "hardhat";

// Scaled to ~0.05 ETH total cost so the smoke runs on a low-balance
// testnet deployer wallet.
const PRICE_PER_TOKEN = 5n * 10n ** 13n; // 0.00005 ETH per token
const LISTING_AMOUNT = 1_000n;
const BUYER1_AMOUNT = 300n;
const BUYER2_AMOUNT = 700n;
const BUYER_GAS_FUND = 2_000_000_000_000_000n; // 0.002 ETH per buyer (covers fill + gas headroom)

async function main() {
  const connection = await network.create();
  const { ethers } = connection;
  const [deployer] = await ethers.getSigners();
  if (deployer === undefined) throw new Error("No deployer signer (PRIVATE_KEY missing).");
  const deployerAddress = await deployer.getAddress();
  const envNetwork = connection.networkName.toUpperCase();

  const sellerKey = process.env.SELLER_PRIVATE_KEY;
  if (!sellerKey) throw new Error("SELLER_PRIVATE_KEY missing.");

  const shopNftAddr = process.env[`V3_3_${envNetwork}_SHOP_NFT_ADDRESS`];
  const sharesAddr = process.env[`V3_3_${envNetwork}_SHOP_SHARES_ADDRESS`];
  const marketAddr = process.env[`V3_3_${envNetwork}_SHARE_MARKET_ADDRESS`];
  if (!shopNftAddr || !sharesAddr || !marketAddr) {
    throw new Error(
      `Missing V3_3_${envNetwork}_{SHOP_NFT,SHOP_SHARES,SHARE_MARKET}_ADDRESS`
    );
  }

  const seller = new ethers.Wallet(sellerKey, deployer.provider);
  console.log("M.1 ShareMarket partial-fill smoke");
  console.log("Network    :", connection.networkName);
  console.log("Deployer   :", deployerAddress);
  console.log("Seller     :", seller.address);
  console.log("ShopNFT    :", shopNftAddr);
  console.log("ShopShares :", sharesAddr);
  console.log("ShareMarket:", marketAddr);

  // ---------------------------------------------------------------------
  // 1. seller has a shop + initialised shares?
  // ---------------------------------------------------------------------
  const shopNft = await ethers.getContractAt("ShopNFT", shopNftAddr, seller);
  const shares = await ethers.getContractAt("ShopShares", sharesAddr, seller);
  let shopId: bigint = await shopNft.shopIdOf(seller.address);
  if (shopId === 0n) {
    const mintFee: bigint = await shopNft.mintFeeWei();
    console.log(`\n[setup] seller has no shop; minting one (fee=${ethers.formatEther(mintFee)} ETH)`);
    const tx = await shopNft.mintShop("M.1 Smoke Shop", "smokeShareMarketPartialFill", "", { value: mintFee });
    await tx.wait();
    shopId = await shopNft.shopIdOf(seller.address);
    console.log(`        minted shopId=${shopId}`);
  } else {
    console.log(`\n[setup] seller owns shopId=${shopId}`);
  }
  const sellerBal: bigint = await shares.balanceOf(seller.address, shopId);
  if (sellerBal === 0n) {
    console.log("[setup] shares not initialised; calling initializeShares(shopId)");
    const tx = await shares.initializeShares(shopId);
    await tx.wait();
    console.log(`        seller now holds ${(await shares.balanceOf(seller.address, shopId)).toString()} tokens`);
  } else {
    console.log(`[setup] seller holds ${sellerBal.toString()} tokens of shopId=${shopId}`);
  }

  // ---------------------------------------------------------------------
  // 2. seller approves market
  // ---------------------------------------------------------------------
  const market = await ethers.getContractAt("ShareMarket", marketAddr, seller);
  const isApproved: boolean = await shares.isApprovedForAll(seller.address, marketAddr);
  if (!isApproved) {
    console.log("\n[2] seller.setApprovalForAll(market, true)");
    const tx = await shares.setApprovalForAll(marketAddr, true);
    const r = await tx.wait();
    console.log(`    tx: ${r!.hash}`);
  } else {
    console.log("\n[2] seller already approved");
  }

  // ---------------------------------------------------------------------
  // 3. seller creates a 1000-token listing @ 0.001 ETH each
  // ---------------------------------------------------------------------
  console.log(
    `\n[3] seller.createListing(shopId=${shopId}, amount=${LISTING_AMOUNT}, NATIVE, pricePerToken=${PRICE_PER_TOKEN})`
  );
  const NATIVE = "0x0000000000000000000000000000000000000000";
  let listingId: bigint;
  {
    const tx = await market.createListing(shopId, LISTING_AMOUNT, NATIVE, PRICE_PER_TOKEN);
    const r = await tx.wait();
    const log = r!.logs.find((l: { topics: readonly string[]; data: string }) => {
      try {
        return market.interface.parseLog(l)?.name === "ListingCreated";
      } catch {
        return false;
      }
    });
    listingId = log ? (market.interface.parseLog(log)!.args.listingId as bigint) : 0n;
    console.log(`    tx: ${r!.hash}  listingId: ${listingId}`);
  }

  // ---------------------------------------------------------------------
  // 4. fund buyer1 + buyer2 from deployer
  // ---------------------------------------------------------------------
  const buyer1 = new ethers.Wallet(ethers.Wallet.createRandom().privateKey, deployer.provider);
  const buyer2 = new ethers.Wallet(ethers.Wallet.createRandom().privateKey, deployer.provider);
  console.log(`\n[4] funding buyer1=${buyer1.address} and buyer2=${buyer2.address}`);
  const cost1 = PRICE_PER_TOKEN * BUYER1_AMOUNT;
  const cost2 = PRICE_PER_TOKEN * BUYER2_AMOUNT;
  {
    const tx = await deployer.sendTransaction({ to: buyer1.address, value: cost1 + BUYER_GAS_FUND });
    await tx.wait();
  }
  {
    const tx = await deployer.sendTransaction({ to: buyer2.address, value: cost2 + BUYER_GAS_FUND });
    await tx.wait();
  }

  const buyer1Market = await ethers.getContractAt("ShareMarket", marketAddr, buyer1);
  const buyer2Market = await ethers.getContractAt("ShareMarket", marketAddr, buyer2);
  const sharesAsSomeone = await ethers.getContractAt("ShopShares", sharesAddr, deployer);

  // ---------------------------------------------------------------------
  // 5. buyer1 partial fill 300 of 1000
  // ---------------------------------------------------------------------
  console.log(`\n[5] buyer1.fillListing(${listingId}, ${BUYER1_AMOUNT}, value=${cost1})`);
  {
    const tx = await buyer1Market.fillListing(listingId, BUYER1_AMOUNT, { value: cost1 });
    const r = await tx.wait();
    console.log(`    tx: ${r!.hash}`);
  }
  let listing = await market.getListing(listingId);
  console.log(
    `    remainingAmount=${listing.remainingAmount}, status=${listing.status} (0=Active/1=Filled/2=Cancelled)`
  );
  let buyer1Tokens: bigint = await sharesAsSomeone.balanceOf(buyer1.address, shopId);
  console.log(`    buyer1 tokens: ${buyer1Tokens}`);
  if (buyer1Tokens !== BUYER1_AMOUNT) throw new Error("buyer1 token balance mismatch");
  if (listing.remainingAmount !== LISTING_AMOUNT - BUYER1_AMOUNT) {
    throw new Error("remainingAmount mismatch after buyer1");
  }
  if (listing.status !== 0n) throw new Error("status should still be Active");

  // ---------------------------------------------------------------------
  // 6. buyer2 finishes the listing — fills remaining 700
  // ---------------------------------------------------------------------
  console.log(`\n[6] buyer2.fillListing(${listingId}, ${BUYER2_AMOUNT}, value=${cost2})`);
  {
    const tx = await buyer2Market.fillListing(listingId, BUYER2_AMOUNT, { value: cost2 });
    const r = await tx.wait();
    console.log(`    tx: ${r!.hash}`);
  }
  listing = await market.getListing(listingId);
  console.log(
    `    remainingAmount=${listing.remainingAmount}, status=${listing.status}`
  );
  const buyer2Tokens: bigint = await sharesAsSomeone.balanceOf(buyer2.address, shopId);
  console.log(`    buyer2 tokens: ${buyer2Tokens}`);
  if (buyer2Tokens !== BUYER2_AMOUNT) throw new Error("buyer2 token balance mismatch");
  if (listing.remainingAmount !== 0n) throw new Error("remainingAmount should be 0");
  if (listing.status !== 1n) throw new Error("status should be Filled");

  console.log("\n────────────────────────────────────────────");
  console.log("M.1 partial-fill smoke: PASS");
  console.log(`  listingId        : ${listingId}`);
  console.log(`  buyer1 tokens    : ${buyer1Tokens}`);
  console.log(`  buyer2 tokens    : ${buyer2Tokens}`);
  console.log(`  listing status   : Filled (remaining=0)`);
  console.log("────────────────────────────────────────────\n");

  await connection.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
