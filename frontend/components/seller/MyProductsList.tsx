"use client";

import Link from "next/link";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { EmptyState, SkeletonLine } from "@/components/Card";
import { MyProductRow } from "@/components/seller/MyProductRow";
import { fetchSellerProducts } from "@/lib/api/seller";

export function MyProductsList({ seller, chainId, enabled }: { seller: string | undefined; chainId: number; enabled: boolean }) {
  const [showInactive, setShowInactive] = useState(false);
  const status = showInactive ? "inactive" : "active";
  const productsQuery = useQuery({
    queryKey: ["seller", "products", seller, chainId, status],
    queryFn: () => fetchSellerProducts({ seller: seller ?? "", chainId, status }),
    enabled: enabled && seller !== undefined
  });

  if (!enabled || seller === undefined) {
    return <EmptyState title="Wallet required" body="Connect a seller wallet on a supported chain." />;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={showInactive} onChange={(event) => setShowInactive(event.target.checked)} />
          Show inactive products
        </label>
        <Link href="/seller/new" className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white">
          New product
        </Link>
      </div>

      {productsQuery.isLoading ? (
        <div className="space-y-2">
          <SkeletonLine />
          <SkeletonLine className="w-2/3" />
        </div>
      ) : productsQuery.isError ? (
        <EmptyState title="Could not load products" body="Try refreshing the dashboard." />
      ) : (productsQuery.data?.products.length ?? 0) === 0 ? (
        <EmptyState
          title={showInactive ? "No inactive products" : "No products yet"}
          body={showInactive ? "Your inactive products will appear here." : "List your first product from the New product button."}
        />
      ) : (
        <div className="space-y-3">
          {productsQuery.data?.products.map((product) => (
            <MyProductRow key={product.id} product={product} />
          ))}
        </div>
      )}
    </div>
  );
}
