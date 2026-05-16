"use client";

import Link from "next/link";
import { useState } from "react";
import { formatEther, formatUnits } from "viem";

import { EmptyState } from "@/components/Card";
import { BuyListingButton } from "@/components/shops/actions/BuyListingButton";
import { CancelListingButton } from "@/components/shops/actions/CancelListingButton";
import { getAcceptedTokens, type AcceptedToken } from "@/lib/contractsV3_2";
import { PRIMARY_CHAIN_ID } from "@/lib/chains";
import type { ShopListing } from "@/lib/api/shops";

const ARBISCAN_TX_BASE = "https://sepolia.arbiscan.io/tx";
const ARBISCAN_ADDRESS_BASE = "https://sepolia.arbiscan.io/address";
const NATIVE = "0x0000000000000000000000000000000000000000";

function shortAddress(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function tokenByAddress(token: string): AcceptedToken | undefined {
  const accepted = getAcceptedTokens(PRIMARY_CHAIN_ID);
  return accepted.find((t) => t.address.toLowerCase() === token.toLowerCase());
}

function formatAmountInToken(raw: bigint, paymentToken: string): string {
  if (paymentToken.toLowerCase() === NATIVE) {
    return `${formatEther(raw)} ETH`;
  }
  const meta = tokenByAddress(paymentToken);
  if (meta) {
    return `${formatUnits(raw, meta.decimals)} ${meta.symbol}`;
  }
  return `${raw.toString()} (raw, token ${shortAddress(paymentToken)})`;
}

interface Props {
  listings: ShopListing[];
  onChange?: () => void;
}

export function ListingsList({ listings, onChange }: Props) {
  const active = listings.filter((l) => l.status === "Active");
  const filled = listings.filter((l) => l.status === "Filled");
  const cancelled = listings.filter((l) => l.status === "Cancelled");
  const [showClosed, setShowClosed] = useState(false);

  return (
    <div className="space-y-4">
      <section>
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-600">
          Active ({active.length})
        </h3>
        {active.length === 0 ? (
          <EmptyState
            title="No active listings"
            body="When a token holder posts tokens for sale, the listing shows up here. Use the Sell-tokens form below if you hold tokens of this shop."
          />
        ) : (
          <ul className="space-y-2">
            {active.map((l) => (
              <ListingRow key={l.listingId} listing={l} onChange={onChange} />
            ))}
          </ul>
        )}
      </section>

      {filled.length + cancelled.length > 0 ? (
        <section>
          <button
            type="button"
            onClick={() => setShowClosed((v) => !v)}
            className="text-sm font-medium text-blue-600 hover:underline"
          >
            {showClosed ? "Hide" : "Show"} closed listings ({filled.length} filled, {cancelled.length} cancelled)
          </button>
          {showClosed ? (
            <ul className="mt-3 space-y-2">
              {[...filled, ...cancelled].map((l) => (
                <ListingRow key={l.listingId} listing={l} onChange={onChange} />
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function ListingRow({ listing, onChange }: { listing: ShopListing; onChange?: () => void }) {
  const statusTone =
    listing.status === "Active"
      ? "bg-emerald-100 text-emerald-900"
      : listing.status === "Filled"
      ? "bg-blue-100 text-blue-900"
      : "bg-slate-100 text-slate-600";

  // M.1: prefer per-token pricing + remaining-of-original. Legacy K.4
  // listings (no pricePerToken column) fall back to the old labels.
  const originalAmount = listing.originalAmount ?? listing.amount;
  const remainingAmount = listing.remainingAmount ?? listing.amount;
  const pricePerTokenBig = listing.pricePerToken
    ? BigInt(listing.pricePerToken)
    : (() => {
        try {
          return BigInt(listing.totalPrice) / BigInt(originalAmount);
        } catch {
          return 0n;
        }
      })();
  const pricePerTokenLabel = formatAmountInToken(pricePerTokenBig, listing.paymentToken);

  return (
    <li className="rounded-md border border-slate-200 bg-slate-50 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-0.5 text-sm">
          <div className="font-medium text-slate-900">
            Listing #{listing.listingId} ·{" "}
            <span className="font-mono">{remainingAmount}</span>
            {" / "}
            <span className="font-mono">{originalAmount}</span> tokens left @{" "}
            <span className="font-mono">{pricePerTokenLabel}</span> per token
          </div>
          <div className="text-xs text-slate-600">
            Seller{" "}
            <Link
              href={`${ARBISCAN_ADDRESS_BASE}/${listing.seller}`}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-blue-600 hover:underline"
            >
              {shortAddress(listing.seller)}
            </Link>{" "}
            · created block {listing.createdBlock}
          </div>
          {listing.buyer ? (
            <div className="text-xs text-slate-600">
              Filled by{" "}
              <Link
                href={`${ARBISCAN_ADDRESS_BASE}/${listing.buyer}`}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-blue-600 hover:underline"
              >
                {shortAddress(listing.buyer)}
              </Link>
            </div>
          ) : null}
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex items-center gap-2">
            <span className={`rounded px-2 py-0.5 text-xs font-medium ${statusTone}`}>
              {listing.status}
            </span>
            <Link
              href={`${ARBISCAN_TX_BASE}/${listing.closedTxHash ?? listing.createdTxHash}`}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-blue-600 hover:underline"
            >
              tx ↗
            </Link>
          </div>
          {listing.status === "Active" ? (
            <>
              <BuyListingButton listing={listing} onConfirmed={onChange} />
              <CancelListingButton listing={listing} onConfirmed={onChange} />
            </>
          ) : null}
        </div>
      </div>
    </li>
  );
}
