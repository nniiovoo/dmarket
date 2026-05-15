"use client";

import type { Address } from "viem";
import { useAccount } from "wagmi";

// Roles the v3.2 order page recognises. `admin` is intentionally absent:
// admin actions surface through the dedicated /admin section (Phase F),
// not through the order detail page.
export type OrderRole = "buyer" | "seller" | "observer";

export function useOrderRole(order: { buyer: Address; seller: Address }): {
  role: OrderRole;
  connectedAddress: Address | undefined;
} {
  const { address } = useAccount();
  const lower = address?.toLowerCase();

  let role: OrderRole = "observer";
  if (lower !== undefined) {
    if (lower === order.buyer.toLowerCase()) role = "buyer";
    else if (lower === order.seller.toLowerCase()) role = "seller";
  }

  return { role, connectedAddress: address };
}
