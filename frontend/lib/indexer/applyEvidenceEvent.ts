import type { PrismaClient } from "@prisma/client";

import { queueNotification } from "../email/send";
import type { DecodedEvidenceEvent } from "./evidenceEventDecoder";

export async function applyEvidenceEvent(
  prisma: PrismaClient,
  chainId: number,
  ev: DecodedEvidenceEvent
): Promise<void> {
  const onChainOrderId = ev.orderId.toString();
  const evidenceIndex = Number(ev.evidenceIndex);

  if (ev.kind === "EvidenceSubmitted") {
    const submittedAt = timestampToDate(ev.blockTimestamp);
    // Was this evidence already indexed? Used below to decide whether to
    // notify — re-indexing the same event (e.g. after a catchUp rerun)
    // shouldn't spam the recipient.
    const wasNew =
      (await prisma.evidence.findUnique({
        where: {
          chainId_onChainOrderId_evidenceIndex: { chainId, onChainOrderId, evidenceIndex }
        },
        select: { evidenceIndex: true }
      })) === null;

    await prisma.evidence.upsert({
      where: {
        chainId_onChainOrderId_evidenceIndex: {
          chainId,
          onChainOrderId,
          evidenceIndex
        }
      },
      create: {
        chainId,
        onChainOrderId,
        evidenceIndex,
        party: ev.party.toLowerCase(),
        evidenceURI: ev.evidenceURI,
        contentHash: ev.contentHash,
        marketplaceDeliveredAtSnapshot: ev.marketplaceDeliveredAtSnapshot,
        submittedAt,
        submittedBlock: ev.blockNumber,
        submittedTxHash: ev.txHash
      },
      update: {
        party: ev.party.toLowerCase(),
        evidenceURI: ev.evidenceURI,
        contentHash: ev.contentHash,
        marketplaceDeliveredAtSnapshot: ev.marketplaceDeliveredAtSnapshot,
        submittedAt,
        submittedBlock: ev.blockNumber,
        submittedTxHash: ev.txHash
      }
    });

    if (wasNew) {
      await notifyOtherParty(prisma, chainId, onChainOrderId, ev.party.toLowerCase());
    }
    return;
  }

  const existing = await prisma.evidence.findUnique({
    where: {
      chainId_onChainOrderId_evidenceIndex: {
        chainId,
        onChainOrderId,
        evidenceIndex
      }
    }
  });
  if (!existing) {
    return;
  }

  if (ev.kind === "OracleRequested") {
    await prisma.evidence.update({
      where: {
        chainId_onChainOrderId_evidenceIndex: {
          chainId,
          onChainOrderId,
          evidenceIndex
        }
      },
      data: {
        oracleRequestId: ev.requestId,
        oracleQueryStatus: "pending"
      }
    });
    return;
  }

  if (ev.kind === "OracleFulfilled") {
    await prisma.evidence.update({
      where: {
        chainId_onChainOrderId_evidenceIndex: {
          chainId,
          onChainOrderId,
          evidenceIndex
        }
      },
      data: {
        oracleQueryStatus: "fulfilled",
        oracleDelivered: ev.delivered,
        oracleDeliveredTimestamp: ev.deliveredTimestamp,
        oracleFulfilledAt: timestampToDate(ev.blockTimestamp),
        oracleFulfilledBlock: ev.blockNumber,
        oracleFulfilledTxHash: ev.txHash
      }
    });
    return;
  }

  if (ev.kind === "OracleFailed") {
    await prisma.evidence.update({
      where: {
        chainId_onChainOrderId_evidenceIndex: {
          chainId,
          onChainOrderId,
          evidenceIndex
        }
      },
      data: {
        oracleQueryStatus: "failed",
        oracleError: ev.reason,
        oracleFulfilledAt: timestampToDate(ev.blockTimestamp),
        oracleFulfilledBlock: ev.blockNumber,
        oracleFulfilledTxHash: ev.txHash
      }
    });
    return;
  }
}

function timestampToDate(timestamp: bigint): Date {
  return new Date(Number(timestamp) * 1000);
}

async function notifyOtherParty(
  prisma: PrismaClient,
  chainId: number,
  onChainOrderId: string,
  submitterAddress: string
): Promise<void> {
  const order = await prisma.onChainOrder.findUnique({
    where: { chainId_onChainOrderId: { chainId, onChainOrderId } },
    select: { buyer: true, seller: true }
  });
  if (!order) return;

  const buyer = order.buyer.toLowerCase();
  const seller = order.seller.toLowerCase();
  const submitter = submitterAddress.toLowerCase();

  if (submitter === buyer) {
    // Buyer just submitted → tell seller.
    queueNotification(seller, "EvidenceSubmittedByBuyer", { chainId, onChainOrderId });
  } else if (submitter === seller) {
    // Seller just submitted → tell buyer.
    queueNotification(buyer, "EvidenceSubmittedBySeller", { chainId, onChainOrderId });
  }
  // If submitter is neither (shouldn't happen — contract enforces party check),
  // drop silently.
}
