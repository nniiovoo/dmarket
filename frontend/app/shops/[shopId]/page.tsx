"use client";

import Link from "next/link";
import { notFound, useParams } from "next/navigation";
import { useEffect, useState } from "react";

import { Card, EmptyState, SkeletonLine } from "@/components/Card";
import { HoldingsTable } from "@/components/shops/HoldingsTable";
import { ListingsList } from "@/components/shops/ListingsList";
import { ShopHeader } from "@/components/shops/ShopHeader";
import { ClaimRevenueButton } from "@/components/shops/actions/ClaimRevenueButton";
import { CreateListingForm } from "@/components/shops/actions/CreateListingForm";
import { InitializeSharesButton } from "@/components/shops/actions/InitializeSharesButton";
import { UpdateShopMetaForm } from "@/components/shops/actions/UpdateShopMetaForm";
import {
  getShop,
  getShopHoldings,
  getShopListings,
  ShopsApiError,
  type ShopHolding,
  type ShopListing,
  type ShopSummary
} from "@/lib/api/shops";
import { useShopRole } from "@/lib/v3_3/useShopRole";

export default function ShopDetailPage() {
  const params = useParams<{ shopId: string }>();
  const rawShopId = params.shopId;
  const shopId = Number(rawShopId);
  const invalid = !Number.isInteger(shopId) || shopId <= 0;

  const [shop, setShop] = useState<ShopSummary | null>(null);
  const [holdings, setHoldings] = useState<ShopHolding[]>([]);
  const [listings, setListings] = useState<ShopListing[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [missing, setMissing] = useState(false);
  const role = useShopRole(invalid ? undefined : shopId);
  const [refreshTick, setRefreshTick] = useState(0);
  function refresh() {
    setRefreshTick((t) => t + 1);
    role.refresh();
  }

  useEffect(() => {
    if (invalid) return;
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(undefined);
      setMissing(false);
      try {
        const [shopRes, holdingsRes, listingsRes] = await Promise.all([
          getShop(shopId),
          getShopHoldings(shopId).catch((err) => {
            if (err instanceof ShopsApiError && err.status === 404) {
              return { shopId, holdings: [] as ShopHolding[], totalShareholders: 0 };
            }
            throw err;
          }),
          getShopListings(shopId, "all").catch((err) => {
            if (err instanceof ShopsApiError && err.status === 404) {
              return { listings: [] as ShopListing[], total: 0 };
            }
            throw err;
          })
        ]);
        if (cancelled) return;
        if (shopRes === null) {
          setMissing(true);
          return;
        }
        setShop(shopRes);
        setHoldings(holdingsRes.holdings);
        setListings(listingsRes.listings);
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
  }, [shopId, invalid, refreshTick]);

  if (invalid) {
    // /shops/abc → bad id. Surface a clean "not found" rather than a 500.
    notFound();
  }
  if (missing) {
    // /shops/999 (well-formed but not-indexed) — same UX as a bad id.
    // The not-found page already explains "indexer may be catching up".
    notFound();
  }

  return (
    <main className="mx-auto max-w-4xl px-4 py-6">
      <div className="mb-4">
        <Link href="/shops" className="text-sm text-blue-600 hover:underline">
          ← Back to shops
        </Link>
      </div>

      {error ? (
        <Card>
          <EmptyState title="Couldn't load this shop" body={error} />
        </Card>
      ) : loading || !shop ? (
        <DetailSkeleton />
      ) : (
        <div className="space-y-6">
          <ShopHeader shop={shop} />

          <Card title={`Token holders (${holdings.length})`}>
            <HoldingsTable
              holdings={holdings}
              totalSharesIssued={shop.totalSharesIssued}
              sharesInitialized={shop.sharesInitialized}
            />
          </Card>

          <Card title={`Listings (${listings.length})`}>
            <ListingsList listings={listings} onChange={refresh} />
          </Card>

          {role.isOwner && !shop.sharesInitialized ? (
            <InitializeSharesButton shopId={shop.shopId} onConfirmed={refresh} />
          ) : null}

          {role.isShareholder ? (
            <>
              <CreateListingForm
                shopId={shop.shopId}
                shareBalance={role.shareBalance}
                onConfirmed={refresh}
              />
              <ClaimRevenueButton shopId={shop.shopId} onConfirmed={refresh} />
            </>
          ) : null}

          {role.isOwner ? <UpdateShopMetaForm shop={shop} onConfirmed={refresh} /> : null}
        </div>
      )}
    </main>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-slate-200 bg-white p-6">
        <SkeletonLine className="mb-3 h-6 w-1/2" />
        <SkeletonLine className="mb-2 w-1/3" />
        <SkeletonLine className="w-2/3" />
      </div>
      <div className="rounded-lg border border-slate-200 bg-white p-5">
        <SkeletonLine className="mb-3 w-1/3" />
        <SkeletonLine className="mb-2" />
        <SkeletonLine className="mb-2" />
        <SkeletonLine className="w-3/4" />
      </div>
    </div>
  );
}
