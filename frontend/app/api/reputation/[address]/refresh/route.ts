import { NextRequest, NextResponse } from "next/server";
import { getAddress, type Address } from "viem";

import { isAdmin } from "@/lib/adminAuth";
import { getSession } from "@/lib/auth/siwe";
import { prisma } from "@/lib/db";
import { issueAttestation } from "@/lib/reputation/issuer";
import { publishAttestation } from "@/lib/reputation/publisher";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ address: string }> };

// Admin-only: immediately issue + publish a fresh attestation for one
// subject. Wraps the same code path the cron uses; the difference is
// auth (SIWE admin session) and no batching.
export async function POST(_request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const session = await getSession();
  if (!isAdmin(session)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { address: addressRaw } = await context.params;
  let subject: Address;
  try {
    subject = getAddress(addressRaw);
  } catch {
    return NextResponse.json({ error: "Invalid address" }, { status: 400 });
  }

  try {
    const issued = await issueAttestation(subject, prisma);

    const registryAddress =
      process.env.NEXT_PUBLIC_V3_2_ARBITRUMSEPOLIA_REPUTATION_ADDRESS ??
      process.env.V3_2_ARBITRUMSEPOLIA_REPUTATION_ADDRESS;

    const placeholder = await prisma.publishedAttestation.create({
      data: {
        subject: subject.toLowerCase(),
        score: issued.attestation.score,
        issuedAt: new Date(issued.attestation.issuedAt * 1000),
        expiry: new Date(issued.attestation.expiry * 1000),
        version: issued.attestation.version,
        signature: issued.signature,
        chainId: 421614,
        registryAddr: registryAddress ?? "",
        txHash: null,
        publishedAt: null
      }
    });

    const txHash = await publishAttestation(issued);

    await prisma.publishedAttestation.update({
      where: { id: placeholder.id },
      data: { txHash, publishedAt: new Date() }
    });

    return NextResponse.json({
      subject,
      attestation: {
        score: issued.attestation.score,
        issuedAt: new Date(issued.attestation.issuedAt * 1000).toISOString(),
        expiry: new Date(issued.attestation.expiry * 1000).toISOString(),
        version: issued.attestation.version
      },
      signature: issued.signature,
      txHash,
      derived: {
        sampleSize: issued.derivedScore.sampleSize,
        components: issued.derivedScore.components
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
