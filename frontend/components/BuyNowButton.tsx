"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAccount, useChainId } from "wagmi";
import { parseEther } from "viem";

import { getExplorerTxUrl, getFaucetUrl } from "@/lib/chains";
import { hasMarketplace } from "@/lib/contracts";
import { useOptimisticOrder } from "@/lib/useOptimisticOrder";
import { useBuyNow } from "@/lib/useBuyNow";
import { Toast } from "@/components/Toast";
import { WalletPopupHint } from "@/components/WalletPopupHint";

type BuyNowButtonProps = {
  seller: string;
  productId: bigint;
  priceEth: string;
  productName: string;
  productImageUrl?: string;
  productStatus?: string;
  disabled?: boolean;
  disabledReason?: string;
};

export function BuyNowButton({
  seller,
  productId,
  priceEth,
  productName,
  productImageUrl = "",
  productStatus = "active",
  disabled: externallyDisabled,
  disabledReason
}: BuyNowButtonProps) {
  const router = useRouter();
  const chainId = useChainId();
  const { address, connector, isConnected } = useAccount();
  const [connectorChainId, setConnectorChainId] = useState<number | undefined>();
  const { state, buyNow, reset } = useBuyNow();
  const optimistic = useOptimisticOrder();
  const handledConfirmedOrder = useRef<string | undefined>(undefined);
  const hash = state.kind === "submitted" || state.kind === "confirmed" ? state.hash : undefined;
  const txUrl = getExplorerTxUrl(chainId, hash);
  const faucetUrl = getFaucetUrl(chainId);
  const effectiveWalletChainId = connectorChainId ?? chainId;
  const unsupported = isConnected && (!hasMarketplace(effectiveWalletChainId) || effectiveWalletChainId !== chainId);
  const disabled = externallyDisabled || unsupported || state.kind === "waitingSignature" || state.kind === "submitted";
  const effectiveDisabledReason = unsupported ? "Switch to a supported chain before buying." : disabledReason;
  const errorTone =
    state.kind === "failed"
      ? state.error.tone === "danger"
        ? "border-red-200 bg-red-50 text-red-800"
        : "border-amber-200 bg-amber-50 text-amber-900"
      : "";

  useEffect(() => {
    if (state.kind !== "confirmed" || state.orderId === undefined || address === undefined) {
      return undefined;
    }

    const orderId = state.orderId.toString();
    if (handledConfirmedOrder.current === orderId) {
      return undefined;
    }

    handledConfirmedOrder.current = orderId;
    const timeout = window.setTimeout(() => {
      optimistic.addPending({
        chainId,
        onChainOrderId: orderId,
        buyer: address.toLowerCase(),
        seller: seller.toLowerCase(),
        productId: productId.toString(),
        amountWei: toWeiString(priceEth),
        product: toProductSummary(productId, productName, productImageUrl, productStatus)
      });
      router.push(`/orders/${orderId}`);
    }, 2_000);

    return () => window.clearTimeout(timeout);
  }, [address, chainId, optimistic, priceEth, productId, productImageUrl, productName, productStatus, router, seller, state]);

  useEffect(() => {
    let cancelled = false;

    async function loadConnectorChain() {
      const nextChainId = await connector?.getChainId();
      if (!cancelled) {
        setConnectorChainId(nextChainId);
      }
    }

    void loadConnectorChain();

    return () => {
      cancelled = true;
    };
  }, [chainId, connector]);

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={() => void buyNow({ seller, productId, priceEth })}
        disabled={disabled}
        aria-label={`Buy ${productName}`}
        className="mt-4 inline-flex w-full justify-center rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-slate-300"
      >
        {unsupported ? "Switch to supported chain" : buttonLabel(state.kind, priceEth)}
      </button>
      {(externallyDisabled || unsupported) && effectiveDisabledReason ? <p className="text-sm text-slate-500">{effectiveDisabledReason}</p> : null}

      {state.kind === "waitingSignature" ? <WalletPopupHint /> : null}

      {state.kind === "submitted" ? (
        <div className="rounded-md bg-slate-50 p-3 text-sm text-slate-600">
          <p className="font-medium text-slate-900">Tx submitted. Waiting for chain confirmation.</p>
          {txUrl ? (
            <a href={txUrl} target="_blank" rel="noreferrer" className="mt-1 inline-block break-all text-blue-700 underline">
              {state.hash}
            </a>
          ) : (
            <p className="mt-1 break-all">{state.hash}</p>
          )}
        </div>
      ) : null}

      {state.kind === "confirmed" ? (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
          {state.orderId !== undefined ? (
            <>
              <p className="font-semibold text-emerald-900">订单 #{state.orderId.toString()} 创建成功！</p>
              <p className="mt-1">链上已确认。正在跳转到订单详情，商品信息可能还在同步。</p>
              <Link href={`/orders/${state.orderId.toString()}`} className="mt-2 inline-block text-blue-700 underline">
                立即查看
              </Link>
              <Toast message={`订单 #${state.orderId.toString()} 创建成功，链上已确认。`} />
            </>
          ) : (
            <p>Transaction confirmed. Order event not found yet; check buyer orders after the indexer syncs.</p>
          )}
        </div>
      ) : null}

      {state.kind === "failed" ? (
        <div className={`rounded-md border p-3 text-sm ${errorTone}`}>
          <p className="font-medium">{state.error.title}</p>
          <p className="mt-1">{state.error.message}</p>
          {state.error.category === "insufficient-funds" && faucetUrl ? (
            <a href={faucetUrl} target="_blank" rel="noreferrer" className="mt-2 inline-block underline">
              Open faucet
            </a>
          ) : null}
          <button type="button" onClick={reset} className="mt-2 block text-blue-700 underline">
            Try again
          </button>
        </div>
      ) : null}
    </div>
  );
}

function buttonLabel(kind: ReturnType<typeof useBuyNow>["state"]["kind"], priceEth: string) {
  if (kind === "waitingSignature") {
    return "Waiting for wallet signature...";
  }
  if (kind === "submitted") {
    return "Confirming on blockchain...";
  }
  if (kind === "confirmed") {
    return "Confirmed";
  }

  return `Buy now (${priceEth} ETH / MATIC)`;
}

function toWeiString(priceEth: string) {
  try {
    return parseEther(priceEth).toString();
  } catch {
    return "0";
  }
}

function toProductSummary(productId: bigint, productName: string, productImageUrl: string, productStatus: string) {
  const numericId = Number(productId);

  if (!Number.isSafeInteger(numericId) || numericId <= 0) {
    return null;
  }

  return {
    id: numericId,
    name: productName,
    imageUrl: productImageUrl,
    status: productStatus
  };
}
