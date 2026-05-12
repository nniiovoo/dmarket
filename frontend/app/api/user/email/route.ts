import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";

import { verifyWalletSignature } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { bindEmailSchema, userEmailQuerySchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const parsed = userEmailQuerySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams.entries()));

  if (!parsed.success) {
    return validationError(parsed.error);
  }

  const user = await prisma.user.findUnique({
    where: { walletAddress: parsed.data.address },
    select: { email: true, emailVerified: true }
  });

  return NextResponse.json({
    isBound: Boolean(user?.email),
    maskedEmail: user?.email ? maskEmail(user.email) : null,
    emailVerified: user?.emailVerified ?? false
  });
}

export async function POST(request: NextRequest) {
  try {
    const data = bindEmailSchema.parse(await request.json());
    const auth = await verifyWalletSignature(
      {
        walletAddress: data.walletAddress,
        signature: data.signature as `0x${string}`,
        signedMessage: data.signedMessage
      },
      `ChainUs:BindEmail:${data.email}:`
    );

    if (!auth.ok) {
      return NextResponse.json({ error: "Signature verification failed", reason: auth.reason }, { status: 401 });
    }

    const user = await prisma.user.upsert({
      where: { walletAddress: data.walletAddress },
      create: {
        walletAddress: data.walletAddress,
        email: data.email,
        emailVerified: false
      },
      update: {
        email: data.email,
        emailVerified: false
      }
    });

    return NextResponse.json({
      walletAddress: user.walletAddress,
      email: user.email,
      emailVerified: user.emailVerified
    });
  } catch (caught) {
    if (caught instanceof ZodError) {
      return validationError(caught);
    }

    return NextResponse.json({ error: "Failed to update email" }, { status: 500 });
  }
}

function maskEmail(email: string) {
  const [local = "", domain = ""] = email.split("@");
  const [domainName = "", ...rest] = domain.split(".");
  const maskedLocal = local.length <= 1 ? `${local}***` : `${local[0]}***`;
  const maskedDomain = domainName.length <= 1 ? `${domainName}***` : `${domainName[0]}******`;
  return `${maskedLocal}@${maskedDomain}${rest.length > 0 ? `.${rest.join(".")}` : ""}`;
}

function validationError(error: ZodError) {
  return NextResponse.json({ error: "Validation failed", details: error.flatten() }, { status: 400 });
}
