// GET /api/shops/list?limit=20&offset=0
//
// Paginated listing of every indexed shop, newest first by shopId.
// Same per-shop summary as /api/shops/[id] but without the holdings
// aggregate (a list view doesn't need that — clients can fetch detail
// on hover).

import { NextRequest, NextResponse } from "next/server";

import { withErrorBoundary } from "@/lib/api/withErrorBoundary";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const TOTAL_SHARES_PER_SHOP = 10_000n;

export const GET = withErrorBoundary(async (request: NextRequest) => {
  const params = request.nextUrl.searchParams;
  const limit = clampInt(params.get("limit"), DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = clampInt(params.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);

  const [rows, total] = await Promise.all([
    prisma.shopNFT.findMany({
      orderBy: { shopId: "desc" },
      take: limit,
      skip: offset
    }),
    prisma.shopNFT.count()
  ]);

  if (rows.length === 0) {
    return NextResponse.json({ shops: [], total });
  }

  // One round trip to count initialised shops + holder counts.
  const ids = rows.map((r) => r.shopId);
  const initialisedCounts = await prisma.shopShareHolding.groupBy({
    by: ["shopId"],
    where: { shopId: { in: ids }, NOT: { balance: "0" } },
    _count: { _all: true }
  });
  const holdersByShop = new Map<number, number>();
  for (const row of initialisedCounts) holdersByShop.set(row.shopId, row._count._all);

  const shops = rows.map((shop) => {
    const holders = holdersByShop.get(shop.shopId) ?? 0;
    const initialised = holders > 0;
    return {
      shopId: shop.shopId,
      currentOwner: shop.currentOwner,
      creator: shop.creator,
      createdAt: shop.createdAt.toISOString(),
      name: shop.name,
      description: shop.description,
      imageUrl: shop.imageUrl,
      sharesInitialized: initialised,
      totalShareholders: holders,
      totalSharesIssued: initialised ? TOTAL_SHARES_PER_SHOP.toString() : "0",
      lastUpdatedBlock: shop.lastUpdatedBlock.toString(),
      lastUpdatedTxHash: shop.lastUpdatedTxHash
    };
  });

  return NextResponse.json({ shops, total });
});

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null || raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return Math.floor(n);
}
