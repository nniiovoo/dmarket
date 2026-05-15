// V3.1 equivalent of applyEvent.ts. Writes to OnChainOrderV3_1 instead of
// OnChainOrder.
//
// Notifications: V3.1 reuses V3's queueNotification/sendOwnerNotification
// machinery with marketplaceVersion="v3.1" so the 24h email dedup key in
// EmailLog doesn't collide with V3 orders that share the same orderId
// (V3 #3 and V3.1 #3 are unrelated). Email templates also pick the right
// detail URL (/v3_1/orders/...) based on the same flag.

import type { PrismaClient } from "@prisma/client";

import { queueNotification, sendOwnerNotification } from "../email/send";
import type { DecodedEvent } from "./eventDecoder";

export async function applyEventV3_1(
  prisma: PrismaClient,
  chainId: number,
  ev: DecodedEvent
): Promise<void> {
  const onChainOrderId = ev.orderId.toString();
  const where = {
    chainId_onChainOrderId: {
      chainId,
      onChainOrderId
    }
  };
  const existing = await prisma.onChainOrderV3_1.findUnique({ where });
  // Did this row exist before we touched it? Used below to gate
  // notifications — re-indexing the same block range (catchUp rerun,
  // indexer restart) must not re-send mails.
  //
  // For Created events: wasNew=true means a brand new order, notify-worthy
  //   downstream events will key off this. Created itself isn't notified.
  // For non-Created events: wasNew=false (the order row already existed),
  //   plus isAlreadyApplied guards against replaying the *same* event.

  if (existing && isAlreadyApplied(existing.lastBlock, existing.lastLogIndex, ev)) {
    return;
  }

  const eventMetadata = {
    lastBlock: ev.blockNumber,
    lastLogIndex: ev.logIndex,
    lastTxHash: ev.txHash,
    lastSyncedAt: new Date()
  };

  if (ev.kind === "Created") {
    await prisma.onChainOrderV3_1.upsert({
      where,
      create: {
        chainId,
        onChainOrderId,
        buyer: ev.buyer.toLowerCase(),
        seller: ev.seller.toLowerCase(),
        productId: ev.productId.toString(),
        amountWei: ev.amount.toString(),
        status: "Created",
        createdAt: timestampToDate(ev.blockTimestamp),
        ...eventMetadata
      },
      update: {
        buyer: ev.buyer.toLowerCase(),
        seller: ev.seller.toLowerCase(),
        productId: ev.productId.toString(),
        amountWei: ev.amount.toString(),
        status: "Created",
        createdAt: timestampToDate(ev.blockTimestamp),
        ...eventMetadata
      }
    });
    // Created itself has no notification (V3 doesn't notify on Created
    // either).
    return;
  }

  if (!existing) {
    // Non-Created event for an order we haven't seen yet — could be the
    // single-sig createAndPayWithAuth case where the indexer caught Paid
    // before Created (out-of-order on a re-org or block skew). Seed a
    // minimal row so the subsequent Created can upsert cleanly. We don't
    // have buyer/seller here, only orderId — leave them blank and let the
    // eventual Created event fill them in. No notification — we don't
    // know who to notify yet.
    return;
  }

  await prisma.onChainOrderV3_1.update({
    where,
    data: {
      ...dataForEvent(ev),
      ...eventMetadata
    }
  });

  // First-time application of this event (isAlreadyApplied returned false
  // above, so this is a genuinely new transition). Notify the relevant
  // parties.
  notifyForEventV3_1(chainId, { buyer: existing.buyer, seller: existing.seller }, ev);
}

function dataForEvent(ev: DecodedEvent) {
  const at = timestampToDate(ev.blockTimestamp);

  switch (ev.kind) {
    case "Paid":
      return { status: "Paid", paidAt: at };
    case "Shipped":
      return { status: "Shipped", shippedAt: at };
    case "Completed":
      return { status: "Completed", completedAt: at };
    case "Cancelled":
      return { status: "Cancelled" };
    case "Disputed":
      return { status: "Disputed", disputedAt: at };
    case "Resolved":
      return {};
    case "Refunded":
      return { status: "Refunded", refundedAt: at };
    case "Created":
      return {};
  }
}

function isAlreadyApplied(lastBlock: bigint, lastLogIndex: number, ev: DecodedEvent) {
  return lastBlock > ev.blockNumber || (lastBlock === ev.blockNumber && lastLogIndex >= ev.logIndex);
}

function timestampToDate(timestamp: bigint) {
  return new Date(Number(timestamp) * 1000);
}

// Mirrors notifyForEvent in applyEvent.ts but tags every email with
// marketplaceVersion="v3.1". The recipient mapping (who hears about what
// event) is identical to V3 on purpose — users shouldn't perceive the
// version distinction.
function notifyForEventV3_1(
  chainId: number,
  order: { buyer: string; seller: string },
  ev: DecodedEvent
) {
  const payload = { chainId, onChainOrderId: ev.orderId.toString() };

  switch (ev.kind) {
    case "Paid":
      queueNotification(order.seller, "OrderPaid", payload, "v3.1");
      break;
    case "Shipped":
      queueNotification(order.buyer, "OrderShipped", payload, "v3.1", 8000);
      break;
    case "Completed":
      queueNotification(order.seller, "OrderCompleted", payload, "v3.1");
      break;
    case "Disputed":
      queueNotification(order.buyer, "OrderDisputed", payload, "v3.1");
      queueNotification(order.seller, "OrderDisputed", payload, "v3.1");
      void sendOwnerNotification("OrderDisputed", payload, "v3.1");
      break;
    case "Refunded":
      queueNotification(order.buyer, "OrderRefunded", payload, "v3.1");
      break;
    case "Created":
    case "Cancelled":
    case "Resolved":
      break;
  }
}
