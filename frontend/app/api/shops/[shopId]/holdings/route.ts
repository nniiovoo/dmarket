// GET /api/shops/[shopId]/holdings
//
// Returns the full holder set for a shop with non-zero balance,
// sorted by balance descending. Each holder gets a percentage
// expressed against the contract's fixed 10 000-share supply.

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

  const rows = await prisma.shopShareHolding.findMany({
    where: { shopId, NOT: { balance: "0" } }
  });

  // Sort in JS — balance is a string (bigint), can't ORDER BY in SQL
  // accurately for arbitrary-precision values. Set sizes are small (≤
  // 10 000 holders in theory; realistically << 50 per shop).
  const sorted = [...rows].sort((a, b) => {
    const ab = BigInt(a.balance);
    const bb = BigInt(b.balance);
    if (ab > bb) return -1;
    if (ab < bb) return 1;
    return a.holder.localeCompare(b.holder);
  });

  const holdings = sorted.map((r) => {
    const balance = BigInt(r.balance);
    // pct = balance × 10000 / TOTAL, printed as XX.XX (2 decimals).
    const bps = (balance * 10_000n) / TOTAL_SHARES_PER_SHOP;
    const whole = bps / 100n;
    const frac = bps % 100n;
    const pct = `${whole}.${frac.toString().padStart(2, "0")}`;
    return {
      holder: r.holder,
      balance: r.balance,
      pct
    };
  });

  return NextResponse.json({
    shopId,
    holdings,
    totalShareholders: holdings.length
  });
});
