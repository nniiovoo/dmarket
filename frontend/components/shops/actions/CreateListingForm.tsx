"use client";

import { useState } from "react";
import type { Address } from "viem";
import { parseEther, parseUnits } from "viem";
import { useAccount, usePublicClient, useReadContract, useWriteContract } from "wagmi";

import { Card } from "@/components/Card";
import { decodeDappError, type DappError } from "@/lib/errors";
import { PRIMARY_CHAIN_ID } from "@/lib/chains";
import { getAcceptedTokens } from "@/lib/contractsV3_2";
import {
  getV3_3ShareMarketAddress,
  getV3_3ShopSharesAddress,
  shareMarketAbi,
  shopSharesAbi,
  NATIVE_TOKEN
} from "@/lib/contractsV3_3";
import { useEnsureChain } from "@/lib/useEnsureChain";

type Status = "idle" | "checking-approval" | "approving" | "listing" | "success" | "error";

interface Props {
  shopId: number;
  shareBalance: bigint | undefined;
  onConfirmed?: () => void;
}

interface TokenChoice {
  symbol: string;
  address: Address;
  decimals: number;
}

/// Two-step sell-shares flow:
///   1. If isApprovedForAll(shares, market) === false → setApprovalForAll
///      (one-time gesture per seller; subsequent listings skip this).
///   2. createListing(shopId, amount, paymentToken, totalPrice).
///
/// Mounted on /shops/[id] only when the connected wallet holds ≥ 1
/// share of the shop. The component embeds its own status pill so the
/// approve → list flow can sequence its tx hashes; TxPanel doesn't
/// model multi-step writes.
export function CreateListingForm({ shopId, shareBalance, onConfirmed }: Props) {
  const { address: connected } = useAccount();
  const publicClient = usePublicClient({ chainId: PRIMARY_CHAIN_ID });
  const { writeContractAsync } = useWriteContract();
  const { ensure } = useEnsureChain();

  const sharesAddress = getV3_3ShopSharesAddress(PRIMARY_CHAIN_ID);
  const shareMarketAddress = getV3_3ShareMarketAddress(PRIMARY_CHAIN_ID);
  const acceptedTokens = getAcceptedTokens(PRIMARY_CHAIN_ID);
  const tokenChoices: TokenChoice[] = [
    { symbol: "ETH", address: NATIVE_TOKEN, decimals: 18 },
    ...acceptedTokens.map<TokenChoice>((t) => ({
      symbol: t.symbol,
      address: t.address,
      decimals: t.decimals
    }))
  ];

  const approvalQuery = useReadContract({
    address: sharesAddress,
    abi: shopSharesAbi,
    functionName: "isApprovedForAll",
    args: connected ? [connected, shareMarketAddress!] : undefined,
    query: { enabled: Boolean(sharesAddress && shareMarketAddress && connected) }
  });

  const [expanded, setExpanded] = useState(false);
  const [amount, setAmount] = useState("");
  const [token, setToken] = useState<Address>(NATIVE_TOKEN);
  const [priceInput, setPriceInput] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [approveHash, setApproveHash] = useState<string | undefined>();
  const [listHash, setListHash] = useState<string | undefined>();
  const [error, setError] = useState<DappError | undefined>();

  if (!sharesAddress || !shareMarketAddress) return null;
  if (!connected) return null;

  const tokenChoice = tokenChoices.find((t) => t.address.toLowerCase() === token.toLowerCase());
  const decimals = tokenChoice?.decimals ?? 18;
  const symbol = tokenChoice?.symbol ?? "ETH";

  const amountBig = (() => {
    if (!/^\d+$/.test(amount)) return undefined;
    try {
      return BigInt(amount);
    } catch {
      return undefined;
    }
  })();
  const priceBig = (() => {
    if (priceInput.trim() === "") return undefined;
    try {
      return decimals === 18 ? parseEther(priceInput) : parseUnits(priceInput, decimals);
    } catch {
      return undefined;
    }
  })();

  const validAmount = amountBig !== undefined && amountBig > 0n;
  const balanceOk =
    shareBalance === undefined ||
    (amountBig !== undefined && amountBig <= shareBalance);
  const validPrice = priceBig !== undefined && priceBig > 0n;
  const formValid = validAmount && balanceOk && validPrice;

  const isApproved = (approvalQuery.data as boolean | undefined) === true;

  async function onSubmit() {
    setError(undefined);
    setApproveHash(undefined);
    setListHash(undefined);
    if (!formValid || amountBig === undefined || priceBig === undefined) return;

    try {
      try {
        await ensure(PRIMARY_CHAIN_ID);
      } catch (err) {
        setError(decodeDappError(err));
        setStatus("error");
        return;
      }

      if (!isApproved) {
        setStatus("approving");
        const hash = await writeContractAsync({
          address: sharesAddress!,
          abi: shopSharesAbi,
          functionName: "setApprovalForAll",
          args: [shareMarketAddress!, true]
        });
        setApproveHash(hash);
        await publicClient?.waitForTransactionReceipt({ hash });
        // Re-poll so the cached value flips to true.
        await approvalQuery.refetch();
      }

      setStatus("listing");
      const hash = await writeContractAsync({
        address: shareMarketAddress!,
        abi: shareMarketAbi,
        functionName: "createListing",
        args: [BigInt(shopId), amountBig, token, priceBig]
      });
      setListHash(hash);
      await publicClient?.waitForTransactionReceipt({ hash });
      setStatus("success");
      onConfirmed?.();
      setAmount("");
      setPriceInput("");
    } catch (err) {
      setError(decodeDappError(err));
      setStatus("error");
    }
  }

  return (
    <Card>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="text-sm font-medium text-blue-600 hover:underline"
      >
        {expanded ? "▾" : "▸"} Sell shares
      </button>
      {expanded ? (
        <div className="mt-4 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-medium uppercase tracking-wide text-slate-600">
                Amount
              </label>
              <input
                type="text"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="e.g. 500"
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm tabular-nums"
              />
              <p className="mt-1 text-xs text-slate-500">
                You hold {shareBalance === undefined ? "…" : shareBalance.toString()} shares of shop #{shopId}.
              </p>
            </div>
            <div>
              <label className="block text-xs font-medium uppercase tracking-wide text-slate-600">
                Payment token
              </label>
              <select
                value={token}
                onChange={(e) => setToken(e.target.value as Address)}
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
              >
                {tokenChoices.map((t) => (
                  <option key={t.address} value={t.address}>
                    {t.symbol}
                    {t.address === NATIVE_TOKEN ? "" : ` (${t.address.slice(0, 6)}…)`}
                  </option>
                ))}
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium uppercase tracking-wide text-slate-600">
                Total price ({symbol})
              </label>
              <input
                type="text"
                value={priceInput}
                onChange={(e) => setPriceInput(e.target.value)}
                placeholder="e.g. 0.001"
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm tabular-nums"
              />
              <p className="mt-1 text-xs text-slate-500">
                Total price for the whole batch — buyers fill the listing all-or-nothing.
              </p>
            </div>
          </div>

          {!isApproved ? (
            <p className="text-xs text-amber-700">
              First listing requires a one-time setApprovalForAll. You&apos;ll sign two
              transactions: approval, then the listing itself.
            </p>
          ) : null}

          {amountBig !== undefined && shareBalance !== undefined && amountBig > shareBalance ? (
            <p className="text-xs text-red-600">
              Amount exceeds your balance ({shareBalance.toString()} shares).
            </p>
          ) : null}

          <button
            type="button"
            onClick={() => void onSubmit()}
            disabled={!formValid || status === "approving" || status === "listing"}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-40"
          >
            {status === "approving"
              ? "Approving…"
              : status === "listing"
              ? "Creating listing…"
              : status === "success"
              ? "Listed ✓"
              : !isApproved
              ? "Approve & list"
              : "Create listing"}
          </button>

          {approveHash ? (
            <p className="text-[10px] text-slate-500">approve {approveHash.slice(0, 10)}…</p>
          ) : null}
          {listHash ? (
            <p className="text-[10px] text-slate-500">list {listHash.slice(0, 10)}…</p>
          ) : null}
          {error ? (
            <p className="text-xs text-red-600">
              {error.title}: {error.message}
            </p>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
