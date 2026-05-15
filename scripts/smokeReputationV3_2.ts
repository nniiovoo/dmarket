import "dotenv/config";

import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: "frontend/.env.local" });

import { network } from "hardhat";

import { PrismaClient } from "../frontend/node_modules/@prisma/client/index.js";

// End-to-end reputation smoke. Self-contained: reads from the Prisma DB,
// recomputes the seller score with the same v0 formula as
// frontend/lib/reputation/score.ts, signs an EIP-712 attestation with the
// REPUTATION_SIGNER_PRIVATE_KEY, broadcasts recordAttestation via the
// deployer wallet, then reads back getAttestation to confirm parity.
//
// The script is run from the repo root with hardhat's network helper so
// it picks up arbitrumSepolia config + PRIVATE_KEY without going through
// the Next.js tsconfig path aliases.

// --- score (mirror of frontend/lib/reputation/score.ts) -----------------

const SCORE_BASE = 500;
const COMPLETED_BONUS_PER_ORDER = 30;
const COMPLETED_BONUS_CAP_ORDERS = 20;
const DISPUTE_PENALTY = 200;
const REFUND_PENALTY = 100;
const FULFILLMENT_GRACE_HOURS = 72;
const FULFILLMENT_PENALTY_PER_HOUR = 0.5;
const AGE_BONUS_PER_WEEK = 1;
const AGE_BONUS_CAP = 50;
const MIN_SAMPLE_SIZE = 5;
const SAMPLE_SENTINEL = 500;
const MAX_SCORE = 1000;
const MIN_SCORE = 0;

const STATUS_INT = {
  Completed: 3,
  Disputed: 5,
  Refunded: 6
} as const;
const STATUS_BY_NAME: Record<string, number> = {
  Created: 0,
  Paid: 1,
  Shipped: 2,
  Completed: 3,
  Cancelled: 4,
  Disputed: 5,
  Refunded: 6
};
function normaliseStatus(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string" && STATUS_BY_NAME[v] !== undefined) return STATUS_BY_NAME[v];
  return 0;
}

type NormalisedOrder = {
  status: number;
  createdAt: Date | null;
  paidAt: Date | null;
  shippedAt: Date | null;
};

async function gatherSellerOrders(prisma: PrismaClient, sellerLower: string): Promise<NormalisedOrder[]> {
  const [v3, v3_1, v3_2] = await Promise.all([
    prisma.onChainOrder.findMany({
      where: { seller: sellerLower },
      select: { status: true, createdAt: true, paidAt: true, shippedAt: true }
    }),
    prisma.onChainOrderV3_1.findMany({
      where: { seller: sellerLower },
      select: { status: true, createdAt: true, paidAt: true, shippedAt: true }
    }),
    prisma.onChainOrderV3_2.findMany({
      where: { seller: sellerLower },
      select: { status: true, createdAt: true, paidAt: true, shippedAt: true }
    })
  ]);

  return [...v3, ...v3_1, ...v3_2].map((r) => ({
    status: normaliseStatus(r.status),
    createdAt: r.createdAt,
    paidAt: r.paidAt,
    shippedAt: r.shippedAt
  }));
}

function computeScore(orders: NormalisedOrder[]) {
  const total = orders.length;
  if (total < MIN_SAMPLE_SIZE) {
    return {
      raw: SAMPLE_SENTINEL,
      sampleSize: total,
      components: {
        completedOrders: 0,
        disputeRate: 0,
        refundRate: 0,
        avgFulfillmentHours: 0,
        accountAgeDays: 0
      }
    };
  }

  let completed = 0;
  let disputed = 0;
  let refunded = 0;
  let fulfillmentHoursTotal = 0;
  let fulfillmentSamples = 0;
  let earliest: Date | null = null;

  for (const o of orders) {
    if (o.createdAt && (earliest === null || o.createdAt < earliest)) earliest = o.createdAt;
    if (o.status === STATUS_INT.Completed) {
      completed += 1;
      if (o.paidAt && o.shippedAt) {
        const h = (o.shippedAt.getTime() - o.paidAt.getTime()) / 3.6e6;
        if (Number.isFinite(h) && h >= 0) {
          fulfillmentHoursTotal += h;
          fulfillmentSamples += 1;
        }
      }
    }
    if (o.status === STATUS_INT.Disputed || o.status === STATUS_INT.Refunded) disputed += 1;
    if (o.status === STATUS_INT.Refunded) refunded += 1;
  }

  const disputeRate = disputed / total;
  const refundRate = refunded / total;
  const avgFulfillmentHours = fulfillmentSamples > 0 ? fulfillmentHoursTotal / fulfillmentSamples : 0;
  const accountAgeDays = earliest ? Math.max(0, (Date.now() - earliest.getTime()) / 86_400_000) : 0;

  const completedTerm = COMPLETED_BONUS_PER_ORDER * Math.min(completed, COMPLETED_BONUS_CAP_ORDERS);
  const disputeTerm = DISPUTE_PENALTY * disputeRate;
  const refundTerm = REFUND_PENALTY * refundRate;
  const fulfillmentTerm = FULFILLMENT_PENALTY_PER_HOUR * Math.max(0, avgFulfillmentHours - FULFILLMENT_GRACE_HOURS);
  const ageTerm = Math.min(AGE_BONUS_CAP, accountAgeDays * (AGE_BONUS_PER_WEEK / 7));

  const raw = Math.round(
    Math.min(MAX_SCORE, Math.max(MIN_SCORE, SCORE_BASE + completedTerm - disputeTerm - refundTerm - fulfillmentTerm + ageTerm))
  );
  return {
    raw,
    sampleSize: total,
    components: { completedOrders: completed, disputeRate, refundRate, avgFulfillmentHours, accountAgeDays }
  };
}

// ---------------------------------------------------------------------------

async function main() {
  const connection = await network.create();
  const { ethers } = connection;
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No deployer signer");

  const registryAddress = process.env.V3_2_ARBITRUMSEPOLIA_REPUTATION_ADDRESS;
  if (!registryAddress) throw new Error("V3_2_ARBITRUMSEPOLIA_REPUTATION_ADDRESS missing");
  const signerKey = process.env.REPUTATION_SIGNER_PRIVATE_KEY;
  if (!signerKey) throw new Error("REPUTATION_SIGNER_PRIVATE_KEY missing");

  const prisma = new PrismaClient();
  try {
    const candidate = await prisma.onChainOrderV3_2.findFirst({
      orderBy: { onChainOrderId: "asc" },
      select: { seller: true }
    });
    if (!candidate) throw new Error("No v3.2 orders in DB — seed via Phase B smoke first");
    const sellerLower = candidate.seller.toLowerCase();
    const seller = ethers.getAddress(sellerLower);
    console.log("subject (seller):", seller);

    const orders = await gatherSellerOrders(prisma, sellerLower);
    const score = computeScore(orders);
    console.log("computed score:", JSON.stringify(score));

    // Read on-chain version to pick the next attestation version.
    const registry = await ethers.getContractAt("ReputationRegistry", registryAddress, deployer);
    const stored = await registry.latest(seller);
    const storedVersion = Number(stored.version);
    const nextVersion = storedVersion + 1;
    if (nextVersion > 255) throw new Error(`version exhausted for ${seller}`);

    const issuedAt = Math.floor(Date.now() / 1000);
    const expiry = issuedAt + 30 * 86400;
    const attestation = {
      subject: seller,
      score: score.raw,
      issuedAt: BigInt(issuedAt),
      expiry: BigInt(expiry),
      version: nextVersion
    };

    const signerWallet = new ethers.Wallet(signerKey);
    const domain = {
      name: "ChainUsReputation",
      version: "1",
      chainId: 421614n,
      verifyingContract: registryAddress
    };
    const types = {
      Attestation: [
        { name: "subject", type: "address" },
        { name: "score", type: "uint16" },
        { name: "issuedAt", type: "uint64" },
        { name: "expiry", type: "uint64" },
        { name: "version", type: "uint8" }
      ]
    };
    const signature = await signerWallet.signTypedData(domain, types, attestation);
    console.log("signed attestation:", JSON.stringify({ ...attestation, issuedAt: Number(attestation.issuedAt), expiry: Number(attestation.expiry), signature }));

    const tx = await registry.connect(deployer).recordAttestation(attestation, signature);
    const receipt = await tx.wait();
    const txHash = receipt?.hash ?? tx.hash;
    console.log("recordAttestation tx:", txHash);

    const onChain = await registry.getAttestation(seller);
    const chainResult = {
      subject: onChain.subject,
      score: Number(onChain.score),
      issuedAt: Number(onChain.issuedAt),
      expiry: Number(onChain.expiry),
      version: Number(onChain.version)
    };
    console.log("on-chain getAttestation:", JSON.stringify(chainResult));

    if (chainResult.score !== score.raw) {
      throw new Error(`score mismatch: chain=${chainResult.score} computed=${score.raw}`);
    }
    if (chainResult.version !== nextVersion) {
      throw new Error(`version mismatch: chain=${chainResult.version} issued=${nextVersion}`);
    }
    console.log("✓ on-chain attestation matches computed score");

    await prisma.publishedAttestation.upsert({
      where: { subject_version: { subject: sellerLower, version: nextVersion } },
      create: {
        subject: sellerLower,
        score: score.raw,
        issuedAt: new Date(issuedAt * 1000),
        expiry: new Date(expiry * 1000),
        version: nextVersion,
        signature,
        chainId: 421614,
        registryAddr: registryAddress,
        txHash,
        publishedAt: new Date()
      },
      update: {
        signature,
        score: score.raw,
        issuedAt: new Date(issuedAt * 1000),
        expiry: new Date(expiry * 1000),
        txHash,
        publishedAt: new Date()
      }
    });
  } finally {
    await prisma.$disconnect();
    await connection.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
