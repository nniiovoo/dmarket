import { NextResponse } from "next/server";

import { clearSessionCookie } from "@/lib/auth/siwe";
import { withErrorBoundary } from "@/lib/api/withErrorBoundary";

export const dynamic = "force-dynamic";

export const POST = withErrorBoundary(async () => {
  await clearSessionCookie();
  return NextResponse.json({ ok: true });
});
