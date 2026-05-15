// V3.2 Kleros adapter event applier. Mirrors adapter events into the
// existing OnChainOrderV3_2 row identified by
// (chainId, marketplaceAddress, onChainOrderId). The adapter doesn't carry
// the marketplace address on each event, so we pass the linked marketplace
// in from the caller (looked up once from env / adapter on-chain read).
//
// Out-of-order safety: if the marketplace event indexer hasn't yet
// created the OnChainOrderV3_2 row (extremely rare; both indexers see
// the same block stream), we log a warning and skip the event. In
// production both indexers are nearly synchronous (<1s skew), so this
// case essentially never fires; if it ever does, the next catch-up pass
// over the marketplace stream will create the row, and a manual re-run
// of the adapter catch-up over the affected block range will re-apply
// the missed adapter event. We do NOT replay automatically because the
// adapter cursor has already advanced past those blocks.

import type { PrismaClient } from "@prisma/client";

import type { DecodedAdapterEvent } from "./eventDecoderV3_2Kleros";

export async function applyAdapterEventV3_2(
  prisma: PrismaClient,
  chainId: number,
  marketplaceAddress: string,
  ev: DecodedAdapterEvent
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

  // Emergency events are operator-side metadata; we log them for
  // observability but don't yet have a column to persist them. Adding a
  // dedicated AdapterEmergencyAction table is on the Phase H.3+ backlog
  // (in the meantime they're recoverable from chain logs).
  if (
    ev.kind === "EmergencyProposed" ||
    ev.kind === "EmergencyExecuted" ||
    ev.kind === "EmergencyCancelled"
  ) {
    console.log(
      `[v3.2 kleros chain ${chainId}] ${ev.kind} order=${onChainOrderId} tx=${ev.txHash}` +
        (ev.kind !== "EmergencyCancelled" ? ` refundBuyer=${ev.refundBuyer}` : "")
    );
    return;
  }

  // RulingDeferred fires when Kleros ruled but marketplace's 3-day
  // cooldown wasn't elapsed yet. The same orderId will receive a
  // DisputeRuled event later (via applyKlerosRuling). For diagnostics we
  // log it but don't persist; the DB only carries the *final* ruling.
  if (ev.kind === "RulingDeferred") {
    console.log(
      `[v3.2 kleros chain ${chainId}] RulingDeferred order=${onChainOrderId} ruling=${ev.ruling} reason="${ev.reason}"`
    );
    return;
  }

  const existing = await prisma.onChainOrderV3_2.findUnique({ where });
  if (!existing) {
    console.warn(
      `[v3.2 kleros chain ${chainId}] ${ev.kind} for order=${onChainOrderId} but row missing — adapter event arrived before marketplace event; skipping`
    );
    return;
  }

  if (ev.kind === "Escalated") {
    // Idempotency: don't overwrite if we've already recorded this escalation.
    if (existing.klerosDisputeId !== null) return;
    await prisma.onChainOrderV3_2.update({
      where,
      data: {
        klerosDisputeId: ev.klerosDisputeId.toString(),
        disputeEscalatedAt: new Date(Number(ev.blockTimestamp) * 1000)
      }
    });
    return;
  }

  if (ev.kind === "Ruled") {
    // Idempotency: only record the first definitive ruling per order.
    // ruling values: 0 (refused → buyer-refund by adapter), 1 (buyer), 2 (seller).
    if (existing.klerosRuling !== null) return;
    await prisma.onChainOrderV3_2.update({
      where,
      data: {
        klerosRuling: Number(ev.ruling),
        klerosRuledAt: new Date(Number(ev.blockTimestamp) * 1000)
      }
    });
    return;
  }
}
