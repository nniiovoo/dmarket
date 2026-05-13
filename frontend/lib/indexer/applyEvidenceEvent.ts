import type { PrismaClient } from "@prisma/client";

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
