import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env.local" });
dotenvConfig({ path: ".env" });
dotenvConfig({ path: "../.env" });

import { PrismaClient } from "@prisma/client";
import { getAddress, type Address } from "viem";

import { issueAttestation } from "../lib/reputation/issuer";
import { publishAttestation } from "../lib/reputation/publisher";
import { computeSellerScore } from "../lib/reputation/score";

// Periodic reputation refresh cron.
//
// Sources of sellers to refresh:
//   1. Active sellers from each marketplace table — anyone whose latest
//      order is within the lookback window. Catches sellers whose volume
//      changed organically (new completions etc.).
//   2. Anything in ReputationRefreshQueue with processedAt=null. The
//      indexer writes here on terminal events so a finished order forces
//      a fresh score without waiting for the next cron tick.
//
// Per-seller failures are logged and don't abort the batch.

const ACTIVE_WINDOW_DAYS = 90;
const POLL_INTERVAL_MS = 15 * 60 * 1000; // 15 min between full sweeps
const once = process.argv.includes("--once");

const prisma = new PrismaClient();

async function gatherSellers(): Promise<Set<string>> {
  const cutoff = new Date(Date.now() - ACTIVE_WINDOW_DAYS * 86400 * 1000);

  const [v3, v3_1, v3_2, queued] = await Promise.all([
    prisma.onChainOrder
      .findMany({
        where: { createdAt: { gte: cutoff } },
        select: { seller: true }
      })
      .catch(() => []),
    prisma.onChainOrderV3_1
      .findMany({
        where: { createdAt: { gte: cutoff } },
        select: { seller: true }
      })
      .catch(() => []),
    prisma.onChainOrderV3_2
      .findMany({
        where: { createdAt: { gte: cutoff } },
        select: { seller: true }
      })
      .catch(() => []),
    prisma.reputationRefreshQueue.findMany({
      where: { processedAt: null },
      select: { subject: true }
    })
  ]);

  const sellers = new Set<string>();
  for (const r of v3) if (r.seller) sellers.add(r.seller.toLowerCase());
  for (const r of v3_1) if (r.seller) sellers.add(r.seller.toLowerCase());
  for (const r of v3_2) if (r.seller) sellers.add(r.seller.toLowerCase());
  for (const r of queued) sellers.add(r.subject.toLowerCase());

  return sellers;
}

async function readLatestPublishedVersion(subject: string): Promise<number> {
  // Only consider rows that actually made it on-chain. Placeholder rows
  // (txHash=null from an interrupted publish) should not block retries.
  const row = await prisma.publishedAttestation.findFirst({
    where: { subject, txHash: { not: null } },
    orderBy: { version: "desc" },
    select: { version: true }
  });
  return row?.version ?? 0;
}

async function processSeller(sellerLower: string) {
  const subject = getAddress(sellerLower) as Address;

  const score = await computeSellerScore(subject, prisma);

  const issued = await issueAttestation(subject, prisma, { precomputedScore: score });

  const dbLatest = await readLatestPublishedVersion(sellerLower);
  if (issued.attestation.version <= dbLatest) {
    // Already published a >=N version — issueAttestation reads the on-chain
    // version which should agree with this, but if the DB is ahead (e.g.
    // chain re-org or duplicate row from an aborted run), skip publishing.
    console.log(
      `[reputation] ${subject} skip — db version=${dbLatest} >= issued version=${issued.attestation.version}`
    );
    return;
  }

  // Optimistic DB row first so a crashed publish leaves a discoverable
  // unsubmitted attestation rather than a lost signature. Upsert on the
  // (subject, version) unique key so a previous interrupted run is
  // reused rather than rejected with a P2002 unique violation.
  const registryAddress =
    process.env.NEXT_PUBLIC_V3_2_ARBITRUMSEPOLIA_REPUTATION_ADDRESS ??
    process.env.V3_2_ARBITRUMSEPOLIA_REPUTATION_ADDRESS;

  const placeholder = await prisma.publishedAttestation.upsert({
    where: { subject_version: { subject: sellerLower, version: issued.attestation.version } },
    create: {
      subject: sellerLower,
      score: issued.attestation.score,
      issuedAt: new Date(issued.attestation.issuedAt * 1000),
      expiry: new Date(issued.attestation.expiry * 1000),
      version: issued.attestation.version,
      signature: issued.signature,
      chainId: 421614,
      registryAddr: registryAddress ?? "",
      txHash: null,
      publishedAt: null
    },
    update: {
      // Re-attempting a previously-signed-but-not-published attestation:
      // refresh the signature + timestamps so the signature is still
      // within its expiry window when the broadcast goes out.
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

  console.log(
    `[reputation] ${subject} score=${issued.attestation.score} version=${issued.attestation.version} tx=${txHash}`
  );
}

async function clearProcessedQueueEntries(subjects: string[]) {
  if (subjects.length === 0) return;
  await prisma.reputationRefreshQueue.updateMany({
    where: { subject: { in: subjects } },
    data: { processedAt: new Date() }
  });
}

async function runOnce() {
  const sellers = await gatherSellers();
  console.log(`[reputation cron] gathered ${sellers.size} sellers`);

  const processed: string[] = [];
  for (const sellerLower of sellers) {
    try {
      await processSeller(sellerLower);
      processed.push(sellerLower);
    } catch (error) {
      console.error(`[reputation cron] seller=${sellerLower} failed:`, error);
    }
  }

  // Mark queue entries as processed regardless of success — the next
  // event will re-enqueue them. Avoids the queue growing unbounded on a
  // sticky-failure seller.
  await clearProcessedQueueEntries(processed);
}

async function main() {
  await runOnce();

  if (once) {
    await prisma.$disconnect();
    return;
  }

  const interval = setInterval(() => {
    void runOnce().catch((error: unknown) => {
      console.error("[reputation cron] tick failed", error);
    });
  }, POLL_INTERVAL_MS);

  const shutdown = async () => {
    clearInterval(interval);
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
