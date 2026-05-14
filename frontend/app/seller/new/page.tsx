"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { parseEther } from "viem";
import { useAccount, useChainId, useSignMessage } from "wagmi";

import { Card, EmptyState } from "@/components/Card";
import { ImageUpload } from "@/components/ImageUpload";
import { NetworkNotice } from "@/components/NetworkNotice";
import { createProduct } from "@/lib/api/products";
import { hasMarketplace } from "@/lib/contracts";

export default function NewProductPage() {
  const router = useRouter();
  const chainId = useChainId();
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const supported = hasMarketplace(chainId);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [priceEth, setPriceEth] = useState("0.0001");
  const [imageUrl, setImageUrl] = useState("");
  const [phase, setPhase] = useState<"idle" | "signing" | "submitting">("idle");
  const [error, setError] = useState<string | undefined>();

  const validation = validateProduct({ name, description, priceEth, imageUrl });
  const disabled = !isConnected || !supported || phase !== "idle" || validation !== undefined;

  async function submitProduct() {
    if (!address || validation) {
      return;
    }

    setError(undefined);
    setPhase("signing");

    try {
      const sellerAddress = address.toLowerCase();
      const signedMessage = `ChainUs:CreateProduct:${Date.now()}:${sellerAddress}`;
      const signature = await signMessageAsync({ message: signedMessage });
      setPhase("submitting");
      const product = await createProduct({
        name,
        description,
        priceWei: parseEther(priceEth).toString(),
        chainId,
        imageUrl,
        sellerAddress,
        signature,
        signedMessage
      });

      router.push(`/products/${product.id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to create product");
      setPhase("idle");
    }
  }

  return (
    <div className="space-y-6">
      <NetworkNotice />
      <div>
        <h1 className="text-2xl font-semibold text-slate-950">Create product</h1>
        <p className="mt-2 text-slate-600">Create Web2 product metadata that maps to an on-chain productId.</p>
      </div>

      <Card title="Product form">
        {!isConnected ? (
          <EmptyState title="Connect wallet" body="Connect the seller wallet before creating a product." />
        ) : !supported ? (
          <EmptyState title="Unsupported network" body="Switch to Sepolia, Polygon Amoy, or Arbitrum Sepolia." />
        ) : (
          <div className="space-y-4">
            <Field label="Name" value={name} onChange={setName} placeholder="Vintage hoodie" />
            <TextArea label="Description" value={description} onChange={setDescription} placeholder="Size, condition, shipping notes..." />
            <Field label="Price" value={priceEth} onChange={setPriceEth} placeholder="0.0001" suffix="ETH / MATIC" />
            <div>
              <p className="text-sm font-medium text-slate-700">Image</p>
              <div className="mt-1">
                <ImageUpload value={imageUrl} onChange={setImageUrl} />
              </div>
            </div>
            <p className="text-sm text-slate-500">Seller: {address}</p>
            {validation ? <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-800">{validation}</p> : null}
            {error ? <p className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
            <button
              type="button"
              onClick={submitProduct}
              disabled={disabled}
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {phase === "signing" ? "Sign in wallet..." : phase === "submitting" ? "Creating..." : "Create product"}
            </button>
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

function TextArea({
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
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="mt-1 min-h-28 w-full rounded-md border border-slate-300 px-3 py-2 outline-none"
      />
    </label>
  );
}

function validateProduct({
  name,
  description,
  priceEth,
  imageUrl
}: {
  name: string;
  description: string;
  priceEth: string;
  imageUrl: string;
}) {
  if (name.trim().length === 0 || name.length > 200) {
    return "Name must be 1-200 characters.";
  }
  if (description.length > 2000) {
    return "Description must be 2000 characters or less.";
  }
  try {
    if (parseEther(priceEth) <= 0n) {
      return "Price must be greater than zero.";
    }
  } catch {
    return "Price must be a valid ETH/MATIC amount.";
  }
  if (imageUrl && !URL.canParse(imageUrl)) {
    return "Image URL must be a valid URL or empty.";
  }

  return undefined;
}
