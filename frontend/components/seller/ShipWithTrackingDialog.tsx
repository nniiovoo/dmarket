"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Hash } from "viem";
import { useAccount, useChainId, useSignMessage, useWaitForTransactionReceipt, useWriteContract } from "wagmi";

import { CarrierBadge } from "@/components/CarrierBadge";
import { CARRIERS, detectCarrier, type CarrierCode } from "@/lib/carriers";
import { updateShipping } from "@/lib/api/shipping";
import { escrowMarketplaceV2Abi, getContractAddresses, isSupportedChain } from "@/lib/contracts";
import { decodeDappError } from "@/lib/errors";
import type { ApiOrder } from "@/lib/orders";

export function ShipWithTrackingDialog({
  order,
  sellerAddress,
  onClose
}: {
  order: ApiOrder;
  sellerAddress: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const currentChainId = useChainId();
  const { connector } = useAccount();
  const contracts = getContractAddresses(order.chainId);
  const onOrderChain = currentChainId === order.chainId;
  const canSendOnCurrentChain = isSupportedChain(currentChainId) && onOrderChain;
  const { writeContractAsync, isPending: walletPending } = useWriteContract();
  const { signMessageAsync } = useSignMessage();
  const [trackingNumber, setTrackingNumber] = useState("");
  const [manualUrl, setManualUrl] = useState("");
  const [shippingNote, setShippingNote] = useState("");
  const [hash, setHash] = useState<Hash | undefined>();
  const [chainConfirmed, setChainConfirmed] = useState(false);
  const [shippingPhase, setShippingPhase] = useState<"idle" | "signing" | "saving">("idle");
  const [success, setSuccess] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const handledReceipt = useRef<Hash | undefined>(undefined);
  const receipt = useWaitForTransactionReceipt({ hash });
  // Only consider the receipt query "pending" once a hash has actually been
  // submitted. tanstack-query reports isPending=true for disabled queries,
  // which would otherwise leave the button stuck on "Waiting for chain...".
  const receiptPending = hash !== undefined && receipt.isPending;
  const normalizedTracking = trackingNumber.trim();
  const hasShippingDetails = normalizedTracking.length > 0;
  // Carrier is derived entirely from the tracking number — no manual dropdown.
  // When detection fails we fall through to "other" so the seller can paste
  // a manual tracking URL.
  const detected = useMemo(() => detectCarrier(normalizedTracking), [normalizedTracking]);
  const carrier: CarrierCode = detected ?? "other";
  const wasAutoDetected = detected !== undefined;
  const validation = useMemo(() => {
    if (!hasShippingDetails) {
      return undefined;
    }

    if (carrier === "other" && !manualUrl.trim()) {
      return "Manual tracking URL is required for Other.";
    }

    if (carrier === "other" && !URL.canParse(manualUrl.trim())) {
      return "Manual tracking URL must be a valid URL.";
    }

    return undefined;
  }, [carrier, hasShippingDetails, manualUrl]);
  const busy = walletPending || receiptPending || shippingPhase !== "idle";

  const saveShippingDetails = useCallback(async () => {
    if (!hasShippingDetails || validation) {
      return;
    }

    setError(undefined);
    setShippingPhase("signing");

    try {
      const signedMessage = `ChainUs:UpdateShipping:${order.chainId}:${order.onChainOrderId}:${carrier}:${normalizedTracking}:${Date.now()}:${sellerAddress}`;
      const signature = await signMessageAsync({ message: signedMessage });
      setShippingPhase("saving");
      await updateShipping(order.chainId, order.onChainOrderId, {
        carrier,
        trackingNumber: normalizedTracking,
        manualUrl: carrier === "other" ? manualUrl.trim() : null,
        shippingNote: shippingNote.trim(),
        sellerAddress,
        signature,
        signedMessage
      });
      setSuccess("发货成功，物流已记录。");
      void invalidateSellerQueries(queryClient, sellerAddress, order.chainId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to save shipping details");
    } finally {
      setShippingPhase("idle");
    }
  }, [
    carrier,
    hasShippingDetails,
    manualUrl,
    normalizedTracking,
    order.chainId,
    order.onChainOrderId,
    queryClient,
    sellerAddress,
    shippingNote,
    signMessageAsync,
    validation
  ]);

  useEffect(() => {
    if (!receipt.isSuccess || hash === undefined || handledReceipt.current === hash) {
      return;
    }

    handledReceipt.current = hash;
    queueMicrotask(() => {
      setChainConfirmed(true);

      if (!hasShippingDetails) {
        setSuccess("Order marked as shipped.");
        void invalidateSellerQueries(queryClient, sellerAddress, order.chainId);
        return;
      }

      void saveShippingDetails();
    });
  }, [hash, hasShippingDetails, order.chainId, queryClient, receipt.isSuccess, saveShippingDetails, sellerAddress]);

  async function submit() {
    if (validation || !contracts?.marketplace || !canSendOnCurrentChain) {
      if (!canSendOnCurrentChain) {
        setError("Switch to the order's testnet before confirming shipment.");
      }
      return;
    }

    setError(undefined);
    setSuccess(undefined);

    if (chainConfirmed) {
      await saveShippingDetails();
      return;
    }

    try {
      const connectorChainId = await connector?.getChainId();
      if (connectorChainId !== order.chainId || !isSupportedChain(connectorChainId)) {
        setError("Your wallet is not actually on this order's testnet yet. Switch MetaMask to the correct testnet, then refresh and try again.");
        return;
      }

      const nextHash = await writeContractAsync({
        address: contracts.marketplace,
        abi: escrowMarketplaceV2Abi,
        chainId: order.chainId,
        functionName: "markShipped",
        args: [BigInt(order.onChainOrderId)]
      });
      setHash(nextHash);
    } catch (caught) {
      const decoded = decodeDappError(caught);
      setError(`${decoded.title}: ${decoded.message}`);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 px-4">
      <div className="w-full max-w-lg rounded-lg bg-white p-5 shadow-xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-950">标记发货 - 订单 #{order.onChainOrderId}</h2>
            <p className="mt-1 text-sm text-slate-500">
              商品：{order.product?.name ?? `Product #${order.productId}`} · 买家：{shortAddress(order.buyer)}
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-md px-2 py-1 text-sm text-slate-500 hover:bg-slate-100">
            Close
          </button>
        </div>

        <div className="mt-5 space-y-4">
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Tracking number</span>
            <div className="mt-1 flex items-center gap-2">
              <input
                value={trackingNumber}
                onChange={(event) => setTrackingNumber(event.target.value)}
                placeholder="SF1234567890"
                className="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-2 outline-none"
              />
              {wasAutoDetected ? <CarrierBadge code={carrier} /> : null}
            </div>
            {hasShippingDetails ? (
              wasAutoDetected ? (
                <span className="mt-1 inline-flex items-center rounded bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                  已自动识别为 {CARRIERS[carrier].name}
                </span>
              ) : (
                <span className="mt-1 inline-flex items-center rounded bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800">
                  未识别快递公司，请填写手动追踪链接
                </span>
              )
            ) : null}
          </label>
          {hasShippingDetails && !wasAutoDetected ? (
            <Field label="Manual tracking URL" value={manualUrl} onChange={setManualUrl} placeholder="https://..." />
          ) : null}
          <Field label="Note" value={shippingNote} onChange={setShippingNote} placeholder="Optional shipping note" />
          <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-800">
            On-chain shipment confirmation is required. Tracking details are optional and can be skipped.
          </p>
          {validation ? <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-800">{validation}</p> : null}
          {!canSendOnCurrentChain ? (
            <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-800">Switch to this order&apos;s testnet before sending the shipment transaction.</p>
          ) : null}
          {error ? <p className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
          {success ? <p className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-700">{success}</p> : null}

          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={busy || validation !== undefined || !contracts?.marketplace || !canSendOnCurrentChain || Boolean(success)}
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {buttonLabel({ walletPending, receiptPending, shippingPhase, chainConfirmed, hasShippingDetails })}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

async function invalidateSellerQueries(queryClient: ReturnType<typeof useQueryClient>, sellerAddress: string, chainId: number) {
  await queryClient.invalidateQueries({ queryKey: ["orders"] });
  await queryClient.invalidateQueries({ queryKey: ["seller", "orders", sellerAddress, chainId] });
}

function Field({
  label,
  value,
  onChange,
  placeholder
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-slate-700">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 outline-none"
      />
    </label>
  );
}

function buttonLabel({
  walletPending,
  receiptPending,
  shippingPhase,
  chainConfirmed,
  hasShippingDetails
}: {
  walletPending: boolean;
  receiptPending: boolean;
  shippingPhase: "idle" | "signing" | "saving";
  chainConfirmed: boolean;
  hasShippingDetails: boolean;
}) {
  if (walletPending) {
    return "Confirm in wallet...";
  }
  if (receiptPending) {
    return "Waiting for chain...";
  }
  if (shippingPhase === "signing") {
    return "Sign shipping...";
  }
  if (shippingPhase === "saving") {
    return "Saving tracking...";
  }
  if (chainConfirmed && hasShippingDetails) {
    return "Retry saving tracking";
  }
  return "Confirm shipment";
}

function shortAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
