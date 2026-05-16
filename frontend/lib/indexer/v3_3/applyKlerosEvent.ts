// V3.3 Kleros adapter event applier. Mirrors adapter events into the
// existing OnChainOrderV3_3 row identified by
// (chainId, marketplaceAddress, onChainOrderId).
//
// The adapter doesn't carry the marketplace address on each event — we
// pass it in from the catch-up dispatcher (resolved once from env). On
// Arbitrum Sepolia there's exactly one v3.3 marketplace address; if we
// ever support multiple v3.3 marketplaces per chain, the dispatcher
// will need to resolve via adapter.marketplace() on-chain instead.
//
// Out-of-order safety: if the marketplace event indexer hasn't yet
// created the OnChainOrderV3_3 row (extremely rare; both contracts
// emit in the same block stream), we log a warning and skip the
// event. The cursor has already advanced past those blocks; recovery
// is a manual re-run with INDEXER_V3_3_KLEROS_ADAPTER_FROM_BLOCK
// overriding the start back to the missed range.

import type { PrismaClient } from "@prisma/client";

import type { KlerosAdapterEvent } from "./decoders";

export async function applyKlerosAdapterEvents(
  prisma: PrismaClient,
  chainId: number,
  marketplaceAddress: string,
  events: readonly KlerosAdapterEvent[]
): Promise<void> {
  for (const ev of events) {
    await applyOne(prisma, chainId, marketplaceAddress, ev);
  }
}

async function applyOne(
  prisma: PrismaClient,
  chainId: number,
  marketplaceAddress: string,
  ev: KlerosAdapterEvent
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

  // Emergency events are operator-side metadata; log them for
  // observability but don't yet have a column to persist. Matches the
  // v3.2 applier's behavior (Phase H.3) so dashboards see the same
  // signal across versions.
  if (
    ev.kind === "EmergencyProposed" ||
    ev.kind === "EmergencyExecuted" ||
    ev.kind === "EmergencyCancelled"
  ) {
    const extra = ev.kind === "EmergencyCancelled" ? "" : ` refundBuyer=${ev.refundBuyer}`;
    console.log(
      `[v3.3 kleros chain ${chainId}] ${ev.kind} order=${onChainOrderId} tx=${ev.txHash}${extra}`
    );
    return;
  }

  // RulingDeferred fires when Kleros ruled but marketplace's 3-day
  // cooldown wasn't elapsed yet. The same orderId will receive a
  // DisputeRuled event later (via applyKlerosRuling). For diagnostics
  // we log but don't persist; the DB only carries the *final* ruling.
  if (ev.kind === "RulingDeferred") {
    console.log(
      `[v3.3 kleros chain ${chainId}] RulingDeferred order=${onChainOrderId} ruling=${ev.ruling} reason="${ev.reason}"`
    );
    return;
  }

  const existing = await prisma.onChainOrderV3_3.findUnique({ where });
  if (!existing) {
    console.warn(
      `[v3.3 kleros chain ${chainId}] ${ev.kind} for order=${onChainOrderId} but row missing — adapter event arrived before marketplace event; skipping`
    );
    return;
  }

  if (ev.kind === "Escalated") {
    // Idempotency: don't overwrite if we've already recorded this escalation.
    if (existing.klerosDisputeId !== null) return;
    await prisma.onChainOrderV3_3.update({
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
    await prisma.onChainOrderV3_3.update({
      where,
      data: {
        klerosRuling: Number(ev.ruling),
        klerosRuledAt: new Date(Number(ev.blockTimestamp) * 1000)
      }
    });
    return;
  }
}
