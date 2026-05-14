"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useAccount, useReadContract } from "wagmi";

import { Card, EmptyState, SkeletonLine } from "@/components/Card";
import { NetworkNotice } from "@/components/NetworkNotice";
import { OrderBadge } from "@/components/OrderBadge";
import { TxPanel } from "@/components/TxPanel";
import { PRIMARY_CHAIN_ID } from "@/lib/chains";
import { getActiveMarketplace, hasMarketplace } from "@/lib/contracts";
import { formatAmount, normalizeOrder, OrderStatus, sameAddress } from "@/lib/order";

const refetchInterval = 12_000;

export default function AdminPage() {
  const { address, isConnected } = useAccount();
  const active = getActiveMarketplace(PRIMARY_CHAIN_ID);
  const supported = hasMarketplace(PRIMARY_CHAIN_ID);
  const [orderIdInput, setOrderIdInput] = useState("");
  const orderId = useMemo(() => parseOrderId(orderIdInput), [orderIdInput]);

  const ownerQuery = useReadContract({
    address: active?.address,
    abi: active?.abi,
    chainId: PRIMARY_CHAIN_ID,
    functionName: "owner",
    query: { enabled: supported, refetchInterval }
  });

  const orderQuery = useReadContract({
    address: active?.address,
    abi: active?.abi,
    chainId: PRIMARY_CHAIN_ID,
    functionName: "getOrder",
    args: orderId === undefined ? undefined : [orderId],
    query: { enabled: supported && orderId !== undefined, retry: false, refetchInterval }
  });

  const owner = ownerQuery.data as string | undefined;
  const order = normalizeOrder(orderQuery.data);
  const isOwner = sameAddress(address, owner);

  function refetchAll() {
    void ownerQuery.refetch();
    void orderQuery.refetch();
  }

  return (
    <div className="space-y-6">
      <NetworkNotice />
      <div>
        <h1 className="text-2xl font-semibold text-slate-950">Admin</h1>
        <p className="mt-2 text-slate-600">Owner tools for disputes and emergency refunds.</p>
      </div>

      <Card title="Owner status">
        {!isConnected ? (
          <EmptyState title="Connect wallet" body="Connect the owner wallet to use admin actions." />
        ) : !supported ? (
          <EmptyState title="Configuration missing" body="Arbitrum marketplace addresses are not configured." />
        ) : ownerQuery.isLoading ? (
          <SkeletonLine className="w-1/2" />
        ) : (
          <div className="space-y-2 text-sm">
            <p>
              Owner: <span className="break-all font-medium">{owner}</span>
            </p>
            <p className={isOwner ? "text-emerald-700" : "text-amber-700"}>
              {isOwner ? "Connected wallet is owner." : "Connected wallet is not owner. Actions are disabled."}
            </p>
          </div>
        )}
      </Card>

      <Card title="Load order">
        <div className="flex gap-2">
          <input
            value={orderIdInput}
            onChange={(event) => setOrderIdInput(event.target.value)}
            placeholder="Order ID"
            className="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-2"
          />
          {orderId !== undefined ? (
            <Link href={`/orders/${orderId.toString()}`} className="rounded-md bg-slate-100 px-4 py-2 text-sm font-medium text-slate-800">
              Detail
            </Link>
          ) : null}
        </div>
      </Card>

      {orderId === undefined ? (
        <EmptyState title="Enter an order ID" body="Admin actions load after you enter a valid order ID." />
      ) : orderQuery.isLoading ? (
        <Card>
          <SkeletonLine />
          <SkeletonLine className="mt-2 w-2/3" />
        </Card>
      ) : order === undefined || orderQuery.isError ? (
        <EmptyState title="Order not found" body="This order does not exist on the selected network." />
      ) : (
        <Card title={`Order #${orderId.toString()}`} action={<OrderBadge status={order.status} />}>
          <div className="mb-4 grid gap-3 text-sm md:grid-cols-2">
            <p>
              Buyer: <span className="break-all font-medium">{order.buyer}</span>
            </p>
            <p>
              Seller: <span className="break-all font-medium">{order.seller}</span>
            </p>
            <p>Amount: {formatAmount(order.amount)} ETH / MATIC</p>
            <p>Product ID: {order.productId.toString()}</p>
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            <TxPanel
              label="Refund buyer"
              description="Resolve a disputed order by refunding buyer."
              disabled={!isOwner || order.status !== OrderStatus.Disputed}
              disabledReason={!isOwner ? "Only owner can resolve disputes." : "Order must be Disputed."}
              onConfirmed={refetchAll}
              buildTransaction={() => ({
                address: active?.address,
                abi: active?.abi,
                chainId: PRIMARY_CHAIN_ID,
                functionName: "resolveDispute",
                args: [orderId, true]
              })}
            />
            <TxPanel
              label="Release seller"
              description="Resolve a disputed order by paying seller."
              disabled={!isOwner || order.status !== OrderStatus.Disputed}
              disabledReason={!isOwner ? "Only owner can resolve disputes." : "Order must be Disputed."}
              onConfirmed={refetchAll}
              buildTransaction={() => ({
                address: active?.address,
                abi: active?.abi,
                chainId: PRIMARY_CHAIN_ID,
                functionName: "resolveDispute",
                args: [orderId, false]
              })}
            />
            <TxPanel
              label="Emergency refund"
              description="Refund buyer without requiring dispute."
              disabled={!isOwner || ![OrderStatus.Paid, OrderStatus.Shipped, OrderStatus.Disputed].includes(order.status)}
              disabledReason={!isOwner ? "Only owner can emergency refund." : "Order must have escrowed funds."}
              onConfirmed={refetchAll}
              buildTransaction={() => ({
                address: active?.address,
                abi: active?.abi,
                chainId: PRIMARY_CHAIN_ID,
                functionName: "ownerEmergencyRefund",
                args: [orderId]
              })}
            />
          </div>
        </Card>
      )}
    </div>
  );
}

function parseOrderId(value: string) {
  try {
    const parsed = BigInt(value);
    return parsed > 0n ? parsed : undefined;
  } catch {
    return undefined;
  }
}
