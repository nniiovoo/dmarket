"use client";

import { useState } from "react";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";

import { decodeDappError, type DappError } from "@/lib/errors";
import { PRIMARY_CHAIN_ID } from "@/lib/chains";
import { getV3_3ShareMarketAddress, shareMarketAbi } from "@/lib/contractsV3_3";
import { useEnsureChain } from "@/lib/useEnsureChain";
import type { ShopListing } from "@/lib/api/shops";

interface Props {
  listing: ShopListing;
  onConfirmed?: () => void;
}

/// Renders only when the connected wallet is the listing's seller.
/// Approval / cancel never moves any funds, so this is a single
/// writeContract call.
export function CancelListingButton({ listing, onConfirmed }: Props) {
  const { address: connected } = useAccount();
  const publicClient = usePublicClient({ chainId: PRIMARY_CHAIN_ID });
  const { writeContractAsync } = useWriteContract();
  const { ensure } = useEnsureChain();
  const shareMarketAddress = getV3_3ShareMarketAddress(PRIMARY_CHAIN_ID);

  const [busy, setBusy] = useState(false);
  const [txHash, setTxHash] = useState<string | undefined>();
  const [error, setError] = useState<DappError | undefined>();
  const [done, setDone] = useState(false);

  if (!shareMarketAddress || !connected) return null;
  if (listing.seller.toLowerCase() !== connected.toLowerCase()) return null;

  async function onClick() {
    setError(undefined);
    setTxHash(undefined);
    setDone(false);
    setBusy(true);
    try {
      try {
        await ensure(PRIMARY_CHAIN_ID);
      } catch (err) {
        throw err;
      }
      const hash = await writeContractAsync({
        address: shareMarketAddress!,
        abi: shareMarketAbi,
        functionName: "cancelListing",
        args: [BigInt(listing.listingId)]
      });
      setTxHash(hash);
      await publicClient?.waitForTransactionReceipt({ hash });
      setDone(true);
      onConfirmed?.();
    } catch (err) {
      setError(decodeDappError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={() => void onClick()}
        disabled={busy || done}
        className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
      >
        {done ? "Cancelled ✓" : busy ? "Cancelling…" : "Cancel listing"}
      </button>
      {txHash ? <span className="text-[10px] text-slate-500">{txHash.slice(0, 10)}…</span> : null}
      {error ? (
        <span className="text-[10px] text-red-600">
          {error.title}: {error.message}
        </span>
      ) : null}
    </div>
  );
}
