import { decodeEventLog, type Abi, type Address } from "viem";

import evidenceRegistryV3AbiJson from "../../abi/EvidenceRegistryV3.json";
import { type IndexedLog } from "./eventDecoder";

const evidenceRegistryV3Abi = evidenceRegistryV3AbiJson as Abi;

type EvidenceBase<TKind extends string> = {
  kind: TKind;
  orderId: bigint;
  blockTimestamp: bigint;
  blockNumber: bigint;
  logIndex: number;
  txHash: string;
};

export type DecodedEvidenceEvent =
  | (EvidenceBase<"EvidenceSubmitted"> & {
      evidenceIndex: bigint;
      party: Address;
      evidenceURI: string;
      contentHash: string;
      marketplaceDeliveredAtSnapshot: bigint;
    })
  | (EvidenceBase<"OracleRequested"> & {
      evidenceIndex: bigint;
      requestId: string;
    })
  | (EvidenceBase<"OracleFulfilled"> & {
      evidenceIndex: bigint;
      delivered: boolean;
      deliveredTimestamp: bigint;
    })
  | (EvidenceBase<"OracleFailed"> & {
      evidenceIndex: bigint;
      reason: string;
    });

export function decodeEvidenceLogs(
  logs: IndexedLog[],
  blockTimestampByNumber: Map<bigint, bigint>
): DecodedEvidenceEvent[] {
  const events: DecodedEvidenceEvent[] = [];

  type DecodedRaw = {
    log: IndexedLog;
    eventName: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args: Record<string, any>;
  };

  const decoded: (DecodedRaw | null)[] = logs.map((log) => {
    try {
      const result = decodeEventLog({
        abi: evidenceRegistryV3Abi,
        data: log.data,
        topics: log.topics
      });
      return {
        log,
        eventName: result.eventName as unknown as string,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        args: (result.args ?? {}) as Record<string, any>
      };
    } catch {
      return null;
    }
  });

  for (let i = 0; i < decoded.length; i++) {
    const item = decoded[i];
    if (item === null) continue;

    const { log, eventName, args } = item;
    const blockTimestamp = blockTimestampByNumber.get(log.blockNumber);
    if (blockTimestamp === undefined) {
      throw new Error(`Missing timestamp for block ${log.blockNumber}`);
    }
    const base = {
      orderId: toBigInt(args.orderId ?? args._evidenceGroupID),
      blockTimestamp,
      blockNumber: log.blockNumber,
      logIndex: log.logIndex,
      txHash: log.transactionHash as string
    };

    switch (eventName) {
      case "EvidenceRecorded": {
        let evidenceURI = "";
        const prev = i > 0 ? decoded[i - 1] : null;
        if (
          prev !== null &&
          prev.eventName === "Evidence" &&
          prev.log.transactionHash === log.transactionHash
        ) {
          evidenceURI = String(prev.args._evidence ?? "");
        }

        events.push({
          ...base,
          kind: "EvidenceSubmitted",
          evidenceIndex: toBigInt(args.evidenceIndex),
          party: args.party as Address,
          evidenceURI,
          contentHash: String(args.contentHash),
          marketplaceDeliveredAtSnapshot: toBigInt(args.marketplaceDeliveredAtSnapshot)
        });
        break;
      }
      case "OracleQueryRequested": {
        events.push({
          ...base,
          kind: "OracleRequested",
          evidenceIndex: toBigInt(args.evidenceIndex),
          requestId: String(args.requestId)
        });
        break;
      }
      case "OracleQueryFulfilled": {
        events.push({
          ...base,
          kind: "OracleFulfilled",
          evidenceIndex: toBigInt(args.evidenceIndex),
          delivered: Boolean(args.delivered),
          deliveredTimestamp: toBigInt(args.deliveredTimestamp)
        });
        break;
      }
      case "OracleQueryFailed": {
        events.push({
          ...base,
          kind: "OracleFailed",
          evidenceIndex: toBigInt(args.evidenceIndex),
          reason: String(args.reason)
        });
        break;
      }
      default:
        break;
    }
  }

  return events;
}

function toBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" || typeof value === "string") return BigInt(value);
  throw new Error("Expected bigint-like event argument");
}
