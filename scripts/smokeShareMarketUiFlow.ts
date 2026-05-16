// CLI mirror of every wagmi-driven write the K.6b UI sends from a
// connected wallet. We don't open a real browser — instead we walk
// the same contract calls a connected wallet would, in the same
// order, so the contract addresses + ABIs the UI imports are proven
// against a live testnet from a CLI runner.
//
// Wallet model: a brand-new one-shot wallet (avoids colliding with
// the deployer's existing shop #4 from K.1). We fund it with just
// enough ETH to cover mint + init + approve + 1 listing + cancel +
// metadata update. All wagmi paths exercised:
//
//   1. shopNft.mintShop                         (MintShopBanner / /shops/new)
//   2. shopShares.initializeShares              (InitializeSharesButton)
//   3. shopShares.setApprovalForAll             (CreateListingForm step 1)
//   4. shareMarket.createListing (native)       (CreateListingForm step 2)
//   5. shareMarket.cancelListing                (CancelListingButton)
//   6. shopNft.updateShopMeta                   (UpdateShopMetaForm)
//
// Buy + claim live on separate-wallet flows (a buyer must not equal
// the seller per ShareMarket invariants); those are covered end-to-
// end by K.3a/K.3b/K.4 smokes and the integration tests. The UI
// components themselves wire the same contract calls — there's no
// new contract surface to smoke here.
//
// Run:
//   npx hardhat run scripts/smokeShareMarketUiFlow.ts --network arbitrumSepolia

import "dotenv/config";

import { network } from "hardhat";

const SHOP_OWNER_GAS_FUND = 3_000_000_000_000_000n; // 0.003 ETH
const ONE_ETH = 10n ** 18n;

async function main() {
  const connection = await network.create();
  const { ethers } = connection;
  const [deployer] = await ethers.getSigners();
  if (deployer === undefined) throw new Error("PRIVATE_KEY not set");
  const deployerAddress = await deployer.getAddress();
  const envNetwork = connection.networkName.toUpperCase();

  const shopNftAddr = process.env[`V3_3_${envNetwork}_SHOP_NFT_ADDRESS`];
  const shopSharesAddr = process.env[`V3_3_${envNetwork}_SHOP_SHARES_ADDRESS`];
  const shareMarketAddr = process.env[`V3_3_${envNetwork}_SHARE_MARKET_ADDRESS`];
  if (!shopNftAddr || !shopSharesAddr || !shareMarketAddr) {
    throw new Error(
      `V3_3_${envNetwork}_{SHOP_NFT,SHOP_SHARES,SHARE_MARKET}_ADDRESS must all be set.`
    );
  }

  console.log("K.6b UI-flow smoke");
  console.log("Network    :", connection.networkName);
  console.log("Deployer   :", deployerAddress);
  console.log("ShopNFT    :", shopNftAddr);
  console.log("ShopShares :", shopSharesAddr);
  console.log("ShareMarket:", shareMarketAddr);

  // Fetch the live mint fee so the smoke doesn't hardcode it.
  const deployerShopNft = await ethers.getContractAt("ShopNFT", shopNftAddr, deployer);
  const mintFeeWei: bigint = await deployerShopNft.mintFeeWei();
  console.log("mintFeeWei :", mintFeeWei.toString());

  // One-shot shopOwner — funded just enough to cover all 6 user-driven txs.
  const ownerKey = ethers.Wallet.createRandom();
  const shopOwner = new ethers.Wallet(ownerKey.privateKey, deployer.provider);
  console.log("shopOwner  :", shopOwner.address);
  {
    const tx = await deployer.sendTransaction({
      to: shopOwner.address,
      value: SHOP_OWNER_GAS_FUND + mintFeeWei
    });
    await tx.wait();
  }

  const ownerShopNft = await ethers.getContractAt("ShopNFT", shopNftAddr, shopOwner);
  const ownerShares = await ethers.getContractAt("ShopShares", shopSharesAddr, shopOwner);
  const ownerMarket = await ethers.getContractAt("ShareMarket", shareMarketAddr, shopOwner);

  // 1) mintShop ----------------------------------------------------------
  console.log("\n[1] mintShop({ name: 'K.6b Smoke Shop' })");
  let shopId: bigint;
  {
    const tx = await ownerShopNft.mintShop("K.6b Smoke Shop", "K.6b UI flow", "", { value: mintFeeWei });
    const r = await tx.wait();
    shopId = BigInt(await ownerShopNft.shopIdOf(shopOwner.address));
    console.log("    tx:", r!.hash, "shopId:", shopId.toString());
  }

  // 2) initializeShares -------------------------------------------------
  console.log("\n[2] initializeShares(", shopId.toString(), ")");
  {
    const tx = await ownerShares.initializeShares(shopId);
    const r = await tx.wait();
    console.log("    tx:", r!.hash);
    const bal: bigint = await ownerShares.balanceOf(shopOwner.address, shopId);
    if (bal !== 10_000n) throw new Error(`expected 10000 shares, got ${bal}`);
  }

  // 3) setApprovalForAll(shareMarket, true) -----------------------------
  console.log("\n[3] setApprovalForAll(shareMarket, true)");
  {
    const tx = await ownerShares.setApprovalForAll(shareMarketAddr, true);
    const r = await tx.wait();
    console.log("    tx:", r!.hash);
    const ok: boolean = await ownerShares.isApprovedForAll(shopOwner.address, shareMarketAddr);
    if (!ok) throw new Error("approval did not stick");
  }

  // 4) createListing (1 000 shares for 0.0005 ETH) ----------------------
  const NATIVE = "0x0000000000000000000000000000000000000000";
  const listingPrice = ONE_ETH / 2000n; // 0.0005 ETH
  const listingAmount = 1_000n;
  console.log(`\n[4] createListing(shopId=${shopId}, amount=${listingAmount}, token=NATIVE, price=${listingPrice})`);
  let listingId: bigint;
  {
    const tx = await ownerMarket.createListing(shopId, listingAmount, NATIVE, listingPrice);
    const r = await tx.wait();
    const log = r!.logs.find((l: { topics: readonly string[]; data: string }) => {
      try {
        return ownerMarket.interface.parseLog(l)?.name === "ListingCreated";
      } catch {
        return false;
      }
    });
    listingId = log ? (ownerMarket.interface.parseLog(log)!.args.listingId as bigint) : 0n;
    console.log("    tx:", r!.hash, "listingId:", listingId.toString());
  }

  // 5) cancelListing ----------------------------------------------------
  console.log(`\n[5] cancelListing(${listingId})`);
  {
    const tx = await ownerMarket.cancelListing(listingId);
    const r = await tx.wait();
    console.log("    tx:", r!.hash);
    const listing = await ownerMarket.getListing(listingId);
    if (listing.status !== 2n) throw new Error(`expected status=2 (Cancelled), got ${listing.status}`);
  }

  // 6) updateShopMeta ---------------------------------------------------
  console.log(`\n[6] updateShopMeta(${shopId}, …)`);
  {
    const tx = await ownerShopNft.updateShopMeta(
      shopId,
      "K.6b Smoke Shop (edited)",
      "Updated by smoke script",
      "ipfs://example"
    );
    const r = await tx.wait();
    console.log("    tx:", r!.hash);
    const meta = await ownerShopNft.shops(shopId);
    if (meta.name !== "K.6b Smoke Shop (edited)") throw new Error("name update did not stick");
  }

  console.log("\n────────────────────────────────────────────");
  console.log("K.6b smoke: PASS");
  console.log(`  shopId           : ${shopId}`);
  console.log(`  listingId        : ${listingId} (cancelled)`);
  console.log(`  meta updated     : ✓`);
  console.log("────────────────────────────────────────────\n");

  await connection.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
