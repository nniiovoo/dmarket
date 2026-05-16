"use client";

import { useState } from "react";
import type { Address } from "viem";
import { erc20Abi } from "viem";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";

import { decodeDappError, type DappError } from "@/lib/errors";
import { PRIMARY_CHAIN_ID } from "@/lib/chains";
import {
  getV3_3ShareMarketAddress,
  shareMarketAbi,
  NATIVE_TOKEN
} from "@/lib/contractsV3_3";
import { useEnsureChain } from "@/lib/useEnsureChain";
import type { ShopListing } from "@/lib/api/shops";

interface Props {
  listing: ShopListing;
  onConfirmed?: () => void;
}

type Status = "idle" | "checking-allowance" | "approving" | "filling" | "success" | "error";

/// Buy any positive number of tokens up to the remaining amount of a
/// partial-fill listing (Phase M.1). The buyer enters a quantity; the
/// component computes totalCost = pricePerToken × amount and:
///   - native: writeContract fillListing(listingId, amount) with msg.value=totalCost
///   - ERC-20: ensure allowance ≥ totalCost (USDT-safe race-free reset
///     when the existing allowance is non-zero and < totalCost); then
///     fillListing(listingId, amount) with msg.value=0.
///
/// Legacy K.4 listings (no pricePerToken / remainingAmount fields in
/// the row) are now rare — the indexer back-fills both on M.1 listings,
/// and K.4 listings are all in non-Active terminal states. We still
/// fall back to totalPrice + amount for safety so a stale row renders
/// instead of crashing.
export function BuyListingButton({ listing, onConfirmed }: Props) {
  const { address: connected } = useAccount();
  const publicClient = usePublicClient({ chainId: PRIMARY_CHAIN_ID });
  const { writeContractAsync } = useWriteContract();
  const { ensure } = useEnsureChain();
  const shareMarketAddress = getV3_3ShareMarketAddress(PRIMARY_CHAIN_ID);

  const remainingBig = (() => {
    if (listing.remainingAmount !== null) {
      try {
        return BigInt(listing.remainingAmount);
      } catch {
        // fallthrough
      }
    }
    return BigInt(listing.amount);
  })();
  const pricePerTokenBig = (() => {
    if (listing.pricePerToken !== null) {
      try {
        return BigInt(listing.pricePerToken);
      } catch {
        // fallthrough
      }
    }
    // Legacy fallback: derive from totalPrice / originalAmount.
    const origin = listing.originalAmount ?? listing.amount;
    try {
      return BigInt(listing.totalPrice) / BigInt(origin);
    } catch {
      return 0n;
    }
  })();

  const [amountStr, setAmountStr] = useState<string>(remainingBig.toString());
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<DappError | undefined>();
  const [approveHash, setApproveHash] = useState<string | undefined>();
  const [fillHash, setFillHash] = useState<string | undefined>();

  if (!shareMarketAddress) return null;
  if (!connected) {
    return (
      <span className="text-xs text-slate-500">Connect a wallet to buy from this listing.</span>
    );
  }
  if (listing.seller.toLowerCase() === connected.toLowerCase()) {
    // Caller is the seller — Buy isn't the relevant action; CancelListingButton renders instead.
    return null;
  }

  const isNative = listing.paymentToken.toLowerCase() === NATIVE_TOKEN.toLowerCase();

  const amountBig: bigint | undefined = (() => {
    if (!/^\d+$/.test(amountStr)) return undefined;
    try {
      const v = BigInt(amountStr);
      return v > 0n ? v : undefined;
    } catch {
      return undefined;
    }
  })();
  const validAmount = amountBig !== undefined && amountBig <= remainingBig;
  const totalCost = amountBig !== undefined ? pricePerTokenBig * amountBig : 0n;

  async function onClick() {
    setError(undefined);
    setApproveHash(undefined);
    setFillHash(undefined);

    if (!publicClient) {
      setError({ title: "Wallet error", message: "No public client.", tone: "warning", category: "unknown" });
      setStatus("error");
      return;
    }
    if (!validAmount || amountBig === undefined) {
      setError({
        title: "Invalid amount",
        message: `Enter a positive amount up to ${remainingBig.toString()}.`,
        tone: "warning",
        category: "unknown"
      });
      setStatus("error");
      return;
    }
    try {
      try {
        await ensure(PRIMARY_CHAIN_ID);
      } catch (err) {
        setError(decodeDappError(err));
        setStatus("error");
        return;
      }

      // ERC-20 path: ensure allowance ≥ totalCost.
      if (!isNative) {
        setStatus("checking-allowance");
        const token = listing.paymentToken as Address;
        const current = (await publicClient.readContract({
          address: token,
          abi: erc20Abi,
          functionName: "allowance",
          args: [connected!, shareMarketAddress!]
        })) as bigint;
        if (current < totalCost) {
          setStatus("approving");
          // USDT-safe race-free approve: zero first if there's stale allowance.
          if (current > 0n) {
            const resetHash = await writeContractAsync({
              address: token,
              abi: erc20Abi,
              functionName: "approve",
              args: [shareMarketAddress!, 0n]
            });
            await publicClient.waitForTransactionReceipt({ hash: resetHash });
          }
          const hash = await writeContractAsync({
            address: token,
            abi: erc20Abi,
            functionName: "approve",
            args: [shareMarketAddress!, totalCost]
          });
          setApproveHash(hash);
          await publicClient.waitForTransactionReceipt({ hash });
        }
      }

      // Fill `amount` tokens. Native: send value alongside; ERC-20: msg.value must be 0.
      setStatus("filling");
      const hash = await writeContractAsync({
        address: shareMarketAddress!,
        abi: shareMarketAbi,
        functionName: "fillListing",
        args: [BigInt(listing.listingId), amountBig],
        value: isNative ? totalCost : 0n
      });
      setFillHash(hash);
      await publicClient.waitForTransactionReceipt({ hash });
      setStatus("success");
      onConfirmed?.();
    } catch (err) {
      setError(decodeDappError(err));
      setStatus("error");
    }
  }

  const buttonLabel =
    status === "checking-allowance"
      ? "Checking allowance…"
      : status === "approving"
      ? "Approving…"
      : status === "filling"
      ? "Buying…"
      : status === "success"
      ? "Bought ✓"
      : isNative
      ? "Buy"
      : "Approve & Buy";

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={amountStr}
          onChange={(e) => setAmountStr(e.target.value)}
          aria-label="How many tokens to buy?"
          placeholder={`up to ${remainingBig.toString()}`}
          className="w-24 rounded-md border border-slate-300 px-2 py-1 text-xs tabular-nums"
        />
        <button
          type="button"
          onClick={() => void onClick()}
          disabled={status === "approving" || status === "filling" || status === "checking-allowance" || !validAmount}
          className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-40"
        >
          {buttonLabel}
        </button>
      </div>
      <span className="text-[10px] text-slate-500 tabular-nums">
        {amountBig !== undefined ? (
          <>cost: {totalCost.toString()} base units · remaining {remainingBig.toString()}</>
        ) : (
          <>remaining {remainingBig.toString()} tokens</>
        )}
      </span>
      {approveHash ? (
        <span className="text-[10px] text-slate-500">approve {approveHash.slice(0, 10)}…</span>
      ) : null}
      {fillHash ? (
        <span className="text-[10px] text-slate-500">fill {fillHash.slice(0, 10)}…</span>
      ) : null}
      {error ? <span className="text-[10px] text-red-600">{error.title}: {error.message}</span> : null}
    </div>
  );
}
