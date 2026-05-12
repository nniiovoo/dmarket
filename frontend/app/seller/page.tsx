"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAccount, useChainId } from "wagmi";

import { Card, EmptyState } from "@/components/Card";
import { NetworkNotice } from "@/components/NetworkNotice";
import { AllOrdersList } from "@/components/seller/AllOrdersList";
import { MyProductsList } from "@/components/seller/MyProductsList";
import { PendingOrdersList } from "@/components/seller/PendingOrdersList";
import { SellerTabs, type SellerTab } from "@/components/seller/SellerTabs";
import { supportedChains } from "@/lib/chains";
import { fetchSellerOrders } from "@/lib/api/seller";
import { isSupportedChain } from "@/lib/contracts";

export default function SellerDashboardPage() {
  const chainId = useChainId();
  const { address, isConnected } = useAccount();
  const [activeTab, setActiveTab] = useState<SellerTab>("pending");
  const supported = isSupportedChain(chainId);
  const chainName = supportedChains.find((chain) => chain.id === chainId)?.name ?? `Chain ${chainId}`;
  const seller = address?.toLowerCase();
  const enabled = isConnected && supported && seller !== undefined;
  const pendingQuery = useQuery({
    queryKey: ["seller", "orders", seller, chainId, "Paid", "count"],
    queryFn: () => fetchSellerOrders({ seller: seller ?? "", chainId, status: "Paid", limit: 100 }),
    enabled,
    refetchInterval: 15_000
  });
  const pendingCount = pendingQuery.data?.orders.length ?? 0;

  return (
    <div className="space-y-6">
      <NetworkNotice />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-950">Seller Dashboard</h1>
          <p className="mt-2 text-slate-600">
            Address: {seller ? shortAddress(seller) : "not connected"} · Chain: {chainName}
          </p>
        </div>
        <Link href="/seller/new" className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white">
          New product
        </Link>
      </div>

      <Card>
        {!isConnected ? (
          <EmptyState title="Connect wallet" body="Connect the seller wallet to manage products and orders." />
        ) : !supported ? (
          <EmptyState title="Unsupported network" body="Switch to Sepolia or Polygon Amoy." />
        ) : (
          <div className="space-y-5">
            <SellerTabs activeTab={activeTab} pendingCount={pendingCount} onChange={setActiveTab} />
            {activeTab === "pending" ? <PendingOrdersList seller={seller} chainId={chainId} enabled={enabled} /> : null}
            {activeTab === "products" ? <MyProductsList seller={seller} chainId={chainId} enabled={enabled} /> : null}
            {activeTab === "orders" ? <AllOrdersList seller={seller} chainId={chainId} enabled={enabled} /> : null}
          </div>
        )}
      </Card>
    </div>
  );
}

function shortAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
