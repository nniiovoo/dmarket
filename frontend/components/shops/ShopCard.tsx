"use client";

import Link from "next/link";

import type { ShopSummary } from "@/lib/api/shops";

function shortAddress(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

interface Props {
  shop: ShopSummary;
}

export function ShopCard({ shop }: Props) {
  const initials = shop.name
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase() || `#${shop.shopId}`;

  return (
    <Link
      href={`/shops/${shop.shopId}`}
      className="group block overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm transition hover:border-slate-400 hover:shadow"
    >
      <div className="flex aspect-video items-center justify-center bg-slate-100 text-3xl font-semibold text-slate-400">
        {shop.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={shop.imageUrl} alt={shop.name} className="h-full w-full object-cover" />
        ) : (
          <span>{initials}</span>
        )}
      </div>
      <div className="space-y-2 p-4">
        <div className="flex items-start justify-between gap-2">
          <h2 className="line-clamp-1 text-base font-semibold text-slate-950 group-hover:underline">
            {shop.name || `Shop #${shop.shopId}`}
          </h2>
          <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
            #{shop.shopId}
          </span>
        </div>
        <p className="text-xs text-slate-500">
          Owner <span className="font-mono">{shortAddress(shop.currentOwner)}</span>
        </p>
        {shop.sharesInitialized ? (
          <p className="text-xs text-slate-600">
            <span className="font-medium text-slate-900">{shop.totalShareholders}</span> token holder
            {shop.totalShareholders === 1 ? "" : "s"} · <span className="font-medium text-slate-900">{shop.totalSharesIssued}</span> tokens
          </p>
        ) : (
          <span className="inline-flex items-center rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">
            Tokens not yet initialized
          </span>
        )}
      </div>
    </Link>
  );
}
