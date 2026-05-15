import { NextResponse } from "next/server";

import { withErrorBoundary } from "@/lib/api/withErrorBoundary";

export const dynamic = "force-dynamic";

export const GET = withErrorBoundary(async () => {
  return NextResponse.json({ ok: true, timestamp: new Date().toISOString() });
});
