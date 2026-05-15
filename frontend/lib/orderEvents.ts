import { decodeEventLog, type TransactionReceipt } from "viem";

import { escrowMarketplaceV2Abi } from "@/lib/contracts";
import { escrowMarketplaceERC20Abi } from "@/lib/contractsV3_2";

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

// v3.2 OrderCreated has an extra `paymentToken` arg so its event topic hash
// differs from v2/v3/v3.1. Decode against the v3.2 ABI separately.
export function findCreatedOrderIdV3_2(receipt: TransactionReceipt | undefined) {
  if (!receipt) {
    return undefined;
  }

  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi: escrowMarketplaceERC20Abi,
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
