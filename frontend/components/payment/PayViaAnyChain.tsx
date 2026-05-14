"use client";

import { useEffect, useState } from "react";
import { formatEther } from "viem";
import { useAccount, useChainId } from "wagmi";

import { PRIMARY_CHAIN, PRIMARY_CHAIN_ID, isPrimaryChain } from "@/lib/chains";
import { getCrossChainQuote, type CrossChainQuote } from "@/lib/lifi";

const NATIVE = "0x0000000000000000000000000000000000000000" as `0x${string}`;

type Props = {
  amountWei: bigint;
  label?: string;
  onDirectConfirm?: () => void;
  onCrossChainConfirm?: (quote: CrossChainQuote) => void;
};

export function PayViaAnyChain({
  amountWei,
  label,
  onDirectConfirm,
  onCrossChainConfirm
}: Props) {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const onPrimary = isPrimaryChain(chainId);

  const [quote, setQuote] = useState<CrossChainQuote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState<string | undefined>();
  const [status, setStatus] = useState("Ready");

  useEffect(() => {
    if (onPrimary || !isConnected || !address || !chainId) {
      setQuote(null);
      setQuoteError(undefined);
      setQuoting(false);
      return;
    }

    let cancelled = false;
    setQuoting(true);
    setQuote(null);
    setQuoteError(undefined);

    getCrossChainQuote({
      fromChainId: chainId,
      fromToken: NATIVE,
      fromAmount: amountWei.toString(),
      fromAddress: address,
      toChainId: PRIMARY_CHAIN_ID,
      toToken: NATIVE
    })
      .then((nextQuote) => {
        if (!cancelled) {
          setQuote(nextQuote);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setQuoteError(error instanceof Error ? error.message : "Quote failed");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setQuoting(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [onPrimary, isConnected, address, chainId, amountWei]);

  if (!isConnected) {
    return (
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
        Connect your wallet to pay.
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div>
        <div className="text-sm font-semibold text-slate-900">
          Pay for {label ?? "this order"}
        </div>
        <div className="mt-0.5 text-xs text-slate-600">
          Price: <span className="font-mono">{formatEther(amountWei)}</span> ETH on{" "}
          {PRIMARY_CHAIN.name}
        </div>
      </div>

      <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
        Status: <span className="font-medium text-slate-900">{status}</span>
      </div>

      {onPrimary ? (
        <DirectPathCard
          amountWei={amountWei}
          onConfirm={() => {
            console.log("[PayViaAnyChain] direct path confirmed");
            setStatus("Direct payment simulated. No transaction was sent.");
            onDirectConfirm?.();
          }}
        />
      ) : (
        <CrossChainPathCard
          currentChainId={chainId}
          quote={quote}
          quoting={quoting}
          error={quoteError}
          onConfirm={() => {
            if (quote) {
              console.log("[PayViaAnyChain] cross-chain path confirmed", quote);
              setStatus("Bridge and payment simulated. No transaction was sent.");
              onCrossChainConfirm?.(quote);
            }
          }}
        />
      )}
    </div>
  );
}

function DirectPathCard({
  amountWei,
  onConfirm
}: {
  amountWei: bigint;
  onConfirm?: () => void;
}) {
  return (
    <div className="rounded border border-emerald-200 bg-emerald-50 p-3">
      <div className="text-xs font-semibold text-emerald-800">Direct path</div>
      <div className="mt-0.5 text-xs text-emerald-700">
        Your wallet is already on {PRIMARY_CHAIN.name}. Pay in one signature.
      </div>
      <button
        onClick={onConfirm}
        className="mt-2 rounded bg-emerald-600 px-3 py-1.5 text-sm text-white hover:bg-emerald-700"
      >
        Pay {formatEther(amountWei)} ETH
      </button>
    </div>
  );
}

function CrossChainPathCard({
  currentChainId,
  quote,
  quoting,
  error,
  onConfirm
}: {
  currentChainId: number;
  quote: CrossChainQuote | null;
  quoting: boolean;
  error?: string;
  onConfirm: () => void;
}) {
  return (
    <div className="rounded border border-amber-200 bg-amber-50 p-3">
      <div className="text-xs font-semibold text-amber-900">Cross-chain path</div>
      <div className="mt-0.5 text-xs text-amber-800">
        Wallet on chain {currentChainId} to {PRIMARY_CHAIN.name}.
      </div>

      <div className="mt-3 space-y-1 text-xs">
        <Row label="Pay token" value="ETH" />
        {quoting && <div className="text-amber-700">Getting quote...</div>}
        {error && (
          <div className="rounded bg-red-50 p-2 text-red-700">
            Quote unavailable: {error}
          </div>
        )}
        {quote && (
          <>
            <Row
              label="You pay"
              value={`${formatEther(BigInt(quote.fromAmount))} ${quote.fromTokenSymbol}`}
            />
            <Row
              label="Marketplace receives"
              value={`${formatEther(BigInt(quote.toAmount))} ${quote.toTokenSymbol}`}
            />
            {quote.feeCostsUsd && <Row label="Bridge fee" value={`~$${quote.feeCostsUsd}`} />}
            {quote.gasCostsUsd && (
              <Row label="Gas on source chain" value={`~$${quote.gasCostsUsd}`} />
            )}
            <Row label="Estimated time" value={`~${quote.estimatedDurationSec}s`} />
          </>
        )}
      </div>

      <div className="mt-3 rounded bg-amber-100 p-2 text-[11px] text-amber-900">
        Two-step process:
        <ol className="ml-4 mt-1 list-decimal space-y-0.5">
          <li>Sign bridge transaction on your current chain</li>
          <li>
            After bridge completes (~{quote?.estimatedDurationSec ?? "45"}s), sign payment on{" "}
            {PRIMARY_CHAIN.name}
          </li>
        </ol>
      </div>

      <button
        onClick={onConfirm}
        disabled={!quote || quoting}
        className="mt-3 rounded bg-amber-600 px-3 py-1.5 text-sm text-white hover:bg-amber-700 disabled:opacity-50"
      >
        {quoting ? "Quoting..." : "Bridge & Pay"}
      </button>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 text-amber-900">
      <span className="text-amber-700">{label}:</span>
      <span className="break-all text-right font-mono">{value}</span>
    </div>
  );
}
