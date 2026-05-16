// End-to-end smoke for ShareMarket (Phase K.4).
//
// Walks every code path:
//   1. Fresh shopOwner mints a shop + initialises 10 000 shares
//   2. shopOwner transfers 5 000 to alice (separate holder, exists
//      mostly to demonstrate the market doesn't touch unrelated
//      holdings)
//   3. shopOwner approves the market once
//   4. Listing #1: 2 000 shares for 0.001 ETH (native), buyer fills
//      → buyer holds 2 000 shares, shopOwner +0.001 ETH
//   5. Listing #2: 1 000 shares for 5 mUSD (ERC-20), buyer fills
//      → buyer holds 3 000 shares, shopOwner +5 mUSD
//   6. Listing #3: 2 000 shares for 0.0005 ETH, shopOwner cancels
//      → status = Cancelled, shares still in shopOwner's wallet
//
// Required env:
//   PRIVATE_KEY                                          deployer (funder)
//   V3_3_<NETWORK>_SHOP_NFT_ADDRESS
//   V3_3_<NETWORK>_SHOP_SHARES_ADDRESS
//   V3_3_<NETWORK>_SHARE_MARKET_ADDRESS
//   V3_2_<NETWORK>_MOCK_USD_ADDRESS                      mUSD for listing #2
//
// Run:
//   npx hardhat run scripts/smokeShareMarket.ts --network arbitrumSepolia

import "dotenv/config";

import { network } from "hardhat";

const SHOP_OWNER_GAS_FUND = 1_500_000_000_000_000n; // 0.0015 ETH (mint + init + approve + 3 createListing + cancel)
const BUYER_GAS_FUND = 1_000_000_000_000_000n; // 0.001 ETH (2 fills + 1 ERC-20 approve)
const ALICE_GAS_FUND = 0n; // alice doesn't transact in this smoke
const LISTING_1_PRICE = 1_000_000_000_000_000n; // 0.001 ETH
const LISTING_1_AMOUNT = 2_000n;
const LISTING_2_PRICE_MUSD = 5_000_000n; // 5 mUSD
const LISTING_2_AMOUNT = 1_000n;
const LISTING_3_PRICE = 500_000_000_000_000n; // 0.0005 ETH
const LISTING_3_AMOUNT = 2_000n;
const SHARES_TO_ALICE = 5_000n;
const BUYER_MUSD_FUND = 6_000_000n; // 6 mUSD (covers 5 mUSD + buffer)

async function main() {
  const connection = await network.create();
  const { ethers } = connection;
  const [deployer] = await ethers.getSigners();
  if (deployer === undefined) throw new Error("No deployer signer found.");
  const deployerAddress = await deployer.getAddress();
  const envNetwork = connection.networkName.toUpperCase();

  const shopNftRaw = process.env[`V3_3_${envNetwork}_SHOP_NFT_ADDRESS`];
  const sharesRaw = process.env[`V3_3_${envNetwork}_SHOP_SHARES_ADDRESS`];
  const marketRaw = process.env[`V3_3_${envNetwork}_SHARE_MARKET_ADDRESS`];
  const musdRaw = process.env[`V3_2_${envNetwork}_MOCK_USD_ADDRESS`];
  if (!shopNftRaw || !sharesRaw || !marketRaw || !musdRaw) {
    throw new Error(
      `All of V3_3_${envNetwork}_{SHOP_NFT,SHOP_SHARES,SHARE_MARKET}_ADDRESS and V3_2_${envNetwork}_MOCK_USD_ADDRESS must be set.`
    );
  }
  const shopNftAddress = ethers.getAddress(shopNftRaw.trim());
  const sharesAddress = ethers.getAddress(sharesRaw.trim());
  const marketAddress = ethers.getAddress(marketRaw.trim());
  const musdAddress = ethers.getAddress(musdRaw.trim());

  const rpcUrl =
    process.env.ARBITRUM_SEPOLIA_RPC_URL ?? process.env.NEXT_PUBLIC_ARBITRUM_SEPOLIA_RPC_URL;
  if (!rpcUrl || rpcUrl.trim() === "") {
    throw new Error("ARBITRUM_SEPOLIA_RPC_URL must be set for the one-shot wallets.");
  }
  const sideProvider = new ethers.JsonRpcProvider(rpcUrl);

  console.log("ShareMarket smoke");
  console.log("Network        :", connection.networkName);
  console.log("Deployer       :", deployerAddress);
  console.log("ShopNFT        :", shopNftAddress);
  console.log("ShopShares     :", sharesAddress);
  console.log("ShareMarket    :", marketAddress);
  console.log("mUSD           :", musdAddress);

  const shopNft = await ethers.getContractAt("ShopNFT", shopNftAddress, deployer);
  const shares = await ethers.getContractAt("ShopShares", sharesAddress, deployer);
  const market = await ethers.getContractAt("ShareMarket", marketAddress, deployer);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const musd: any = new ethers.Contract(
    musdAddress,
    [
      "function balanceOf(address) view returns (uint256)",
      "function transfer(address,uint256) returns (bool)",
      "function approve(address,uint256) returns (bool)"
    ],
    deployer
  );

  // Sanity: market knows its shares.
  const marketShares: string = await market.shares();
  if (marketShares.toLowerCase() !== sharesAddress.toLowerCase()) {
    throw new Error(`market.shares() = ${marketShares}, expected ${sharesAddress}`);
  }
  console.log("\n[0] market.shares() ✓");

  // [1] Mint a fresh smoke shop to a one-shot shopOwner.
  const shopOwner = ethers.Wallet.createRandom(sideProvider);
  const alice = ethers.Wallet.createRandom(sideProvider);
  const buyer = ethers.Wallet.createRandom(sideProvider);
  console.log(`\n[1] shopOwner = ${shopOwner.address}`);
  console.log(`    alice     = ${alice.address}`);
  console.log(`    buyer     = ${buyer.address}`);

  // Fund all three with the ETH they need to transact. alice is a
  // pure holder this run so she gets nothing.
  console.log("\n    funding shopOwner + buyer with gas ETH...");
  {
    const tx = await deployer.sendTransaction({ to: shopOwner.address, value: SHOP_OWNER_GAS_FUND });
    await tx.wait();
  }
  {
    const tx = await deployer.sendTransaction({ to: buyer.address, value: BUYER_GAS_FUND });
    await tx.wait();
  }
  if (ALICE_GAS_FUND > 0n) {
    const tx = await deployer.sendTransaction({ to: alice.address, value: ALICE_GAS_FUND });
    await tx.wait();
  }

  // adminMint shop to shopOwner (deployer is ShopNFT owner).
  let shopId: bigint;
  {
    console.log("\n    adminMint shop → shopOwner...");
    const tx = await shopNft.connect(deployer).adminMint(shopOwner.address, "K.4 Smoke Shop", "", "");
    const r = await tx.wait();
    shopId = await shopNft.shopIdOf(shopOwner.address);
    console.log(`    tx     : ${r!.hash}`);
    console.log(`    shopId : ${shopId}`);
  }

  // [2] Initialise + split shares.
  console.log(`\n[2] shopOwner initializeShares(#${shopId})...`);
  {
    const tx = await shares.connect(shopOwner).initializeShares(shopId);
    const r = await tx.wait();
    console.log(`    tx : ${r!.hash}`);
  }
  console.log(`    transferring ${SHARES_TO_ALICE} to alice...`);
  {
    const tx = await shares
      .connect(shopOwner)
      .safeTransferFrom(shopOwner.address, alice.address, shopId, SHARES_TO_ALICE, "0x");
    const r = await tx.wait();
    console.log(`    tx : ${r!.hash}`);
  }

  // [3] One-shot approval.
  console.log("\n[3] shopOwner approves ShareMarket...");
  {
    const tx = await shares.connect(shopOwner).setApprovalForAll(marketAddress, true);
    const r = await tx.wait();
    console.log(`    tx : ${r!.hash}`);
  }

  // [4] Listing #1: native fill.
  console.log(`\n[4] Listing #1: ${LISTING_1_AMOUNT} shares for ${LISTING_1_PRICE} wei native.`);
  let listing1Id: bigint;
  {
    const tx = await market
      .connect(shopOwner)
      .createListing(shopId, LISTING_1_AMOUNT, "0x0000000000000000000000000000000000000000", LISTING_1_PRICE);
    const r = await tx.wait();
    const log = r!.logs.find((l) => {
      try {
        return market.interface.parseLog(l)?.name === "ListingCreated";
      } catch {
        return false;
      }
    });
    if (!log) throw new Error("ListingCreated not found");
    listing1Id = market.interface.parseLog(log)!.args.listingId;
    console.log(`    createListing tx : ${r!.hash}`);
    console.log(`    listingId        : ${listing1Id}`);
  }

  console.log("    funding buyer with extra ETH (listing price)...");
  // Buyer needs LISTING_1_PRICE on top of gas budget. BUYER_GAS_FUND
  // already includes more than enough headroom; this is a safety top-up.
  {
    const tx = await deployer.sendTransaction({ to: buyer.address, value: LISTING_1_PRICE });
    await tx.wait();
  }

  const sellerEthBefore1 = await ethers.provider.getBalance(shopOwner.address);
  console.log("    buyer fillListing(1) with the exact 0.001 ETH...");
  {
    const tx = await market.connect(buyer).fillListing(listing1Id, { value: LISTING_1_PRICE });
    const r = await tx.wait();
    console.log(`    fill tx          : ${r!.hash}`);
  }
  const sellerEthAfter1 = await ethers.provider.getBalance(shopOwner.address);
  const buyerSharesAfter1: bigint = await shares.balanceOf(buyer.address, shopId);
  const marketEthAfter1 = await ethers.provider.getBalance(marketAddress);
  console.log(`    shopOwner ETH delta : +${sellerEthAfter1 - sellerEthBefore1}`);
  console.log(`    buyer shares balance: ${buyerSharesAfter1}`);
  console.log(`    market ETH balance  : ${marketEthAfter1}`);
  if (sellerEthAfter1 - sellerEthBefore1 !== LISTING_1_PRICE) throw new Error("seller native delta mismatch");
  if (buyerSharesAfter1 !== LISTING_1_AMOUNT) throw new Error("buyer shares after fill #1 mismatch");
  if (marketEthAfter1 !== 0n) throw new Error("market ETH balance non-zero after fill #1");

  // [5] Listing #2: ERC-20 fill.
  console.log(`\n[5] Listing #2: ${LISTING_2_AMOUNT} shares for ${LISTING_2_PRICE_MUSD} mUSD-base (5 mUSD).`);
  let listing2Id: bigint;
  {
    const tx = await market
      .connect(shopOwner)
      .createListing(shopId, LISTING_2_AMOUNT, musdAddress, LISTING_2_PRICE_MUSD);
    const r = await tx.wait();
    const log = r!.logs.find((l) => {
      try {
        return market.interface.parseLog(l)?.name === "ListingCreated";
      } catch {
        return false;
      }
    });
    listing2Id = market.interface.parseLog(log!)!.args.listingId;
    console.log(`    createListing tx : ${r!.hash}`);
    console.log(`    listingId        : ${listing2Id}`);
  }

  console.log("    funding buyer with mUSD + approving the market...");
  {
    const tx = await musd.connect(deployer).transfer(buyer.address, BUYER_MUSD_FUND);
    await tx.wait();
  }
  {
    const tx = await musd.connect(buyer).approve(marketAddress, LISTING_2_PRICE_MUSD);
    await tx.wait();
  }
  const sellerMusdBefore2: bigint = await musd.balanceOf(shopOwner.address);
  {
    const tx = await market.connect(buyer).fillListing(listing2Id);
    const r = await tx.wait();
    console.log(`    fill tx          : ${r!.hash}`);
  }
  const sellerMusdAfter2: bigint = await musd.balanceOf(shopOwner.address);
  const buyerSharesAfter2: bigint = await shares.balanceOf(buyer.address, shopId);
  const marketMusd2: bigint = await musd.balanceOf(marketAddress);
  const buyerMusdAfter2: bigint = await musd.balanceOf(buyer.address);
  console.log(`    shopOwner mUSD delta : +${sellerMusdAfter2 - sellerMusdBefore2}`);
  console.log(`    buyer shares balance : ${buyerSharesAfter2}`);
  console.log(`    buyer mUSD balance   : ${buyerMusdAfter2}`);
  console.log(`    market mUSD balance  : ${marketMusd2}`);
  if (sellerMusdAfter2 - sellerMusdBefore2 !== LISTING_2_PRICE_MUSD) {
    throw new Error("seller mUSD delta mismatch");
  }
  if (buyerSharesAfter2 !== LISTING_1_AMOUNT + LISTING_2_AMOUNT) {
    throw new Error(`buyer shares after fill #2 mismatch: ${buyerSharesAfter2}`);
  }
  if (marketMusd2 !== 0n) throw new Error("market mUSD balance non-zero after fill #2");

  // [6] Listing #3: created + cancelled.
  console.log(`\n[6] Listing #3: ${LISTING_3_AMOUNT} shares — to be cancelled.`);
  let listing3Id: bigint;
  {
    const tx = await market
      .connect(shopOwner)
      .createListing(shopId, LISTING_3_AMOUNT, "0x0000000000000000000000000000000000000000", LISTING_3_PRICE);
    const r = await tx.wait();
    listing3Id = market.interface.parseLog(
      r!.logs.find((l) => {
        try {
          return market.interface.parseLog(l)?.name === "ListingCreated";
        } catch {
          return false;
        }
      })!
    )!.args.listingId;
    console.log(`    createListing tx : ${r!.hash}`);
    console.log(`    listingId        : ${listing3Id}`);
  }
  {
    const tx = await market.connect(shopOwner).cancelListing(listing3Id);
    const r = await tx.wait();
    console.log(`    cancel tx        : ${r!.hash}`);
  }
  const listing3State = await market.getListing(listing3Id);
  if (listing3State.status !== 2n) throw new Error(`expected Cancelled (2), got ${listing3State.status}`);

  // [7] Final accounting.
  const finalSellerShares: bigint = await shares.balanceOf(shopOwner.address, shopId);
  const finalBuyerShares: bigint = await shares.balanceOf(buyer.address, shopId);
  const finalAliceShares: bigint = await shares.balanceOf(alice.address, shopId);
  const finalMarketEth = await ethers.provider.getBalance(marketAddress);
  const finalMarketMusd: bigint = await musd.balanceOf(marketAddress);
  const total: bigint = await shares.TOTAL_SUPPLY();

  console.log("\n────────────────────────────────────────────");
  console.log("Phase K.4 smoke: PASS");
  console.log(`  shopId                : ${shopId}`);
  console.log(`  listing #1 (native)   : filled (0.001 ETH ↔ 2 000 shares)`);
  console.log(`  listing #2 (mUSD)     : filled (5 mUSD ↔ 1 000 shares)`);
  console.log(`  listing #3 (native)   : cancelled`);
  console.log(`  final shopOwner shares: ${finalSellerShares} (= 10 000 − 5 000 alice − 2 000 buyer − 1 000 buyer)`);
  console.log(`  final buyer shares    : ${finalBuyerShares}`);
  console.log(`  final alice shares    : ${finalAliceShares}`);
  console.log(`  sum                   : ${finalSellerShares + finalBuyerShares + finalAliceShares} (must == ${total})`);
  console.log(`  market ETH balance    : ${finalMarketEth}`);
  console.log(`  market mUSD balance   : ${finalMarketMusd}`);
  console.log("────────────────────────────────────────────\n");

  if (finalSellerShares + finalBuyerShares + finalAliceShares !== total) {
    throw new Error("share total invariant violated");
  }
  if (finalMarketEth !== 0n) throw new Error("market ETH balance non-zero at end");
  if (finalMarketMusd !== 0n) throw new Error("market mUSD balance non-zero at end");

  await connection.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
