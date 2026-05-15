import type { PrismaClient } from "@prisma/client";
import type { Address } from "viem";

// Components and weights for the v0 reputation score. The contract holds a
// uint16 so we cap raw at 1000 — well below the type limit, leaving headroom
// for future formula tweaks without a contract migration. Score weights are
// const here so it's obvious what's tunable; do NOT make them runtime-config
// until we have a versioned formula stored alongside the attestation.
const SCORE_BASE = 500;
const COMPLETED_BONUS_PER_ORDER = 30;
const COMPLETED_BONUS_CAP_ORDERS = 20; // ceiling on how much completed-volume helps
const DISPUTE_PENALTY = 200; // multiplied by disputeRate (0..1)
const REFUND_PENALTY = 100; // multiplied by refundRate (0..1)
const FULFILLMENT_GRACE_HOURS = 72; // no penalty until shipping took longer than this
const FULFILLMENT_PENALTY_PER_HOUR = 0.5; // 1 hour over grace → -0.5
const AGE_BONUS_PER_WEEK = 1; // accountAgeDays / 7
const AGE_BONUS_CAP = 50;
const MIN_SAMPLE_SIZE = 5;
const SAMPLE_SENTINEL = 500;
const MAX_SCORE = 1000;
const MIN_SCORE = 0;

export interface ScoreComponents {
  completedOrders: number;
  disputeRate: number;
  refundRate: number;
  avgFulfillmentHours: number;
  accountAgeDays: number;
}

export interface SellerScore {
  subject: Address;
  raw: number;
  components: ScoreComponents;
  sampleSize: number;
}

// Lightly-typed subset of an order row that the aggregator consumes. The
// real Prisma row types differ slightly per model — v3.2 stores `status` as
// Int, v2/v3/v3.1 store it as a string — so the gather step normalises into
// this shape before stats run.
export type NormalisedOrder = {
  status: number; // 0..6 — see OrderStatus enum in lib/order.ts
  createdAt: Date | null;
  paidAt: Date | null;
  shippedAt: Date | null;
};

const STATUS_INT = {
  Created: 0,
  Paid: 1,
  Shipped: 2,
  Completed: 3,
  Cancelled: 4,
  Disputed: 5,
  Refunded: 6
} as const;

const STATUS_BY_NAME: Record<string, number> = {
  Created: STATUS_INT.Created,
  Paid: STATUS_INT.Paid,
  Shipped: STATUS_INT.Shipped,
  Completed: STATUS_INT.Completed,
  Cancelled: STATUS_INT.Cancelled,
  Disputed: STATUS_INT.Disputed,
  Refunded: STATUS_INT.Refunded
};

function normaliseStatus(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && STATUS_BY_NAME[value] !== undefined) return STATUS_BY_NAME[value];
  // Treat unknown statuses as Created (0) — the safest default that does not
  // count towards completed/disputed.
  return STATUS_INT.Created;
}

// Pull this seller's orders across every marketplace model that exists.
// Orders are de-duplicated only by table (each table has its own orderId
// space); a v3 order #5 and a v3.2 order #5 are unrelated and both count.
export async function gatherSellerOrders(
  seller: Address,
  db: PrismaClient
): Promise<NormalisedOrder[]> {
  const lowered = seller.toLowerCase();

  const [v2, v3, v3_1, v3_2] = await Promise.all([
    // OnChainOrder is the v2/v3 unified table — its `seller` column is
    // lowercased on insert by the indexer.
    db.onChainOrder
      .findMany({
        where: { seller: lowered },
        select: { status: true, createdAt: true, paidAt: true, shippedAt: true }
      })
      .catch(() => []),
    // V3.1 lives in its own table.
    db.onChainOrderV3_1
      .findMany({
        where: { seller: lowered },
        select: { status: true, createdAt: true, paidAt: true, shippedAt: true }
      })
      .catch(() => []),
    db.onChainOrderV3_2
      .findMany({
        where: { seller: lowered },
        select: { status: true, createdAt: true, paidAt: true, shippedAt: true }
      })
      .catch(() => []),
    // Sentinel for a future v2-only model split. Left as empty so the
    // shape lines up.
    Promise.resolve([] as NormalisedOrder[])
  ]);

  // Note: this codebase doesn't have a dedicated OnChainOrderV2 table — v2
  // and v3 share OnChainOrder. The double-fetch above is harmless.
  void v3_2;

  return [...v2, ...v3, ...v3_1, ...v3_2].map((row) => ({
    status: normaliseStatus(row.status),
    createdAt: row.createdAt,
    paidAt: row.paidAt,
    shippedAt: row.shippedAt
  }));
}

export function computeScoreFromOrders(seller: Address, orders: NormalisedOrder[]): SellerScore {
  const total = orders.length;

  if (total < MIN_SAMPLE_SIZE) {
    return {
      subject: seller,
      raw: SAMPLE_SENTINEL,
      components: {
        completedOrders: 0,
        disputeRate: 0,
        refundRate: 0,
        avgFulfillmentHours: 0,
        accountAgeDays: 0
      },
      sampleSize: total
    };
  }

  let completed = 0;
  let disputed = 0;
  let refunded = 0;
  let fulfillmentHoursTotal = 0;
  let fulfillmentSamples = 0;
  let earliestCreatedAt: Date | null = null;

  for (const o of orders) {
    if (o.createdAt && (earliestCreatedAt === null || o.createdAt < earliestCreatedAt)) {
      earliestCreatedAt = o.createdAt;
    }

    if (o.status === STATUS_INT.Completed) {
      completed += 1;
      if (o.paidAt && o.shippedAt) {
        const hours = (o.shippedAt.getTime() - o.paidAt.getTime()) / (1000 * 3600);
        if (Number.isFinite(hours) && hours >= 0) {
          fulfillmentHoursTotal += hours;
          fulfillmentSamples += 1;
        }
      }
    }

    // disputed: order is currently Disputed OR ended up Refunded (which
    // implies a resolved dispute in the v3.x model). Refunded ALSO counts
    // as refunded — the two penalties stack on the same order on purpose:
    // a buyer-side refund signals a worse seller experience than a dispute
    // that was won.
    if (o.status === STATUS_INT.Disputed || o.status === STATUS_INT.Refunded) {
      disputed += 1;
    }
    if (o.status === STATUS_INT.Refunded) {
      refunded += 1;
    }
  }

  const disputeRate = total > 0 ? disputed / total : 0;
  const refundRate = total > 0 ? refunded / total : 0;
  const avgFulfillmentHours = fulfillmentSamples > 0 ? fulfillmentHoursTotal / fulfillmentSamples : 0;
  const accountAgeDays = earliestCreatedAt
    ? Math.max(0, (Date.now() - earliestCreatedAt.getTime()) / (1000 * 86400))
    : 0;

  const completedTerm = COMPLETED_BONUS_PER_ORDER * Math.min(completed, COMPLETED_BONUS_CAP_ORDERS);
  const disputeTerm = DISPUTE_PENALTY * disputeRate;
  const refundTerm = REFUND_PENALTY * refundRate;
  const fulfillmentTerm =
    FULFILLMENT_PENALTY_PER_HOUR * Math.max(0, avgFulfillmentHours - FULFILLMENT_GRACE_HOURS);
  const ageTerm = Math.min(AGE_BONUS_CAP, accountAgeDays * (AGE_BONUS_PER_WEEK / 7));

  const raw = Math.round(
    Math.min(
      MAX_SCORE,
      Math.max(MIN_SCORE, SCORE_BASE + completedTerm - disputeTerm - refundTerm - fulfillmentTerm + ageTerm)
    )
  );

  return {
    subject: seller,
    raw,
    components: {
      completedOrders: completed,
      disputeRate,
      refundRate,
      avgFulfillmentHours,
      accountAgeDays
    },
    sampleSize: total
  };
}

export async function computeSellerScore(seller: Address, db: PrismaClient): Promise<SellerScore> {
  const orders = await gatherSellerOrders(seller, db);
  return computeScoreFromOrders(seller, orders);
}
