import type { PrismaClient } from "@prisma/client";

import { queueNotification, sendOwnerNotification } from "../email/send";
import type { DecodedEvent } from "./eventDecoder";

export async function applyEvent(prisma: PrismaClient, chainId: number, ev: DecodedEvent): Promise<void> {
  const onChainOrderId = ev.orderId.toString();
  const where = {
    chainId_onChainOrderId: {
      chainId,
      onChainOrderId
    }
  };
  const existing = await prisma.onChainOrder.findUnique({ where });

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
    await prisma.onChainOrder.upsert({
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
    return;
  }

  if (!existing) {
    return;
  }

  await prisma.onChainOrder.update({
    where,
    data: {
      ...dataForEvent(ev),
      ...eventMetadata
    }
  });
  notifyForEvent(chainId, existing, ev);
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

function notifyForEvent(
  chainId: number,
  order: {
    buyer: string;
    seller: string;
  },
  ev: DecodedEvent
) {
  const payload = { chainId, onChainOrderId: ev.orderId.toString() };

  // Explicit "v3" everywhere even though it's the default — defense against
  // future positional-arg drift now that queueNotification takes
  // (addr, kind, payload, marketplaceVersion, delayMs).
  switch (ev.kind) {
    case "Paid":
      queueNotification(order.seller, "OrderPaid", payload, "v3");
      break;
    case "Shipped":
      queueNotification(order.buyer, "OrderShipped", payload, "v3", 8000);
      break;
    case "Completed":
      queueNotification(order.seller, "OrderCompleted", payload, "v3");
      break;
    case "Disputed":
      queueNotification(order.buyer, "OrderDisputed", payload, "v3");
      queueNotification(order.seller, "OrderDisputed", payload, "v3");
      void sendOwnerNotification("OrderDisputed", payload, "v3");
      break;
    case "Refunded":
      queueNotification(order.buyer, "OrderRefunded", payload, "v3");
      break;
    case "Created":
    case "Cancelled":
    case "Resolved":
      break;
  }
}
