"use client";

import Link from "next/link";
import type { Address } from "viem";

import { ReputationBadge } from "@/components/reputation/ReputationBadge";
import type { ShopSummary } from "@/lib/api/shops";

interface Props {
  shop: ShopSummary;
}

const ARBISCAN_ADDRESS_BASE = "https://sepolia.arbiscan.io/address";

function shortAddress(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function ShopHeader({ shop }: Props) {
  const initials = shop.name
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase() || `#${shop.shopId}`;
  const created = new Date(shop.createdAt);
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex flex-col gap-5 sm:flex-row">
        <div className="flex h-32 w-32 flex-shrink-0 items-center justify-center rounded-md bg-slate-100 text-3xl font-semibold text-slate-400">
          {shop.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={shop.imageUrl}
              alt={shop.name}
              className="h-full w-full rounded-md object-cover"
            />
          ) : (
            <span>{initials}</span>
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold text-slate-950">
              {shop.name || `Shop #${shop.shopId}`}
            </h1>
            <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
              #{shop.shopId}
            </span>
            <ReputationBadge sellerAddress={shop.currentOwner as Address} />
          </div>
          <div className="space-y-1 text-sm text-slate-600">
            <p>
              Owner{" "}
              <Link
                href={`${ARBISCAN_ADDRESS_BASE}/${shop.currentOwner}`}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-blue-600 hover:underline"
              >
                {shortAddress(shop.currentOwner)}
              </Link>
            </p>
            <p>
              Creator{" "}
              <span className="font-mono">{shortAddress(shop.creator)}</span>
              {shop.creator.toLowerCase() !== shop.currentOwner.toLowerCase() ? (
                <span className="ml-2 text-xs text-amber-700">(NFT has been transferred)</span>
              ) : null}
            </p>
            <p>Created {created.toLocaleString()}</p>
          </div>
          {shop.description ? (
            <p className="whitespace-pre-line text-sm text-slate-700">{shop.description}</p>
          ) : (
            <p className="text-sm italic text-slate-400">No description set.</p>
          )}
          {shop.sharesInitialized ? (
            <p className="text-sm text-slate-700">
              <span className="font-semibold">{shop.totalShareholders}</span> token holder
              {shop.totalShareholders === 1 ? "" : "s"} ·{" "}
              <span className="font-semibold">{shop.totalSharesIssued}</span> tokens issued
            </p>
          ) : (
            <span className="inline-flex items-center rounded bg-amber-100 px-2 py-1 text-xs font-medium text-amber-900">
              Tokens not yet initialised — the owner can mint the 10 000 supply at any time
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
