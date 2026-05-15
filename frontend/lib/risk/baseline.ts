import { prisma } from "../db";

export type SellerBaseline = {
  seller: string;
  totalOrders: number;
  completedOrders: number;
  disputedOrders: number;
  refundedOrders: number;
  meanAmountWei: bigint;
  p95AmountWei: bigint;
  firstOrderAt: Date | null;
  lastOrderAt: Date | null;
};

type OrderRow = {
  status: string;
  amountWei: string;
  createdAt: Date | null;
};

function p95(sorted: bigint[]): bigint {
  if (sorted.length === 0) return 0n;
  const idx = Math.floor(sorted.length * 0.95);
  return sorted[Math.min(idx, sorted.length - 1)];
}

function computeBaseline(seller: string, rows: OrderRow[]): SellerBaseline {
  const completed = rows.filter((r) => r.status === "Completed");
  const disputed  = rows.filter((r) => r.status === "Disputed");
  const refunded  = rows.filter((r) => r.status === "Refunded");

  const completedWeis = completed
    .map((r) => BigInt(r.amountWei))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const meanAmountWei =
    completedWeis.length === 0
      ? 0n
      : completedWeis.reduce((s, v) => s + v, 0n) / BigInt(completedWeis.length);

  const dates = rows
    .map((r) => r.createdAt)
    .filter((d): d is Date => d !== null)
    .map((d) => d.getTime())
    .sort((a, b) => a - b);

  return {
    seller,
    totalOrders:     rows.length,
    completedOrders: completed.length,
    disputedOrders:  disputed.length,
    refundedOrders:  refunded.length,
    meanAmountWei,
    p95AmountWei:    p95(completedWeis),
    firstOrderAt:    dates.length > 0 ? new Date(dates[0]) : null,
    lastOrderAt:     dates.length > 0 ? new Date(dates[dates.length - 1]) : null,
  };
}

export async function buildSellerBaseline(
  seller: string,
  opts?: { lookbackDays?: number }
): Promise<SellerBaseline> {
  const normalised = seller.toLowerCase();

  const where: {
    seller: string;
    createdAt?: { gte: Date };
  } = { seller: normalised };

  if (opts?.lookbackDays !== undefined) {
    const cutoff = new Date(Date.now() - opts.lookbackDays * 86_400_000);
    where.createdAt = { gte: cutoff };
  }

  const fields = { status: true, amountWei: true, createdAt: true } as const;

  const [v3Rows, v31Rows] = await Promise.all([
    prisma.onChainOrder.findMany({ where, select: fields }),
    prisma.onChainOrderV3_1.findMany({ where, select: fields }),
  ]);

  const allRows: OrderRow[] = [...v3Rows, ...v31Rows];
  return computeBaseline(normalised, allRows);
}
