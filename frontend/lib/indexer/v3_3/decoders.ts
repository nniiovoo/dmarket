// Event decoders for the four v3.3 shop-economy contracts.
//
// Each contract gets its own decoder that consumes the IndexedLog
// stream and emits a strongly-typed union. We don't share the
// EventBase + IndexedLog types from `../eventDecoder.ts` directly
// because the v3.3 contracts emit a much wider set of event shapes
// (ERC-721 Transfer, ERC-1155 TransferSingle/Batch, plus the v3.3
// business events), and forcing them all through the v3.2 `kind`
// union would lose type safety at the apply step.

import type { Abi, Address } from "viem";
import { decodeEventLog } from "viem";

import shopNftAbiJson from "../../../abi/ShopNFT.json";
import shopSharesAbiJson from "../../../abi/ShopShares.json";
import revenueDistributorAbiJson from "../../../abi/RevenueDistributor.json";
import shareMarketAbiJson from "../../../abi/ShareMarket.json";
import marketplaceAbiJson from "../../../abi/EscrowMarketplaceV3_3.json";

import type { IndexedLog } from "../eventDecoder";

const shopNftAbi = shopNftAbiJson as Abi;
const shopSharesAbi = shopSharesAbiJson as Abi;
const revenueDistributorAbi = revenueDistributorAbiJson as Abi;
const shareMarketAbi = shareMarketAbiJson as Abi;
const marketplaceAbi = marketplaceAbiJson as Abi;

interface LogContext {
  blockNumber: bigint;
  logIndex: number;
  txHash: string;
  blockTimestamp: bigint;
}

function ctxOf(log: IndexedLog, blockTimestamp: bigint): LogContext {
  return {
    blockNumber: log.blockNumber,
    logIndex: log.logIndex,
    txHash: log.transactionHash,
    blockTimestamp
  };
}

// ---------------------------------------------------------------------------
// ShopNFT
// ---------------------------------------------------------------------------

export type ShopNftEvent =
  | (LogContext & { kind: "ShopCreated"; shopId: bigint; creator: Address; name: string })
  | (LogContext & {
      kind: "ShopMetadataUpdated";
      shopId: bigint;
      name: string;
      description: string;
      imageUrl: string;
    })
  | (LogContext & { kind: "Transfer"; from: Address; to: Address; tokenId: bigint });

export function decodeShopNftLog(log: IndexedLog, blockTimestamp: bigint): ShopNftEvent | undefined {
  let decoded: { eventName: string; args: Record<string, unknown> };
  try {
    decoded = decodeEventLog({ abi: shopNftAbi, data: log.data, topics: log.topics }) as unknown as {
      eventName: string;
      args: Record<string, unknown>;
    };
  } catch {
    return undefined;
  }
  const ctx = ctxOf(log, blockTimestamp);
  switch (decoded.eventName) {
    case "ShopCreated":
      return {
        ...ctx,
        kind: "ShopCreated",
        shopId: decoded.args.shopId as bigint,
        creator: decoded.args.creator as Address,
        name: (decoded.args.name as string) ?? ""
      };
    case "ShopMetadataUpdated":
      return {
        ...ctx,
        kind: "ShopMetadataUpdated",
        shopId: decoded.args.shopId as bigint,
        name: (decoded.args.name as string) ?? "",
        description: (decoded.args.description as string) ?? "",
        imageUrl: (decoded.args.imageUrl as string) ?? ""
      };
    case "Transfer":
      return {
        ...ctx,
        kind: "Transfer",
        from: decoded.args.from as Address,
        to: decoded.args.to as Address,
        tokenId: decoded.args.tokenId as bigint
      };
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// ShopShares (ERC-1155)
// ---------------------------------------------------------------------------

export type ShopSharesEvent =
  | (LogContext & {
      kind: "SharesInitialized";
      shopId: bigint;
      initialHolder: Address;
    })
  | (LogContext & {
      kind: "TransferSingle";
      operator: Address;
      from: Address;
      to: Address;
      id: bigint;
      value: bigint;
    })
  | (LogContext & {
      kind: "TransferBatch";
      operator: Address;
      from: Address;
      to: Address;
      ids: readonly bigint[];
      values: readonly bigint[];
    });

export function decodeShopSharesLog(
  log: IndexedLog,
  blockTimestamp: bigint
): ShopSharesEvent | undefined {
  let decoded: { eventName: string; args: Record<string, unknown> };
  try {
    decoded = decodeEventLog({ abi: shopSharesAbi, data: log.data, topics: log.topics }) as unknown as {
      eventName: string;
      args: Record<string, unknown>;
    };
  } catch {
    return undefined;
  }
  const ctx = ctxOf(log, blockTimestamp);
  switch (decoded.eventName) {
    case "SharesInitialized":
      return {
        ...ctx,
        kind: "SharesInitialized",
        shopId: decoded.args.shopId as bigint,
        initialHolder: decoded.args.initialHolder as Address
      };
    case "TransferSingle":
      return {
        ...ctx,
        kind: "TransferSingle",
        operator: decoded.args.operator as Address,
        from: decoded.args.from as Address,
        to: decoded.args.to as Address,
        id: decoded.args.id as bigint,
        value: decoded.args.value as bigint
      };
    case "TransferBatch":
      return {
        ...ctx,
        kind: "TransferBatch",
        operator: decoded.args.operator as Address,
        from: decoded.args.from as Address,
        to: decoded.args.to as Address,
        ids: decoded.args.ids as readonly bigint[],
        values: decoded.args.values as readonly bigint[]
      };
    default:
      // SettlerUpdated / URI / ApprovalForAll / OwnershipTransferred —
      // not material to the holding-balance projection.
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// RevenueDistributor
// ---------------------------------------------------------------------------

export type DistributorEvent =
  | (LogContext & {
      kind: "Deposited";
      shopId: bigint;
      token: Address;
      amount: bigint;
      by: Address;
    })
  | (LogContext & {
      kind: "Settled";
      shopId: bigint;
      token: Address;
      holder: Address;
      credited: bigint;
    })
  | (LogContext & {
      kind: "Claimed";
      shopId: bigint;
      token: Address;
      holder: Address;
      amount: bigint;
    });

export function decodeDistributorLog(
  log: IndexedLog,
  blockTimestamp: bigint
): DistributorEvent | undefined {
  let decoded: { eventName: string; args: Record<string, unknown> };
  try {
    decoded = decodeEventLog({
      abi: revenueDistributorAbi,
      data: log.data,
      topics: log.topics
    }) as unknown as { eventName: string; args: Record<string, unknown> };
  } catch {
    return undefined;
  }
  const ctx = ctxOf(log, blockTimestamp);
  switch (decoded.eventName) {
    case "Deposited":
      return {
        ...ctx,
        kind: "Deposited",
        shopId: decoded.args.shopId as bigint,
        token: decoded.args.token as Address,
        amount: decoded.args.amount as bigint,
        by: decoded.args.by as Address
      };
    case "Settled":
      return {
        ...ctx,
        kind: "Settled",
        shopId: decoded.args.shopId as bigint,
        token: decoded.args.token as Address,
        holder: decoded.args.holder as Address,
        credited: decoded.args.credited as bigint
      };
    case "Claimed":
      return {
        ...ctx,
        kind: "Claimed",
        shopId: decoded.args.shopId as bigint,
        token: decoded.args.token as Address,
        holder: decoded.args.holder as Address,
        amount: decoded.args.amount as bigint
      };
    default:
      // AuthorizedDepositorUpdated / OwnershipTransferred etc. — admin
      // events that don't affect the holder-claim projection.
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// ShareMarket
// ---------------------------------------------------------------------------

export type ShareMarketEvent =
  | (LogContext & {
      kind: "ListingCreated";
      listingId: bigint;
      seller: Address;
      shopId: bigint;
      amount: bigint;
      paymentToken: Address;
      totalPrice: bigint;
    })
  | (LogContext & {
      kind: "ListingFilled";
      listingId: bigint;
      buyer: Address;
      seller: Address;
      shopId: bigint;
      amount: bigint;
      paymentToken: Address;
      totalPrice: bigint;
    })
  | (LogContext & { kind: "ListingCancelled"; listingId: bigint; seller: Address });

export function decodeShareMarketLog(
  log: IndexedLog,
  blockTimestamp: bigint
): ShareMarketEvent | undefined {
  let decoded: { eventName: string; args: Record<string, unknown> };
  try {
    decoded = decodeEventLog({
      abi: shareMarketAbi,
      data: log.data,
      topics: log.topics
    }) as unknown as { eventName: string; args: Record<string, unknown> };
  } catch {
    return undefined;
  }
  const ctx = ctxOf(log, blockTimestamp);
  switch (decoded.eventName) {
    case "ListingCreated":
      return {
        ...ctx,
        kind: "ListingCreated",
        listingId: decoded.args.listingId as bigint,
        seller: decoded.args.seller as Address,
        shopId: decoded.args.shopId as bigint,
        amount: decoded.args.amount as bigint,
        paymentToken: decoded.args.paymentToken as Address,
        totalPrice: decoded.args.totalPrice as bigint
      };
    case "ListingFilled":
      return {
        ...ctx,
        kind: "ListingFilled",
        listingId: decoded.args.listingId as bigint,
        buyer: decoded.args.buyer as Address,
        seller: decoded.args.seller as Address,
        shopId: decoded.args.shopId as bigint,
        amount: decoded.args.amount as bigint,
        paymentToken: decoded.args.paymentToken as Address,
        totalPrice: decoded.args.totalPrice as bigint
      };
    case "ListingCancelled":
      return {
        ...ctx,
        kind: "ListingCancelled",
        listingId: decoded.args.listingId as bigint,
        seller: decoded.args.seller as Address
      };
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// EscrowMarketplaceV3_3 (K.5b)
// ---------------------------------------------------------------------------

export type MarketplaceEvent =
  | (LogContext & {
      kind: "OrderCreated";
      orderId: bigint;
      buyer: Address;
      seller: Address;
      shopId: bigint;
      paymentToken: Address;
      productId: bigint;
      amount: bigint;
    })
  | (LogContext & {
      kind: "OrderPaid";
      orderId: bigint;
      buyer: Address;
      paymentToken: Address;
      amount: bigint;
    })
  | (LogContext & { kind: "OrderShipped"; orderId: bigint; seller: Address })
  | (LogContext & { kind: "OrderCompleted"; orderId: bigint; seller: Address; amount: bigint })
  | (LogContext & { kind: "OrderCancelled"; orderId: bigint })
  | (LogContext & { kind: "DisputeOpened"; orderId: bigint; openedBy: Address })
  | (LogContext & { kind: "DisputeResolved"; orderId: bigint; refundBuyer: boolean })
  | (LogContext & { kind: "OrderRefunded"; orderId: bigint; buyer: Address; amount: bigint })
  | (LogContext & {
      kind: "RevenueDistributed";
      orderId: bigint;
      shopId: bigint;
      token: Address;
      fee: bigint;
      sellerAmount: bigint;
    });

export function decodeMarketplaceLog(
  log: IndexedLog,
  blockTimestamp: bigint
): MarketplaceEvent | undefined {
  let decoded: { eventName: string; args: Record<string, unknown> };
  try {
    decoded = decodeEventLog({
      abi: marketplaceAbi,
      data: log.data,
      topics: log.topics
    }) as unknown as { eventName: string; args: Record<string, unknown> };
  } catch {
    return undefined;
  }
  const ctx = ctxOf(log, blockTimestamp);
  const a = decoded.args;
  switch (decoded.eventName) {
    case "OrderCreated":
      return {
        ...ctx,
        kind: "OrderCreated",
        orderId: a.orderId as bigint,
        buyer: a.buyer as Address,
        seller: a.seller as Address,
        shopId: a.shopId as bigint,
        paymentToken: a.paymentToken as Address,
        productId: a.productId as bigint,
        amount: a.amount as bigint
      };
    case "OrderPaid":
      return {
        ...ctx,
        kind: "OrderPaid",
        orderId: a.orderId as bigint,
        buyer: a.buyer as Address,
        paymentToken: a.paymentToken as Address,
        amount: a.amount as bigint
      };
    case "OrderShipped":
      return {
        ...ctx,
        kind: "OrderShipped",
        orderId: a.orderId as bigint,
        seller: a.seller as Address
      };
    case "OrderCompleted":
      return {
        ...ctx,
        kind: "OrderCompleted",
        orderId: a.orderId as bigint,
        seller: a.seller as Address,
        amount: a.amount as bigint
      };
    case "OrderCancelled":
      return { ...ctx, kind: "OrderCancelled", orderId: a.orderId as bigint };
    case "DisputeOpened":
      return {
        ...ctx,
        kind: "DisputeOpened",
        orderId: a.orderId as bigint,
        openedBy: a.openedBy as Address
      };
    case "DisputeResolved":
      return {
        ...ctx,
        kind: "DisputeResolved",
        orderId: a.orderId as bigint,
        refundBuyer: a.refundBuyer as boolean
      };
    case "OrderRefunded":
      return {
        ...ctx,
        kind: "OrderRefunded",
        orderId: a.orderId as bigint,
        buyer: a.buyer as Address,
        amount: a.amount as bigint
      };
    case "RevenueDistributed":
      return {
        ...ctx,
        kind: "RevenueDistributed",
        orderId: a.orderId as bigint,
        shopId: a.shopId as bigint,
        token: a.token as Address,
        fee: a.fee as bigint,
        sellerAmount: a.sellerAmount as bigint
      };
    default:
      // PaymentAuthExecuted / NonceInvalidated / AcceptedTokenUpdated
      // / FeeRateUpdated / FeeRecipientUpdated / DistributorUpdated /
      // Paused / Unpaused / Ownership* — admin or auxiliary events
      // that don't affect the order projection.
      return undefined;
  }
}
