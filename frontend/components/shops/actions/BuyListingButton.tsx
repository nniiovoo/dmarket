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

/// Buys the entire listing in one user-driven flow:
///   1. native: writeContract fillListing with msg.value=totalPrice
///   2. ERC-20: read current allowance(shareMarket); if < totalPrice,
///      forceApprove via standard approve(spender, value) (USDT-safe
///      because we reset to 0 first when there's a stale value);
///      then fillListing with msg.value=0.
///
/// The component embeds a small status pill and a per-step tx hash log
/// — it doesn't lean on TxPanel because the multi-step flow (approve
/// then fill) needs sequenced state that TxPanel doesn't expose.
export function BuyListingButton({ listing, onConfirmed }: Props) {
  const { address: connected } = useAccount();
  const publicClient = usePublicClient({ chainId: PRIMARY_CHAIN_ID });
  const { writeContractAsync } = useWriteContract();
  const { ensure } = useEnsureChain();
  const shareMarketAddress = getV3_3ShareMarketAddress(PRIMARY_CHAIN_ID);

  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<DappError | undefined>();
  const [approveHash, setApproveHash] = useState<string | undefined>();
  const [fillHash, setFillHash] = useState<string | undefined>();

  if (!shareMarketAddress) return null;
  if (!connected) {
    return (
      <span className="text-xs text-slate-500">Connect a wallet to buy this listing.</span>
    );
  }
  if (listing.seller.toLowerCase() === connected.toLowerCase()) {
    // Caller is the seller — Buy isn't the relevant action; CancelListingButton renders instead.
    return null;
  }

  const totalPrice = BigInt(listing.totalPrice);
  const isNative = listing.paymentToken.toLowerCase() === NATIVE_TOKEN.toLowerCase();

  async function onClick() {
    setError(undefined);
    setApproveHash(undefined);
    setFillHash(undefined);

    if (!publicClient) {
      setError({ title: "Wallet error", message: "No public client.", tone: "warning", category: "unknown" });
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

      // ERC-20 path: ensure allowance ≥ totalPrice.
      if (!isNative) {
        setStatus("checking-allowance");
        const token = listing.paymentToken as Address;
        const current = (await publicClient.readContract({
          address: token,
          abi: erc20Abi,
          functionName: "allowance",
          args: [connected!, shareMarketAddress!]
        })) as bigint;
        if (current < totalPrice) {
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
            args: [shareMarketAddress!, totalPrice]
          });
          setApproveHash(hash);
          await publicClient.waitForTransactionReceipt({ hash });
        }
      }

      // Fill the listing. Native: send value alongside; ERC-20: msg.value must be 0.
      setStatus("filling");
      const hash = await writeContractAsync({
        address: shareMarketAddress!,
        abi: shareMarketAbi,
        functionName: "fillListing",
        args: [BigInt(listing.listingId)],
        value: isNative ? totalPrice : 0n
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
      <button
        type="button"
        onClick={() => void onClick()}
        disabled={status === "approving" || status === "filling" || status === "checking-allowance"}
        className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-40"
      >
        {buttonLabel}
      </button>
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
