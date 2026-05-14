import type { Abi, Log } from "viem";
import { decodeEventLog, type Address } from "viem";

import escrowMarketplaceV3AbiJson from "../../abi/EscrowMarketplaceV3.json";

export type IndexedLog = Log & {
  blockNumber: bigint;
  logIndex: number;
  transactionHash: `0x${string}`;
};

export type DecodedEvent =
  | EventBase<"Created"> & {
      buyer: Address;
      seller: Address;
      productId: bigint;
      amount: bigint;
    }
  | EventBase<"Paid">
  | EventBase<"Shipped">
  | EventBase<"Completed">
  | EventBase<"Cancelled">
  | EventBase<"Disputed">
  | EventBase<"Resolved">
  | EventBase<"Refunded">;

type EventBase<TKind extends string> = {
  kind: TKind;
  orderId: bigint;
  blockTimestamp: bigint;
  blockNumber: bigint;
  logIndex: number;
  txHash: string;
};

type EventArgs = Record<string, unknown>;

const escrowMarketplaceAbi = escrowMarketplaceV3AbiJson as Abi;

export function decodeLogs(logs: IndexedLog[], blockTimestampByNumber: Map<bigint, bigint>) {
  const decoded: DecodedEvent[] = [];

  for (const log of logs) {
    const event = decodeIndexerLog(log, blockTimestampByNumber.get(log.blockNumber));

    if (event !== undefined) {
      decoded.push(event);
    }
  }

  return decoded.sort(compareDecodedEvents);
}

export function compareLogs(a: IndexedLog, b: IndexedLog) {
  if (a.blockNumber !== b.blockNumber) {
    return a.blockNumber < b.blockNumber ? -1 : 1;
  }

  return a.logIndex - b.logIndex;
}

export function compareDecodedEvents(a: DecodedEvent, b: DecodedEvent) {
  if (a.blockNumber !== b.blockNumber) {
    return a.blockNumber < b.blockNumber ? -1 : 1;
  }

  return a.logIndex - b.logIndex;
}

function decodeIndexerLog(log: IndexedLog, blockTimestamp: bigint | undefined): DecodedEvent | undefined {
  if (blockTimestamp === undefined) {
    throw new Error(`Missing timestamp for block ${log.blockNumber}`);
  }

  try {
    const decoded = decodeEventLog({
      abi: escrowMarketplaceAbi,
      data: log.data,
      topics: log.topics
    });
    const eventName = decoded.eventName as unknown as string;
    const args = (decoded.args ?? {}) as unknown as EventArgs;
    const base = {
      orderId: toBigInt(args.orderId),
      blockTimestamp,
      blockNumber: log.blockNumber,
      logIndex: log.logIndex,
      txHash: log.transactionHash
    };

    switch (eventName) {
      case "OrderCreated":
        return {
          ...base,
          kind: "Created",
          buyer: args.buyer as Address,
          seller: args.seller as Address,
          productId: toBigInt(args.productId),
          amount: toBigInt(args.amount)
        };
      case "OrderPaid":
        return { ...base, kind: "Paid" };
      case "OrderShipped":
        return { ...base, kind: "Shipped" };
      case "OrderCompleted":
        return { ...base, kind: "Completed" };
      case "OrderCancelled":
        return { ...base, kind: "Cancelled" };
      case "DisputeOpened":
        return { ...base, kind: "Disputed" };
      case "DisputeResolved":
        return { ...base, kind: "Resolved" };
      case "OrderRefunded":
      case "OrderEmergencyRefunded":
        return { ...base, kind: "Refunded" };
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

function toBigInt(value: unknown) {
  if (typeof value === "bigint") {
    return value;
  }

  if (typeof value === "number" || typeof value === "string") {
    return BigInt(value);
  }

  throw new Error("Expected bigint-like event argument");
}
