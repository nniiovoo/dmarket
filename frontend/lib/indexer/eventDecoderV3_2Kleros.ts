// V3.2 Kleros adapter event decoder. Independent from
// eventDecoderV3_2.ts because the adapter is a separate contract (with a
// separate ABI + event topic hashes). Captures only the events the
// adapter indexer needs; everything else (Dispute, Ruling proxies,
// MarketplaceCallExecuted, etc.) is silently dropped.

import type { Abi } from "viem";
import { decodeEventLog, type Address } from "viem";

import klerosAdapterAbiJson from "../../abi/KlerosV2DisputeAdapterV3_2.json";
import type { IndexedLog } from "./eventDecoder";

export type DecodedAdapterEvent =
  | (EventBase<"Escalated"> & { klerosDisputeId: bigint; by: Address; feePaid: bigint })
  | (EventBase<"Ruled"> & { klerosDisputeId: bigint; ruling: bigint })
  | (EventBase<"RulingDeferred"> & { klerosDisputeId: bigint; ruling: bigint; reason: string })
  | (EventBase<"EmergencyProposed"> & { refundBuyer: boolean; unlocksAt: bigint })
  | (EventBase<"EmergencyExecuted"> & { refundBuyer: boolean })
  | EventBase<"EmergencyCancelled">;

type EventBase<TKind extends string> = {
  kind: TKind;
  orderId: bigint;
  blockTimestamp: bigint;
  blockNumber: bigint;
  logIndex: number;
  txHash: string;
};

type EventArgs = Record<string, unknown>;

const abi = klerosAdapterAbiJson as Abi;

export function decodeAdapterLogs(
  logs: IndexedLog[],
  blockTimestampByNumber: Map<bigint, bigint>
): DecodedAdapterEvent[] {
  const decoded: DecodedAdapterEvent[] = [];
  for (const log of logs) {
    const event = decodeOne(log, blockTimestampByNumber.get(log.blockNumber));
    if (event !== undefined) decoded.push(event);
  }
  return decoded.sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
    return a.logIndex - b.logIndex;
  });
}

function decodeOne(log: IndexedLog, blockTimestamp: bigint | undefined): DecodedAdapterEvent | undefined {
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
      case "DisputeEscalated":
        return {
          ...base,
          kind: "Escalated",
          klerosDisputeId: toBigInt(args.klerosDisputeId),
          by: args.by as Address,
          feePaid: toBigInt(args.feePaid)
        };
      case "DisputeRuled":
        return {
          ...base,
          kind: "Ruled",
          klerosDisputeId: toBigInt(args.klerosDisputeId),
          ruling: toBigInt(args.ruling)
        };
      case "RulingDeferred":
        return {
          ...base,
          kind: "RulingDeferred",
          klerosDisputeId: toBigInt(args.klerosDisputeId),
          ruling: toBigInt(args.ruling),
          reason: String(args.reason ?? "")
        };
      case "EmergencyRefundProposed":
        return {
          ...base,
          kind: "EmergencyProposed",
          refundBuyer: Boolean(args.refundBuyer),
          unlocksAt: toBigInt(args.unlocksAt)
        };
      case "EmergencyRefundExecuted":
        return {
          ...base,
          kind: "EmergencyExecuted",
          refundBuyer: Boolean(args.refundBuyer)
        };
      case "EmergencyRefundCancelled":
        return { ...base, kind: "EmergencyCancelled" };
      default:
        // Other adapter events (Dispute / Ruling ERC-792 proxies,
        // RefundWithdrawn, MarketplaceCallExecuted, etc.) are ignored —
        // they don't change order-side state.
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
