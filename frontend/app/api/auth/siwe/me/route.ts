import { NextResponse } from "next/server";

import { getSession } from "@/lib/auth/siwe";
import { withErrorBoundary } from "@/lib/api/withErrorBoundary";

export const dynamic = "force-dynamic";

export const GET = withErrorBoundary(async () => {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ address: null }, { status: 200 });
  }
  return NextResponse.json({
    address: session.address,
    expiresAt: session.expiresAt.toISOString()
  });
});
