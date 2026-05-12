"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount, useChainId, useReadContract } from "wagmi";

import { Card, EmptyState, SkeletonLine } from "@/components/Card";
import { NetworkNotice } from "@/components/NetworkNotice";
import { LockedActions } from "@/components/order/LockedActions";
import { OrderActions as RoleOrderActions } from "@/components/order/OrderActions";
import { OrderTimeline } from "@/components/order/OrderTimeline";
import { StatusBadge } from "@/components/order/StatusBadge";
import { OrderProcessingHint } from "@/components/OrderProcessingHint";
import { ShipWithTrackingDialog } from "@/components/seller/ShipWithTrackingDialog";
import { TrackingLink } from "@/components/TrackingLink";
import { TxPanel } from "@/components/TxPanel";
import { fetchOrder } from "@/lib/api/orders";
import { getExplorerAddressUrl } from "@/lib/chains";
import { escrowMarketplaceV2Abi, escrowVaultAbi, getContractAddresses, isSupportedChain } from "@/lib/contracts";
import { formatAmount, formatTimestamp, normalizeOrder, OrderStatus } from "@/lib/order";
import { computeActions, getRole, type AvailableAction } from "@/lib/orderPermissions";
import { computeTimeline } from "@/lib/orderTimeline";
import type { ApiOrder } from "@/lib/orders";

const refetchInterval = 12_000;

export default function OrderDetailPage() {
  const params = useParams<{ orderId: string }>();
  const router = useRouter();
  const [showShipDialog, setShowShipDialog] = useState(false);
  const orderId = useMemo(() => parseOrderId(params.orderId), [params.orderId]);
  const chainId = useChainId();
  const { address, isConnected } = useAccount();
  const contracts = getContractAddresses(chainId);
  const supported = isSupportedChain(chainId);

  const orderQuery = useReadContract({
    address: contracts?.marketplace,
    abi: escrowMarketplaceV2Abi,
    functionName: "getOrder",
    args: orderId === undefined ? undefined : [orderId],
    query: { enabled: supported && orderId !== undefined, refetchInterval, retry: false }
  });

  const vaultQuery = useReadContract({
    address: contracts?.vault,
    abi: escrowVaultAbi,
    functionName: "lockedAmount",
    args: orderId === undefined ? undefined : [orderId],
    query: { enabled: supported && orderId !== undefined, refetchInterval }
  });

  const ownerQuery = useReadContract({
    address: contracts?.marketplace,
    abi: escrowMarketplaceV2Abi,
    functionName: "owner",
    query: { enabled: supported, refetchInterval }
  });

  const orderApi = useQuery({
    queryKey: ["order", chainId, orderId?.toString()],
    queryFn: () => fetchOrder(chainId, orderId?.toString() ?? ""),
    enabled: supported && orderId !== undefined,
    refetchInterval,
    retry: false
  });

  const order = normalizeOrder(orderQuery.data);
  const lockedAmount = vaultQuery.data as bigint | undefined;
  const owner = ownerQuery.data as string | undefined;
  const role =
    order === undefined
      ? "stranger"
      : getRole({
          connectedAddress: address,
          orderBuyer: order.buyer,
          orderSeller: order.seller,
          contractOwner: owner
        });
  const actions =
    order === undefined
      ? { available: [], locked: [] }
      : computeActions({
          role,
          status: order.status,
          amountLabel: `${formatAmount(order.amount)} ETH / MATIC`
        });
  const timeline = order === undefined ? [] : computeTimeline(order);

  function refetchAll() {
    void orderQuery.refetch();
    void vaultQuery.refetch();
    void ownerQuery.refetch();
    void orderApi.refetch();
  }

  return (
    <div className="space-y-6">
      <NetworkNotice />
      <div>
        <Link href="/" className="text-sm text-blue-700 underline">
          Back home
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-slate-950">Order #{params.orderId}</h1>
      </div>

      {!isConnected ? (
        <EmptyState title="Connect wallet" body="Connect a wallet to read and act on this order." />
      ) : !supported ? (
        <EmptyState title="Unsupported network" body="Switch to Sepolia or Polygon Amoy." />
      ) : orderId === undefined ? (
        <EmptyState title="Invalid order ID" body="Use a positive numeric order ID." />
      ) : orderQuery.isLoading ? (
        <Card>
          <SkeletonLine />
          <SkeletonLine className="mt-2 w-2/3" />
        </Card>
      ) : order === undefined || orderQuery.isError ? (
        <EmptyState title="Order not found" body="This order ID does not exist on the selected network." />
      ) : (
        <>
          {orderApi.isLoading || orderApi.isError ? (
            <Card title="On-chain confirmation" action={<StatusBadge status={order.status} />}>
              <p className="text-sm text-slate-700">Order #{orderId.toString()} is confirmed on-chain. Product details are still syncing from the indexer.</p>
              <OrderProcessingHint />
            </Card>
          ) : null}
          <Card title={`Order #${orderId.toString()}`} action={<StatusBadge status={order.status} />}>
            <div className="flex flex-wrap items-center gap-3 text-sm text-slate-600">
              <span>{formatAmount(order.amount)} ETH / MATIC</span>
              <span>{formatTimestamp(order.createdAt)}</span>
            </div>
          </Card>
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,24rem)]">
            <Card title="进度时间线">
              <OrderTimeline stages={timeline} connectedAddress={address} />
            </Card>
            <div className="space-y-4">
              <RoleOrderActions
                available={actions.available}
                role={role}
                renderAction={(action) => (
                  <ActionExecutor
                    action={action}
                    order={order}
                    apiOrder={orderApi.data}
                    orderId={orderId}
                    marketplaceAddress={contracts?.marketplace}
                    onConfirmed={refetchAll}
                    onOpenShipDialog={() => setShowShipDialog(true)}
                  />
                )}
              />
              <LockedActions locked={actions.locked} />
            </div>
          </div>
          <ProductSection order={orderApi.data} isLoading={orderApi.isLoading} isSyncing={orderApi.isError} />
          <Card title="Order details" action={<StatusBadge status={order.status} />}>
            <div className="grid gap-3 text-sm md:grid-cols-2">
              <Info label="Buyer" value={order.buyer} href={getExplorerAddressUrl(chainId, order.buyer)} />
              <Info label="Seller" value={order.seller} href={getExplorerAddressUrl(chainId, order.seller)} />
              <Info label="Product ID" value={order.productId.toString()} />
              <Info label="Amount" value={`${formatAmount(order.amount)} ETH / MATIC`} />
              <Info label="Locked in vault" value={`${formatAmount(lockedAmount)} ETH / MATIC`} />
              <Info label="Created" value={formatTimestamp(order.createdAt)} />
              <Info label="Paid" value={formatTimestamp(order.paidAt)} />
              <Info label="Shipped" value={formatTimestamp(order.shippedAt)} />
              <Info label="Completed" value={formatTimestamp(order.completedAt)} />
            </div>
            {orderQuery.isFetching || vaultQuery.isFetching ? <p className="mt-3 text-xs text-slate-500">Refreshing...</p> : null}
          </Card>
          <ShippingSection order={orderApi.data} status={order.status} isLoading={orderApi.isLoading} isSyncing={orderApi.isError} />
          {showShipDialog ? (
            <ShipWithTrackingDialog
              order={toApiOrder(orderApi.data, order, chainId)}
              sellerAddress={order.seller}
              onClose={() => {
                setShowShipDialog(false);
                refetchAll();
                router.push("/seller");
              }}
            />
          ) : null}
        </>
      )}
    </div>
  );
}

function ShippingSection({
  order,
  status,
  isLoading,
  isSyncing
}: {
  order: ApiOrder | undefined;
  status: OrderStatus;
  isLoading: boolean;
  isSyncing: boolean;
}) {
  if (![OrderStatus.Shipped, OrderStatus.Completed, OrderStatus.Disputed, OrderStatus.Refunded].includes(status)) {
    return null;
  }

  return (
    <Card title="Shipping">
      {isLoading ? (
        <div className="space-y-2">
          <SkeletonLine />
          <SkeletonLine className="w-2/3" />
        </div>
      ) : isSyncing ? (
        <>
          <p className="text-sm text-slate-500">Shipping details are waiting for the indexer API.</p>
          <OrderProcessingHint />
        </>
      ) : (
        <TrackingLink
          carrier={order?.carrier ?? null}
          trackingNumber={order?.trackingNumber ?? null}
          trackingUrl={order?.trackingUrl ?? null}
          shippingNote={order?.shippingNote ?? null}
        />
      )}
    </Card>
  );
}

function ProductSection({ order, isLoading, isSyncing }: { order: ApiOrder | undefined; isLoading: boolean; isSyncing: boolean }) {
  if (isLoading || isSyncing) {
    return (
      <Card title="Product">
        {isLoading ? (
          <div className="grid grid-cols-[4rem_minmax(0,1fr)] gap-3">
            <SkeletonLine className="h-16 w-16" />
            <div className="space-y-2">
              <SkeletonLine />
              <SkeletonLine className="w-2/3" />
            </div>
          </div>
        ) : null}
        <OrderProcessingHint />
      </Card>
    );
  }

  if (!order?.product) {
    return (
      <Card title="Product">
        <p className="text-sm text-slate-500">Product info not available (indexer syncing or product not in catalog).</p>
      </Card>
    );
  }

  return (
    <Card title="Product">
      <div className="grid grid-cols-[4rem_minmax(0,1fr)] gap-3">
        <div className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-md bg-slate-100 text-xs text-slate-500">
          {order.product.imageUrl ? (
            <div
              aria-label={order.product.name}
              className="h-full w-full bg-cover bg-center"
              role="img"
              style={{ backgroundImage: `url(${order.product.imageUrl})` }}
            />
          ) : (
            <span>No image</span>
          )}
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-base font-semibold text-slate-950">{order.product.name}</h2>
            {order.product.status === "inactive" ? (
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">[已下架]</span>
            ) : null}
          </div>
          <p className="mt-1 text-sm text-slate-500">Catalog product #{order.product.id}</p>
        </div>
      </div>
    </Card>
  );
}

function ActionExecutor({
  action,
  order,
  apiOrder,
  orderId,
  marketplaceAddress,
  onConfirmed,
  onOpenShipDialog
}: {
  action: AvailableAction;
  order: NonNullable<ReturnType<typeof normalizeOrder>>;
  apiOrder: ApiOrder | undefined;
  orderId: bigint;
  marketplaceAddress: string | undefined;
  onConfirmed: () => void;
  onOpenShipDialog: () => void;
}) {
  if (action.action === "markShipped") {
    return (
      <button
        type="button"
        onClick={onOpenShipDialog}
        className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white"
      >
        {action.buttonLabel}
      </button>
    );
  }

  if (action.action === "resolveDispute") {
    return (
      <div className="grid gap-3">
        <TxPanel
          label="退款给买家"
          description="争议仲裁结果：托管资金退回买家。"
          onConfirmed={onConfirmed}
          buildTransaction={() => ({
            address: marketplaceAddress,
            abi: escrowMarketplaceV2Abi,
            functionName: "resolveDispute",
            args: [orderId, true]
          })}
        />
        <TxPanel
          label="放款给卖家"
          description="争议仲裁结果：托管资金释放给卖家。"
          onConfirmed={onConfirmed}
          buildTransaction={() => ({
            address: marketplaceAddress,
            abi: escrowMarketplaceV2Abi,
            functionName: "resolveDispute",
            args: [orderId, false]
          })}
        />
      </div>
    );
  }

  return (
    <TxPanel
      label={action.buttonLabel}
      description={txDescription(action, apiOrder)}
      onConfirmed={onConfirmed}
      buildTransaction={() => buildActionTransaction(action.action, {
        order,
        orderId,
        marketplaceAddress
      })}
    />
  );
}

function buildActionTransaction(
  action: AvailableAction["action"],
  {
    order,
    orderId,
    marketplaceAddress
  }: {
    order: NonNullable<ReturnType<typeof normalizeOrder>>;
    orderId: bigint;
    marketplaceAddress: string | undefined;
  }
) {
  if (action === "pay") {
    return {
      address: marketplaceAddress,
      abi: escrowMarketplaceV2Abi,
      functionName: "payOrder",
      args: [orderId],
      value: order.amount
    };
  }

  if (action === "cancel") {
    return {
      address: marketplaceAddress,
      abi: escrowMarketplaceV2Abi,
      functionName: "cancelOrder",
      args: [orderId]
    };
  }

  if (action === "confirmReceived") {
    return {
      address: marketplaceAddress,
      abi: escrowMarketplaceV2Abi,
      functionName: "confirmReceived",
      args: [orderId]
    };
  }

  if (action === "openDispute") {
    return {
      address: marketplaceAddress,
      abi: escrowMarketplaceV2Abi,
      functionName: "openDispute",
      args: [orderId]
    };
  }

  return {
    address: marketplaceAddress,
    abi: escrowMarketplaceV2Abi,
    functionName: "ownerEmergencyRefund",
    args: [orderId]
  };
}

function txDescription(action: AvailableAction, apiOrder: ApiOrder | undefined) {
  if (action.action === "emergencyRefund") {
    return "请确认这是平台介入的紧急退款操作。";
  }

  if (action.action === "confirmReceived" && apiOrder?.trackingNumber) {
    return `确认收到物流单号 ${apiOrder.trackingNumber} 对应的商品。`;
  }

  return action.description;
}

function toApiOrder(apiOrder: ApiOrder | undefined, order: NonNullable<ReturnType<typeof normalizeOrder>>, chainId: number): ApiOrder {
  if (apiOrder !== undefined) {
    return apiOrder;
  }

  return {
    chainId,
    onChainOrderId: order.id.toString(),
    buyer: order.buyer,
    seller: order.seller,
    productId: order.productId.toString(),
    amountWei: order.amount.toString(),
    status: "Paid",
    createdAt: null,
    paidAt: null,
    shippedAt: null,
    completedAt: null,
    refundedAt: null,
    disputedAt: null,
    carrier: null,
    trackingNumber: null,
    trackingUrl: null,
    shippingNote: null,
    shippingUpdatedAt: null,
    product: null
  };
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

function parseOrderId(value: string | undefined) {
  if (value === undefined) {
    return undefined;
  }
  try {
    const parsed = BigInt(value);
    return parsed > 0n ? parsed : undefined;
  } catch {
    return undefined;
  }
}
