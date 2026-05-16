"use client";

import Link from "next/link";
import { useState } from "react";

import { EmptyState } from "@/components/Card";
import type { ShopHolding } from "@/lib/api/shops";

const ARBISCAN_ADDRESS_BASE = "https://sepolia.arbiscan.io/address";
const COLLAPSED_ROWS = 10;

function shortAddress(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

interface Props {
  holdings: ShopHolding[];
  totalSharesIssued: string;
  sharesInitialized: boolean;
}

export function HoldingsTable({ holdings, totalSharesIssued, sharesInitialized }: Props) {
  const [expanded, setExpanded] = useState(false);

  if (!sharesInitialized) {
    return (
      <EmptyState
        title="Shares not yet initialised"
        body="The shop owner has not minted the share supply yet. Once they call initializeShares, 10 000 shares will appear here."
      />
    );
  }
  if (holdings.length === 0) {
    return (
      <EmptyState
        title="No holders"
        body="The indexer reports zero non-zero balances for this shop. This usually means the indexer is still catching up."
      />
    );
  }

  const visible = expanded ? holdings : holdings.slice(0, COLLAPSED_ROWS);
  const hidden = holdings.length - visible.length;

  return (
    <>
      <table className="min-w-full text-sm">
        <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="pb-2 font-medium">Holder</th>
            <th className="pb-2 text-right font-medium">Balance</th>
            <th className="pb-2 text-right font-medium">Share %</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {visible.map((h) => (
            <tr key={h.holder}>
              <td className="py-2 font-mono text-xs text-slate-700">
                <Link
                  href={`${ARBISCAN_ADDRESS_BASE}/${h.holder}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-blue-600 hover:underline"
                >
                  {shortAddress(h.holder)}
                </Link>
              </td>
              <td className="py-2 text-right tabular-nums text-slate-900">{h.balance}</td>
              <td className="py-2 text-right tabular-nums font-medium text-slate-900">
                {h.pct}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {hidden > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-3 text-xs font-medium text-blue-600 hover:underline"
        >
          Show {hidden} more holder{hidden === 1 ? "" : "s"}
        </button>
      ) : holdings.length > COLLAPSED_ROWS && expanded ? (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="mt-3 text-xs font-medium text-slate-500 hover:underline"
        >
          Collapse
        </button>
      ) : null}
      <p className="mt-3 text-xs text-slate-500">
        Total issued: <span className="font-mono">{totalSharesIssued}</span> shares
      </p>
    </>
  );
}
