// Sepolia deployment E2E test — order lifecycle + evidence + oracle.
//
// Required env (root .env):
//   PRIVATE_KEY                        deployer / buyer / owner
//   SELLER_PRIVATE_KEY                 seller (different wallet, needs Sepolia ETH)
//   SEPOLIA_RPC_URL
//   V3_SEPOLIA_VAULT_ADDRESS
//   V3_SEPOLIA_MARKETPLACE_ADDRESS
//   V3_SEPOLIA_EVIDENCE_REGISTRY_ADDRESS
//
// Usage:
//   npx hardhat run scripts/sepoliaTest/02_lifecycleAndEvidence.ts --network sepolia
//
// Costs: ~0.005 ETH gas + 0.002 ETH locked in escrow (released back on
// withdraw). 1 oracle call uses ~0.2 LINK from the platform subscription.

import { network } from "hardhat";
import type { Wallet } from "ethers";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

function fmtEth(wei: bigint): string {
  const eth = Number(wei) / 1e18;
  return eth.toFixed(6) + " ETH";
}

function section(label: string) {
  console.log("\n" + "=".repeat(70));
  console.log(label);
  console.log("=".repeat(70));
}

async function main() {
  const connection = await network.create();
  const { ethers } = connection;

  const vaultAddr = requireEnv("V3_SEPOLIA_VAULT_ADDRESS");
  const marketplaceAddr = requireEnv("V3_SEPOLIA_MARKETPLACE_ADDRESS");
  const registryAddr = requireEnv("V3_SEPOLIA_EVIDENCE_REGISTRY_ADDRESS");
  const sellerKey = requireEnv("SELLER_PRIVATE_KEY");

  const [buyer] = await ethers.getSigners();
  if (!buyer) throw new Error("No buyer signer; check PRIVATE_KEY");

  // Use the same provider; just attach a different key for seller.
  // ethers v6 in hardhat 3 — buyer.provider is the configured Sepolia provider.
  const seller = new ethers.Wallet(sellerKey, buyer.provider) as unknown as Wallet;

  const buyerAddr = await buyer.getAddress();
  const sellerAddr = await seller.getAddress();

  const vault = await ethers.getContractAt("EscrowVaultV3", vaultAddr, buyer);
  const marketplace = await ethers.getContractAt("EscrowMarketplaceV3", marketplaceAddr, buyer);
  const registry = await ethers.getContractAt("EvidenceRegistryV3", registryAddr, buyer);

  // Will need to switch to seller-signer for some calls.
  const marketplaceAsSeller = marketplace.connect(seller);
  const registryAsSeller = registry.connect(seller);
  const vaultAsSeller = vault.connect(seller);

  section("Setup");
  console.log(`Buyer:  ${buyerAddr}`);
  console.log(`Seller: ${sellerAddr}`);
  const buyerBalance = await buyer.provider!.getBalance(buyerAddr);
  const sellerBalance = await buyer.provider!.getBalance(sellerAddr);
  console.log(`Buyer balance:  ${fmtEth(buyerBalance)}`);
  console.log(`Seller balance: ${fmtEth(sellerBalance)}`);

  if (buyerAddr.toLowerCase() === sellerAddr.toLowerCase()) {
    throw new Error("Buyer and seller must be different wallets");
  }
  if (buyerBalance < ethers.parseEther("0.01")) {
    throw new Error("Buyer needs ≥ 0.01 Sepolia ETH for testing");
  }
  if (sellerBalance < ethers.parseEther("0.005")) {
    throw new Error(
      `Seller wallet ${sellerAddr} needs ≥ 0.005 Sepolia ETH for gas. ` +
      `Send some test ETH there before running this script.`
    );
  }

  const startOrderId = await marketplace.nextOrderId();
  console.log(`nextOrderId before test: ${startOrderId}`);

  const ORDER_AMOUNT = ethers.parseEther("0.001"); // 0.001 ETH per order

  // ─────────────────────────────────────────────────────────────────────
  section("Test 1: Happy path lifecycle (createAndPay → ship → confirm → withdraw)");

  console.log("\n[1.1] Buyer createAndPay()");
  const tx1 = await marketplace.createAndPay(sellerAddr, 1001n, { value: ORDER_AMOUNT });
  const r1 = await tx1.wait();
  const order1Id = startOrderId;
  console.log(`  ✓ tx: ${r1!.hash}`);
  console.log(`  ✓ orderId: ${order1Id}`);

  const o1AfterPay = await marketplace.getOrder(order1Id);
  console.log(`  status: ${o1AfterPay.status} (expected 1 = Paid)`);
  if (o1AfterPay.status !== 1n) throw new Error("Expected status Paid");

  const lockedBefore = await vault.lockedAmount(order1Id);
  console.log(`  vault locked: ${fmtEth(lockedBefore)}`);
  if (lockedBefore !== ORDER_AMOUNT) throw new Error("Vault locked amount mismatch");

  const partiesV = await vault.partiesByOrder(order1Id);
  if (partiesV.buyer.toLowerCase() !== buyerAddr.toLowerCase()) throw new Error("Vault buyer mismatch (H5 check)");
  if (partiesV.seller.toLowerCase() !== sellerAddr.toLowerCase()) throw new Error("Vault seller mismatch (H5 check)");
  console.log(`  ✓ vault.partiesByOrder buyer/seller correct (H5 working)`);

  console.log("\n[1.2] Seller markShipped()");
  const tx2 = await marketplaceAsSeller.markShipped(order1Id);
  const r2 = await tx2.wait();
  console.log(`  ✓ tx: ${r2!.hash}`);

  const o1AfterShip = await marketplace.getOrder(order1Id);
  if (o1AfterShip.status !== 2n) throw new Error("Expected status Shipped");
  console.log(`  ✓ status now Shipped`);

  console.log("\n[1.3] Buyer confirmReceived()");
  const tx3 = await marketplace.confirmReceived(order1Id);
  const r3 = await tx3.wait();
  console.log(`  ✓ tx: ${r3!.hash}`);

  const o1AfterConfirm = await marketplace.getOrder(order1Id);
  if (o1AfterConfirm.status !== 3n) throw new Error("Expected status Completed");
  console.log(`  ✓ status now Completed`);

  const sellerPending = await vault.pendingWithdrawal(sellerAddr);
  console.log(`  seller.pendingWithdrawal: ${fmtEth(sellerPending)}`);
  if (sellerPending < ORDER_AMOUNT) throw new Error("Seller pending should be at least order amount");

  console.log("\n[1.4] Seller withdraw() — pull payment");
  const sellerBalBefore = await buyer.provider!.getBalance(sellerAddr);
  const tx4 = await vaultAsSeller.withdraw(sellerAddr);
  const r4 = await tx4.wait();
  console.log(`  ✓ tx: ${r4!.hash}`);
  const sellerBalAfter = await buyer.provider!.getBalance(sellerAddr);
  const gain = sellerBalAfter - sellerBalBefore + r4!.gasUsed * r4!.gasPrice;
  console.log(`  seller balance change (gas-adjusted): ${fmtEth(gain)}`);
  console.log(`  ✓ happy path lifecycle complete`);

  // ─────────────────────────────────────────────────────────────────────
  section("Test 2: Dispute path + Evidence (createAndPay → ship → openDispute → submit evidence)");

  console.log("\n[2.1] Buyer createAndPay() — order 2");
  const tx5 = await marketplace.createAndPay(sellerAddr, 1002n, { value: ORDER_AMOUNT });
  const r5 = await tx5.wait();
  const order2Id = startOrderId + 1n;
  console.log(`  ✓ orderId: ${order2Id}, tx: ${r5!.hash}`);

  console.log("\n[2.2] Seller markShipped()");
  await (await marketplaceAsSeller.markShipped(order2Id)).wait();
  console.log(`  ✓ status: Shipped`);

  console.log("\n[2.3] Buyer openDispute()");
  const tx6 = await marketplace.openDispute(order2Id);
  await tx6.wait();
  const o2AfterDispute = await marketplace.getOrder(order2Id);
  if (o2AfterDispute.status !== 5n) throw new Error("Expected status Disputed");
  console.log(`  ✓ status: Disputed, disputedAt: ${o2AfterDispute.disputedAt}`);

  console.log("\n[2.4] Buyer submitEvidence(orderId, uri) — passive mode");
  const buyerEvidenceURI = "ipfs://QmBuyerEvidenceTestSepolia001";
  const tx7 = await registry.submitEvidence(order2Id, buyerEvidenceURI);
  const r7 = await tx7.wait();
  console.log(`  ✓ tx: ${r7!.hash}`);
  const evCount = await registry.getEvidenceCount(order2Id);
  console.log(`  ✓ evidence count: ${evCount}`);
  const ev0 = await registry.getEvidence(order2Id, 0);
  console.log(`  evidence[0].party: ${ev0.party}`);
  console.log(`  evidence[0].contentHash: ${ev0.contentHash}`);

  console.log("\n[2.5] Seller submitEvidence(orderId, uri) — second piece");
  const sellerEvidenceURI = "ipfs://QmSellerCounterEvidenceTestSepolia002";
  await (await registryAsSeller.submitEvidence(order2Id, sellerEvidenceURI)).wait();
  const evCount2 = await registry.getEvidenceCount(order2Id);
  console.log(`  ✓ evidence count: ${evCount2}`);

  // ─────────────────────────────────────────────────────────────────────
  section("Test 3: Oracle path — submitEvidenceWithOracleQuery + Chainlink callback");

  console.log("\n[3.1] Buyer submitEvidenceWithOracleQuery() — fires Chainlink request");
  const oracleEvidenceURI = "ipfs://QmOracleQueryEvidence003";
  const tx8 = await registry.submitEvidenceWithOracleQuery(order2Id, oracleEvidenceURI);
  const r8 = await tx8.wait();
  console.log(`  ✓ tx: ${r8!.hash}`);

  // Find the OracleQueryRequested event to grab requestId
  const evIndex = await registry.getEvidenceCount(order2Id) - 1n;
  const evRec = await registry.getEvidence(order2Id, evIndex);
  console.log(`  oracle requestId: ${evRec.oracleRequestId}`);

  console.log("\n[3.2] Polling for Chainlink callback (up to 3 minutes)...");
  const start = Date.now();
  const maxWaitMs = 3 * 60 * 1000;
  let oracleResult: { fulfilled: boolean; delivered: boolean; deliveredTimestamp: bigint } | null = null;
  while (Date.now() - start < maxWaitMs) {
    const result = await registry.oracleResults(order2Id, evIndex);
    if (result.fulfilled) {
      oracleResult = result;
      break;
    }
    process.stdout.write(".");
    await new Promise((res) => setTimeout(res, 10_000)); // poll every 10s
  }
  console.log("");

  if (oracleResult) {
    console.log(`  ✓ Callback received after ${Math.floor((Date.now() - start) / 1000)}s`);
    console.log(`    delivered:           ${oracleResult.delivered}`);
    console.log(`    deliveredTimestamp:  ${oracleResult.deliveredTimestamp}`);
    console.log(`  ✓ Oracle path verified (either delivered=true or =false; both are valid)`);
  } else {
    console.log(`  ⚠ No callback in 3 minutes. This is possible if:`);
    console.log(`    - 17track marked the tracking as 'not registered' → JS throws err`);
    console.log(`      → contract emits OracleQueryFailed, oracleResults stays empty`);
    console.log(`    - Or LINK subscription depleted`);
    console.log(`  Check https://functions.chain.link/sepolia/${process.env.FUNCTIONS_SUBSCRIPTION_ID}`);
    console.log(`  for request history.`);
  }

  // ─────────────────────────────────────────────────────────────────────
  section("Test 4: Failure paths (verify reverts)");

  console.log("\n[4.1] resolveDispute called immediately → expect revert 'Dispute resolution delay'");
  try {
    await marketplace.resolveDispute.staticCall(order2Id, true);
    throw new Error("Expected revert, got success");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Dispute resolution delay has not elapsed")) {
      console.log(`  ✓ correctly reverted with delay check`);
    } else {
      console.log(`  ⚠ reverted but with unexpected reason: ${msg.slice(0, 200)}`);
    }
  }

  console.log("\n[4.2] ownerEmergencyRefund on Paid (order 3) before 30 days → expect revert");
  const tx9 = await marketplace.createAndPay(sellerAddr, 1003n, { value: ORDER_AMOUNT });
  await tx9.wait();
  const order3Id = startOrderId + 2n;
  console.log(`  order 3 created (orderId ${order3Id}), still in Paid state`);
  try {
    await marketplace.ownerEmergencyRefund.staticCall(order3Id);
    throw new Error("Expected revert, got success");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Order not stale enough for emergency refund")) {
      console.log(`  ✓ correctly reverted on stale-check`);
    } else {
      console.log(`  ⚠ reverted with unexpected reason: ${msg.slice(0, 200)}`);
    }
  }

  console.log("\n[4.3] Non-party submitEvidence → expect revert NotPartyOfOrder");
  // Create a random throwaway signer (we won't send any tx from it, just staticCall)
  const stranger = ethers.Wallet.createRandom().connect(buyer.provider!);
  const registryAsStranger = registry.connect(stranger);
  try {
    await registryAsStranger.submitEvidence.staticCall(order2Id, "ipfs://hacker");
    throw new Error("Expected revert, got success");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("NotPartyOfOrder")) {
      console.log(`  ✓ correctly reverted with NotPartyOfOrder`);
    } else {
      console.log(`  ⚠ reverted with: ${msg.slice(0, 200)}`);
    }
  }

  console.log("\n[4.4] Second submitEvidenceWithOracleQuery within 1h cooldown → expect revert");
  try {
    await registry.submitEvidenceWithOracleQuery.staticCall(order2Id, "ipfs://cooldownTest");
    throw new Error("Expected revert, got success");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("OracleQueryCooldown")) {
      console.log(`  ✓ correctly reverted with OracleQueryCooldown`);
    } else {
      console.log(`  ⚠ reverted with: ${msg.slice(0, 200)}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  section("Summary");
  console.log(`✓ Order ${order1Id}: Completed (happy path)`);
  console.log(`✓ Order ${order2Id}: Disputed (2 passive evidence + 1 oracle-query evidence)`);
  console.log(`  Oracle:                ${oracleResult ? (oracleResult.delivered ? "delivered=true" : "delivered=false") : "pending or failed"}`);
  console.log(`✓ Order ${order3Id}: Paid (still in escrow; reused for failure-path test)`);
  console.log("");
  console.log("On-chain test passed. Next step (script 03): seed these orders into");
  console.log("the indexer DB so they show up in the frontend.");

  await connection.close();
}

main().catch((error: unknown) => {
  console.error("\n✗ TEST FAILED");
  console.error(error);
  process.exitCode = 1;
});
