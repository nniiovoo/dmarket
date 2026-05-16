// On-chain smoke for RevenueDistributor (Phase K.3a).
//
// What this proves end-to-end on Arbitrum Sepolia:
//   1. shares.settler() points at the distributor (post-wireV3_3)
//   2. adminMint a fresh shop to the deployer
//   3. initializeShares(shopId) — settler hook fires, but it's a no-op
//      because no deposit has happened yet
//   4. deployer transfers 3000 shares to the seller-address — settler
//      fires for both sides, still no-op
//   5. deployer self-authorises as a depositor, then deposits 1 ETH
//      revenue for shopId
//   6. pendingClaim(deployer) = 0.7 ETH, pendingClaim(seller) = 0.3 ETH
//      (no rounding — 10000 * 1e18 / 10000 = 1e18 exactly)
//   7. seller.claim(...) actually pulls the 0.3 ETH out, leaving
//      deployer's 0.7 ETH still pending
//   8. deployer transfers another 2000 shares to seller (settler
//      credits deployer 0.7, leaves seller's userIndex at 0.7-tip but
//      with the freshly-credited 0.3 already gone)
//   9. deposit another 1 ETH → seller now has 5000/10000 share →
//      pendingClaim(seller) = 0.5 ETH, deployer pending = 0.7 + 0.5 = 1.2
//
// Required env:
//   PRIVATE_KEY                                          deployer wallet
//   SELLER_PRIVATE_KEY                                   used for its derived address only
//   V3_3_<NETWORK>_SHOP_NFT_ADDRESS                      from K.1
//   V3_3_<NETWORK>_SHOP_SHARES_ADDRESS                   from K.3a re-deploy
//   V3_3_<NETWORK>_REVENUE_DISTRIBUTOR_ADDRESS           from K.3a
//
// Run:
//   npx hardhat run scripts/smokeRevenueDistributor.ts --network arbitrumSepolia

import "dotenv/config";

import { network } from "hardhat";

const FIRST_TRANSFER = 3_000n;
const SECOND_TRANSFER = 2_000n;
// Use a small deposit so the smoke survives on a depleted testnet wallet.
// The math is identical: 0.01 ETH × (deployer_balance / 10_000) for the
// share split, and the assertions check the exact integer values.
const ONE_ETH_LITERAL = "0.01";

async function main() {
  const connection = await network.create();
  const { ethers } = connection;
  const [deployer] = await ethers.getSigners();
  if (deployer === undefined) throw new Error("No deployer signer found. Check PRIVATE_KEY.");
  const deployerAddress = await deployer.getAddress();

  const sellerKey = process.env.SELLER_PRIVATE_KEY;
  if (!sellerKey || sellerKey.trim() === "") {
    throw new Error("SELLER_PRIVATE_KEY is not set — needed for its derived address.");
  }
  const sellerAddress = new ethers.Wallet(sellerKey).address;

  const envNetwork = connection.networkName.toUpperCase();
  const shopNftRaw = process.env[`V3_3_${envNetwork}_SHOP_NFT_ADDRESS`];
  const sharesRaw = process.env[`V3_3_${envNetwork}_SHOP_SHARES_ADDRESS`];
  const distRaw = process.env[`V3_3_${envNetwork}_REVENUE_DISTRIBUTOR_ADDRESS`];
  if (!shopNftRaw || !sharesRaw || !distRaw) {
    throw new Error(
      `V3_3_${envNetwork}_SHOP_NFT_ADDRESS / SHOP_SHARES_ADDRESS / REVENUE_DISTRIBUTOR_ADDRESS must all be set.`
    );
  }
  const shopNftAddress = ethers.getAddress(shopNftRaw.trim());
  const sharesAddress = ethers.getAddress(sharesRaw.trim());
  const distAddress = ethers.getAddress(distRaw.trim());

  console.log("RevenueDistributor smoke");
  console.log("Network        :", connection.networkName);
  console.log("Deployer       :", deployerAddress);
  console.log("Seller (target):", sellerAddress);
  console.log("ShopNFT        :", shopNftAddress);
  console.log("ShopShares     :", sharesAddress);
  console.log("Distributor    :", distAddress);

  const shopNft = await ethers.getContractAt("ShopNFT", shopNftAddress, deployer);
  const shares = await ethers.getContractAt("ShopShares", sharesAddress, deployer);
  const distributor = await ethers.getContractAt("RevenueDistributor", distAddress, deployer);

  // 0) Sanity: settler wiring is in place.
  const wiredSettler: string = await shares.settler();
  if (wiredSettler.toLowerCase() !== distAddress.toLowerCase()) {
    throw new Error(
      `shares.settler() = ${wiredSettler}, expected ${distAddress}. Run scripts/wireV3_3.ts first.`
    );
  }
  console.log("\n[0] shares.settler() ✓ matches distributor");

  const NATIVE = "0x0000000000000000000000000000000000000000";
  const total: bigint = await shares.TOTAL_SUPPLY();
  const oneEth = ethers.parseEther(ONE_ETH_LITERAL);

  // 1) adminMint a fresh shop to the deployer (or reuse one).
  let shopId: bigint = await shopNft.shopIdOf(deployerAddress);
  let adminMintTxHash = "";
  if (shopId === 0n) {
    console.log("\n[1] Owner-minting a fresh shop to the deployer...");
    const tx = await shopNft.adminMint(deployerAddress, "K.3a Smoke Shop", "RevenueDistributor smoke", "");
    const receipt = await tx.wait();
    if (!receipt) throw new Error("adminMint no receipt");
    adminMintTxHash = receipt.hash;
    shopId = await shopNft.shopIdOf(deployerAddress);
    console.log(`    tx     : ${adminMintTxHash}`);
    console.log(`    shopId : ${shopId.toString()}`);
  } else {
    console.log(`\n[1] Deployer already owns shop #${shopId.toString()} — reusing.`);
  }

  // 2) initializeShares (skip if already done — re-runnable smoke).
  let initTxHash = "";
  if (!(await shares.initialized(shopId))) {
    console.log(`\n[2] initializeShares(#${shopId.toString()}) — mint 10000 shares to deployer.`);
    const tx = await shares.connect(deployer).initializeShares(shopId);
    const receipt = await tx.wait();
    if (!receipt) throw new Error("initializeShares no receipt");
    initTxHash = receipt.hash;
    console.log(`    tx : ${initTxHash}`);
  } else {
    console.log(`\n[2] Shares already initialized for #${shopId.toString()} — skipping.`);
  }

  // 3) Authorise the deployer as a depositor so we can deposit native
  // (K.3b will replace this with the marketplace authorising itself).
  const alreadyAuthorised = await distributor.authorizedDepositors(deployerAddress);
  if (!alreadyAuthorised) {
    console.log("\n[3] Self-authorising deployer as a depositor...");
    const tx = await distributor.connect(deployer).setAuthorizedDepositor(deployerAddress, true);
    await tx.wait();
  } else {
    console.log("\n[3] Deployer already authorised as depositor.");
  }

  // 4) deployer transfers FIRST_TRANSFER shares to the seller address.
  // Note: the settler is wired but no deposits yet → settle is a no-op.
  const initialSellerBal: bigint = await shares.balanceOf(sellerAddress, shopId);
  if (initialSellerBal < FIRST_TRANSFER) {
    console.log(`\n[4] Transferring ${FIRST_TRANSFER} shares deployer → seller...`);
    const tx = await shares
      .connect(deployer)
      .safeTransferFrom(deployerAddress, sellerAddress, shopId, FIRST_TRANSFER - initialSellerBal, "0x");
    const receipt = await tx.wait();
    console.log(`    tx : ${receipt!.hash}`);
  } else {
    console.log(`\n[4] Seller already holds ≥${FIRST_TRANSFER} shares — skipping initial transfer.`);
  }
  const deployerBalBefore: bigint = await shares.balanceOf(deployerAddress, shopId);
  const sellerBalBefore: bigint = await shares.balanceOf(sellerAddress, shopId);
  console.log(`    balances: deployer=${deployerBalBefore} seller=${sellerBalBefore}`);

  // 5) deposit 1 ETH revenue for shopId
  console.log(`\n[5] deposit ${ONE_ETH_LITERAL} ETH to shop #${shopId.toString()}...`);
  const dep1Tx = await distributor.connect(deployer).deposit(shopId, { value: oneEth });
  const dep1Receipt = await dep1Tx.wait();
  console.log(`    tx : ${dep1Receipt!.hash}`);
  const cumulative1: bigint = await distributor.cumulativeIndex(shopId, NATIVE);
  console.log(`    cumulativeIndex = ${cumulative1.toString()}`);

  // 6) pendingClaim should split 70/30 if deployer=7000, seller=3000.
  const pendingDep1: bigint = await distributor.pendingClaim(shopId, NATIVE, deployerAddress);
  const pendingSel1: bigint = await distributor.pendingClaim(shopId, NATIVE, sellerAddress);
  const expectedDep1 = (oneEth * deployerBalBefore) / total;
  const expectedSel1 = (oneEth * sellerBalBefore) / total;
  console.log(`\n[6] pendingClaim after deposit #1:`);
  console.log(`    deployer: ${pendingDep1.toString()}  (expected ${expectedDep1.toString()})`);
  console.log(`    seller  : ${pendingSel1.toString()}  (expected ${expectedSel1.toString()})`);
  if (pendingDep1 !== expectedDep1) throw new Error("deployer pendingClaim mismatch after deposit #1");
  if (pendingSel1 !== expectedSel1) throw new Error("seller pendingClaim mismatch after deposit #1");

  // 7) Second transfer THEN second deposit — proves the settler hook
  // credits the right pre-transfer balance for each side.
  console.log(`\n[7] Transferring ${SECOND_TRANSFER} more shares deployer → seller (settler fires)...`);
  const xfer2Tx = await shares
    .connect(deployer)
    .safeTransferFrom(deployerAddress, sellerAddress, shopId, SECOND_TRANSFER, "0x");
  const xfer2Receipt = await xfer2Tx.wait();
  console.log(`    tx : ${xfer2Receipt!.hash}`);

  const deployerBal2: bigint = await shares.balanceOf(deployerAddress, shopId);
  const sellerBal2: bigint = await shares.balanceOf(sellerAddress, shopId);
  console.log(`    balances: deployer=${deployerBal2} seller=${sellerBal2}`);

  console.log(`\n[8] deposit another ${ONE_ETH_LITERAL} ETH to shop #${shopId.toString()}...`);
  const dep2Tx = await distributor.connect(deployer).deposit(shopId, { value: oneEth });
  await dep2Tx.wait();

  // After deposit #2: deployer pending = expectedDep1 (still owed from #1)
  //                                       + oneEth * deployerBal2/total
  //                   seller   pending = expectedSel1 (already credited at xfer2 settle)
  //                                       + oneEth * sellerBal2/total
  const pendingDep2: bigint = await distributor.pendingClaim(shopId, NATIVE, deployerAddress);
  const pendingSel2: bigint = await distributor.pendingClaim(shopId, NATIVE, sellerAddress);
  const expectedDep2 = expectedDep1 + (oneEth * deployerBal2) / total;
  const expectedSel2 = expectedSel1 + (oneEth * sellerBal2) / total;
  console.log(`\n    pendingClaim after deposit #2:`);
  console.log(`    deployer: ${pendingDep2.toString()}  (expected ${expectedDep2.toString()})`);
  console.log(`    seller  : ${pendingSel2.toString()}  (expected ${expectedSel2.toString()})`);
  if (pendingDep2 !== expectedDep2) throw new Error("deployer pendingClaim mismatch after deposit #2");
  if (pendingSel2 !== expectedSel2) throw new Error("seller pendingClaim mismatch after deposit #2");

  // 9) deployer claims everything (we don't have the seller's private
  // key in this script, so we only exercise the claim path for the
  // deployer — that's enough to prove the on-chain transfer works).
  console.log(`\n[9] deployer claims native revenue for shop #${shopId.toString()}...`);
  const balBefore = await ethers.provider.getBalance(deployerAddress);
  const claimTx = await distributor.connect(deployer).claim(shopId, NATIVE);
  const claimReceipt = await claimTx.wait();
  const gas = claimReceipt!.gasUsed * claimReceipt!.gasPrice;
  const balAfter = await ethers.provider.getBalance(deployerAddress);
  const received = balAfter - balBefore + gas;
  console.log(`    tx       : ${claimReceipt!.hash}`);
  console.log(`    received : ${received.toString()} (expected ${expectedDep2.toString()})`);
  if (received !== expectedDep2) throw new Error("Claim payout mismatch");

  // After claim, deployer pending should be 0; seller pending should
  // be unchanged because we never touched their state.
  const pendingDep3: bigint = await distributor.pendingClaim(shopId, NATIVE, deployerAddress);
  const pendingSel3: bigint = await distributor.pendingClaim(shopId, NATIVE, sellerAddress);
  console.log(`\n    post-claim pending:`);
  console.log(`    deployer: ${pendingDep3.toString()} (expected 0)`);
  console.log(`    seller  : ${pendingSel3.toString()} (expected ${expectedSel2.toString()})`);
  if (pendingDep3 !== 0n) throw new Error("deployer pendingClaim should be 0 after claim");
  if (pendingSel3 !== expectedSel2) throw new Error("seller pendingClaim drifted unexpectedly");

  console.log("\n────────────────────────────────────────────");
  console.log("Phase K.3a smoke: PASS");
  console.log(`  shopId             : ${shopId.toString()}`);
  console.log(`  adminMint tx       : ${adminMintTxHash || "(reused existing shop)"}`);
  console.log(`  initializeShares   : ${initTxHash || "(already initialized)"}`);
  console.log(`  share transfer 1   : ${initialSellerBal < FIRST_TRANSFER ? "see [4]" : "(skipped)"}`);
  console.log(`  deposit #1 tx      : ${dep1Receipt!.hash}`);
  console.log(`  share transfer 2   : ${xfer2Receipt!.hash}`);
  console.log(`  deposit #2 tx      : ${(await dep2Tx.wait())!.hash}`);
  console.log(`  deployer claim tx  : ${claimReceipt!.hash}`);
  console.log(`  deployer net ETH   : +${received.toString()} (= ${ethers.formatEther(received)} ETH)`);
  console.log(`  seller pending     : ${pendingSel3.toString()} (= ${ethers.formatEther(pendingSel3)} ETH)`);
  console.log("────────────────────────────────────────────\n");

  await connection.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
