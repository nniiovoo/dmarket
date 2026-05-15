import { NextResponse } from "next/server";

import { createNonce } from "@/lib/auth/siwe";
import { withErrorBoundary } from "@/lib/api/withErrorBoundary";

export const dynamic = "force-dynamic";

export const POST = withErrorBoundary(async () => {
  const nonce = await createNonce();
  return NextResponse.json({ nonce });
});
