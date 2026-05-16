// GET /api/users/[address]/holdings
//
// All non-zero share holdings owned by `address`, joined with the
// shop name + currentOwner so the portfolio UI doesn't need a second
// round-trip per shop.
//
// Caller passes an EVM address; we normalise to lowercase to match
// the indexer's storage convention. The response is the union of
// ShopShareHolding (balance) and ShopNFT (name / owner) for every
// shop in the holding set.

import { NextRequest, NextResponse } from "next/server";

import { withErrorBoundary } from "@/lib/api/withErrorBoundary";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

const TOTAL_SHARES_PER_SHOP = 10_000n;

interface Ctx {
  params: Promise<{ address: string }>;
}

export const GET = withErrorBoundary(async (_request: NextRequest, ctx: Ctx) => {
  const { address: addressRaw } = await ctx.params;
  if (!/^0x[0-9a-fA-F]{40}$/.test(addressRaw)) {
    return NextResponse.json({ error: "invalid_address" }, { status: 400 });
  }
  const holder = addressRaw.toLowerCase();

  const rows = await prisma.shopShareHolding.findMany({
    where: { holder, NOT: { balance: "0" } }
  });
  if (rows.length === 0) {
    return NextResponse.json({ holder, holdings: [], total: 0 });
  }

  const shopIds = rows.map((r) => r.shopId);
  const shops = await prisma.shopNFT.findMany({ where: { shopId: { in: shopIds } } });
  const shopMap = new Map<number, (typeof shops)[number]>();
  for (const s of shops) shopMap.set(s.shopId, s);

  // Sort by balance descending so the most-valuable holdings appear
  // first; balances are arbitrary-precision so we compare as BigInt.
  const sorted = [...rows].sort((a, b) => {
    const ab = BigInt(a.balance);
    const bb = BigInt(b.balance);
    if (ab > bb) return -1;
    if (ab < bb) return 1;
    return a.shopId - b.shopId;
  });

  const holdings = sorted.map((row) => {
    const balance = BigInt(row.balance);
    const bps = (balance * 10_000n) / TOTAL_SHARES_PER_SHOP;
    const whole = bps / 100n;
    const frac = bps % 100n;
    const pct = `${whole}.${frac.toString().padStart(2, "0")}`;
    const shop = shopMap.get(row.shopId);
    return {
      shopId: row.shopId,
      balance: row.balance,
      pct,
      shopName: shop?.name ?? `Shop #${row.shopId}`,
      shopCurrentOwner: shop?.currentOwner ?? null,
      shopImageUrl: shop?.imageUrl ?? "",
      lastUpdatedBlock: row.lastUpdatedBlock.toString()
    };
  });

  return NextResponse.json({ holder, holdings, total: holdings.length });
});
