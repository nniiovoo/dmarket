"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { formatEther, parseEther } from "viem";

import { Card, EmptyState, SkeletonLine } from "@/components/Card";
import { NetworkNotice } from "@/components/NetworkNotice";
import { fetchProducts, searchProductsApi, type Product } from "@/lib/api/products";
import { hasMarketplace } from "@/lib/contracts";
import { PRIMARY_CHAIN, PRIMARY_CHAIN_ID } from "@/lib/chains";

export default function ProductsPage() {
  const supported = hasMarketplace(PRIMARY_CHAIN_ID);
  const chainName = PRIMARY_CHAIN.name;
  const searchParams = useSearchParams();
  const router = useRouter();

  const initialQ = searchParams.get("q") ?? "";
  const initialPriceMaxEth = searchParams.get("priceMaxEth") ?? "";
  const [qInput, setQInput] = useState(initialQ);
  const [priceMaxEthInput, setPriceMaxEthInput] = useState(initialPriceMaxEth);
  const [debouncedQ, setDebouncedQ] = useState(initialQ);
  const [debouncedPriceMaxEth, setDebouncedPriceMaxEth] = useState(initialPriceMaxEth);

  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();

  // 300ms debounce on both inputs. Mirror the debounced values back into
  // the query string so links + browser history stay coherent.
  useEffect(() => {
    const id = window.setTimeout(() => {
      setDebouncedQ(qInput.trim());
      setDebouncedPriceMaxEth(priceMaxEthInput.trim());
    }, 300);
    return () => window.clearTimeout(id);
  }, [qInput, priceMaxEthInput]);

  useEffect(() => {
    const next = new URLSearchParams();
    if (debouncedQ) next.set("q", debouncedQ);
    if (debouncedPriceMaxEth) next.set("priceMaxEth", debouncedPriceMaxEth);
    const qs = next.toString();
    router.replace(qs ? `/products?${qs}` : "/products", { scroll: false });
  }, [debouncedQ, debouncedPriceMaxEth, router]);

  const searchActive = debouncedQ.length > 0 || debouncedPriceMaxEth.length > 0;

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!supported) {
        setProducts([]);
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(undefined);

      try {
        if (searchActive) {
          let priceMaxWei: string | undefined;
          if (debouncedPriceMaxEth) {
            try {
              priceMaxWei = parseEther(debouncedPriceMaxEth).toString();
            } catch {
              setError("Price max must be a decimal number of ETH");
              setLoading(false);
              return;
            }
          }
          const result = await searchProductsApi({
            q: debouncedQ || undefined,
            priceMaxWei,
            chainId: PRIMARY_CHAIN_ID,
            sortBy: debouncedQ ? "relevance" : "recent",
            limit: 40
          });
          if (!cancelled) {
            setProducts(
              result.results.map((r) => ({
                id: r.id,
                sellerAddress: r.sellerAddress,
                name: r.name,
                description: r.description,
                priceWei: r.priceWei,
                chainId: r.chainId,
                imageUrl: r.imageUrl,
                status: "active",
                createdAt: r.createdAt,
                updatedAt: r.createdAt
              }))
            );
          }
        } else {
          const result = await fetchProducts({ chainId: PRIMARY_CHAIN_ID, status: "active", limit: 40 });
          if (!cancelled) setProducts(result.products);
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

    void load();

    return () => {
      cancelled = true;
    };
  }, [supported, searchActive, debouncedQ, debouncedPriceMaxEth]);

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

      <Card>
        <div className="flex flex-col gap-3 md:flex-row md:items-center">
          <label className="flex-1">
            <span className="sr-only">Search products</span>
            <input
              type="search"
              value={qInput}
              onChange={(event) => setQInput(event.target.value)}
              placeholder="Search products..."
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <span>Price max (ETH)</span>
            <input
              type="text"
              inputMode="decimal"
              value={priceMaxEthInput}
              onChange={(event) => setPriceMaxEthInput(event.target.value)}
              placeholder="0.05"
              className="w-28 rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
        </div>
        {searchActive ? (
          <p className="mt-2 text-xs text-slate-500">
            Showing search results{debouncedQ ? ` for "${debouncedQ}"` : ""}
            {debouncedPriceMaxEth ? ` under ${debouncedPriceMaxEth} ETH` : ""}.
          </p>
        ) : null}
      </Card>

      <Card title={searchActive ? "Search results" : "Marketplace"}>
        {loading ? (
          <div className="grid gap-4 md:grid-cols-3">
            <SkeletonLine />
            <SkeletonLine />
            <SkeletonLine />
          </div>
        ) : error ? (
          <EmptyState title="Could not load products" body={error} />
        ) : !supported ? (
          <EmptyState title="Configuration missing" body="Arbitrum marketplace addresses are not configured." />
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
