"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatEther, formatUnits } from "viem";
import { useAccount } from "wagmi";

import { Card, EmptyState, SkeletonLine } from "@/components/Card";
import {
  getUserHoldings,
  getUserListings,
  ShopsApiError,
  type ShopListing,
  type UserHolding
} from "@/lib/api/shops";
import { useUserShopId } from "@/lib/v3_3/useUserShopId";
import { getAcceptedTokens } from "@/lib/contractsV3_2";
import { PRIMARY_CHAIN_ID } from "@/lib/chains";

const NATIVE = "0x0000000000000000000000000000000000000000";

function shortAddress(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function formatPrice(totalPrice: string, paymentToken: string): string {
  const amount = BigInt(totalPrice);
  if (paymentToken.toLowerCase() === NATIVE) return `${formatEther(amount)} ETH`;
  const meta = getAcceptedTokens(PRIMARY_CHAIN_ID).find(
    (t) => t.address.toLowerCase() === paymentToken.toLowerCase()
  );
  if (meta) return `${formatUnits(amount, meta.decimals)} ${meta.symbol}`;
  return `${amount.toString()} (raw)`;
}

export default function PortfolioPage() {
  const { address, isConnected } = useAccount();
  const { shopId: ownedShopId } = useUserShopId();
  const [holdings, setHoldings] = useState<UserHolding[]>([]);
  const [listings, setListings] = useState<ShopListing[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!address) {
        setHoldings([]);
        setListings([]);
        return;
      }
      setLoading(true);
      setError(undefined);
      try {
        const [h, l] = await Promise.all([
          getUserHoldings(address).catch((err) => {
            if (err instanceof ShopsApiError && err.status === 404) {
              return { holder: address, holdings: [] as UserHolding[], total: 0 };
            }
            throw err;
          }),
          getUserListings(address, "all").catch((err) => {
            if (err instanceof ShopsApiError && err.status === 404) {
              return { seller: address, listings: [] as ShopListing[], total: 0 };
            }
            throw err;
          })
        ]);
        if (cancelled) return;
        setHoldings(h.holdings);
        setListings(l.listings);
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
  }, [address]);

  const active = listings.filter((l) => l.status === "Active");
  const closed = listings.filter((l) => l.status !== "Active");

  return (
    <main className="mx-auto max-w-4xl px-4 py-6">
      <h1 className="text-2xl font-semibold text-slate-950">Portfolio</h1>
      <p className="mt-1 text-sm text-slate-600">
        Your ShopNFT (if any), your share holdings across every shop, and your open ShareMarket
        listings. All data is read from the indexer; revenue claims happen on each shop&apos;s
        detail page.
      </p>

      {!isConnected ? (
        <Card>
          <EmptyState
            title="Connect your wallet"
            body="The portfolio page needs your wallet address to look up your holdings."
          />
        </Card>
      ) : (
        <div className="mt-6 space-y-6">
          <Card title="ShopNFT">
            {ownedShopId === undefined ? (
              <SkeletonLine className="w-1/2" />
            ) : ownedShopId === 0n ? (
              <EmptyState
                title="No shop minted yet"
                body="Heads up: minting a shop is a one-time per-wallet action — the contract enforces 1-seller-1-shop. Mint via the /shops page banner."
              />
            ) : (
              <Link
                href={`/shops/${ownedShopId.toString()}`}
                className="text-sm text-blue-600 hover:underline"
              >
                You own ShopNFT #{ownedShopId.toString()} →
              </Link>
            )}
          </Card>

          <Card title={`Token holdings (${holdings.length})`}>
            {loading && holdings.length === 0 ? (
              <SkeletonLine />
            ) : error ? (
              <EmptyState title="Couldn't load holdings" body={error} />
            ) : holdings.length === 0 ? (
              <EmptyState
                title="No holdings"
                body="You don't own any shop tokens yet. Browse /shops and look for shops with active listings."
              />
            ) : (
              <ul className="space-y-2">
                {holdings.map((h) => (
                  <li
                    key={h.shopId}
                    className="flex items-center justify-between gap-3 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm"
                  >
                    <div className="min-w-0">
                      <Link
                        href={`/shops/${h.shopId}`}
                        className="font-medium text-slate-900 hover:underline"
                      >
                        {h.shopName}
                      </Link>
                      <p className="text-xs text-slate-500">
                        Shop #{h.shopId}
                        {h.shopCurrentOwner
                          ? ` · current owner ${shortAddress(h.shopCurrentOwner)}`
                          : ""}
                      </p>
                    </div>
                    <div className="text-right tabular-nums">
                      <p className="font-mono text-sm text-slate-900">{h.balance}</p>
                      <p className="text-xs text-slate-500">{h.pct}%</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title={`Active listings (${active.length})`}>
            {active.length === 0 ? (
              <EmptyState
                title="No active listings"
                body="Your active ShareMarket listings appear here. Post one from a shop detail page."
              />
            ) : (
              <ul className="space-y-2">
                {active.map((l) => (
                  <UserListingRow key={l.listingId} listing={l} />
                ))}
              </ul>
            )}
          </Card>

          {closed.length > 0 ? (
            <Card title={`Closed listings (${closed.length})`}>
              <ul className="space-y-2">
                {closed.map((l) => (
                  <UserListingRow key={l.listingId} listing={l} />
                ))}
              </ul>
            </Card>
          ) : null}
        </div>
      )}
    </main>
  );
}

function UserListingRow({ listing }: { listing: ShopListing }) {
  return (
    <li className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <Link
            href={`/shops/${listing.shopId}`}
            className="font-medium text-slate-900 hover:underline"
          >
            Listing #{listing.listingId} · shop #{listing.shopId}
          </Link>
          <p className="text-xs text-slate-600">
            <span className="font-mono">{listing.remainingAmount ?? listing.amount}</span> / {listing.originalAmount ?? listing.amount} tokens @{" "}
            <span className="font-mono">
              {formatPrice(listing.pricePerToken ?? listing.totalPrice, listing.paymentToken)}
            </span>{" "}
            per token
          </p>
        </div>
        <span
          className={
            listing.status === "Active"
              ? "rounded bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-900"
              : listing.status === "Filled"
              ? "rounded bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-900"
              : "rounded bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600"
          }
        >
          {listing.status}
        </span>
      </div>
    </li>
  );
}
