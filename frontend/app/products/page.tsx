"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { formatEther } from "viem";
import { useChainId } from "wagmi";

import { Card, EmptyState, SkeletonLine } from "@/components/Card";
import { NetworkNotice } from "@/components/NetworkNotice";
import { fetchProducts, type Product } from "@/lib/api/products";
import { hasMarketplace } from "@/lib/contracts";
import { supportedChains } from "@/lib/chains";

export default function ProductsPage() {
  const chainId = useChainId();
  const supported = hasMarketplace(chainId);
  const chainName = useMemo(() => supportedChains.find((chain) => chain.id === chainId)?.name ?? "current network", [chainId]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;

    async function loadProducts() {
      if (!supported) {
        setProducts([]);
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(undefined);

      try {
        const result = await fetchProducts({ chainId, status: "active", limit: 40 });
        if (!cancelled) {
          setProducts(result.products);
        }
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : "Failed to load products");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void loadProducts();

    return () => {
      cancelled = true;
    };
  }, [chainId, supported]);

  return (
    <div className="space-y-6">
      <NetworkNotice />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-950">Products</h1>
          <p className="mt-2 text-slate-600">Browse active ChainUs products on {chainName}.</p>
        </div>
        <Link href="/seller/new" className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white">
          Create product
        </Link>
      </div>

      <Card title="Marketplace">
        {loading ? (
          <div className="grid gap-4 md:grid-cols-3">
            <SkeletonLine />
            <SkeletonLine />
            <SkeletonLine />
          </div>
        ) : error ? (
          <EmptyState title="Could not load products" body={error} />
        ) : !supported ? (
          <EmptyState title="Unsupported network" body="Switch to Sepolia, Polygon Amoy, or Arbitrum Sepolia to browse products." />
        ) : products.length === 0 ? (
          <EmptyState title="No products yet" body="No active products on this chain. Create the first listing from Sell." />
        ) : (
          <div className="grid gap-4 md:grid-cols-3">
            {products.map((product) => (
              <Link
                key={product.id}
                href={`/products/${product.id}`}
                className="overflow-hidden rounded-lg border border-slate-200 bg-white hover:border-slate-300"
              >
                <ProductImage product={product} />
                <div className="space-y-2 p-4">
                  <p className="font-medium text-slate-950">{product.name}</p>
                  <p className="text-sm text-slate-600">{formatEther(BigInt(product.priceWei))} ETH / MATIC</p>
                  <p className="text-xs text-slate-500">
                    Seller {product.sellerAddress.slice(0, 6)}...{product.sellerAddress.slice(-4)}
                  </p>
                </div>
              </Link>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function ProductImage({ product }: { product: Product }) {
  if (!product.imageUrl) {
    return (
      <div className="flex aspect-[4/3] items-center justify-center bg-slate-100 text-sm font-medium text-slate-400">
        No image
      </div>
    );
  }

  return (
    <div
      className="aspect-[4/3] bg-slate-100 bg-cover bg-center"
      style={{ backgroundImage: `url("${product.imageUrl}")` }}
      aria-label={product.name}
    />
  );
}
