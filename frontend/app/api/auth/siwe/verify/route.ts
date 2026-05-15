import { NextRequest, NextResponse } from "next/server";

import { createSession, setSessionCookie, verifySiwe } from "@/lib/auth/siwe";
import { withErrorBoundary } from "@/lib/api/withErrorBoundary";

export const dynamic = "force-dynamic";

export const POST = withErrorBoundary(async (request: NextRequest) => {
  let body: { message?: string; signature?: string };
  try {
    body = (await request.json()) as { message?: string; signature?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { message, signature } = body;
  if (!message || !signature) {
    return NextResponse.json({ error: "message and signature are required" }, { status: 400 });
  }
  if (!signature.startsWith("0x")) {
    return NextResponse.json({ error: "signature must be 0x-prefixed hex" }, { status: 400 });
  }

  const result = await verifySiwe(message, signature as `0x${string}`);
  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: 401 });
  }

  const session = await createSession(result.address);
  await setSessionCookie(session);

  return NextResponse.json({
    address: result.address,
    expiresAt: session.expiresAt.toISOString()
  });
});
