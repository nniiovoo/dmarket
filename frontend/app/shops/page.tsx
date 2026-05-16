"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { Card, EmptyState, SkeletonLine } from "@/components/Card";
import { MintShopBanner } from "@/components/shops/MintShopBanner";
import { ShopGrid } from "@/components/shops/ShopGrid";
import { listShops, type ShopSummary } from "@/lib/api/shops";

const PAGE_SIZE = 12;

export default function ShopsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // 1-indexed page parameter; clamped to ≥1 so a malicious ?page=-3
  // doesn't underflow the offset math.
  const rawPage = Number(searchParams.get("page") ?? "1");
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;

  const [shops, setShops] = useState<ShopSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(undefined);
      try {
        const offset = (page - 1) * PAGE_SIZE;
        const res = await listShops(PAGE_SIZE, offset);
        if (cancelled) return;
        setShops(res.shops);
        setTotal(res.total);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [page]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function goTo(targetPage: number) {
    const clamped = Math.max(1, Math.min(totalPages, targetPage));
    if (clamped === page) return;
    const next = new URLSearchParams();
    if (clamped > 1) next.set("page", String(clamped));
    const qs = next.toString();
    router.push(qs ? `/shops?${qs}` : "/shops", { scroll: false });
  }

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <header className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-950">ChainUs Shops</h1>
          <p className="mt-1 text-sm text-slate-600">
            Every shop on the marketplace is a transferable NFT with a fixed 10 000-token supply.
            Browse below; pick one to see its token holders and any active listings.
          </p>
        </div>
      </header>

      <MintShopBanner />

      {error ? (
        <Card>
          <EmptyState
            title="Couldn't load shops"
            body={error}
          />
          <p className="mt-3 text-sm text-slate-500">
            The indexer may be catching up. Check{" "}
            <Link href="/api/indexer/status" className="text-blue-600 underline">
              /api/indexer/status
            </Link>{" "}
            for the v3.3 shop-economy block.
          </p>
        </Card>
      ) : loading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="rounded-lg border border-slate-200 bg-white p-4">
              <SkeletonLine className="mb-3 h-32" />
              <SkeletonLine className="mb-2 w-1/2" />
              <SkeletonLine className="w-3/4" />
            </div>
          ))}
        </div>
      ) : shops.length === 0 ? (
        <EmptyState
          title="No shops yet"
          body="Shops appear here as soon as a seller mints their ShopNFT. The mint-shop UI lands in the next K.6b phase."
        />
      ) : (
        <>
          <ShopGrid shops={shops} />
          <div className="mt-6 flex items-center justify-between text-sm text-slate-600">
            <span>
              Page {page} of {totalPages} · {total} shop{total === 1 ? "" : "s"} total
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => goTo(page - 1)}
                disabled={page <= 1}
                className="rounded border border-slate-300 px-3 py-1.5 text-sm font-medium disabled:opacity-40"
              >
                ← Prev
              </button>
              <button
                type="button"
                onClick={() => goTo(page + 1)}
                disabled={page >= totalPages}
                className="rounded border border-slate-300 px-3 py-1.5 text-sm font-medium disabled:opacity-40"
              >
                Next →
              </button>
            </div>
          </div>
        </>
      )}
    </main>
  );
}
