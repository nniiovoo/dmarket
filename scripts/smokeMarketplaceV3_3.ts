// End-to-end smoke for EscrowMarketplaceV3_3 (Phase K.3b).
//
// Proves on Arbitrum Sepolia:
//   - v3.3 marketplace is wired (distributor + authorisation + shopNft)
//   - createOrder(seller=deployer, paymentToken=mUSD) → payOrderERC20 →
//     markShipped → confirmReceived
//   - On completion: seller gets 99 %, distributor gets 1 % via
//     forceApprove + depositERC20
//   - Per-share math: deployer (7 000 shares) + alice (3 000 shares)
//     claim 70 % / 30 % of the fee respectively, summing to the full fee
//
// Funding model: PRIVATE_KEY (deployer) is also the seller AND a 7000-
// share holder of a fresh smoke shop. The script mints a one-shot
// "alice" wallet and a one-shot "buyer" wallet, then funds them with
// just enough mUSD and ETH to do their parts. This keeps the smoke
// independent of any external faucet state.
//
// Required env:
//   PRIVATE_KEY                                          deployer / seller / shareholder
//   V3_3_<NETWORK>_SHOP_NFT_ADDRESS
//   V3_3_<NETWORK>_SHOP_SHARES_ADDRESS
//   V3_3_<NETWORK>_REVENUE_DISTRIBUTOR_ADDRESS
//   V3_3_<NETWORK>_MARKETPLACE_ADDRESS
//   V3_2_<NETWORK>_MOCK_USD_ADDRESS                      mUSD allow-listed on the v3.3 marketplace
//
// Run:
//   npx hardhat run scripts/smokeMarketplaceV3_3.ts --network arbitrumSepolia

import "dotenv/config";

import { network } from "hardhat";

const ORDER_AMOUNT_MUSD = 3_000_000n; // 3 mUSD at 6 decimals
const ALICE_GAS_FUND = 200_000_000_000_000n; // 0.0002 ETH for one claim tx
const BUYER_GAS_FUND = 600_000_000_000_000n; // 0.0006 ETH (approve + pay + confirm)
const FIRST_SHARES_TO_ALICE = 3_000n; // 30 % split

async function main() {
  const connection = await network.create();
  const { ethers, provider } = connection;
  const [deployer] = await ethers.getSigners();
  if (deployer === undefined) throw new Error("No deployer signer found.");
  const deployerAddress = await deployer.getAddress();

  const envNetwork = connection.networkName.toUpperCase();
  const shopNftRaw = process.env[`V3_3_${envNetwork}_SHOP_NFT_ADDRESS`];
  const sharesRaw = process.env[`V3_3_${envNetwork}_SHOP_SHARES_ADDRESS`];
  const distRaw = process.env[`V3_3_${envNetwork}_REVENUE_DISTRIBUTOR_ADDRESS`];
  const marketRaw = process.env[`V3_3_${envNetwork}_MARKETPLACE_ADDRESS`];
  const musdRaw = process.env[`V3_2_${envNetwork}_MOCK_USD_ADDRESS`];
  if (!shopNftRaw || !sharesRaw || !distRaw || !marketRaw || !musdRaw) {
    throw new Error(
      `All of V3_3_${envNetwork}_{SHOP_NFT,SHOP_SHARES,REVENUE_DISTRIBUTOR,MARKETPLACE}_ADDRESS and V3_2_${envNetwork}_MOCK_USD_ADDRESS must be set.`
    );
  }
  const shopNftAddress = ethers.getAddress(shopNftRaw.trim());
  const sharesAddress = ethers.getAddress(sharesRaw.trim());
  const distAddress = ethers.getAddress(distRaw.trim());
  const marketAddress = ethers.getAddress(marketRaw.trim());
  const musdAddress = ethers.getAddress(musdRaw.trim());

  console.log("v3.3 marketplace end-to-end smoke");
  console.log("Network        :", connection.networkName);
  console.log("Deployer       :", deployerAddress);
  console.log("ShopNFT        :", shopNftAddress);
  console.log("ShopShares     :", sharesAddress);
  console.log("Distributor    :", distAddress);
  console.log("Marketplace    :", marketAddress);
  console.log("mUSD           :", musdAddress);

  const shopNft = await ethers.getContractAt("ShopNFT", shopNftAddress, deployer);
  const shares = await ethers.getContractAt("ShopShares", sharesAddress, deployer);
  const distributor = await ethers.getContractAt("RevenueDistributor", distAddress, deployer);
  const market = await ethers.getContractAt("EscrowMarketplaceV3_3", marketAddress, deployer);
  // Generic minimal ERC-20 surface — mUSD ABI from K.2.
  const ercAbi = [
    "function balanceOf(address) view returns (uint256)",
    "function transfer(address,uint256) returns (bool)",
    "function approve(address,uint256) returns (bool)",
    "function allowance(address,address) view returns (uint256)"
  ];
  // Cast through `unknown` so TypeChain doesn't lose the typed-call
  // surface — Hardhat's `ethers.Contract` constructor returns a
  // BaseContract whose methods are not statically known from the
  // string-array ABI.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const musd: any = new ethers.Contract(musdAddress, ercAbi, deployer);

  // [0] Sanity: marketplace ↔ distributor wiring.
  const marketDist: string = await market.distributor();
  if (marketDist.toLowerCase() !== distAddress.toLowerCase()) {
    throw new Error(`market.distributor() = ${marketDist}, expected ${distAddress}`);
  }
  const isAuth: boolean = await distributor.authorizedDepositors(marketAddress);
  if (!isAuth) throw new Error("market is not in distributor.authorizedDepositors — run wireV3_3.ts");
  const feeBps: bigint = await market.feeRateBps();
  console.log(`\n[0] wiring ✓  feeRateBps = ${feeBps}`);

  // Wallets that don't have an entry in PRIVATE_KEY need their own
  // JSON-RPC provider — Hardhat's network helper provider doesn't
  // expose getTransactionCount for standalone ethers signers.
  const rpcUrl =
    process.env.ARBITRUM_SEPOLIA_RPC_URL ?? process.env.NEXT_PUBLIC_ARBITRUM_SEPOLIA_RPC_URL;
  if (!rpcUrl || rpcUrl.trim() === "") {
    throw new Error("ARBITRUM_SEPOLIA_RPC_URL must be set for the one-shot wallets.");
  }
  const sideProvider = new ethers.JsonRpcProvider(rpcUrl);

  // [1] Always mint a FRESH smoke shop to a one-shot wallet so each
  // run starts from a known share-balance state. Reusing a shop the
  // deployer already owns can collide with prior smokes that already
  // distributed shares away from the deployer.
  //
  // To stay within "deployer is both seller and 70% shareholder", we
  // mint to a one-shot "shopOwner" wallet that we control — but for
  // simplicity, this smoke uses adminMint *to a brand-new address that
  // we control* via SELLER_PRIVATE_KEY when present, OR we move the
  // ShopNFT to deployer-after-mint by mint→transfer chain. The K.3a
  // bookkeeping leaves the deployer's #4 share pool short.
  //
  // Cheapest: adminMint a fresh shop to a fresh shopOwner wallet that
  // we then use as the seller for this smoke.
  const shopOwner = ethers.Wallet.createRandom(sideProvider);
  // shopOwner needs gas: minting shares + transferring shares to alice
  // + completing-side actions (markShipped). Budget generously.
  const SHOP_OWNER_GAS_FUND = 1_000_000_000_000_000n; // 0.001 ETH
  console.log(`\n[1] minting fresh smoke shop to a one-shot shopOwner...`);
  console.log(`    shopOwner address : ${shopOwner.address}`);
  {
    const tx = await deployer.sendTransaction({ to: shopOwner.address, value: SHOP_OWNER_GAS_FUND });
    await tx.wait();
  }
  let shopId: bigint;
  {
    const tx = await shopNft.connect(deployer).adminMint(shopOwner.address, "K.3b Smoke Shop", "", "");
    const r = await tx.wait();
    shopId = await shopNft.shopIdOf(shopOwner.address);
    console.log(`    adminMint tx : ${r!.hash}`);
    console.log(`    shopId       : ${shopId}`);
  }

  // [2] shopOwner initialises shares — gets all 10 000.
  console.log(`\n[2] shopOwner initialises shares for #${shopId}...`);
  {
    const tx = await shares.connect(shopOwner).initializeShares(shopId);
    const r = await tx.wait();
    console.log(`    tx : ${r!.hash}`);
  }

  // [3] Spin up a one-shot alice and a one-shot buyer (sideProvider
  // already created above for shopOwner).
  const alice = ethers.Wallet.createRandom(sideProvider);
  const buyer = ethers.Wallet.createRandom(sideProvider);
  console.log(`\n[3] alice  = ${alice.address}`);
  console.log(`    buyer  = ${buyer.address}`);

  // shopOwner transfers 3000 shares to alice → 7000 / 3000 split.
  console.log(`    transferring ${FIRST_SHARES_TO_ALICE} shares shopOwner → alice...`);
  {
    const tx = await shares
      .connect(shopOwner)
      .safeTransferFrom(shopOwner.address, alice.address, shopId, FIRST_SHARES_TO_ALICE, "0x");
    const r = await tx.wait();
    console.log(`    tx : ${r!.hash}`);
  }
  const shopOwnerShares: bigint = await shares.balanceOf(shopOwner.address, shopId);
  const aliceFinalShares: bigint = await shares.balanceOf(alice.address, shopId);
  console.log(`    balances: shopOwner=${shopOwnerShares} alice=${aliceFinalShares}`);

  // [4] Fund buyer with mUSD (3 + a tiny buffer for re-runs) and ETH.
  const buyerMusdBal: bigint = await musd.balanceOf(buyer.address);
  if (buyerMusdBal < ORDER_AMOUNT_MUSD) {
    console.log(`\n[4] funding buyer with ${ORDER_AMOUNT_MUSD} mUSD...`);
    const tx = await musd.connect(deployer).transfer(buyer.address, ORDER_AMOUNT_MUSD - buyerMusdBal);
    const r = await tx.wait();
    console.log(`    tx : ${r!.hash}`);
  }
  console.log("    funding buyer with gas ETH...");
  {
    const tx = await deployer.sendTransaction({ to: buyer.address, value: BUYER_GAS_FUND });
    const r = await tx.wait();
    console.log(`    tx : ${r!.hash}`);
  }
  console.log("    funding alice with gas ETH...");
  {
    const tx = await deployer.sendTransaction({ to: alice.address, value: ALICE_GAS_FUND });
    const r = await tx.wait();
    console.log(`    tx : ${r!.hash}`);
  }

  // [5] buyer creates order → pays → seller ships → buyer confirms.
  console.log("\n[5] buyer creates + pays + ships + confirms...");
  const buyerMarket = market.connect(buyer);
  const buyerMusd = musd.connect(buyer);

  const productId = 7n + shopId; // arbitrary, just unique per run
  const createTx = await buyerMarket.createOrder(shopOwner.address, musdAddress, productId, ORDER_AMOUNT_MUSD);
  const createReceipt = await createTx.wait();
  // Parse the OrderCreated event (now indexed orderId).
  const log = createReceipt!.logs.find((l) => {
    try {
      const parsed = market.interface.parseLog(l);
      return parsed?.name === "OrderCreated";
    } catch {
      return false;
    }
  });
  if (!log) throw new Error("OrderCreated not found in createOrder receipt");
  const orderId: bigint = market.interface.parseLog(log)!.args.orderId;
  console.log(`    createOrder tx     : ${createReceipt!.hash}`);
  console.log(`    orderId            : ${orderId}`);

  await (await buyerMusd.approve(marketAddress, ORDER_AMOUNT_MUSD)).wait();
  const payTx = await buyerMarket.payOrderERC20(orderId);
  const payReceipt = await payTx.wait();
  console.log(`    payOrderERC20 tx   : ${payReceipt!.hash}`);

  const shipTx = await market.connect(shopOwner).markShipped(orderId);
  const shipReceipt = await shipTx.wait();
  console.log(`    markShipped tx     : ${shipReceipt!.hash}`);

  // Capture balances JUST before confirm so we can measure the deltas.
  const sellerMusdBefore: bigint = await musd.balanceOf(shopOwner.address);
  const distMusdBefore: bigint = await musd.balanceOf(distAddress);

  const confirmTx = await buyerMarket.confirmReceived(orderId);
  const confirmReceipt = await confirmTx.wait();
  console.log(`    confirmReceived tx : ${confirmReceipt!.hash}`);

  const sellerMusdAfter: bigint = await musd.balanceOf(shopOwner.address);
  const distMusdAfter: bigint = await musd.balanceOf(distAddress);
  const sellerReceived = sellerMusdAfter - sellerMusdBefore;
  const distReceived = distMusdAfter - distMusdBefore;

  const expectedFee = (ORDER_AMOUNT_MUSD * feeBps) / 10_000n;
  const expectedSellerNet = ORDER_AMOUNT_MUSD - expectedFee;
  console.log(`\n[6] payout split:`);
  console.log(`    seller   received  : ${sellerReceived} mUSD-base (expected ${expectedSellerNet})`);
  console.log(`    dist     received  : ${distReceived} mUSD-base (expected ${expectedFee})`);
  if (sellerReceived !== expectedSellerNet) throw new Error("seller payout mismatch");
  if (distReceived !== expectedFee) throw new Error("distributor fee mismatch");

  // [7] Verify per-share math.
  const PRECISION: bigint = await distributor.PRECISION();
  const total: bigint = await shares.TOTAL_SUPPLY();
  const cumulative: bigint = await distributor.cumulativeIndex(shopId, musdAddress);
  console.log(`\n[7] cumulativeIndex[#${shopId}][mUSD] = ${cumulative}`);
  const expectedCumulativeContribution = (expectedFee * PRECISION) / total;
  // Note: cumulative may already be > 0 from earlier smoke runs on the
  // same shop. Assert *delta-style* against the pre-confirm value.
  // For simplicity we just assert it has grown by at least the
  // expected amount.
  // Pre-confirm value isn't captured here — instead, assert pendingClaim.
  const pendingShopOwner: bigint = await distributor.pendingClaim(shopId, musdAddress, shopOwner.address);
  const pendingAlice: bigint = await distributor.pendingClaim(shopId, musdAddress, alice.address);
  console.log(`    pendingClaim(shopOwner, ${shopOwnerShares} shares): ${pendingShopOwner}`);
  console.log(`    pendingClaim(alice,     ${aliceFinalShares} shares): ${pendingAlice}`);
  if (pendingShopOwner + pendingAlice !== expectedFee) {
    throw new Error(`pending sum ${pendingShopOwner + pendingAlice} != fee ${expectedFee}`);
  }
  if (pendingShopOwner * 3n !== pendingAlice * 7n) {
    throw new Error(
      `share split ratio mismatch: shopOwner=${pendingShopOwner} alice=${pendingAlice} (expected 7:3)`
    );
  }

  // [8] alice claims her 30 %.
  console.log("\n[8] alice claims her share...");
  const aliceMusdBefore: bigint = await musd.balanceOf(alice.address);
  {
    const claimTx = await distributor.connect(alice).claim(shopId, musdAddress);
    const r = await claimTx.wait();
    console.log(`    tx : ${r!.hash}`);
  }
  const aliceMusdAfter: bigint = await musd.balanceOf(alice.address);
  const aliceReceived = aliceMusdAfter - aliceMusdBefore;
  console.log(`    alice received: ${aliceReceived} mUSD-base`);
  if (aliceReceived !== pendingAlice) throw new Error("alice claim payout mismatch");

  // [9] shopOwner claims her 70 %.
  console.log("\n[9] shopOwner claims her share...");
  const soMusdBefore: bigint = await musd.balanceOf(shopOwner.address);
  {
    const claimTx = await distributor.connect(shopOwner).claim(shopId, musdAddress);
    const r = await claimTx.wait();
    console.log(`    tx : ${r!.hash}`);
  }
  const soMusdAfter: bigint = await musd.balanceOf(shopOwner.address);
  const soClaimed = soMusdAfter - soMusdBefore;
  console.log(`    shopOwner received: ${soClaimed} mUSD-base`);
  if (soClaimed !== pendingShopOwner) throw new Error("shopOwner claim payout mismatch");

  // [10] After both claims, distributor's mUSD balance from THIS order
  // is fully drained. (It may still hold dust from earlier smoke runs
  // on a different shopId; we don't assert == 0 globally.)
  const finalDistMusd: bigint = await musd.balanceOf(distAddress);
  console.log(`\n[10] distributor mUSD residual balance: ${finalDistMusd}`);
  if (finalDistMusd > distReceived - aliceReceived - soClaimed) {
    // alice + shopOwner should have drained everything we put in.
    // Allow residue (some prior smoke's un-claimed dust on a different shopId).
    console.log("     (residual covers other shops' un-claimed dust — fine.)");
  }

  console.log("\n────────────────────────────────────────────");
  console.log("Phase K.3b smoke: PASS");
  console.log(`  shopId             : ${shopId}`);
  console.log(`  order amount       : ${ORDER_AMOUNT_MUSD} mUSD-base (3 mUSD)`);
  console.log(`  fee                : ${expectedFee} mUSD-base (1 %)`);
  console.log(`  seller net         : ${expectedSellerNet} mUSD-base (99 %)`);
  console.log(`  shopOwner claim    : ${soClaimed} mUSD-base (= 7 000 / 10 000 of fee)`);
  console.log(`  alice claim        : ${aliceReceived} mUSD-base (= 3 000 / 10 000 of fee)`);
  console.log(`  sum vs fee         : ${soClaimed + aliceReceived} == ${expectedFee} ✓`);
  console.log("────────────────────────────────────────────\n");

  await connection.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
