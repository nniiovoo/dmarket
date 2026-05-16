// GET /api/users/[address]/listings?status=active|all
//
// ShareMarket listings the caller posted. Same shape as /api/listings
// but pre-filtered by `seller`. Used by the portfolio "my listings"
// section so users can find their own active listings + history
// without scrolling through the global feed.

import { NextRequest, NextResponse } from "next/server";

import { withErrorBoundary } from "@/lib/api/withErrorBoundary";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

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

interface Ctx {
  params: Promise<{ address: string }>;
}

export const GET = withErrorBoundary(async (request: NextRequest, ctx: Ctx) => {
  const { address: addressRaw } = await ctx.params;
  if (!/^0x[0-9a-fA-F]{40}$/.test(addressRaw)) {
    return NextResponse.json({ error: "invalid_address" }, { status: 400 });
  }
  const seller = addressRaw.toLowerCase();

  const params = request.nextUrl.searchParams;
  const statusRaw = (params.get("status") ?? "all").toLowerCase();
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

  const where: Record<string, unknown> = { seller };
  if (statusFilter !== undefined) where.status = statusFilter;

  const rows = await prisma.shopListing.findMany({
    where,
    orderBy: { createdBlock: "desc" }
  });

  const listings = rows.map((row) => ({
    listingId: row.listingId,
    seller: row.seller,
    shopId: row.shopId,
    amount: row.amount,
    paymentToken: row.paymentToken,
    totalPrice: row.totalPrice,
    status: STATUS_NAMES[row.status] ?? "Unknown",
    statusCode: row.status,
    buyer: row.buyer,
    createdBlock: row.createdBlock.toString(),
    createdTxHash: row.createdTxHash,
    closedBlock: row.closedBlock?.toString() ?? null,
    closedTxHash: row.closedTxHash ?? null
  }));

  return NextResponse.json({ seller, listings, total: listings.length });
});
