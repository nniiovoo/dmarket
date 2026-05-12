"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { isAddress, parseEther, zeroAddress } from "viem";
import { useAccount, useChainId } from "wagmi";

import { BuyNowButton } from "@/components/BuyNowButton";
import { Card, EmptyState } from "@/components/Card";
import { NetworkNotice } from "@/components/NetworkNotice";
import { TxPanel } from "@/components/TxPanel";
import { escrowMarketplaceV2Abi, getContractAddresses, isSupportedChain } from "@/lib/contracts";

export default function CreateOrderPage() {
  return (
    <Suspense
      fallback={
        <Card title="Order form">
          <p className="text-sm text-slate-500">Loading order form...</p>
        </Card>
      }
    >
      <CreateOrderPageContent />
    </Suspense>
  );
}

function CreateOrderPageContent() {
  const searchParams = useSearchParams();
  const queryKey = searchParams.toString();

  return (
    <CreateOrderForm
      key={queryKey}
      initialSeller={searchParams.get("seller") ?? ""}
      initialProductId={searchParams.get("productId") ?? "1"}
      initialAmount={searchParams.get("amount") ?? "0.0001"}
      productName={searchParams.get("productName")}
    />
  );
}

function CreateOrderForm({
  initialSeller,
  initialProductId,
  initialAmount,
  productName
}: {
  initialSeller: string;
  initialProductId: string;
  initialAmount: string;
  productName: string | null;
}) {
  const chainId = useChainId();
  const { address, isConnected } = useAccount();
  const contracts = getContractAddresses(chainId);
  const supported = isSupportedChain(chainId);
  const [seller, setSeller] = useState(initialSeller);
  const [productId, setProductId] = useState(initialProductId);
  const [amount, setAmount] = useState(initialAmount);
  const [advancedMode, setAdvancedMode] = useState(false);

  const validation = validateCreateOrder({ seller, productId, amount, connectedAddress: address });
  const disabled = !isConnected || !supported || validation !== undefined;

  return (
    <div className="space-y-6">
      <NetworkNotice />
      <div>
        <h1 className="text-2xl font-semibold text-slate-950">Create order</h1>
        <p className="mt-2 text-slate-600">Create an unpaid order. The buyer pays later from the order detail page.</p>
        {productName ? <p className="mt-2 text-sm text-slate-500">Ordering: {productName}</p> : null}
      </div>

      <Card title="Order form">
        {!isConnected ? (
          <EmptyState title="Connect wallet" body="Connect the buyer wallet before creating an order." />
        ) : !supported ? (
          <EmptyState title="Unsupported network" body="Switch to Sepolia or Polygon Amoy." />
        ) : (
          <div className="space-y-4">
            <Field label="Seller address" value={seller} onChange={setSeller} placeholder="0x..." />
            <Field label="Product ID" value={productId} onChange={setProductId} placeholder="1" />
            <Field label="Amount" value={amount} onChange={setAmount} placeholder="0.0001" suffix="ETH / MATIC" />
            <label className="flex items-start gap-2 rounded-md bg-slate-50 p-3 text-sm text-slate-700">
              <input type="checkbox" checked={advancedMode} onChange={(event) => setAdvancedMode(event.target.checked)} className="mt-1" />
              <span>
                Advanced mode: create the order now and pay later. Most purchases should use one-click buy.
              </span>
            </label>
            {validation ? <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-800">{validation}</p> : null}
            {advancedMode ? (
              <TxPanel
                label="Create order"
                description="Advanced path. The buyer pays later from the order detail page."
                disabled={disabled}
                disabledReason={validation}
                buildTransaction={() => ({
                  address: contracts?.marketplace,
                  abi: escrowMarketplaceV2Abi,
                  functionName: "createOrder",
                  args: [seller, BigInt(productId), parseEther(amount)]
                })}
              />
            ) : (
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                <p className="font-medium text-slate-950">Buy now（一键购买）</p>
                <p className="mt-1 text-sm text-slate-600">Create the order and escrow funds in one wallet confirmation.</p>
                <BuyNowButton
                  seller={seller}
                  productId={isIntegerString(productId) ? BigInt(productId) : 0n}
                  priceEth={amount}
                  productName={productName ?? `Product #${productId}`}
                  disabled={disabled}
                  disabledReason={validation}
                />
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  suffix
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  suffix?: string;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-slate-700">{label}</span>
      <div className="mt-1 flex overflow-hidden rounded-md border border-slate-300 bg-white">
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          className="min-w-0 flex-1 px-3 py-2 outline-none"
        />
        {suffix ? <span className="border-l border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-500">{suffix}</span> : null}
      </div>
    </label>
  );
}

function validateCreateOrder({
  seller,
  productId,
  amount,
  connectedAddress
}: {
  seller: string;
  productId: string;
  amount: string;
  connectedAddress: string | undefined;
}) {
  if (!isAddress(seller)) {
    return "Seller must be a valid address.";
  }
  if (seller.toLowerCase() === zeroAddress.toLowerCase()) {
    return "Seller cannot be the zero address.";
  }
  if (connectedAddress !== undefined && seller.toLowerCase() === connectedAddress.toLowerCase()) {
    return "Seller cannot be the connected buyer wallet.";
  }
  try {
    if (BigInt(productId) < 0n) {
      return "Product ID must be zero or greater.";
    }
  } catch {
    return "Product ID must be an integer.";
  }
  try {
    if (parseEther(amount) <= 0n) {
      return "Amount must be greater than zero.";
    }
  } catch {
    return "Amount must be a valid ETH/MATIC amount.";
  }

  return undefined;
}

function isIntegerString(value: string) {
  try {
    BigInt(value);
    return true;
  } catch {
    return false;
  }
}
