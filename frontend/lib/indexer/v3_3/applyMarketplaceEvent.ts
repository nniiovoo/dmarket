// Applier for v3.3 marketplace events (Phase K.5b).
//
// Mirrors v3.2's applyEventV3_2 lifecycle (Created → Paid → Shipped →
// Completed | Cancelled | Disputed → Resolved → Completed/Refunded)
// while also folding the v3.3-specific `shopId` snapshot in at
// creation and the (feeAmount, sellerAmount) split written by
// RevenueDistributed at completion.
//
// Out-of-order safety: lifecycle events that arrive before the
// matching OrderCreated are logged and skipped. The next catch-up
// pass over the same block range will replay them after the create.
// (Same approach as v3.2 applyEvent.)

import type { PrismaClient } from "@prisma/client";

import type { MarketplaceEvent } from "./decoders";

const STATUS = {
  Created: 0,
  Paid: 1,
  Shipped: 2,
  Completed: 3,
  Cancelled: 4,
  Disputed: 5,
  Refunded: 6
} as const;

function timestampToDate(timestamp: bigint): Date {
  return new Date(Number(timestamp) * 1000);
}

function lower(addr: string): string {
  return addr.toLowerCase();
}

export async function applyMarketplaceEvents(
  prisma: PrismaClient,
  chainId: number,
  marketplaceAddress: string,
  events: readonly MarketplaceEvent[]
): Promise<void> {
  const lowerMarket = marketplaceAddress.toLowerCase();
  for (const ev of events) {
    try {
      await applyOne(prisma, chainId, lowerMarket, ev);
    } catch (err) {
      const orderRef = "orderId" in ev ? `order=${ev.orderId.toString()}` : "(no order)";
      console.error(
        `[v3.3 marketplace chain ${chainId}] apply failed for ${ev.kind} ${orderRef} tx=${ev.txHash}`,
        err
      );
    }
  }
}

async function applyOne(
  prisma: PrismaClient,
  chainId: number,
  marketplaceAddress: string,
  ev: MarketplaceEvent
): Promise<void> {
  if (ev.kind === "OrderCreated") {
    const orderId = ev.orderId.toString();
    const where = {
      chainId_marketplaceAddress_onChainOrderId: {
        chainId,
        marketplaceAddress,
        onChainOrderId: orderId
      }
    } as const;
    const existing = await prisma.onChainOrderV3_3.findUnique({ where });
    // Replay safety: if a later event for this order already advanced
    // the cursor past this create's block, leave the existing row
    // alone — we don't want to clobber a Completed status with the
    // initial Created.
    if (existing && existing.lastEventBlock > ev.blockNumber) return;
    const createdAt = timestampToDate(ev.blockTimestamp);
    await prisma.onChainOrderV3_3.upsert({
      where,
      create: {
        chainId,
        marketplaceAddress,
        onChainOrderId: orderId,
        buyer: lower(ev.buyer),
        seller: lower(ev.seller),
        shopId: Number(ev.shopId),
        paymentToken: lower(ev.paymentToken),
        productId: ev.productId.toString(),
        amount: ev.amount.toString(),
        status: STATUS.Created,
        createdAt,
        lastEventBlock: ev.blockNumber,
        lastEventTxHash: ev.txHash
      },
      update: {
        // Re-org rebuild: refresh everything but keep historical event
        // timestamps that downstream events have already filled.
        buyer: lower(ev.buyer),
        seller: lower(ev.seller),
        shopId: Number(ev.shopId),
        paymentToken: lower(ev.paymentToken),
        productId: ev.productId.toString(),
        amount: ev.amount.toString(),
        status: STATUS.Created,
        createdAt,
        lastEventBlock: ev.blockNumber,
        lastEventTxHash: ev.txHash
      }
    });
    return;
  }

  // All non-Created events need the row to already exist.
  if (!("orderId" in ev)) return;
  const orderId = ev.orderId.toString();
  const where = {
    chainId_marketplaceAddress_onChainOrderId: {
      chainId,
      marketplaceAddress,
      onChainOrderId: orderId
    }
  } as const;
  const existing = await prisma.onChainOrderV3_3.findUnique({ where });
  if (!existing) {
    console.warn(
      `[v3.3 marketplace chain ${chainId}] skip ${ev.kind} for missing order ${orderId} (out-of-order; will replay on next catch-up)`
    );
    return;
  }
  if (existing.lastEventBlock > ev.blockNumber) {
    // Already past this event in time — don't regress.
    return;
  }

  const ts = timestampToDate(ev.blockTimestamp);
  const eventMeta = {
    lastEventBlock: ev.blockNumber,
    lastEventTxHash: ev.txHash,
    lastSyncedAt: new Date()
  };

  switch (ev.kind) {
    case "OrderPaid":
      await prisma.onChainOrderV3_3.update({
        where,
        data: { status: STATUS.Paid, paidAt: ts, ...eventMeta }
      });
      return;
    case "OrderShipped":
      await prisma.onChainOrderV3_3.update({
        where,
        data: { status: STATUS.Shipped, shippedAt: ts, ...eventMeta }
      });
      return;
    case "OrderCompleted":
      // RevenueDistributed (if any) lands in the same tx; we preserve
      // any feeAmount/sellerAmount already written and just bump
      // status + completedAt.
      await prisma.onChainOrderV3_3.update({
        where,
        data: { status: STATUS.Completed, completedAt: ts, ...eventMeta }
      });
      return;
    case "OrderCancelled":
      await prisma.onChainOrderV3_3.update({
        where,
        data: { status: STATUS.Cancelled, ...eventMeta }
      });
      return;
    case "DisputeOpened":
      await prisma.onChainOrderV3_3.update({
        where,
        data: { status: STATUS.Disputed, disputedAt: ts, ...eventMeta }
      });
      return;
    case "DisputeResolved":
      // The terminal state comes from the OrderCompleted (refundBuyer=false)
      // or OrderRefunded (refundBuyer=true) that fires in the same tx.
      // We just tag the lastEvent* pointer.
      await prisma.onChainOrderV3_3.update({ where, data: { ...eventMeta } });
      return;
    case "OrderRefunded":
      await prisma.onChainOrderV3_3.update({
        where,
        data: { status: STATUS.Refunded, ...eventMeta }
      });
      return;
    case "RevenueDistributed":
      // Captured at completion. We do NOT change status here — the
      // OrderCompleted event in the same tx handles that. Just stamp
      // the fee split so the API can report it.
      await prisma.onChainOrderV3_3.update({
        where,
        data: {
          feeAmount: ev.fee.toString(),
          sellerAmount: ev.sellerAmount.toString(),
          ...eventMeta
        }
      });
      return;
    default: {
      // exhaustive check
      const _unreached: never = ev;
      void _unreached;
      return;
    }
  }
}
