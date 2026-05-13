import { NextRequest, NextResponse } from "next/server";

import { listEvidenceForOrder } from "@/lib/evidence";
import { orderDetailParamsSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ chainId: string; onChainOrderId: string }>;
};

export async function GET(_request: NextRequest, context: RouteContext) {
  const params = await context.params;
  const parsed = orderDetailParamsSchema.safeParse(params);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid order lookup", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const result = await listEvidenceForOrder(parsed.data.chainId, parsed.data.onChainOrderId);

  return NextResponse.json(result);
}
