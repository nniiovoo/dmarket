import { NextRequest, NextResponse } from "next/server";

import { withErrorBoundary } from "@/lib/api/withErrorBoundary";
import { prisma } from "@/lib/db";
import { userEmailQuerySchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

export const GET = withErrorBoundary(async (request: NextRequest) => {
  const parsed = userEmailQuerySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams.entries()));

  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", details: parsed.error.flatten() }, { status: 400 });
  }

  const user = await prisma.user.findUnique({
    where: { walletAddress: parsed.data.address },
    select: { walletAddress: true, email: true, emailVerified: true }
  });

  if (!user) {
    return NextResponse.json({ walletAddress: parsed.data.address, hasEmail: false, emailVerified: false });
  }

  return NextResponse.json({
    walletAddress: user.walletAddress,
    hasEmail: Boolean(user.email),
    emailVerified: user.emailVerified
  });
});
