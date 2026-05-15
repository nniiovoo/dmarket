"use client";

import type { Address } from "viem";

import { useReputation, type OnChainAttestation } from "@/lib/reputation/useReputation";

type Props = {
  sellerAddress: Address;
  variant?: "compact" | "full";
  showRefreshButton?: boolean;
};

const ARBISCAN_TX_BASE = "https://sepolia.arbiscan.io/tx";
const MIN_SAMPLE_SIZE = 5; // Mirrors the gate in lib/reputation/score.ts.

export function ReputationBadge({ sellerAddress, variant = "compact", showRefreshButton = false }: Props) {
  const { data, isLoading, error } = useReputation(sellerAddress);

  if (isLoading) {
    return variant === "full" ? <FullSkeleton /> : <CompactSkeleton />;
  }

  if (error || !data) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-zinc-100 px-2 py-0.5 text-xs text-zinc-500">
        ★ —
      </span>
    );
  }

  const cached = data.cached;
  const onChain = data.onChain;
  const sampleSize = cached?.sampleSize ?? data.sampleSize;
  const lowSample = sampleSize < MIN_SAMPLE_SIZE;

  if (lowSample) {
    return variant === "full" ? (
      <FullCard>
        <p className="text-sm text-zinc-600">New seller — not enough order history yet ({sampleSize} orders).</p>
      </FullCard>
    ) : (
      <span className="inline-flex items-center gap-1 rounded-md bg-zinc-100 px-2 py-0.5 text-xs text-zinc-500">
        New seller
      </span>
    );
  }

  const displayedScore = onChain?.score ?? cached?.score ?? 500;
  const tone = scoreTone(displayedScore);
  const verifiedOnChain = onChain !== null;

  if (variant === "compact") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md bg-zinc-50 px-2 py-0.5 text-xs">
        <span className={`font-semibold ${tone}`}>★ {displayedScore}</span>
        {verifiedOnChain ? (
          <span className="text-emerald-600">✓ Verified</span>
        ) : (
          <span className="text-zinc-500">Off-chain</span>
        )}
      </span>
    );
  }

  return (
    <FullCard>
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-medium text-slate-700">Reputation Score</h3>
        <span className={`text-2xl font-semibold ${tone}`}>★ {displayedScore} <span className="text-sm text-slate-400">/ 1000</span></span>
      </div>
      <p className="mt-1 text-xs text-slate-500">
        {verifiedOnChain ? (
          <>
            ✓ Verified on-chain · v={onChain!.version} · expires {formatDate(onChain!.expiry)}
          </>
        ) : (
          <>Computed (not yet on-chain)</>
        )}
      </p>

      {cached ? (
        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-1 border-t border-slate-200 pt-3 text-sm">
          <dt className="text-slate-500">Completed orders</dt>
          <dd className="text-right text-slate-900">{cached.components.completedOrders}</dd>
          <dt className="text-slate-500">Dispute rate</dt>
          <dd className="text-right text-slate-900">{formatPercent(cached.components.disputeRate)}</dd>
          <dt className="text-slate-500">Refund rate</dt>
          <dd className="text-right text-slate-900">{formatPercent(cached.components.refundRate)}</dd>
          <dt className="text-slate-500">Avg fulfillment</dt>
          <dd className="text-right text-slate-900">{formatHours(cached.components.avgFulfillmentHours)}</dd>
          <dt className="text-slate-500">Account age</dt>
          <dd className="text-right text-slate-900">{formatDays(cached.components.accountAgeDays)}</dd>
          <dt className="text-slate-500">Sample size</dt>
          <dd className="text-right text-slate-900">{sampleSize}</dd>
        </dl>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-200 pt-3">
        {verifiedOnChain ? (
          <a
            href={`${ARBISCAN_TX_BASE}/${onChain!.txHash}`}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-blue-700 underline"
          >
            View on-chain attestation →
          </a>
        ) : (
          <span className="text-xs text-slate-400">No on-chain attestation yet</span>
        )}
        {showRefreshButton ? <PublishButton onChain={onChain} /> : null}
      </div>
    </FullCard>
  );
}

function PublishButton({ onChain }: { onChain: OnChainAttestation | null }) {
  // Self-publish from the seller's wallet is Phase F work — for now this
  // surfaces the action and explains why it isn't wired up.
  const label = onChain ? "Publish update on-chain" : "Publish on-chain";
  return (
    <button
      type="button"
      disabled
      title="Coming soon — self-publish via the seller wallet"
      className="rounded-md bg-slate-100 px-3 py-1 text-xs font-medium text-slate-400"
    >
      {label}
    </button>
  );
}

function FullCard({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">{children}</div>;
}

function CompactSkeleton() {
  return <span className="inline-block h-5 w-20 animate-pulse rounded-md bg-zinc-100" />;
}

function FullSkeleton() {
  return (
    <FullCard>
      <div className="h-4 w-32 animate-pulse rounded bg-zinc-100" />
      <div className="mt-2 h-8 w-24 animate-pulse rounded bg-zinc-100" />
      <div className="mt-4 h-3 w-full animate-pulse rounded bg-zinc-100" />
    </FullCard>
  );
}

function scoreTone(score: number) {
  if (score >= 700) return "text-green-600";
  if (score >= 400) return "text-amber-600";
  if (score < 400) return "text-red-600";
  return "text-zinc-500";
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString();
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatHours(value: number): string {
  if (value < 1) return "<1 hour";
  return `${Math.round(value)} hours`;
}

function formatDays(value: number): string {
  return `${Math.round(value)} days`;
}
