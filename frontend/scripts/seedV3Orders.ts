// Seeds the indexer DB with V3 marketplace orders.
//
// Now that the indexer covers V3 marketplace events on arbitrumSepolia,
// new orders flow into the DB automatically. This seed script is now
// a recovery tool for manual reseeding (e.g. wiped DB, or to backfill
// orders created before indexer was running).
//
// Required env (read from frontend/.env or root .env via tsx):
//   NEXT_PUBLIC_V3_<NETWORK>_MARKETPLACE_ADDRESS  (e.g. _SEPOLIA_ or _ARBITRUMSEPOLIA_)
//   <NETWORK>_RPC_URL (e.g. SEPOLIA_RPC_URL or ARBITRUM_SEPOLIA_RPC_URL)
//   DATABASE_URL
//
// Usage (from frontend dir):
//   cd frontend && npx tsx scripts/seedV3Orders.ts                  # defaults to sepolia
//   SEED_CHAIN=arbitrumSepolia npx tsx scripts/seedV3Orders.ts
//   npx tsx scripts/seedV3Orders.ts --chain arbitrumSepolia 1 2 3
//
// CLI args after --chain (or first non-flag args) are order IDs to seed;
// default is 1,2,3.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, http, type Address, type Chain } from "viem";
import { arbitrumSepolia, sepolia } from "viem/chains";
import { PrismaClient } from "@prisma/client";
import escrowMarketplaceV3AbiJson from "../abi/EscrowMarketplaceV3.json" with { type: "json" };

// Map our network names to viem chains and the env var prefix the deploy
// scripts use (`V3_<PREFIX>_*`). Keeping this in one table makes adding a
// new testnet a single-line change.
const SUPPORTED: Record<string, { chain: Chain; envPrefix: string; rpcEnv: string }> = {
  sepolia: {
    chain: sepolia,
    envPrefix: "SEPOLIA",
    rpcEnv: "SEPOLIA_RPC_URL"
  },
  arbitrumSepolia: {
    chain: arbitrumSepolia,
    envPrefix: "ARBITRUMSEPOLIA",
    rpcEnv: "ARBITRUM_SEPOLIA_RPC_URL"
  }
};

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

function parseArgs() {
  const argv = process.argv.slice(2);
  let chainName = process.env.SEED_CHAIN ?? "sepolia";
  const orderArgs: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--chain") {
      chainName = argv[i + 1] ?? chainName;
      i++;
    } else {
      orderArgs.push(argv[i]!);
    }
  }

  return { chainName, orderArgs };
}

async function main() {
  const { chainName, orderArgs } = parseArgs();
  const cfg = SUPPORTED[chainName];

  if (!cfg) {
    throw new Error(`Unsupported chain: ${chainName}. Supported: ${Object.keys(SUPPORTED).join(", ")}`);
  }

  const marketplaceAddr =
    (process.env[`NEXT_PUBLIC_V3_${cfg.envPrefix}_MARKETPLACE_ADDRESS`] as Address | undefined) ??
    (process.env[`V3_${cfg.envPrefix}_MARKETPLACE_ADDRESS`] as Address | undefined);
  const rpc =
    process.env[`NEXT_PUBLIC_${cfg.rpcEnv}`] ?? process.env[cfg.rpcEnv];
  if (!marketplaceAddr) throw new Error(`Missing NEXT_PUBLIC_V3_${cfg.envPrefix}_MARKETPLACE_ADDRESS`);
  if (!rpc) throw new Error(`Missing ${cfg.rpcEnv}`);

  const orderIds = (orderArgs.length > 0 ? orderArgs : ["1", "2", "3"]).map((s) => BigInt(s));

  console.log("Seeding V3 orders into indexer DB");
  console.log(`  chain:        ${chainName}`);
  console.log(`  marketplace:  ${marketplaceAddr}`);
  console.log(`  RPC:          ${rpc.slice(0, 40)}...`);
  console.log(`  orderIds:     ${orderIds.join(", ")}`);

  const client = createPublicClient({
    chain: cfg.chain,
    transport: http(rpc)
  });

  const prisma = new PrismaClient();
  const chainId = cfg.chain.id;

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
