// V3.2 marketplace event decoder. Separate from eventDecoder.ts because
// V3.2's OrderCreated event carries an extra `paymentToken` argument
// (different topic hash from V3/V3.1) and OrderPaid carries paymentToken
// in its data payload. Keeping a parallel decoder avoids regressing the
// V3/V3.1 path while letting us capture the v3.2-specific fields cleanly.

import type { Abi } from "viem";
import { decodeEventLog, type Address } from "viem";

import escrowMarketplaceERC20AbiJson from "../../abi/EscrowMarketplaceERC20.json";
import type { IndexedLog } from "./eventDecoder";

export type DecodedEventV3_2 =
  | (EventBase<"Created"> & {
      buyer: Address;
      seller: Address;
      paymentToken: Address;
      productId: bigint;
      amount: bigint;
    })
  | (EventBase<"Paid"> & { paymentToken: Address; amount: bigint })
  | EventBase<"Shipped">
  | (EventBase<"Completed"> & { amount: bigint })
  | EventBase<"Cancelled">
  | EventBase<"Disputed">
  | EventBase<"Resolved">
  | (EventBase<"Refunded"> & { amount: bigint });

type EventBase<TKind extends string> = {
  kind: TKind;
  orderId: bigint;
  blockTimestamp: bigint;
  blockNumber: bigint;
  logIndex: number;
  txHash: string;
};

type EventArgs = Record<string, unknown>;

const abi = escrowMarketplaceERC20AbiJson as Abi;

export function decodeLogsV3_2(logs: IndexedLog[], blockTimestampByNumber: Map<bigint, bigint>) {
  const decoded: DecodedEventV3_2[] = [];

  for (const log of logs) {
    const event = decodeOne(log, blockTimestampByNumber.get(log.blockNumber));
    if (event !== undefined) {
      decoded.push(event);
    }
  }

  return decoded.sort(compareDecoded);
}

export function compareDecodedV3_2(a: DecodedEventV3_2, b: DecodedEventV3_2) {
  return compareDecoded(a, b);
}

function compareDecoded(a: DecodedEventV3_2, b: DecodedEventV3_2) {
  if (a.blockNumber !== b.blockNumber) {
    return a.blockNumber < b.blockNumber ? -1 : 1;
  }
  return a.logIndex - b.logIndex;
}

function decodeOne(log: IndexedLog, blockTimestamp: bigint | undefined): DecodedEventV3_2 | undefined {
  if (blockTimestamp === undefined) {
    throw new Error(`Missing timestamp for block ${log.blockNumber}`);
  }

  try {
    const decoded = decodeEventLog({ abi, data: log.data, topics: log.topics });
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
          paymentToken: args.paymentToken as Address,
          productId: toBigInt(args.productId),
          amount: toBigInt(args.amount)
        };
      case "OrderPaid":
        return {
          ...base,
          kind: "Paid",
          paymentToken: args.paymentToken as Address,
          amount: toBigInt(args.amount)
        };
      case "OrderShipped":
        return { ...base, kind: "Shipped" };
      case "OrderCompleted":
        return { ...base, kind: "Completed", amount: toBigInt(args.amount) };
      case "OrderCancelled":
        return { ...base, kind: "Cancelled" };
      case "DisputeOpened":
        return { ...base, kind: "Disputed" };
      case "DisputeResolved":
        return { ...base, kind: "Resolved" };
      case "OrderRefunded":
        return { ...base, kind: "Refunded", amount: toBigInt(args.amount) };
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

function toBigInt(value: unknown) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" || typeof value === "string") return BigInt(value);
  throw new Error("Expected bigint-like event argument");
}
