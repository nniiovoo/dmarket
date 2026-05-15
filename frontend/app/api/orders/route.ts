import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";

import { withErrorBoundary } from "@/lib/api/withErrorBoundary";
import { listOrders } from "@/lib/orders";
import { orderListQuerySchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

export const GET = withErrorBoundary(async (request: NextRequest) => {
  const parsed = orderListQuerySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams.entries()));

  if (!parsed.success) {
    return validationError(parsed.error);
  }

  const { buyer, seller, chainId, status, limit, offset } = parsed.data;
  const result = await listOrders({ buyer, seller, chainId, status, limit, offset });

  return NextResponse.json(result);
});

function validationError(error: ZodError) {
  return NextResponse.json({ error: "Validation failed", details: error.flatten() }, { status: 400 });
}
