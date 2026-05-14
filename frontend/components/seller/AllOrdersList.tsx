"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { EmptyState, SkeletonLine } from "@/components/Card";
import { OrderCard } from "@/components/OrderCard";
import { fetchSellerOrders } from "@/lib/api/seller";
import type { ApiOrder, OrderStatusName } from "@/lib/orders";

const groups: Array<{ id: string; title: string; statuses: OrderStatusName[]; initiallyOpen: boolean }> = [
  { id: "active", title: "In progress", statuses: ["Paid", "Shipped", "Disputed"], initiallyOpen: true },
  { id: "completed", title: "Completed", statuses: ["Completed"], initiallyOpen: false },
  { id: "cancelled", title: "Cancelled", statuses: ["Cancelled"], initiallyOpen: false },
  { id: "refunded", title: "Refunded", statuses: ["Refunded"], initiallyOpen: false }
];

export function AllOrdersList({ seller, chainId, enabled }: { seller: string | undefined; chainId: number; enabled: boolean }) {
  const [openGroups, setOpenGroups] = useState(() => new Set(groups.filter((group) => group.initiallyOpen).map((group) => group.id)));
  const ordersQuery = useQuery({
    queryKey: ["seller", "orders", seller, chainId, "all"],
    queryFn: () => fetchSellerOrders({ seller: seller ?? "", chainId }),
    enabled: enabled && seller !== undefined,
    refetchInterval: 15_000
  });

  if (!enabled || seller === undefined) {
    return <EmptyState title="Wallet required" body="Connect a seller wallet on a supported chain." />;
  }

  if (ordersQuery.isLoading) {
    return (
      <div className="space-y-2">
        <SkeletonLine />
        <SkeletonLine className="w-2/3" />
      </div>
    );
  }

  if (ordersQuery.isError) {
    return <EmptyState title="Could not load orders" body="Make sure the order indexer has run." />;
  }

  const orders = ordersQuery.data?.orders ?? [];

  if (orders.length === 0) {
    return <EmptyState title="No orders yet" body="Orders for your products will appear here after buyers check out." />;
  }

  return (
    <div className="space-y-3">
      {groups.map((group) => {
        const groupedOrders = orders.filter((order) => group.statuses.includes(order.status));
        const open = openGroups.has(group.id);

        return (
          <section key={group.id} className="rounded-md border border-slate-200">
            <button
              type="button"
              onClick={() => {
                setOpenGroups((current) => {
                  const next = new Set(current);
                  if (next.has(group.id)) {
                    next.delete(group.id);
                  } else {
                    next.add(group.id);
                  }
                  return next;
                });
              }}
              className="flex w-full items-center justify-between px-4 py-3 text-left"
            >
              <span className="font-medium text-slate-950">{group.title}</span>
              <span className="text-sm text-slate-500">{groupedOrders.length}</span>
            </button>
            {open ? (
              <div className="space-y-3 border-t border-slate-100 p-3">
                {groupedOrders.length === 0 ? (
                  <p className="text-sm text-slate-500">No orders in this group.</p>
                ) : (
                  groupedOrders.map((order) => <SellerOrderCard key={`${order.chainId}:${order.onChainOrderId}`} order={order} />)
                )}
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

function SellerOrderCard({ order }: { order: ApiOrder }) {
  return (
    <OrderCard
      chainId={order.chainId}
      onChainOrderId={order.onChainOrderId}
      status={order.status}
      amountWei={order.amountWei}
      product={order.product}
    />
  );
}
