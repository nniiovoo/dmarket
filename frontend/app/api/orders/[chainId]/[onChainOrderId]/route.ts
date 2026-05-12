import { NextRequest, NextResponse } from "next/server";

import { getOrder } from "@/lib/orders";
import { orderDetailParamsSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ chainId: string; onChainOrderId: string }>;
};

export async function GET(_request: NextRequest, context: RouteContext) {
  const params = await context.params;
  const parsed = orderDetailParamsSchema.safeParse(params);

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid order lookup", details: parsed.error.flatten() }, { status: 400 });
  }

  const order = await getOrder(parsed.data.chainId, parsed.data.onChainOrderId);

  if (!order) {
    return NextResponse.json({ error: "Order not found in indexer" }, { status: 404 });
  }

  return NextResponse.json(order);
}
