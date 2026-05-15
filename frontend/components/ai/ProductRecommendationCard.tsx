"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatEther } from "viem";

import type { CandidateReputation, CandidateWithMeta } from "@/lib/ai/recommend";
import { convertEthWeiToToken, MOCK_ETH_TO_MUSD } from "@/lib/payment/tokenAmount";
import { getAcceptedTokens } from "@/lib/contractsV3_2";

interface Props {
  candidate: CandidateWithMeta;
}

function reputationBadge(rep: CandidateReputation): { label: string; tone: "gold" | "blue" | "gray" } {
  if (rep.sentinel) return { label: `New seller (${rep.sampleSize} orders)`, tone: "blue" };
  if (rep.score !== null && rep.score >= 700) {
    return { label: `★ ${rep.score} (${rep.sampleSize} orders)`, tone: "gold" };
  }
  return { label: `${rep.score ?? "—"} / 1000 (${rep.sampleSize} orders)`, tone: "gray" };
}

function toneClass(tone: "gold" | "blue" | "gray"): string {
  switch (tone) {
    case "gold":
      return "bg-amber-100 text-amber-900 border-amber-300";
    case "blue":
      return "bg-blue-100 text-blue-900 border-blue-300";
    case "gray":
      return "bg-gray-100 text-gray-700 border-gray-300";
  }
}

export function ProductRecommendationCard({ candidate }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { product, reputation, reasoning } = candidate;
  const badge = reputationBadge(reputation);

  const tokens = getAcceptedTokens(product.chainId);
  const erc20 = tokens[0]; // mUSD on Arbitrum Sepolia (currently the only one)
  const priceWei = BigInt(product.priceWei);
  const usdcEstimate = erc20 ? convertEthWeiToToken(priceWei, erc20) : null;

  async function onBuy() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/ai/draft-order", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ productId: product.id, expectedPriceWei: product.priceWei })
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; reason?: string };
        if (res.status === 401) {
          setError("Connect your wallet (top-right) and sign in before drafting an order.");
        } else if (res.status === 409) {
          setError("Price changed since you started shopping. Re-run the search.");
        } else {
          setError(`Draft failed (${res.status}): ${body.error ?? "unknown"}${body.reason ? ` — ${body.reason}` : ""}`);
        }
        return;
      }
      const draft = (await res.json()) as { signUrl: string };
      // signUrl is same-origin in dev (http://localhost:3000/sign/...) and
      // absolute in prod. Either way push() routes the user to the wallet
      // handoff page.
      const url = new URL(draft.signUrl, window.location.origin);
      if (url.origin === window.location.origin) {
        router.push(url.pathname);
      } else {
        window.location.assign(draft.signUrl);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-semibold">{product.name}</div>
          <div className="mt-0.5 text-xs text-gray-500">id #{product.id} · chain {product.chainId}</div>
        </div>
        <span className={`whitespace-nowrap rounded border px-2 py-0.5 text-xs font-medium ${toneClass(badge.tone)}`}>
          {badge.label}
        </span>
      </div>

      <div className="mt-3 flex items-center gap-3 text-sm">
        <div>
          <div className="font-medium">{formatEther(priceWei)} ETH</div>
          {usdcEstimate !== null && erc20 ? (
            <div className="text-xs text-gray-500">
              ≈ {(Number(usdcEstimate) / 10 ** erc20.decimals).toFixed(2)} {erc20.symbol}
              <span className="ml-1 text-gray-400">(mock 1 ETH = {MOCK_ETH_TO_MUSD.toString()} {erc20.symbol})</span>
            </div>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => void onBuy()}
          disabled={busy}
          className="ml-auto rounded-md bg-black px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-40"
        >
          {busy ? "Drafting…" : "Buy"}
        </button>
      </div>

      <div className="mt-2 text-xs text-gray-500">{reasoning}</div>
      {error ? <div className="mt-2 text-xs text-red-600">{error}</div> : null}
    </div>
  );
}
