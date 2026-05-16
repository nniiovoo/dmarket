// DB-write paths for the v3.3 shop-economy indexer. One function per
// contract type — each accepts a sorted array of decoded events and
// applies them sequentially. The catch-up loop wraps the per-contract
// dispatch in a per-event try/catch so a single malformed event doesn't
// stall the cursor.
//
// All addresses are stored lower-cased so the API endpoints (which
// take user input) can match on normalised keys.

import { randomBytes } from "node:crypto";

import type { PrismaClient } from "@prisma/client";

import type {
  DistributorEvent,
  ShareMarketEvent,
  ShopNftEvent,
  ShopSharesEvent
} from "./decoders";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// Listing-status integers mirror the on-chain enum
// (Active=0 / Filled=1 / Cancelled=2). They are also the values stored
// on `ShopListing.status` so the API can return them verbatim.
const LISTING_STATUS_ACTIVE = 0;
const LISTING_STATUS_FILLED = 1;
const LISTING_STATUS_CANCELLED = 2;

// ShopRevenueEvent.eventType — matches the order in the API enum doc.
const REVENUE_EVENT_DEPOSITED = 0;
const REVENUE_EVENT_SETTLED = 1;
const REVENUE_EVENT_CLAIMED = 2;

function lower(addr: string): string {
  return addr.toLowerCase();
}

// Event ids use random bytes rather than (txHash, logIndex) directly so
// the primary key is short — the unique index on (txHash, logIndex) is
// what enforces dedup.
function eventId(): string {
  return randomBytes(16).toString("hex");
}

// -------------------------------------------------------------------------
// ShopNFT
// -------------------------------------------------------------------------

export async function applyShopNftEvents(
  prisma: PrismaClient,
  events: readonly ShopNftEvent[]
): Promise<void> {
  for (const ev of events) {
    try {
      await applyShopNftEvent(prisma, ev);
    } catch (err) {
      console.error(`[v3.3 shopNft] apply failed for ${ev.kind} tx=${ev.txHash}`, err);
    }
  }
}

async function applyShopNftEvent(prisma: PrismaClient, ev: ShopNftEvent): Promise<void> {
  if (ev.kind === "ShopCreated") {
    // Mint path: ShopNFT.adminMint / mintShop emit ShopCreated AND
    // ERC-721 Transfer. We use ShopCreated as the canonical "row
    // bootstrap" because it carries the seller name in plaintext.
    const shopId = Number(ev.shopId);
    const creator = lower(ev.creator);
    await prisma.shopNFT.upsert({
      where: { shopId },
      create: {
        shopId,
        currentOwner: creator,
        creator,
        createdAt: new Date(Number(ev.blockTimestamp) * 1000),
        name: ev.name,
        description: "",
        imageUrl: "",
        lastUpdatedBlock: ev.blockNumber,
        lastUpdatedTxHash: ev.txHash
      },
      update: {
        // Re-org rebuild: keep the same creator + createdAt, refresh
        // metadata + cursor stamps. Avoids stale rows after a chain
        // reorg below finality.
        creator,
        createdAt: new Date(Number(ev.blockTimestamp) * 1000),
        name: ev.name,
        lastUpdatedBlock: ev.blockNumber,
        lastUpdatedTxHash: ev.txHash
      }
    });
    return;
  }

  if (ev.kind === "ShopMetadataUpdated") {
    // Only updates mutable fields.
    await prisma.shopNFT
      .update({
        where: { shopId: Number(ev.shopId) },
        data: {
          name: ev.name,
          description: ev.description,
          imageUrl: ev.imageUrl,
          lastUpdatedBlock: ev.blockNumber,
          lastUpdatedTxHash: ev.txHash
        }
      })
      .catch((err: unknown) => {
        // Possible if a ShopMetadataUpdated arrives out-of-order
        // (catch-up scanned the contract back-to-front). Log + skip;
        // the bootstrapping ShopCreated will follow.
        console.warn(`[v3.3 shopNft] metadata-update for missing shop ${ev.shopId}: ${err}`);
      });
    return;
  }

  if (ev.kind === "Transfer") {
    // Mint side (from == 0) is already handled by ShopCreated above —
    // ignore so we don't fight that path. Real transfers update
    // currentOwner; burn (to == 0) would zero it but we don't expose
    // a burn entry point.
    if (ev.from === ZERO_ADDRESS) return;
    await prisma.shopNFT
      .update({
        where: { shopId: Number(ev.tokenId) },
        data: {
          currentOwner: lower(ev.to),
          lastUpdatedBlock: ev.blockNumber,
          lastUpdatedTxHash: ev.txHash
        }
      })
      .catch((err: unknown) => {
        console.warn(`[v3.3 shopNft] Transfer for missing shop ${ev.tokenId}: ${err}`);
      });
  }
}

// -------------------------------------------------------------------------
// ShopShares — projects balances into ShopShareHolding.
// -------------------------------------------------------------------------

export async function applyShopSharesEvents(
  prisma: PrismaClient,
  events: readonly ShopSharesEvent[]
): Promise<void> {
  for (const ev of events) {
    try {
      await applyShopSharesEvent(prisma, ev);
    } catch (err) {
      console.error(`[v3.3 shopShares] apply failed for ${ev.kind} tx=${ev.txHash}`, err);
    }
  }
}

async function applyShopSharesEvent(prisma: PrismaClient, ev: ShopSharesEvent): Promise<void> {
  if (ev.kind === "SharesInitialized") {
    // Mint emits TransferSingle from 0x0 → initialHolder right after,
    // which is what actually moves the balance. SharesInitialized is
    // purely a tag for off-chain consumers; we leave the projection
    // to TransferSingle.
    return;
  }

  const triples: Array<{ shopId: bigint; value: bigint }> = [];
  let from: string;
  let to: string;
  if (ev.kind === "TransferSingle") {
    from = ev.from;
    to = ev.to;
    triples.push({ shopId: ev.id, value: ev.value });
  } else {
    // TransferBatch
    from = ev.from;
    to = ev.to;
    if (ev.ids.length !== ev.values.length) {
      console.error(
        `[v3.3 shopShares] TransferBatch length mismatch: ${ev.ids.length} vs ${ev.values.length} tx=${ev.txHash}`
      );
      return;
    }
    for (let i = 0; i < ev.ids.length; ++i) {
      const id = ev.ids[i];
      const v = ev.values[i];
      if (id === undefined || v === undefined) continue;
      triples.push({ shopId: id, value: v });
    }
  }

  const fromLower = lower(from);
  const toLower = lower(to);

  for (const { shopId, value } of triples) {
    if (value === 0n) continue;
    const shopIdNum = Number(shopId);
    if (from !== ZERO_ADDRESS) {
      await adjustHolding(prisma, shopIdNum, fromLower, -value, ev.blockNumber);
    }
    if (to !== ZERO_ADDRESS) {
      await adjustHolding(prisma, shopIdNum, toLower, value, ev.blockNumber);
    }
  }
}

async function adjustHolding(
  prisma: PrismaClient,
  shopId: number,
  holder: string,
  delta: bigint,
  blockNumber: bigint
): Promise<void> {
  const existing = await prisma.shopShareHolding.findUnique({
    where: { shopId_holder: { shopId, holder } }
  });
  const current = existing ? BigInt(existing.balance) : 0n;
  const next = current + delta;
  if (next < 0n) {
    // Indicates a missed event or out-of-order delivery. Skip but log
    // so the operator can decide whether to rebuild from cursor=0.
    console.error(
      `[v3.3 shopShares] negative balance avoided: shop ${shopId} holder ${holder} current=${current} delta=${delta}`
    );
    return;
  }
  await prisma.shopShareHolding.upsert({
    where: { shopId_holder: { shopId, holder } },
    create: {
      shopId,
      holder,
      balance: next.toString(),
      lastUpdatedBlock: blockNumber
    },
    update: {
      balance: next.toString(),
      lastUpdatedBlock: blockNumber
    }
  });
}

// -------------------------------------------------------------------------
// RevenueDistributor — audit log only.
// -------------------------------------------------------------------------

export async function applyDistributorEvents(
  prisma: PrismaClient,
  events: readonly DistributorEvent[]
): Promise<void> {
  for (const ev of events) {
    try {
      await applyDistributorEvent(prisma, ev);
    } catch (err) {
      console.error(`[v3.3 distributor] apply failed for ${ev.kind} tx=${ev.txHash}`, err);
    }
  }
}

async function applyDistributorEvent(
  prisma: PrismaClient,
  ev: DistributorEvent
): Promise<void> {
  const common = {
    id: eventId(),
    shopId: Number(ev.shopId),
    token: lower(ev.token),
    blockNumber: ev.blockNumber,
    txHash: ev.txHash,
    logIndex: ev.logIndex,
    blockTime: new Date(Number(ev.blockTimestamp) * 1000)
  };
  let record: typeof common & { eventType: number; holder: string | null; amount: string };
  if (ev.kind === "Deposited") {
    record = { ...common, eventType: REVENUE_EVENT_DEPOSITED, holder: null, amount: ev.amount.toString() };
  } else if (ev.kind === "Settled") {
    record = {
      ...common,
      eventType: REVENUE_EVENT_SETTLED,
      holder: lower(ev.holder),
      amount: ev.credited.toString()
    };
  } else {
    record = {
      ...common,
      eventType: REVENUE_EVENT_CLAIMED,
      holder: lower(ev.holder),
      amount: ev.amount.toString()
    };
  }

  // Dedup on (txHash, logIndex) — re-running catch-up over an
  // already-indexed range is a no-op.
  await prisma.shopRevenueEvent
    .upsert({
      where: { txHash_logIndex: { txHash: record.txHash, logIndex: record.logIndex } },
      create: record,
      update: {} // immutable once written
    })
    .catch((err: unknown) => {
      console.error(`[v3.3 distributor] upsert failed: ${err}`);
    });
}

// -------------------------------------------------------------------------
// ShareMarket — projects listing lifecycle into ShopListing.
// -------------------------------------------------------------------------

export async function applyShareMarketEvents(
  prisma: PrismaClient,
  events: readonly ShareMarketEvent[]
): Promise<void> {
  for (const ev of events) {
    try {
      await applyShareMarketEvent(prisma, ev);
    } catch (err) {
      console.error(`[v3.3 shareMarket] apply failed for ${ev.kind} tx=${ev.txHash}`, err);
    }
  }
}

async function applyShareMarketEvent(
  prisma: PrismaClient,
  ev: ShareMarketEvent
): Promise<void> {
  if (ev.kind === "ListingCreated") {
    const listingId = Number(ev.listingId);
    // M.1: persist (originalAmount, remainingAmount, pricePerToken).
    // Also fill the legacy `amount` + `totalPrice` columns so any
    // un-migrated query still resolves to sensible numbers.
    const originalAmount = ev.amount.toString();
    const pricePerToken = ev.pricePerToken.toString();
    const totalAtMint = (ev.amount * ev.pricePerToken).toString();
    await prisma.shopListing.upsert({
      where: { listingId },
      create: {
        listingId,
        seller: lower(ev.seller),
        shopId: Number(ev.shopId),
        amount: originalAmount,
        paymentToken: lower(ev.paymentToken),
        totalPrice: totalAtMint,
        originalAmount,
        remainingAmount: originalAmount,
        pricePerToken,
        status: LISTING_STATUS_ACTIVE,
        buyer: null,
        createdBlock: ev.blockNumber,
        createdTxHash: ev.txHash,
        closedBlock: null,
        closedTxHash: null
      },
      update: {
        // re-org rebuild
        seller: lower(ev.seller),
        shopId: Number(ev.shopId),
        amount: originalAmount,
        paymentToken: lower(ev.paymentToken),
        totalPrice: totalAtMint,
        originalAmount,
        remainingAmount: originalAmount,
        pricePerToken,
        status: LISTING_STATUS_ACTIVE,
        buyer: null,
        createdBlock: ev.blockNumber,
        createdTxHash: ev.txHash,
        closedBlock: null,
        closedTxHash: null
      }
    });
    return;
  }
  if (ev.kind === "ListingFilled") {
    // M.1: a fill no longer terminates the listing unconditionally —
    // it shrinks `remainingAmount`. The on-chain `remainingAfter`
    // field is authoritative; if it's 0 the listing flips to Filled
    // in the same call. Record the buyer of the *terminal* fill so
    // the legacy `buyer` column still reflects "who closed it" —
    // for partial fills, we leave `buyer` until the final fill.
    const remainingAfter = ev.remainingAfter.toString();
    const flippedToFilled = ev.remainingAfter === 0n;
    await prisma.shopListing
      .update({
        where: { listingId: Number(ev.listingId) },
        data: {
          remainingAmount: remainingAfter,
          status: flippedToFilled ? LISTING_STATUS_FILLED : LISTING_STATUS_ACTIVE,
          ...(flippedToFilled
            ? {
                buyer: lower(ev.buyer),
                closedBlock: ev.blockNumber,
                closedTxHash: ev.txHash
              }
            : {})
        }
      })
      .catch((err: unknown) => {
        console.warn(`[v3.3 shareMarket] fill for missing listing ${ev.listingId}: ${err}`);
      });
    return;
  }
  if (ev.kind === "ListingCancelled") {
    await prisma.shopListing
      .update({
        where: { listingId: Number(ev.listingId) },
        data: {
          status: LISTING_STATUS_CANCELLED,
          closedBlock: ev.blockNumber,
          closedTxHash: ev.txHash
        }
      })
      .catch((err: unknown) => {
        console.warn(`[v3.3 shareMarket] cancel for missing listing ${ev.listingId}: ${err}`);
      });
  }
}
