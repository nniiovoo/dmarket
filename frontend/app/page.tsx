"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatEther } from "viem";
import { useAccount, useBalance, useReadContract } from "wagmi";

import { Card, EmptyState, SkeletonLine } from "@/components/Card";
import { NetworkNotice } from "@/components/NetworkNotice";
import { OrderCard } from "@/components/OrderCard";
import { fetchOrders } from "@/lib/api/orders";
import { PRIMARY_CHAIN, PRIMARY_CHAIN_ID, explorerByChainId, getExplorerAddressUrl, getFaucetUrl } from "@/lib/chains";
import { getActiveMarketplace } from "@/lib/contracts";
import { useOptimisticOrder, type PendingOrder } from "@/lib/useOptimisticOrder";

const refetchInterval = 12_000;

export default function HomePage() {
  const router = useRouter();
  const { address, isConnected } = useAccount();
  const [manualOrderId, setManualOrderId] = useState("");
  const optimistic = useOptimisticOrder();
  const active = getActiveMarketplace(PRIMARY_CHAIN_ID);
  const supported = active !== undefined;
  const heroTitle = "Escrow Marketplace v3";
  const heroSubtitle = "ChainUs runs on Arbitrum with Kleros V2 decentralized arbitration.";
  const networkStatus = `${PRIMARY_CHAIN.name} (testnet)`;
  const balance = useBalance({ address, chainId: PRIMARY_CHAIN_ID, query: { enabled: address !== undefined } });

  const nextOrderId = useReadContract({
    address: active?.address,
    abi: active?.abi,
    chainId: PRIMARY_CHAIN_ID,
    functionName: "nextOrderId",
    query: { enabled: supported, refetchInterval }
  });

  const buyerOrdersQuery = useQuery({
    queryKey: ["orders", "buyer", address, PRIMARY_CHAIN_ID],
    queryFn: () => fetchOrders({ buyer: address, chainId: PRIMARY_CHAIN_ID }),
    enabled: supported && address !== undefined,
    refetchInterval
  });

  const sellerOrdersQuery = useQuery({
    queryKey: ["orders", "seller", address, PRIMARY_CHAIN_ID],
    queryFn: () => fetchOrders({ seller: address, chainId: PRIMARY_CHAIN_ID }),
    enabled: supported && address !== undefined,
    refetchInterval
  });
  const buyerPendingOrders = useMemo(
    () =>
      optimistic.pendingOrders.filter(
        (order) => order.chainId === PRIMARY_CHAIN_ID && address !== undefined && order.buyer === address.toLowerCase()
      ),
    [address, optimistic.pendingOrders]
  );

  useEffect(() => {
    const indexedIds = new Set((buyerOrdersQuery.data?.orders ?? []).map((order) => order.onChainOrderId));
    const matched = buyerPendingOrders.filter((order) => indexedIds.has(order.onChainOrderId));

    if (matched.length === 0) {
      return undefined;
    }

    const timeout = window.setTimeout(() => {
      for (const order of matched) {
        optimistic.clearPending(order.chainId, order.onChainOrderId);
      }
    }, 0);

    return () => window.clearTimeout(timeout);
  }, [buyerOrdersQuery.data?.orders, buyerPendingOrders, optimistic]);

  function openManualOrder() {
    if (!manualOrderId.trim()) {
      return;
    }

    router.push(`/orders/${manualOrderId.trim()}`);
  }

  return (
    <div className="space-y-6">
      <NetworkNotice />
      <section className="rounded-lg bg-slate-950 p-6 text-white">
        <p className="text-sm text-slate-300">Phase 3 frontend</p>
        <h1 className="mt-2 text-3xl font-semibold">{heroTitle}</h1>
        <p className="mt-3 max-w-3xl text-slate-300">{heroSubtitle}</p>
        <div className="mt-5 flex flex-wrap gap-3">
          <Link href="/create" className="rounded-md bg-white px-4 py-2 text-sm font-medium text-slate-950">
            Create order
          </Link>
          <Link href="/admin" className="rounded-md bg-slate-800 px-4 py-2 text-sm font-medium text-white">
            Admin
          </Link>
          {isConnected ? (
            <Link href="/seller" className="rounded-md bg-slate-800 px-4 py-2 text-sm font-medium text-white">
              Seller Dashboard
            </Link>
          ) : null}
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Network">
          {!isConnected ? (
            <EmptyState title="Connect wallet" body="Connect a wallet to read your buyer and seller orders." />
          ) : !supported ? (
            <EmptyState title="Configuration missing" body="Arbitrum marketplace addresses are not configured." />
          ) : (
            <div className="space-y-3 text-sm">
              <InfoRow label="Status" value={networkStatus} />
              <InfoRow label="Chain ID" value={String(PRIMARY_CHAIN_ID)} />
              <InfoRow
                label="Marketplace"
                value={active?.address}
                href={getExplorerAddressUrl(PRIMARY_CHAIN_ID, active?.address)}
              />
              <InfoRow label="Vault" value={active?.vault} href={getExplorerAddressUrl(PRIMARY_CHAIN_ID, active?.vault)} />
              <InfoRow
                label="Next order ID"
                value={nextOrderId.isLoading ? undefined : String((nextOrderId.data as bigint | undefined) ?? "-")}
              />
              <InfoRow
                label="Wallet balance"
                value={balance.data ? `${formatEther(balance.data.value)} ${balance.data.symbol}` : "-"}
              />
              {balance.data?.value === 0n ? (
                <a
                  className="inline-block text-blue-700 underline"
                  href={getFaucetUrl(PRIMARY_CHAIN_ID)}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open faucet
                </a>
              ) : null}
              {explorerByChainId[PRIMARY_CHAIN_ID] ? (
                <p className="text-xs text-slate-500">Explorer: {explorerByChainId[PRIMARY_CHAIN_ID]}</p>
              ) : null}
            </div>
          )}
        </Card>

        <Card title="Find order">
          <div className="flex gap-2">
            <input
              value={manualOrderId}
              onChange={(event) => setManualOrderId(event.target.value)}
              placeholder="Order ID"
              className="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-2"
            />
            <button onClick={openManualOrder} className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white">
              Open
            </button>
          </div>
          <p className="mt-3 text-sm text-slate-500">Open a known on-chain order ID on the selected network.</p>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <OrderList title="My buyer orders" query={buyerOrdersQuery} chainReady={supported && isConnected} pendingOrders={buyerPendingOrders} />
        <OrderList title="My seller orders" query={sellerOrdersQuery} chainReady={supported && isConnected} />
      </div>
    </div>
  );
}

function InfoRow({ label, value, href }: { label: string; value: string | undefined; href?: string }) {
  return (
    <div className="flex flex-col gap-1 border-b border-slate-100 pb-2 last:border-0 sm:flex-row sm:justify-between">
      <span className="font-medium text-slate-600">{label}</span>
      {value === undefined ? (
        <SkeletonLine className="w-32" />
      ) : href ? (
        <a href={href} target="_blank" rel="noreferrer" className="break-all text-blue-700 underline">
          {value}
        </a>
      ) : (
        <span className="break-all text-slate-900">{value}</span>
      )}
    </div>
  );
}

function OrderList({
  title,
  query,
  chainReady,
  pendingOrders = []
}: {
  title: string;
  query: ReturnType<typeof useQuery<Awaited<ReturnType<typeof fetchOrders>>>>;
  chainReady: boolean;
  pendingOrders?: PendingOrder[];
}) {
  const dbOrders = query.data?.orders ?? [];
  const indexedIds = new Set(dbOrders.map((order) => order.onChainOrderId));
  const visiblePendingOrders = pendingOrders.filter((order) => !indexedIds.has(order.onChainOrderId));
  const visibleOrders = [...visiblePendingOrders, ...dbOrders];

  return (
    <Card title={title}>
      {!chainReady ? (
        <EmptyState title="Wallet required" body="Connect on a supported chain to load orders." />
      ) : query.isLoading && visibleOrders.length === 0 ? (
        <div className="space-y-2">
          <SkeletonLine />
          <SkeletonLine className="w-2/3" />
        </div>
      ) : query.isError && visibleOrders.length === 0 ? (
        <EmptyState title="Orders unavailable" body="The order indexer API is not ready yet." />
      ) : visibleOrders.length === 0 ? (
        <EmptyState title="No indexed orders yet" body="Run the indexer, create an order, or switch to a wallet with prior test flows." />
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-slate-500">The indexer can lag chain confirmations by about 15 seconds after a transaction.</p>
          {visibleOrders.map((order) => {
            const isPending = visiblePendingOrders.some(
              (pendingOrder) => pendingOrder.chainId === order.chainId && pendingOrder.onChainOrderId === order.onChainOrderId
            );

            return (
              <OrderCard
                key={`${order.chainId}:${order.onChainOrderId}`}
                chainId={order.chainId}
                onChainOrderId={order.onChainOrderId}
                status={order.status}
                amountWei={order.amountWei}
                product={order.product}
                isPending={isPending}
              />
            );
          })}
          {query.isFetching ? <p className="text-xs text-slate-500">Refreshing...</p> : null}
        </div>
      )}
    </Card>
  );
}
