import { decodeEventLog, type TransactionReceipt } from "viem";

import { escrowMarketplaceV2Abi } from "@/lib/contracts";

export function findCreatedOrderId(receipt: TransactionReceipt | undefined) {
  if (!receipt) {
    return undefined;
  }

  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi: escrowMarketplaceV2Abi,
        data: log.data,
        topics: log.topics
      });

      if (decoded.eventName === "OrderCreated") {
        const args = decoded.args as unknown as { orderId?: bigint };
        return args.orderId;
      }
    } catch {
      continue;
    }
  }

  return undefined;
}
