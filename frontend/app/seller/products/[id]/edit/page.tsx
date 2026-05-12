"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { formatEther, parseEther } from "viem";
import { useAccount, useSignMessage } from "wagmi";

import { Card, EmptyState, SkeletonLine } from "@/components/Card";
import { ImageUpload } from "@/components/ImageUpload";
import { NetworkNotice } from "@/components/NetworkNotice";
import { deleteProduct, fetchProduct, updateProduct, type Product } from "@/lib/api/products";
import { sameAddress } from "@/lib/order";

export default function EditProductPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const productId = Number(params.id);
  const productIdIsValid = Number.isInteger(productId) && productId > 0;
  const [product, setProduct] = useState<Product | undefined>();
  const [loading, setLoading] = useState(productIdIsValid);
  const [phase, setPhase] = useState<"idle" | "signing" | "saving" | "unlisting">("idle");
  const [error, setError] = useState<string | undefined>();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [priceEth, setPriceEth] = useState("");
  const [imageUrl, setImageUrl] = useState("");

  const isSeller = sameAddress(address, product?.sellerAddress);
  const validation = validateProduct({ name, description, priceEth, imageUrl });
  const disabled = !isConnected || !isSeller || phase !== "idle" || validation !== undefined;

  useEffect(() => {
    let cancelled = false;

    async function loadProduct() {
      setLoading(true);
      setError(undefined);

      try {
        const result = await fetchProduct(productId);
        if (!cancelled) {
          setProduct(result);
          setName(result.name);
          setDescription(result.description);
          setPriceEth(formatEther(BigInt(result.priceWei)));
          setImageUrl(result.imageUrl);
        }
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : "Failed to load product");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    if (productIdIsValid) {
      void loadProduct();
    }

    return () => {
      cancelled = true;
    };
  }, [productId, productIdIsValid]);

  async function saveProduct() {
    if (!address || !product || validation) {
      return;
    }

    setError(undefined);
    setPhase("signing");

    try {
      const sellerAddress = address.toLowerCase();
      const signedMessage = `ChainUs:UpdateProduct:${product.id}:${Date.now()}:${sellerAddress}`;
      const signature = await signMessageAsync({ message: signedMessage });
      setPhase("saving");
      await updateProduct(product.id, {
        name,
        description,
        priceWei: parseEther(priceEth).toString(),
        imageUrl,
        sellerAddress,
        signature,
        signedMessage
      });

      router.push(`/products/${product.id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to update product");
      setPhase("idle");
    }
  }

  async function unlistProduct() {
    if (!address || !product || !window.confirm("Take this product off the active marketplace?")) {
      return;
    }

    setError(undefined);
    setPhase("signing");

    try {
      const sellerAddress = address.toLowerCase();
      const signedMessage = `ChainUs:DeleteProduct:${product.id}:${Date.now()}:${sellerAddress}`;
      const signature = await signMessageAsync({ message: signedMessage });
      setPhase("unlisting");
      await deleteProduct(product.id, { sellerAddress, signature, signedMessage });
      router.push("/seller");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to unlist product");
      setPhase("idle");
    }
  }

  if (!productIdIsValid) {
    return <EmptyState title="Product unavailable" body="Invalid product id." />;
  }

  if (loading) {
    return (
      <Card title="Edit product">
        <SkeletonLine />
        <SkeletonLine className="mt-2 w-2/3" />
      </Card>
    );
  }

  if (error && !product) {
    return <EmptyState title="Product unavailable" body={error} />;
  }

  if (!product) {
    return <EmptyState title="Product not found" body="This listing does not exist." />;
  }

  return (
    <div className="space-y-6">
      <NetworkNotice />
      <div>
        <Link href="/seller" className="text-sm text-blue-700 underline">
          Back to seller dashboard
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-slate-950">Edit product</h1>
      </div>

      <Card title={product.name}>
        {!isConnected ? (
          <EmptyState title="Connect wallet" body="Connect the product owner wallet to edit this listing." />
        ) : !isSeller ? (
          <EmptyState title="Only the product owner can edit this." body="Switch to the seller wallet for this product." />
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
            <p className="text-sm text-slate-500">Seller: {product.sellerAddress}</p>
            {validation ? <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-800">{validation}</p> : null}
            {error ? <p className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void saveProduct()}
                disabled={disabled}
                className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                {buttonLabel(phase, "Save product")}
              </button>
              {product.status !== "inactive" ? (
                <button
                  type="button"
                  onClick={() => void unlistProduct()}
                  disabled={disabled}
                  className="rounded-md bg-red-700 px-4 py-2 text-sm font-medium text-white disabled:bg-slate-300"
                >
                  {phase === "unlisting" ? "Unlisting..." : phase === "signing" ? "Sign in wallet..." : "Unlist"}
                </button>
              ) : null}
            </div>
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

function buttonLabel(phase: "idle" | "signing" | "saving" | "unlisting", idleLabel: string) {
  if (phase === "signing") {
    return "Sign in wallet...";
  }
  if (phase === "saving") {
    return "Saving...";
  }
  if (phase === "unlisting") {
    return "Unlisting...";
  }

  return idleLabel;
}
