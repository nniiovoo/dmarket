import { NextRequest, NextResponse } from "next/server";

import { withErrorBoundary } from "@/lib/api/withErrorBoundary";
import { getOrderV3_2 } from "@/lib/orders";

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ chainId: string; marketplaceAddress: string; onChainOrderId: string }>;
};

export const GET = withErrorBoundary(async (_request: NextRequest, context: RouteContext) => {
  const { chainId: chainIdRaw, marketplaceAddress, onChainOrderId } = await context.params;

  const chainId = Number(chainIdRaw);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    return NextResponse.json({ error: "Invalid chainId" }, { status: 400 });
  }

  if (!/^0x[0-9a-fA-F]{40}$/.test(marketplaceAddress)) {
    return NextResponse.json({ error: "Invalid marketplace address" }, { status: 400 });
  }

  // onChainOrderId is a stringified non-negative integer. Reject anything
  // else without hitting the DB.
  if (!/^[0-9]+$/.test(onChainOrderId)) {
    return NextResponse.json({ error: "Invalid orderId" }, { status: 400 });
  }

  const order = await getOrderV3_2(chainId, marketplaceAddress, onChainOrderId);

  if (!order) {
    return NextResponse.json({ error: "Order not found in v3.2 indexer" }, { status: 404 });
  }

  return NextResponse.json(order);
});
