"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { erc20Abi, type Address } from "viem";
import { useAccount, useReadContract } from "wagmi";

import { PRIMARY_CHAIN_ID, getExplorerTxUrl } from "@/lib/chains";
import type { AcceptedToken } from "@/lib/contractsV3_2";
import { getV3_2ContractAddresses } from "@/lib/contractsV3_2";
import { useBuyNowERC20 } from "@/lib/useBuyNowERC20";

type Props = {
  seller: Address;
  productId: bigint;
  token: AcceptedToken;
  amount: bigint;
  productName?: string;
};

export function BuyNowERC20Button({ seller, productId, token, amount, productName }: Props) {
  const router = useRouter();
  const { address } = useAccount();
  const v3_2 = getV3_2ContractAddresses(PRIMARY_CHAIN_ID);
  const marketplace = v3_2?.marketplace;

  const allowanceQuery = useReadContract({
    address: token.address,
    abi: erc20Abi,
    chainId: PRIMARY_CHAIN_ID,
    functionName: "allowance",
    args: address && marketplace ? [address, marketplace] : undefined,
    query: { enabled: Boolean(address && marketplace) }
  });
  const allowance = allowanceQuery.data as bigint | undefined;
  const needsApprove = allowance === undefined ? true : allowance < amount;

  const { status, orderId, txHash, error, execute, reset } = useBuyNowERC20({
    sellerAddress: seller,
    productId,
    paymentToken: token.address,
    amount
  });

  const navigatedRef = useRef(false);

  useEffect(() => {
    if (status === "success" && orderId !== null && !navigatedRef.current) {
      navigatedRef.current = true;
      if (marketplace) {
        router.push(`/orders/v3_2/${PRIMARY_CHAIN_ID}/${marketplace}/${orderId.toString()}`);
      }
    }
  }, [status, orderId, router, marketplace]);

  const busy = status !== "idle" && status !== "success" && status !== "error";
  const label = busy
    ? statusLabel(status)
    : needsApprove
      ? `Approve ${token.symbol} → Pay`
      : `Pay with ${token.symbol}`;

  return (
    <div className="mt-4 space-y-3">
      <button
        type="button"
        onClick={() => {
          if (status === "error") reset();
          void execute();
        }}
        disabled={busy || !marketplace}
        aria-label={productName ? `Buy ${productName} with ${token.symbol}` : `Pay with ${token.symbol}`}
        className="inline-flex w-full justify-center rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
      >
        {label}
      </button>

      {!marketplace ? (
        <p className="text-xs text-slate-500">V3.2 marketplace is not configured for the primary chain.</p>
      ) : null}

      {status !== "idle" ? (
        <div className="rounded-md bg-slate-50 p-3 text-sm">
          <p className="font-medium capitalize text-slate-900">Status: {statusLabel(status)}</p>
          <TxLine label="Approve" hash={txHash.approve} />
          <TxLine label="Create order" hash={txHash.create} />
          <TxLine label="Pay" hash={txHash.pay} />
          {error ? (
            <div className={`mt-2 ${error.tone === "danger" ? "text-red-700" : "text-amber-700"}`}>
              <p className="font-medium">{error.title}</p>
              <p>{error.message}</p>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function TxLine({ label, hash }: { label: string; hash?: string }) {
  if (!hash) return null;
  const url = getExplorerTxUrl(PRIMARY_CHAIN_ID, hash);
  return (
    <p className="mt-1 break-all text-xs text-slate-600">
      {label}:{" "}
      {url ? (
        <a href={url} target="_blank" rel="noreferrer" className="text-blue-700 underline">
          {hash}
        </a>
      ) : (
        hash
      )}
    </p>
  );
}

function statusLabel(status: string) {
  switch (status) {
    case "checking-allowance":
      return "Checking allowance...";
    case "approving":
      return "Approving in wallet...";
    case "creating-order":
      return "Creating order...";
    case "paying":
      return "Paying...";
    case "success":
      return "Confirmed";
    case "error":
      return "Failed";
    default:
      return status;
  }
}
