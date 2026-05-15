import { NextResponse } from "next/server";
import { getAddress, type Address } from "viem";

import { isAdmin } from "@/lib/adminAuth";
import { getSession } from "@/lib/auth/siwe";
import { prisma } from "@/lib/db";
import { issueAttestation } from "@/lib/reputation/issuer";
import { publishAttestation } from "@/lib/reputation/publisher";

export const dynamic = "force-dynamic";

// GET: list the contents of ReputationRefreshQueue. POST: drain every
// entry with processedAt=null by running the same issue + publish pipeline
// the cron uses, then mark processed. Errors are accumulated and returned
// so the admin sees per-row failure reasons (typically nonce races or a
// missing on-chain signer rotation).

export async function GET(): Promise<NextResponse> {
  const session = await getSession();
  if (!isAdmin(session)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const entries = await prisma.reputationRefreshQueue.findMany({
    orderBy: [{ processedAt: "asc" }, { queuedAt: "desc" }],
    take: 200
  });
  return NextResponse.json({
    entries: entries.map((e) => ({
      subject: e.subject,
      queuedAt: e.queuedAt.toISOString(),
      processedAt: e.processedAt?.toISOString() ?? null
    }))
  });
}

export async function POST(): Promise<NextResponse> {
  const session = await getSession();
  if (!isAdmin(session)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const pending = await prisma.reputationRefreshQueue.findMany({
    where: { processedAt: null },
    select: { subject: true }
  });

  const registryAddress =
    process.env.NEXT_PUBLIC_V3_2_ARBITRUMSEPOLIA_REPUTATION_ADDRESS ??
    process.env.V3_2_ARBITRUMSEPOLIA_REPUTATION_ADDRESS;
  if (!registryAddress) {
    return NextResponse.json({ error: "ReputationRegistry not configured" }, { status: 503 });
  }

  let succeeded = 0;
  let failed = 0;
  const errors: string[] = [];
  const completed: string[] = [];

  for (const row of pending) {
    const subjectLower = row.subject.toLowerCase();
    try {
      const subject = getAddress(subjectLower) as Address;
      const issued = await issueAttestation(subject, prisma);

      const placeholder = await prisma.publishedAttestation.upsert({
        where: { subject_version: { subject: subjectLower, version: issued.attestation.version } },
        create: {
          subject: subjectLower,
          score: issued.attestation.score,
          issuedAt: new Date(issued.attestation.issuedAt * 1000),
          expiry: new Date(issued.attestation.expiry * 1000),
          version: issued.attestation.version,
          signature: issued.signature,
          chainId: 421614,
          registryAddr: registryAddress,
          txHash: null,
          publishedAt: null
        },
        update: {
          score: issued.attestation.score,
          issuedAt: new Date(issued.attestation.issuedAt * 1000),
          expiry: new Date(issued.attestation.expiry * 1000),
          signature: issued.signature
        }
      });

      const txHash = await publishAttestation(issued);
      await prisma.publishedAttestation.update({
        where: { id: placeholder.id },
        data: { txHash, publishedAt: new Date() }
      });
      succeeded += 1;
      completed.push(subjectLower);
    } catch (err) {
      failed += 1;
      errors.push(`${subjectLower}: ${err instanceof Error ? err.message : String(err)}`);
      // Still mark as processed so the queue doesn't loop forever on the
      // same bad subject. The indexer will re-enqueue when fresh events
      // arrive.
      completed.push(subjectLower);
    }
  }

  if (completed.length > 0) {
    await prisma.reputationRefreshQueue.updateMany({
      where: { subject: { in: completed } },
      data: { processedAt: new Date() }
    });
  }

  return NextResponse.json({
    processed: pending.length,
    succeeded,
    failed,
    errors: errors.slice(0, 20)
  });
}
