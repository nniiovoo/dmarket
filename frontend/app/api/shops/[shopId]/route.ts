// GET /api/shops/[shopId]
//
// Returns the shop's identity (from ShopNFT) + a cheap summary of its
// share state (from ShopShareHolding). Read-only — all writes happen
// in the v3.3 shop-economy indexer.

import { NextRequest, NextResponse } from "next/server";

import { withErrorBoundary } from "@/lib/api/withErrorBoundary";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

const TOTAL_SHARES_PER_SHOP = 10_000n;

interface Ctx {
  params: Promise<{ shopId: string }>;
}

export const GET = withErrorBoundary(async (_request: NextRequest, ctx: Ctx) => {
  const { shopId: shopIdRaw } = await ctx.params;
  const shopId = Number(shopIdRaw);
  if (!Number.isInteger(shopId) || shopId <= 0) {
    return NextResponse.json({ error: "invalid_shop_id" }, { status: 400 });
  }

  const shop = await prisma.shopNFT.findUnique({ where: { shopId } });
  if (!shop) return NextResponse.json({ error: "shop_not_found" }, { status: 404 });

  // ShopShareHolding is a wide projection. Aggregate distinct holders
  // (with > 0 balance) and let the contract guarantee that the sum is
  // exactly TOTAL_SHARES_PER_SHOP iff initialised.
  const holdings = await prisma.shopShareHolding.findMany({
    where: { shopId, NOT: { balance: "0" } },
    select: { balance: true }
  });
  const initialised = holdings.length > 0;

  return NextResponse.json({
    shopId: shop.shopId,
    currentOwner: shop.currentOwner,
    creator: shop.creator,
    createdAt: shop.createdAt.toISOString(),
    name: shop.name,
    description: shop.description,
    imageUrl: shop.imageUrl,
    sharesInitialized: initialised,
    totalShareholders: holdings.length,
    totalSharesIssued: initialised ? TOTAL_SHARES_PER_SHOP.toString() : "0",
    lastUpdatedBlock: shop.lastUpdatedBlock.toString(),
    lastUpdatedTxHash: shop.lastUpdatedTxHash
  });
});
