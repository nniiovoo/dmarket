// Stage 2a closed-loop verification.
//
// Goal: prove a brand-new on-chain order on Arbitrum Sepolia auto-flows into
// the frontend DB via the indexer's liveWatch, without any seed script.
//
// What this does:
//   1. Reads V3 marketplace + RPC env (root .env)
//   2. Connects buyer (PRIVATE_KEY) and seller (SELLER_PRIVATE_KEY) wallets
//   3. Captures next orderId, then calls createAndPay(seller, productId, value)
//   4. Polls the indexer DB (Prisma) every 5s for up to 90s, looking for the
//      new OnChainOrder row with status=Paid (Created event from createAndPay
//      then immediately the Paid event arrives in the same tx — but the
//      indexer applies them in log order, so we look for Paid as the final
//      state)
//   5. Reports SUCCESS/FAILURE with details
//
// Pre-condition: the indexer must be running (npm run indexer in frontend/)
//   in another terminal. This script does NOT start it; it only observes.
//
// Required env (root .env):
//   PRIVATE_KEY                                   buyer
//   SELLER_PRIVATE_KEY                            seller (≥ 0.001 ETH gas)
//   ARBITRUM_SEPOLIA_RPC_URL
//   V3_ARBITRUMSEPOLIA_MARKETPLACE_ADDRESS
//   DATABASE_URL                                  postgres connection
//
// Usage:
//   npx hardhat run scripts/sepoliaTest/05_verifyIndexerCloseLoop.ts --network arbitrumSepolia

import { network } from "hardhat";
import { PrismaClient } from "../../frontend/node_modules/@prisma/client";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
}

function fmtEth(wei: bigint): string {
  return (Number(wei) / 1e18).toFixed(6) + " ETH";
}

async function main() {
  const connection = await network.create();
  const { ethers } = connection;

  if (connection.networkName !== "arbitrumSepolia") {
    throw new Error(`This test targets Arbitrum Sepolia, got ${connection.networkName}`);
  }

  const marketplaceAddr = requireEnv("V3_ARBITRUMSEPOLIA_MARKETPLACE_ADDRESS");
  requireEnv("DATABASE_URL");

  const [buyer] = await ethers.getSigners();
  if (!buyer) throw new Error("No buyer signer; check PRIVATE_KEY");

  const sellerAddr = process.env.SELLER_PRIVATE_KEY
    ? await new ethers.Wallet(process.env.SELLER_PRIVATE_KEY).getAddress()
    : undefined;
  if (!sellerAddr) throw new Error("Missing SELLER_PRIVATE_KEY");

  const buyerAddr = await buyer.getAddress();
  if (buyerAddr.toLowerCase() === sellerAddr.toLowerCase()) {
    throw new Error("Buyer and seller must be different wallets");
  }

  const marketplace = await ethers.getContractAt("EscrowMarketplaceV3", marketplaceAddr, buyer);

  console.log("Stage 2a closed-loop verification (Arbitrum Sepolia)\n");
  console.log(`  Buyer:       ${buyerAddr}`);
  console.log(`  Seller:      ${sellerAddr}`);
  console.log(`  Marketplace: ${marketplaceAddr}\n`);

  const buyerBalance = await buyer.provider!.getBalance(buyerAddr);
  console.log(`  Buyer balance: ${fmtEth(buyerBalance)}`);
  if (buyerBalance < ethers.parseEther("0.002")) {
    throw new Error("Buyer needs ≥ 0.002 Arbitrum Sepolia ETH");
  }

  const startOrderId = await marketplace.nextOrderId();
  const orderId = startOrderId;
  const productId = BigInt(Date.now() % 1_000_000);
  const amount = ethers.parseEther("0.001");

  console.log(`\n[1/3] Creating on-chain order ${orderId} (productId=${productId}, amount=${fmtEth(amount)})`);
  const tx = await marketplace.createAndPay(sellerAddr, productId, { value: amount });
  console.log(`  tx hash: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`  ✓ confirmed in block ${receipt!.blockNumber}`);

  console.log(`\n[2/3] Polling frontend DB for OnChainOrder(chainId=421614, onChainOrderId=${orderId})`);
  console.log(`  Make sure 'npm run indexer' is running in frontend/ in another shell.`);

  const prisma = new PrismaClient();
  const startedAt = Date.now();
  const timeoutMs = 90_000;
  const pollIntervalMs = 5_000;
  let foundOrder: { status: string; paidAt: Date | null; lastBlock: bigint; lastTxHash: string } | null = null;

  while (Date.now() - startedAt < timeoutMs) {
    const row = await prisma.onChainOrder.findUnique({
      where: {
        chainId_onChainOrderId: {
          chainId: 421614,
          onChainOrderId: orderId.toString()
        }
      },
      select: { status: true, paidAt: true, lastBlock: true, lastTxHash: true }
    });
    if (row) {
      foundOrder = row;
      // Wait for the row to reach Paid (createAndPay emits Created + Paid in
      // the same tx; the indexer applies them in log order, so the final
      // resting state should be Paid).
      if (row.status === "Paid") break;
    }
    process.stdout.write(".");
    await new Promise((res) => setTimeout(res, pollIntervalMs));
  }
  console.log("");

  await prisma.$disconnect();

  console.log(`\n[3/3] Result\n`);
  if (foundOrder && foundOrder.status === "Paid") {
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    console.log(`  ✓ SUCCESS: order ${orderId} reached status='Paid' in DB after ${elapsed}s`);
    console.log(`    lastBlock:  ${foundOrder.lastBlock}`);
    console.log(`    lastTxHash: ${foundOrder.lastTxHash}`);
    console.log(`    paidAt:     ${foundOrder.paidAt?.toISOString() ?? "(null)"}`);
    console.log(`\n  Stage 2a closed loop is working end-to-end.`);
  } else if (foundOrder) {
    console.log(`  ⚠ PARTIAL: row exists with status='${foundOrder.status}' (expected 'Paid')`);
    console.log(`    Indexer saw the Created event but not the Paid event yet.`);
    console.log(`    Try again or check indexer logs.`);
    process.exitCode = 2;
  } else {
    console.log(`  ✗ FAILURE: order ${orderId} never appeared in DB within ${timeoutMs / 1000}s`);
    console.log(`    Possible causes:`);
    console.log(`      - Indexer is not running (start with 'npm run indexer' in frontend/)`);
    console.log(`      - INDEXER_ARBSEPOLIA_FROM_BLOCK is set too high (skipped past your block)`);
    console.log(`      - liveWatch RPC is not seeing this address — check chain id 421614 in config`);
    console.log(`      - DATABASE_URL points to a different DB than the indexer is writing to`);
    process.exitCode = 1;
  }

  await connection.close();
}

main().catch((error: unknown) => {
  console.error("\n✗ TEST FAILED");
  console.error(error);
  process.exitCode = 1;
});
