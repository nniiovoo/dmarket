// One-shot wiring for the v3.3 contract stack:
//   1. shares.setSettler(distributor)                         (Phase K.3a)
//   2. distributor.setAuthorizedDepositor(marketplace, true)  (Phase K.3b)
//
// Both steps are idempotent — re-running is safe. Step 2 is skipped
// (with a warn) when V3_3_<NETWORK>_MARKETPLACE_ADDRESS is not yet set.

import "dotenv/config";

import { network } from "hardhat";

async function main() {
  const connection = await network.create();
  const { ethers } = connection;
  const [deployer] = await ethers.getSigners();
  if (deployer === undefined) throw new Error("No deployer signer found.");
  const deployerAddress = await deployer.getAddress();
  const envNetwork = connection.networkName.toUpperCase();

  const sharesRaw = process.env[`V3_3_${envNetwork}_SHOP_SHARES_ADDRESS`];
  const distRaw = process.env[`V3_3_${envNetwork}_REVENUE_DISTRIBUTOR_ADDRESS`];
  if (!sharesRaw || !distRaw) {
    throw new Error(
      `Both V3_3_${envNetwork}_SHOP_SHARES_ADDRESS and V3_3_${envNetwork}_REVENUE_DISTRIBUTOR_ADDRESS must be set.`
    );
  }
  const sharesAddress = ethers.getAddress(sharesRaw.trim());
  const distAddress = ethers.getAddress(distRaw.trim());

  console.log("Wiring v3.3 contracts...");
  console.log("Network            :", connection.networkName);
  console.log("Deployer           :", deployerAddress);
  console.log("ShopShares         :", sharesAddress);
  console.log("RevenueDistributor :", distAddress);

  const shares = await ethers.getContractAt("ShopShares", sharesAddress, deployer);
  const distributor = await ethers.getContractAt("RevenueDistributor", distAddress, deployer);

  // Sanity: the distributor must point at THIS shares contract. If
  // they're mismatched, a setSettler would brick share transfers.
  const distSharesRef: string = await distributor.shares();
  if (distSharesRef.toLowerCase() !== sharesAddress.toLowerCase()) {
    throw new Error(
      `RevenueDistributor.shares() = ${distSharesRef}, expected ${sharesAddress}. Refusing to wire.`
    );
  }

  const currentSettler: string = await shares.settler();
  if (currentSettler.toLowerCase() === distAddress.toLowerCase()) {
    console.log("\n✓ shares.settler() already points at the distributor — nothing to do.");
  } else {
    console.log(`\n[setSettler] current=${currentSettler} → new=${distAddress}`);
    const tx = await shares.connect(deployer).setSettler(distAddress);
    const receipt = await tx.wait();
    if (!receipt) throw new Error("setSettler returned no receipt");
    console.log(`  tx: ${receipt.hash}`);
  }

  const after: string = await shares.settler();
  if (after.toLowerCase() !== distAddress.toLowerCase()) {
    throw new Error(`Post-wire mismatch: shares.settler() = ${after}, expected ${distAddress}.`);
  }
  console.log(`✓ shares.settler() = ${after}`);

  // -------------------------------------------------------------------
  // Step 2: authorise the v3.3 marketplace on the distributor (Phase K.3b)
  // -------------------------------------------------------------------
  const marketplaceRaw = process.env[`V3_3_${envNetwork}_MARKETPLACE_ADDRESS`];
  if (!marketplaceRaw || marketplaceRaw.trim() === "") {
    console.log(
      `\n[skip] V3_3_${envNetwork}_MARKETPLACE_ADDRESS is not set — re-run after scripts/deployV3_3Marketplace.ts.`
    );
    await connection.close();
    return;
  }
  const marketplaceAddress = ethers.getAddress(marketplaceRaw.trim());
  console.log(`\nv3.3 marketplace   : ${marketplaceAddress}`);

  const alreadyAuthorised: boolean = await distributor.authorizedDepositors(marketplaceAddress);
  if (alreadyAuthorised) {
    console.log("✓ distributor.authorizedDepositors[marketplace] = true — nothing to do.");
  } else {
    console.log("[setAuthorizedDepositor] marketplace → authorised");
    const tx = await distributor.connect(deployer).setAuthorizedDepositor(marketplaceAddress, true);
    const receipt = await tx.wait();
    if (!receipt) throw new Error("setAuthorizedDepositor returned no receipt");
    console.log(`  tx: ${receipt.hash}`);
  }
  const finalAuth: boolean = await distributor.authorizedDepositors(marketplaceAddress);
  if (!finalAuth) throw new Error("Post-wire mismatch: marketplace is not authorised.");
  console.log(`✓ distributor.authorizedDepositors[${marketplaceAddress}] = true`);

  // -------------------------------------------------------------------
  // K.4 ShareMarket — informational only. ShareMarket has no contract-
  // level wiring step: sellers approve it themselves at listing time
  // via shopShares.setApprovalForAll(market, true). Print a hint if it's
  // configured so the operator knows wireV3_3 saw it.
  // -------------------------------------------------------------------
  const shareMarketRaw = process.env[`V3_3_${envNetwork}_SHARE_MARKET_ADDRESS`];
  if (shareMarketRaw && shareMarketRaw.trim() !== "") {
    console.log(`\nShareMarket (K.4)  : ${ethers.getAddress(shareMarketRaw.trim())}`);
    console.log("  no wiring required — sellers approve market individually at listing time.");
  }

  await connection.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
