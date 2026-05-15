// Smoke test for the anomaly detection scorer.
// Run with: npx tsx scripts/smokeAnomaly.ts

import { scoreAnomaly } from "../lib/risk/anomaly";
import type { SellerBaseline } from "../lib/risk/baseline";

let passed = 0;

function assert(label: string, cond: unknown): void {
  if (!cond) {
    console.error(`FAIL  ${label}`);
    process.exit(1);
  }
  console.log(`PASS  ${label}`);
  passed++;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function baseline(overrides: Partial<SellerBaseline> = {}): SellerBaseline {
  return {
    seller:          "0xseller",
    totalOrders:     20,
    completedOrders: 18,
    disputedOrders:  0,
    refundedOrders:  0,
    meanAmountWei:   100_000n,
    p95AmountWei:    200_000n,
    firstOrderAt:    new Date("2024-01-01"),
    lastOrderAt:     new Date("2025-01-01"),
    ...overrides,
  };
}

// ── 1. Empty history → seller_new triggered ───────────────────────────────────

const emptyBaseline = baseline({
  totalOrders: 0, completedOrders: 0, disputedOrders: 0, refundedOrders: 0,
  meanAmountWei: 0n, p95AmountWei: 0n,
  firstOrderAt: null, lastOrderAt: null,
});
const emptyReport = scoreAnomaly({
  seller: "0xseller", buyerAccountAgeDays: 30, amountWei: 100_000n, baseline: emptyBaseline,
});
assert("empty history: seller_new triggered", emptyReport.flags.includes("seller_new"));
assert("empty history: seller_new score = 1", emptyReport.signals.find((s) => s.key === "seller_new")!.score === 1);
assert("empty history: amount_vs_p95 not triggered (p95=0)", !emptyReport.flags.includes("amount_vs_p95"));

// ── 2. High amount → amount_vs_p95 triggered ─────────────────────────────────

const highAmtBaseline = baseline({ p95AmountWei: 200_000n });
const highAmtReport = scoreAnomaly({
  seller: "0xseller", buyerAccountAgeDays: 30,
  amountWei: 1_200_000n,   // > 2 * 200_000 = 400_000 → triggers
  baseline: highAmtBaseline,
});
assert("high amount: amount_vs_p95 triggered", highAmtReport.flags.includes("amount_vs_p95"));
assert("high amount: score in (0,1]", highAmtReport.signals.find((s) => s.key === "amount_vs_p95")!.score > 0);

// ── 3. Established seller, normal amount, old buyer → no flags ────────────────

const cleanReport = scoreAnomaly({
  seller: "0xseller", buyerAccountAgeDays: 365, amountWei: 100_000n, baseline: baseline(),
});
assert("clean scenario: no flags", cleanReport.flags.length === 0);
assert("clean scenario: overall = 0", cleanReport.overall === 0);

// ── 4. High dispute rate → seller_dispute_rate triggered ─────────────────────

const disputeBaseline = baseline({ totalOrders: 100, disputedOrders: 20, completedOrders: 75 });
const disputeReport = scoreAnomaly({
  seller: "0xseller", buyerAccountAgeDays: 365, amountWei: 100_000n, baseline: disputeBaseline,
});
assert("dispute: seller_dispute_rate triggered", disputeReport.flags.includes("seller_dispute_rate"));
const drSignal = disputeReport.signals.find((s) => s.key === "seller_dispute_rate")!;
assert("dispute: score > 0", drSignal.score > 0);
assert("dispute: score <= 1", drSignal.score <= 1);

// ── 5. All four signals triggered ────────────────────────────────────────────

const allBaseline = baseline({
  totalOrders: 2, completedOrders: 1, disputedOrders: 1, refundedOrders: 0,
  p95AmountWei: 50_000n,
});
// amountWei = 500_000 > 2*50_000=100_000 → amount_vs_p95
// buyerAccountAgeDays = 3 < 7 → new_buyer
// totalOrders = 2 < 3 → seller_new
// disputedOrders/totalOrders = 0.5 > 0.05 → seller_dispute_rate
const allReport = scoreAnomaly({
  seller: "0xseller", buyerAccountAgeDays: 3, amountWei: 500_000n, baseline: allBaseline,
});
assert("all-four: amount_vs_p95 triggered", allReport.flags.includes("amount_vs_p95"));
assert("all-four: new_buyer triggered", allReport.flags.includes("new_buyer"));
assert("all-four: seller_new triggered", allReport.flags.includes("seller_new"));
assert("all-four: seller_dispute_rate triggered", allReport.flags.includes("seller_dispute_rate"));
assert("all-four: overall > 0", allReport.overall > 0);

// Verify overall is the mean of triggered signal scores
const triggeredScores = allReport.signals.filter((s) => s.triggered).map((s) => s.score);
const expectedOverall = triggeredScores.reduce((a, b) => a + b, 0) / triggeredScores.length;
assert(
  "all-four: overall equals mean of triggered scores",
  Math.abs(allReport.overall - expectedOverall) < 1e-10
);

console.log(`\nALL PASS (${passed} assertions)`);
