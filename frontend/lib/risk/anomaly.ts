import type { SellerBaseline } from "./baseline";

export type AnomalySignal = {
  key: string;
  score: number;
  triggered: boolean;
  detail: string;
};

export type AnomalyReport = {
  seller: string;
  signals: AnomalySignal[];
  overall: number;
  flags: string[];
};

export type AnomalyInput = {
  seller: string;
  buyerAccountAgeDays: number;
  amountWei: bigint;
  baseline: SellerBaseline;
};

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

function signalAmountVsP95(amountWei: bigint, p95: bigint): AnomalySignal {
  const triggered = p95 > 0n && amountWei > 2n * p95;
  let score = 0;
  if (triggered && p95 > 0n) {
    // amountWei / (5 * p95) as float — avoid BigInt division truncation
    score = clamp(Number(amountWei * 1_000n / (5n * p95)) / 1_000, 0, 1);
  }
  return {
    key: "amount_vs_p95",
    score,
    triggered,
    detail: `amountWei=${amountWei} p95=${p95}`,
  };
}

function signalNewBuyer(buyerAccountAgeDays: number): AnomalySignal {
  const triggered = buyerAccountAgeDays < 7;
  const score = triggered ? 1 - buyerAccountAgeDays / 7 : 0;
  return {
    key: "new_buyer",
    score,
    triggered,
    detail: `buyerAccountAgeDays=${buyerAccountAgeDays}`,
  };
}

function signalSellerNew(totalOrders: number): AnomalySignal {
  const triggered = totalOrders < 3;
  const score = triggered ? 1 - totalOrders / 3 : 0;
  return {
    key: "seller_new",
    score,
    triggered,
    detail: `totalOrders=${totalOrders}`,
  };
}

function signalSellerDisputeRate(disputed: number, total: number): AnomalySignal {
  const rate = disputed / Math.max(total, 1);
  const triggered = rate > 0.05;
  const score = triggered ? Math.min((rate - 0.05) / 0.10, 1) : 0;
  return {
    key: "seller_dispute_rate",
    score,
    triggered,
    detail: `disputedOrders=${disputed} totalOrders=${total} rate=${rate.toFixed(4)}`,
  };
}

export function scoreAnomaly(input: AnomalyInput): AnomalyReport {
  const { seller, buyerAccountAgeDays, amountWei, baseline } = input;

  const signals: AnomalySignal[] = [
    signalAmountVsP95(amountWei, baseline.p95AmountWei),
    signalNewBuyer(buyerAccountAgeDays),
    signalSellerNew(baseline.totalOrders),
    signalSellerDisputeRate(baseline.disputedOrders, baseline.totalOrders),
  ];

  const triggered = signals.filter((s) => s.triggered);
  const overall =
    triggered.length === 0
      ? 0
      : triggered.reduce((sum, s) => sum + s.score, 0) / triggered.length;

  return {
    seller,
    signals,
    overall,
    flags: triggered.map((s) => s.key),
  };
}
