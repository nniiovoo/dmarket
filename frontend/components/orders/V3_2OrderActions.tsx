"use client";

import { useRouter } from "next/navigation";
import { useCallback } from "react";
import type { Address } from "viem";

import { TxPanel } from "@/components/TxPanel";
import { escrowMarketplaceERC20Abi } from "@/lib/contractsV3_2";
import { OrderStatus } from "@/lib/order";
import { useOrderRole, type OrderRole } from "@/lib/v3_2/useOrderRole";

type Props = {
  order: { buyer: Address; seller: Address; onChainOrderId: string; status: OrderStatus };
  chainId: number;
  marketplaceAddress: Address;
};

// Lifecycle actions for a v3.2 order: cancelOrder / markShipped /
// confirmReceived / openDispute. Disputed and terminal states render
// nothing — Kleros escalation has its own panel, and terminal orders
// have no further on-chain action.
export function V3_2OrderActions({ order, chainId, marketplaceAddress }: Props) {
  const router = useRouter();
  const { role } = useOrderRole({ buyer: order.buyer, seller: order.seller });

  // router.refresh re-runs the page's server data + remounts client
  // queries (react-query's useQuery picks up the new server snapshot).
  // We defer a few seconds so the indexer has a chance to ingest the
  // event before refresh.
  const onConfirmed = useCallback(() => {
    setTimeout(() => router.refresh(), 5_000);
  }, [router]);

  const actions = pickActions(order.status, role);
  if (actions.length === 0) return null;

  const orderIdBigInt = BigInt(order.onChainOrderId);

  return (
    <div className="space-y-3">
      {actions.map((action) => (
        <TxPanel
          key={action.functionName}
          label={action.label}
          description={action.description}
          buildTransaction={() => ({
            address: marketplaceAddress,
            abi: escrowMarketplaceERC20Abi,
            chainId,
            functionName: action.functionName,
            args: [orderIdBigInt]
          })}
          onConfirmed={onConfirmed}
        />
      ))}
    </div>
  );
}

type ActionDescriptor = {
  functionName: "cancelOrder" | "markShipped" | "confirmReceived" | "openDispute";
  label: string;
  description: string;
};

function pickActions(status: OrderStatus, role: OrderRole): ActionDescriptor[] {
  if (role === "observer") return [];

  switch (status) {
    case OrderStatus.Created:
      if (role === "buyer") {
        return [
          {
            functionName: "cancelOrder",
            label: "Cancel order",
            description: "Cancel before paying. Only valid while the order is still Created."
          }
        ];
      }
      return [];
    case OrderStatus.Paid:
      if (role === "seller") {
        return [
          {
            functionName: "markShipped",
            label: "Mark shipped",
            description: "Confirm you've dispatched the goods. Buyer can then release funds by confirming receipt."
          }
        ];
      }
      return [];
    case OrderStatus.Shipped:
      if (role === "buyer") {
        return [
          {
            functionName: "confirmReceived",
            label: "Confirm received",
            description: "Confirms delivery and releases funds to the seller. Cannot be undone."
          },
          {
            functionName: "openDispute",
            label: "Open dispute",
            description: "Locks the order in Disputed state. Either party can then escalate to Kleros for binding arbitration."
          }
        ];
      }
      if (role === "seller") {
        return [
          {
            functionName: "openDispute",
            label: "Open dispute",
            description: "Locks the order in Disputed state. Either party can then escalate to Kleros for binding arbitration."
          }
        ];
      }
      return [];
    default:
      // Disputed → handled by V3_2KlerosSection.
      // Completed / Cancelled / Refunded → terminal, no action.
      return [];
  }
}
