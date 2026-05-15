import type { Rule } from "./types";

export const SELLER_BLOCKLIST: string[] = [];

export const defaultRules: Rule[] = [
  {
    id: "elevated-dispute-rate",
    description: "Seller dispute rate in last 30 days exceeds 5% — require second confirmation",
    priority: 80,
    enabled: true,
    when: { op: "gt", path: "seller.disputeRate30d", value: 0.05 },
    then: { type: "require_second_confirm", reason: "elevated_dispute_rate" },
  },
  {
    id: "high-value-new-buyer",
    description: "Order >= $5000 with buyer account age < 7 days — require manual review",
    priority: 90,
    enabled: true,
    when: {
      op: "and",
      clauses: [
        { op: "gte", path: "order.amountUsd", value: 5000 },
        { op: "lt", path: "buyer.accountAgeDays", value: 7 },
      ],
    },
    then: { type: "require_review", reason: "high_value_new_buyer" },
  },
  {
    id: "seller-blocklisted",
    description: "Seller address is on the platform blocklist — block transaction",
    priority: 100,
    enabled: true,
    when: { op: "in", path: "seller.address", values: SELLER_BLOCKLIST },
    then: { type: "block", reason: "seller_blocklisted" },
  },
];
