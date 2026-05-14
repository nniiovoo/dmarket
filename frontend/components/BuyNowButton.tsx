"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { parseEther, type Address } from "viem";

import { PayViaAnyChain } from "@/components/payment/PayViaAnyChain";
import { PRIMARY_CHAIN_ID } from "@/lib/chains";

type BuyNowButtonProps = {
  seller: Address | string;
  productId: bigint;
  priceEth: string;
  productName?: string;
  productImageUrl?: string;
  productStatus?: string;
  disabled?: boolean;
  disabledReason?: string;
  label?: string;
};

export function BuyNowButton({
  seller,
  productId,
  priceEth,
  productName,
  disabled,
  disabledReason,
  label
}: BuyNowButtonProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const amountWei = safeParseEther(priceEth);
  const buttonDisabled = disabled || amountWei === undefined;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={buttonDisabled}
        aria-label={productName ? `Buy ${productName}` : "Buy now"}
        className="mt-4 inline-flex w-full justify-center rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
      >
        {label ?? `Buy now (${priceEth} ETH)`}
      </button>
      {buttonDisabled && disabledReason ? <p className="mt-2 text-sm text-slate-500">{disabledReason}</p> : null}

      {open && amountWei !== undefined ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-lg bg-white p-5 shadow-lg"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold text-slate-950">Complete purchase</h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded px-2 py-1 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                aria-label="Close purchase dialog"
              >
                x
              </button>
            </div>

            <PayViaAnyChain
              amountWei={amountWei}
              label={productName ?? "Order"}
              executeMode="live"
              seller={seller as Address}
              productId={productId}
              onOrderCreated={(orderId, txHash) => {
                console.log("[BuyNow] order created", orderId, txHash);
                setOpen(false);
                router.push(`/orders/${orderId.toString()}?chainId=${PRIMARY_CHAIN_ID}`);
              }}
              onError={(message) => {
                console.error("[BuyNow] error", message);
              }}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}

function safeParseEther(value: string) {
  try {
    return parseEther(value);
  } catch {
    return undefined;
  }
}
