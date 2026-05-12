import { formatEther, type Address } from "viem";

export const orderStatusLabels = ["Created", "Paid", "Shipped", "Completed", "Cancelled", "Disputed", "Refunded"];

export enum OrderStatus {
  Created,
  Paid,
  Shipped,
  Completed,
  Cancelled,
  Disputed,
  Refunded
}

export type OrderView = {
  id: bigint;
  buyer: Address;
  status: OrderStatus;
  createdAt: bigint;
  seller: Address;
  paidAt: bigint;
  productId: bigint;
  amount: bigint;
  shippedAt: bigint;
  completedAt: bigint;
};

export function normalizeOrder(raw: unknown): OrderView | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }

  const value = raw as Record<string, unknown> & unknown[];

  return {
    id: BigInt((value.id ?? value[0]) as bigint),
    buyer: (value.buyer ?? value[1]) as Address,
    status: Number(value.status ?? value[2]) as OrderStatus,
    createdAt: BigInt((value.createdAt ?? value[3]) as bigint),
    seller: (value.seller ?? value[4]) as Address,
    paidAt: BigInt((value.paidAt ?? value[5]) as bigint),
    productId: BigInt((value.productId ?? value[6]) as bigint),
    amount: BigInt((value.amount ?? value[7]) as bigint),
    shippedAt: BigInt((value.shippedAt ?? value[8]) as bigint),
    completedAt: BigInt((value.completedAt ?? value[9]) as bigint)
  };
}

export function statusLabel(status: number | undefined) {
  if (status === undefined) {
    return "Unknown";
  }

  return orderStatusLabels[status] ?? `Unknown (${status})`;
}

export function formatAmount(value: bigint | undefined) {
  return value === undefined ? "-" : formatEther(value);
}

export function sameAddress(a: string | undefined, b: string | undefined) {
  return a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();
}

export function formatTimestamp(value: bigint | undefined) {
  if (value === undefined || value === 0n) {
    return "-";
  }

  return new Date(Number(value) * 1000).toLocaleString();
}
