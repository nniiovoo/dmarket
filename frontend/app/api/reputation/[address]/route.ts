import { NextRequest, NextResponse } from "next/server";
import { getAddress, type Address } from "viem";

import { prisma } from "@/lib/db";
import { createRateLimiter } from "@/lib/rateLimit";
import { computeSellerScore } from "@/lib/reputation/score";

export const dynamic = "force-dynamic";

// Two limits stack here:
//   - per-IP : caps abusive scrape (10/min)
//   - per-subject : caps a single subject being polled hot (60/day),
//     mostly to keep DB compute reasonable since the score recomputes on
//     every GET (no cache table yet)
const ipLimiter = createRateLimiter({ name: "reputation-ip", max: 30, windowMs: 60 * 1000 });
const subjectLimiter = createRateLimiter({ name: "reputation-subject", max: 200, windowMs: 24 * 3600 * 1000 });

type RouteContext = { params: Promise<{ address: string }> };

export async function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const { address: addressRaw } = await context.params;
  let subject: Address;
  try {
    subject = getAddress(addressRaw);
  } catch {
    return NextResponse.json({ error: "Invalid address" }, { status: 400 });
  }

  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown";

  const [ipResult, subjectResult] = await Promise.all([
    ipLimiter.check(ip),
    subjectLimiter.check(subject.toLowerCase())
  ]);

  if (!ipResult.ok || !subjectResult.ok) {
    return NextResponse.json(
      {
        error: "Rate limit exceeded",
        resetAt: Math.max(ipResult.resetAt, subjectResult.resetAt)
      },
      { status: 429 }
    );
  }

  const sellerLower = subject.toLowerCase();

  // Latest on-chain attestation we know about — from the DB (which mirrors
  // what the cron published). Falling back to a chain read is overkill;
  // the cron is the source of truth and a stale DB row simply shows up as
  // "older but real" data.
  const latest = await prisma.publishedAttestation.findFirst({
    where: { subject: sellerLower, txHash: { not: null } },
    orderBy: { version: "desc" }
  });

  // Recompute the cached score on every read. If this hot-paths under
  // load we'll add a Redis TTL cache; the v0 ergonomics aren't worth a
  // second table.
  const computed = await computeSellerScore(subject, prisma);

  return NextResponse.json({
    subject,
    onChain: latest
      ? {
          score: latest.score,
          version: latest.version,
          issuedAt: latest.issuedAt.toISOString(),
          expiry: latest.expiry.toISOString(),
          txHash: latest.txHash,
          registryAddress: latest.registryAddr
        }
      : null,
    cached: {
      score: computed.raw,
      components: computed.components,
      sampleSize: computed.sampleSize,
      computedAt: new Date().toISOString()
    },
    sampleSize: computed.sampleSize
  });
}
