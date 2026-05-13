// Seeds the indexer DB with V3 marketplace orders.
//
// Why this exists: the live indexer (catchUp + liveWatch) currently only
// watches V2 marketplace events. V3 marketplace orders therefore don't
// appear in the OnChainOrder table by themselves. This one-off seeder
// reads V3 marketplace state directly via RPC and upserts a matching
// OnChainOrder row so the frontend can render the order detail page.
//
// Required env (read from frontend/.env or root .env via tsx):
//   NEXT_PUBLIC_V3_SEPOLIA_MARKETPLACE_ADDRESS
//   SEPOLIA_RPC_URL or NEXT_PUBLIC_SEPOLIA_RPC_URL
//   DATABASE_URL
//
// Usage (from frontend dir):
//   cd frontend && npx tsx scripts/seedV3SepoliaOrders.ts
//
// Optional CLI args: order IDs to seed, defaults to 1,2,3
//   npx tsx scripts/seedV3SepoliaOrders.ts 1 2 3 4

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, http, type Address } from "viem";
import { sepolia } from "viem/chains";
import { PrismaClient } from "@prisma/client";
import escrowMarketplaceV3AbiJson from "../abi/EscrowMarketplaceV3.json" with { type: "json" };

// Load .env and .env.local from cwd (frontend/), mirroring Next.js convention.
function loadEnv() {
  for (const file of [".env", ".env.local"]) {
    const path = join(process.cwd(), file);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx);
      let value = trimmed.slice(idx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[key] ??= value;
    }
  }
}
loadEnv();

const OrderStatusName: Record<number, string> = {
  0: "Created",
  1: "Paid",
  2: "Shipped",
  3: "Completed",
  4: "Cancelled",
  5: "Disputed",
  6: "Refunded"
};

function timestampToDate(sec: bigint): Date | null {
  return sec === 0n ? null : new Date(Number(sec) * 1000);
}

async function main() {
  const marketplaceAddr = process.env.NEXT_PUBLIC_V3_SEPOLIA_MARKETPLACE_ADDRESS as Address | undefined;
  const rpc = process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL || process.env.SEPOLIA_RPC_URL;
  if (!marketplaceAddr) throw new Error("Missing NEXT_PUBLIC_V3_SEPOLIA_MARKETPLACE_ADDRESS");
  if (!rpc) throw new Error("Missing SEPOLIA_RPC_URL");

  // Order IDs from CLI args, defaulting to 1,2,3
  const argv = process.argv.slice(2);
  const orderIds = (argv.length > 0 ? argv : ["1", "2", "3"]).map((s) => BigInt(s));

  console.log("Seeding V3 orders into indexer DB");
  console.log(`  marketplace:  ${marketplaceAddr}`);
  console.log(`  RPC:          ${rpc.slice(0, 40)}...`);
  console.log(`  orderIds:     ${orderIds.join(", ")}`);

  const client = createPublicClient({
    chain: sepolia,
    transport: http(rpc)
  });

  const prisma = new PrismaClient();
  const chainId = sepolia.id;

  for (const orderId of orderIds) {
    console.log(`\n→ order ${orderId}`);

    const order = (await client.readContract({
      address: marketplaceAddr,
      abi: escrowMarketplaceV3AbiJson,
      functionName: "getOrder",
      args: [orderId]
    })) as {
      id: bigint;
      buyer: Address;
      status: number;
      createdAt: bigint;
      seller: Address;
      paidAt: bigint;
      productId: bigint;
      amount: bigint;
      shippedAt: bigint;
      completedAt: bigint;
      deliveredAt: bigint;
      disputedAt: bigint;
    };

    console.log(`  buyer:    ${order.buyer}`);
    console.log(`  seller:   ${order.seller}`);
    console.log(`  amount:   ${order.amount.toString()} wei`);
    console.log(`  status:   ${OrderStatusName[order.status] ?? "Unknown"}`);

    const where = {
      chainId_onChainOrderId: { chainId, onChainOrderId: orderId.toString() }
    };

    const data = {
      chainId,
      onChainOrderId: orderId.toString(),
      buyer: order.buyer.toLowerCase(),
      seller: order.seller.toLowerCase(),
      productId: order.productId.toString(),
      amountWei: order.amount.toString(),
      status: OrderStatusName[order.status] ?? "Unknown",
      createdAt: timestampToDate(order.createdAt),
      paidAt: timestampToDate(order.paidAt),
      shippedAt: timestampToDate(order.shippedAt),
      completedAt: timestampToDate(order.completedAt),
      refundedAt: null,
      disputedAt: timestampToDate(order.disputedAt),
      // These are the indexer's bookkeeping fields. We're not coming from
      // a real getLogs scan, so use a sentinel block (0) and a "seed" tag
      // for the tx hash so a future indexer pass can still overwrite us.
      lastBlock: 0n,
      lastLogIndex: 0,
      lastTxHash: "seed-script",
      lastSyncedAt: new Date()
    };

    await prisma.onChainOrder.upsert({
      where,
      create: data,
      update: data
    });

    console.log(`  ✓ upserted`);
  }

  await prisma.$disconnect();
  console.log("\nAll orders seeded.");
  console.log("\nOpen in browser:");
  for (const orderId of orderIds) {
    console.log(`  http://localhost:3000/orders/${orderId}`);
  }
}

main().catch((error: unknown) => {
  console.error("Seeder failed:");
  console.error(error);
  process.exitCode = 1;
});
