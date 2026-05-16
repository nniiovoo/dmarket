// GET /api/listings?status=active&shopId=5&limit=20&offset=0
//
// Read surface for the K.4 ShareMarket projection. Used by the K.6
// frontend's "marketplace for shares of shop N" + "my open listings"
// views.

import { NextRequest, NextResponse } from "next/server";

import { withErrorBoundary } from "@/lib/api/withErrorBoundary";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const STATUS_NAMES: Record<number, string> = {
  0: "Active",
  1: "Filled",
  2: "Cancelled"
};

const STATUS_LOOKUP: Record<string, number> = {
  active: 0,
  filled: 1,
  cancelled: 2
};

export const GET = withErrorBoundary(async (request: NextRequest) => {
  const params = request.nextUrl.searchParams;
  const statusRaw = (params.get("status") ?? "all").toLowerCase();
  const shopIdRaw = params.get("shopId");
  const sellerRaw = params.get("seller");
  const limit = clampInt(params.get("limit"), DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = clampInt(params.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);

  // status — accept "active"/"filled"/"cancelled"/"all" (default all).
  let statusFilter: number | undefined;
  if (statusRaw !== "all") {
    statusFilter = STATUS_LOOKUP[statusRaw];
    if (statusFilter === undefined) {
      return NextResponse.json(
        { error: "invalid_status", allowed: ["active", "filled", "cancelled", "all"] },
        { status: 400 }
      );
    }
  }

  const where: Record<string, unknown> = {};
  if (statusFilter !== undefined) where.status = statusFilter;
  if (shopIdRaw !== null) {
    const shopId = Number(shopIdRaw);
    if (!Number.isInteger(shopId) || shopId <= 0) {
      return NextResponse.json({ error: "invalid_shop_id" }, { status: 400 });
    }
    where.shopId = shopId;
  }
  if (sellerRaw !== null) {
    where.seller = sellerRaw.toLowerCase();
  }

  const [rows, total] = await Promise.all([
    prisma.shopListing.findMany({
      where,
      orderBy: { createdBlock: "desc" },
      take: limit,
      skip: offset
    }),
    prisma.shopListing.count({ where })
  ]);

  const listings = rows.map((row) => ({
    listingId: row.listingId,
    seller: row.seller,
    shopId: row.shopId,
    amount: row.amount,
    paymentToken: row.paymentToken,
    totalPrice: row.totalPrice,
    originalAmount: row.originalAmount,
    remainingAmount: row.remainingAmount,
    pricePerToken: row.pricePerToken,
    status: STATUS_NAMES[row.status] ?? "Unknown",
    statusCode: row.status,
    buyer: row.buyer,
    createdBlock: row.createdBlock.toString(),
    createdTxHash: row.createdTxHash,
    closedBlock: row.closedBlock?.toString() ?? null,
    closedTxHash: row.closedTxHash ?? null
  }));

  return NextResponse.json({ listings, total });
});

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null || raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return Math.floor(n);
}
