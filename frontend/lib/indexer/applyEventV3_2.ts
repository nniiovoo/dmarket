// V3.2 applyEvent. Writes to OnChainOrderV3_2 using a 3-column unique key
// (chainId, marketplaceAddress, onChainOrderId) so that orders sharing an
// orderId with V3/V3.1 markets don't collide. Notifications are deferred
// to a later phase — V3.2 currently produces no emails.

import type { PrismaClient } from "@prisma/client";

import type { DecodedEventV3_2 } from "./eventDecoderV3_2";

// Mirror of the on-chain enum order (Solidity OrderStatus). Keep in sync
// with frontend/lib/order.ts.
const STATUS_INT = {
  Created: 0,
  Paid: 1,
  Shipped: 2,
  Completed: 3,
  Cancelled: 4,
  Disputed: 5,
  Refunded: 6
} as const;

export async function applyEventV3_2(
  prisma: PrismaClient,
  chainId: number,
  marketplaceAddress: string,
  ev: DecodedEventV3_2
): Promise<void> {
  const lowerMarketplace = marketplaceAddress.toLowerCase();
  const onChainOrderId = ev.orderId.toString();
  const where = {
    chainId_marketplaceAddress_onChainOrderId: {
      chainId,
      marketplaceAddress: lowerMarketplace,
      onChainOrderId
    }
  } as const;
  const existing = await prisma.onChainOrderV3_2.findUnique({ where });

  // Replay-safety: if the row's lastEventBlock is already past this event,
  // we've seen it. (We don't track lastLogIndex on this model — re-running
  // catchUp over an already-indexed block is a no-op event-for-event.)
  if (existing && existing.lastEventBlock > ev.blockNumber) {
    return;
  }

  const eventMetadata = {
    lastEventBlock: ev.blockNumber,
    lastEventTxHash: ev.txHash,
    lastSyncedAt: new Date()
  };
  const at = timestampToDate(ev.blockTimestamp);

  if (ev.kind === "Created") {
    await prisma.onChainOrderV3_2.upsert({
      where,
      create: {
        chainId,
        marketplaceAddress: lowerMarketplace,
        onChainOrderId,
        buyer: ev.buyer.toLowerCase(),
        seller: ev.seller.toLowerCase(),
        paymentToken: ev.paymentToken.toLowerCase(),
        productId: ev.productId.toString(),
        amount: ev.amount.toString(),
        status: STATUS_INT.Created,
        createdAt: at,
        ...eventMetadata
      },
      update: {
        // The Created event re-arriving means we somehow lost the original
        // row (or a re-org rebuilt it). Trust the chain.
        buyer: ev.buyer.toLowerCase(),
        seller: ev.seller.toLowerCase(),
        paymentToken: ev.paymentToken.toLowerCase(),
        productId: ev.productId.toString(),
        amount: ev.amount.toString(),
        status: STATUS_INT.Created,
        createdAt: at,
        ...eventMetadata
      }
    });
    return;
  }

  if (!existing) {
    // Non-Created event for an order we don't have yet — same out-of-order
    // case as v3.1's applyEventV3_1. Skip; the subsequent Created will
    // populate the row, and the next periodic catch-up over the same block
    // range will replay this non-Created event against the now-present row.
    return;
  }

  await prisma.onChainOrderV3_2.update({
    where,
    data: { ...dataForEvent(ev, at), ...eventMetadata }
  });

  // Reputation refresh trigger: any seller-side terminal transition is a
  // reason to recompute their score. We enqueue the seller and let the
  // cron pick them up; doing the heavy compute + sign inside the indexer
  // hot path would slow event processing and tie the indexer to the
  // signer key. Single-row upsert: resetting processedAt to null tells
  // the cron a new event arrived since the last sweep.
  if (ev.kind === "Completed" || ev.kind === "Refunded" || ev.kind === "Resolved") {
    await prisma.reputationRefreshQueue.upsert({
      where: { subject: existing.seller },
      create: { subject: existing.seller, processedAt: null },
      update: { queuedAt: new Date(), processedAt: null }
    });
  }
}

function dataForEvent(ev: DecodedEventV3_2, at: Date) {
  switch (ev.kind) {
    case "Paid":
      return { status: STATUS_INT.Paid, paidAt: at };
    case "Shipped":
      return { status: STATUS_INT.Shipped, shippedAt: at };
    case "Completed":
      return { status: STATUS_INT.Completed, completedAt: at };
    case "Cancelled":
      return { status: STATUS_INT.Cancelled };
    case "Disputed":
      return { status: STATUS_INT.Disputed, disputedAt: at };
    case "Resolved":
      // DisputeResolved itself doesn't change status — the partner
      // OrderCompleted (seller wins) or OrderRefunded (buyer wins) event
      // emitted alongside resolveDispute() carries the terminal transition.
      return {};
    case "Refunded":
      return { status: STATUS_INT.Refunded };
    case "Created":
      return {};
  }
}

function timestampToDate(timestamp: bigint) {
  return new Date(Number(timestamp) * 1000);
}
