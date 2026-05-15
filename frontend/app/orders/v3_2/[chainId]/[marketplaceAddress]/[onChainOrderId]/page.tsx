"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatUnits, type Address } from "viem";

import { Card, EmptyState, SkeletonLine } from "@/components/Card";
import { OrderTimeline } from "@/components/order/OrderTimeline";
import { StatusBadge } from "@/components/order/StatusBadge";
import { ReputationBadge } from "@/components/reputation/ReputationBadge";
import { fetchOrderV3_2 } from "@/lib/api/orders";
import { getExplorerAddressUrl, getExplorerTxUrl } from "@/lib/chains";
import { getAcceptedTokens } from "@/lib/contractsV3_2";
import { formatAmount, formatTimestamp, OrderStatus, type OrderView } from "@/lib/order";
import { computeTimeline } from "@/lib/orderTimeline";
import type { ApiOrder, OrderStatusName } from "@/lib/orders";

// V3.2 order detail page. Self-contained renderer that hits the
// /api/orders/v3_2 cache (not on-chain). This route exists so the URL
// fully identifies the order — (chainId, marketplaceAddress, orderId) —
// removing the Phase B query-string disambiguation hack. Evidence/Kleros/
// shipping integrations are intentionally not wired up here yet; those
// belong to a future v3.2 deliverable.

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
const ORDER_STATUS_BY_NAME: Record<OrderStatusName, OrderStatus> = {
  Created: OrderStatus.Created,
  Paid: OrderStatus.Paid,
  Shipped: OrderStatus.Shipped,
  Completed: OrderStatus.Completed,
  Cancelled: OrderStatus.Cancelled,
  Disputed: OrderStatus.Disputed,
  Refunded: OrderStatus.Refunded
};

export default function OrderV3_2DetailPage() {
  const params = useParams<{ chainId: string; marketplaceAddress: string; onChainOrderId: string }>();
  const chainId = Number(params.chainId);
  const marketplaceAddress = params.marketplaceAddress;
  const onChainOrderId = params.onChainOrderId;

  const valid =
    Number.isInteger(chainId) &&
    chainId > 0 &&
    /^0x[0-9a-fA-F]{40}$/.test(marketplaceAddress) &&
    /^[0-9]+$/.test(onChainOrderId);

  const orderQuery = useQuery({
    queryKey: ["order:v3.2", chainId, marketplaceAddress.toLowerCase(), onChainOrderId],
    queryFn: () => fetchOrderV3_2(chainId, marketplaceAddress, onChainOrderId),
    enabled: valid,
    refetchInterval: 12_000,
    retry: false
  });

  const apiOrder = orderQuery.data;
  const view = useMemo<OrderView | undefined>(() => (apiOrder ? apiOrderToView(apiOrder) : undefined), [apiOrder]);
  const timeline = view ? computeTimeline(view) : [];
  const amountLabel = view ? formatV3_2Amount(view, chainId) : "-";

  if (!valid) {
    return <EmptyState title="Invalid order URL" body="URL must be /orders/v3_2/[chainId]/[marketplace]/[orderId]." />;
  }

  if (orderQuery.isLoading) {
    return (
      <Card>
        <SkeletonLine />
        <SkeletonLine className="mt-2 w-2/3" />
      </Card>
    );
  }

  if (!apiOrder || !view) {
    return (
      <div className="space-y-4">
        <Link href="/" className="text-sm text-blue-700 underline">
          Back home
        </Link>
        <EmptyState
          title="Order not found"
          body={`No v3.2 order found at chainId=${chainId}, marketplace=${marketplaceAddress}, id=${onChainOrderId}. The indexer may still be catching up.`}
        />
      </div>
    );
  }

  const buyer = view.buyer;
  const seller = view.seller;
  const paymentToken = view.paymentToken;
  const txUrl = getExplorerTxUrl(chainId, apiOrder.lastTxHash ?? undefined);

  return (
    <div className="space-y-6">
      <div>
        <Link href="/" className="text-sm text-blue-700 underline">
          Back home
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-slate-950">
          v3.2 Order #{onChainOrderId}
        </h1>
        <p className="mt-1 text-xs text-slate-500">
          {marketplaceAddress.toLowerCase()} on chain {chainId}
        </p>
      </div>

      <Card title={`Order #${onChainOrderId}`} action={<StatusBadge status={view.status} />}>
        <div className="flex flex-wrap items-center gap-3 text-sm text-slate-600">
          <span>{amountLabel}</span>
          <span>{formatTimestamp(view.createdAt)}</span>
          {txUrl ? (
            <a href={txUrl} target="_blank" rel="noreferrer" className="text-blue-700 underline">
              Last tx ↗
            </a>
          ) : null}
        </div>
      </Card>

      <Card title="进度时间线">
        <OrderTimeline stages={timeline} />
      </Card>

      <Card title="Order details" action={<StatusBadge status={view.status} />}>
        <div className="grid gap-3 text-sm md:grid-cols-2">
          <PartyInfo label="Buyer" address={buyer} chainId={chainId} />
          <PartyInfo label="Seller" address={seller} chainId={chainId} />
          <Info label="Product ID" value={view.productId.toString()} />
          <Info label="Amount" value={amountLabel} />
          {paymentToken && paymentToken !== ZERO_ADDRESS ? (
            <Info
              label="Payment token"
              value={paymentToken}
              href={getExplorerAddressUrl(chainId, paymentToken)}
            />
          ) : (
            <Info label="Payment" value="Native ETH" />
          )}
          <Info label="Created" value={formatTimestamp(view.createdAt)} />
          <Info label="Paid" value={formatTimestamp(view.paidAt)} />
          <Info label="Shipped" value={formatTimestamp(view.shippedAt)} />
          <Info label="Completed" value={formatTimestamp(view.completedAt)} />
        </div>
        {orderQuery.isFetching ? <p className="mt-3 text-xs text-slate-500">Refreshing...</p> : null}
      </Card>
    </div>
  );
}

function apiOrderToView(api: ApiOrder): OrderView {
  const toUnix = (iso: string | null): bigint => {
    if (!iso) return 0n;
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) return 0n;
    return BigInt(Math.floor(ms / 1000));
  };
  return {
    id: BigInt(api.onChainOrderId),
    buyer: api.buyer as Address,
    status: ORDER_STATUS_BY_NAME[api.status],
    createdAt: toUnix(api.createdAt),
    seller: api.seller as Address,
    paidAt: toUnix(api.paidAt),
    productId: BigInt(api.productId),
    amount: BigInt(api.amountWei),
    shippedAt: toUnix(api.shippedAt),
    completedAt: toUnix(api.completedAt),
    paymentToken: api.paymentToken as Address | undefined
  };
}

function formatV3_2Amount(view: OrderView, chainId: number): string {
  if (view.paymentToken && view.paymentToken !== ZERO_ADDRESS) {
    const token = getAcceptedTokens(chainId).find(
      (t) => t.address.toLowerCase() === view.paymentToken!.toLowerCase()
    );
    if (token) return `${formatUnits(view.amount, token.decimals)} ${token.symbol}`;
    return `${view.amount.toString()} (token ${view.paymentToken})`;
  }
  return `${formatAmount(view.amount)} ETH`;
}

function Info({ label, value, href }: { label: string; value: string; href?: string }) {
  return (
    <div className="rounded-md bg-slate-50 p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      {href ? (
        <a href={href} target="_blank" rel="noreferrer" className="mt-1 block break-all text-blue-700 underline">
          {value}
        </a>
      ) : (
        <p className="mt-1 break-all text-slate-950">{value}</p>
      )}
    </div>
  );
}

function PartyInfo({ label, address, chainId }: { label: string; address: string; chainId: number }) {
  const href = getExplorerAddressUrl(chainId, address);
  return (
    <div className="rounded-md bg-slate-50 p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      {href ? (
        <a href={href} target="_blank" rel="noreferrer" className="mt-1 block break-all text-blue-700 underline">
          {address}
        </a>
      ) : (
        <p className="mt-1 break-all text-slate-950">{address}</p>
      )}
      <div className="mt-2">
        <ReputationBadge sellerAddress={address as Address} variant="compact" />
      </div>
    </div>
  );
}
