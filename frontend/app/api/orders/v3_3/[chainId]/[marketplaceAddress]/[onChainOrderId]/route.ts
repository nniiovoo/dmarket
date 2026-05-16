// GET /api/orders/v3_3/[chainId]/[marketplaceAddress]/[onChainOrderId]
//
// Returns the indexer's projection of a v3.3 order. 404 if the
// indexer has not yet caught up to the order (no fallback to a live
// on-chain read — K.6 frontend will handle that if it needs to).
//
// Status names mirror the on-chain enum:
//   Created / Paid / Shipped / Completed / Cancelled / Disputed / Refunded

import { NextRequest, NextResponse } from "next/server";

import { withErrorBoundary } from "@/lib/api/withErrorBoundary";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

const STATUS_NAMES: Record<number, string> = {
  0: "Created",
  1: "Paid",
  2: "Shipped",
  3: "Completed",
  4: "Cancelled",
  5: "Disputed",
  6: "Refunded"
};

interface Ctx {
  params: Promise<{ chainId: string; marketplaceAddress: string; onChainOrderId: string }>;
}

export const GET = withErrorBoundary(async (_request: NextRequest, ctx: Ctx) => {
  const params = await ctx.params;
  const chainId = Number(params.chainId);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    return NextResponse.json({ error: "invalid_chain_id" }, { status: 400 });
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(params.marketplaceAddress)) {
    return NextResponse.json({ error: "invalid_marketplace_address" }, { status: 400 });
  }
  if (!/^\d+$/.test(params.onChainOrderId)) {
    return NextResponse.json({ error: "invalid_order_id" }, { status: 400 });
  }

  const marketplaceAddress = params.marketplaceAddress.toLowerCase();
  const order = await prisma.onChainOrderV3_3.findUnique({
    where: {
      chainId_marketplaceAddress_onChainOrderId: {
        chainId,
        marketplaceAddress,
        onChainOrderId: params.onChainOrderId
      }
    }
  });
  if (!order) return NextResponse.json({ error: "order_not_found" }, { status: 404 });

  return NextResponse.json({
    chainId: order.chainId,
    marketplaceAddress: order.marketplaceAddress,
    onChainOrderId: order.onChainOrderId,
    buyer: order.buyer,
    seller: order.seller,
    shopId: order.shopId,
    paymentToken: order.paymentToken,
    productId: order.productId,
    amount: order.amount,
    status: STATUS_NAMES[order.status] ?? "Unknown",
    statusCode: order.status,
    createdAt: order.createdAt.toISOString(),
    paidAt: order.paidAt?.toISOString() ?? null,
    shippedAt: order.shippedAt?.toISOString() ?? null,
    completedAt: order.completedAt?.toISOString() ?? null,
    disputedAt: order.disputedAt?.toISOString() ?? null,
    feeAmount: order.feeAmount,
    sellerAmount: order.sellerAmount,
    lastEventBlock: order.lastEventBlock.toString(),
    lastEventTxHash: order.lastEventTxHash,
    lastSyncedAt: order.lastSyncedAt.toISOString()
  });
});
