"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";

import { EmptyState, SkeletonLine } from "@/components/Card";
import { QuickShipButton } from "@/components/seller/QuickShipButton";
import { fetchSellerOrders } from "@/lib/api/seller";

export function PendingOrdersList({ seller, chainId, enabled }: { seller: string | undefined; chainId: number; enabled: boolean }) {
  const pendingQuery = useQuery({
    queryKey: ["seller", "orders", seller, chainId, "Paid"],
    queryFn: () => fetchSellerOrders({ seller: seller ?? "", chainId, status: "Paid" }),
    enabled: enabled && seller !== undefined,
    refetchInterval: 15_000
  });

  if (!enabled || seller === undefined) {
    return <EmptyState title="Wallet required" body="Connect a seller wallet on Sepolia or Amoy." />;
  }

  if (pendingQuery.isLoading) {
    return (
      <div className="space-y-2">
        <SkeletonLine />
        <SkeletonLine className="w-2/3" />
      </div>
    );
  }

  if (pendingQuery.isError) {
    return <EmptyState title="Could not load pending orders" body="Make sure the order indexer has run." />;
  }

  if ((pendingQuery.data?.orders.length ?? 0) === 0) {
    return <EmptyState title="No pending shipments" body="暂时没有待发货订单." />;
  }

  return (
    <div className="space-y-3">
      {pendingQuery.data?.orders.map((order) => (
        <div key={`${order.chainId}:${order.onChainOrderId}`} className="rounded-md border border-slate-200 p-3">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)]">
            <Link href={`/orders/${order.onChainOrderId}`} className="grid grid-cols-[4rem_minmax(0,1fr)] gap-3">
              <div className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-md bg-slate-100 text-xs text-slate-500">
                {order.product?.imageUrl ? (
                  <div
                    aria-label={order.product.name}
                    className="h-full w-full bg-cover bg-center"
                    role="img"
                    style={{ backgroundImage: `url("${order.product.imageUrl}")` }}
                  />
                ) : (
                  <span>No image</span>
                )}
              </div>
              <div className="min-w-0">
                <p className="truncate font-medium text-slate-950">{order.product?.name ?? "Product not found"}</p>
                <p className="mt-1 text-sm text-slate-500">
                  Order #{order.onChainOrderId} · Buyer {shortAddress(order.buyer)}
                </p>
                <p className="mt-1 text-xs text-slate-500">Paid {timeAgo(order.paidAt)}</p>
              </div>
            </Link>
            <QuickShipButton order={order} sellerAddress={seller} />
          </div>
        </div>
      ))}
    </div>
  );
}

function shortAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function timeAgo(value: string | null) {
  if (!value) {
    return "-";
  }

  const elapsed = Date.now() - new Date(value).getTime();
  const minutes = Math.max(1, Math.floor(elapsed / 60_000));

  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }

  return `${Math.floor(hours / 24)}d ago`;
}
