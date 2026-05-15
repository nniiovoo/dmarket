"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { formatEther, parseEther } from "viem";
import { useAccount, useSignMessage } from "wagmi";

import { BuyNowButton } from "@/components/BuyNowButton";
import { BuyNowERC20Button } from "@/components/BuyNowERC20Button";
import { Card, EmptyState, SkeletonLine } from "@/components/Card";
import { ContactSellerButton } from "@/components/messages/ContactSellerButton";
import {
  PaymentTokenPicker,
  convertEthWeiToToken,
  type PaymentMode
} from "@/components/PaymentTokenPicker";
import { ReputationBadge } from "@/components/reputation/ReputationBadge";
import { fetchProduct, updateProduct, deleteProduct, type Product } from "@/lib/api/products";
import { PRIMARY_CHAIN_ID } from "@/lib/chains";
import { sameAddress } from "@/lib/order";
import type { Address } from "viem";

export default function ProductDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const productId = Number(params.id);
  const productIdIsValid = Number.isInteger(productId) && productId > 0;
  const [product, setProduct] = useState<Product | undefined>();
  const [loading, setLoading] = useState(productIdIsValid);
  const [sellerToolPhase, setSellerToolPhase] = useState<"idle" | "signing" | "saving" | "deleting">("idle");
  const [error, setError] = useState<string | undefined>();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [priceEth, setPriceEth] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [paymentMode, setPaymentMode] = useState<PaymentMode>({ kind: "native" });

  const isSeller = sameAddress(address, product?.sellerAddress);

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

    if (!productIdIsValid) {
      return undefined;
    }

    void loadProduct();

    return () => {
      cancelled = true;
    };
  }, [productId, productIdIsValid]);

  async function saveProduct() {
    if (!address || !product) {
      return;
    }

    setError(undefined);
    setSellerToolPhase("signing");

    try {
      const sellerAddress = address.toLowerCase();
      const signedMessage = `ChainUs:UpdateProduct:${product.id}:${Date.now()}:${sellerAddress}`;
      const signature = await signMessageAsync({ message: signedMessage });
      setSellerToolPhase("saving");
      const updated = await updateProduct(product.id, {
        name,
        description,
        priceWei: parseEther(priceEth).toString(),
        imageUrl,
        sellerAddress,
        signature,
        signedMessage
      });

      setProduct(updated);
      setEditing(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to update product");
      setSellerToolPhase("idle");
    }
  }

  async function removeProduct() {
    if (!address || !product) {
      return;
    }

    setError(undefined);
    setSellerToolPhase("signing");

    try {
      const sellerAddress = address.toLowerCase();
      const signedMessage = `ChainUs:DeleteProduct:${product.id}:${Date.now()}:${sellerAddress}`;
      const signature = await signMessageAsync({ message: signedMessage });
      setSellerToolPhase("deleting");
      await deleteProduct(product.id, { sellerAddress, signature, signedMessage });
      router.push("/products");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to delete product");
      setSellerToolPhase("idle");
    }
  }

  if (loading) {
    return (
      <Card title="Product">
        <SkeletonLine />
      </Card>
    );
  }

  if (!productIdIsValid) {
    return <EmptyState title="Product unavailable" body="Invalid product id" />;
  }

  if (error && !product) {
    return <EmptyState title="Product unavailable" body={error} />;
  }

  if (!product) {
    return <EmptyState title="Product not found" body="This listing does not exist." />;
  }

  return (
    <div className="space-y-6">
      <Link href="/products" className="text-sm font-medium text-slate-600 hover:text-slate-950">
        Back to products
      </Link>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Card title={product.name}>
          <ProductImage product={product} />
          <div className="mt-5 space-y-3 text-sm">
            <p className="text-slate-700">{product.description || "No description."}</p>
            <Info label="Product ID" value={String(product.id)} />
            <div>
              <p className="text-xs font-medium uppercase text-slate-400">Seller</p>
              <div className="mt-0.5 flex flex-wrap items-center gap-2">
                <p className="break-all text-slate-700">{product.sellerAddress}</p>
                <ReputationBadge sellerAddress={product.sellerAddress as Address} variant="compact" />
              </div>
            </div>
            <Info label="Chain ID" value={String(product.chainId)} />
            <Info label="Status" value={product.status} />
            <Info label="Price" value={`${formatEther(BigInt(product.priceWei))} ETH / MATIC`} />
          </div>
        </Card>

        <div className="space-y-4">
          <Card title="Buy">
            <p className="text-2xl font-semibold text-slate-950">{formatEther(BigInt(product.priceWei))}</p>
            <p className="mt-1 text-sm text-slate-500">ETH / MATIC depending on selected testnet.</p>
            {isSeller ? (
              <p className="mt-4 rounded-md bg-slate-50 p-3 text-sm text-slate-600">You cannot buy your own listing.</p>
            ) : product.status !== "active" ? (
              <p className="mt-4 rounded-md bg-slate-50 p-3 text-sm text-slate-600">This product is not available for purchase.</p>
            ) : (
              <>
                <PaymentTokenPicker
                  chainId={PRIMARY_CHAIN_ID}
                  value={paymentMode}
                  onChange={setPaymentMode}
                  productPriceInWei={BigInt(product.priceWei)}
                />
                {paymentMode.kind === "native" ? (
                  <BuyNowButton
                    seller={product.sellerAddress}
                    productId={BigInt(product.id)}
                    priceEth={formatEther(BigInt(product.priceWei))}
                    productName={product.name}
                    productImageUrl={product.imageUrl}
                    productStatus={product.status}
                    label={`Buy with ETH (${formatEther(BigInt(product.priceWei))} ETH)`}
                  />
                ) : (
                  <BuyNowERC20Button
                    seller={product.sellerAddress as Address}
                    productId={BigInt(product.id)}
                    token={paymentMode.token}
                    amount={convertEthWeiToToken(BigInt(product.priceWei), paymentMode.token)}
                    productName={product.name}
                  />
                )}
              </>
            )}
            <Link
              href={`/create?${new URLSearchParams({
                productId: String(product.id),
                seller: product.sellerAddress,
                amount: formatEther(BigInt(product.priceWei)),
                productName: product.name
              }).toString()}`}
              className="mt-3 block text-center text-sm text-blue-700 underline"
            >
              Open advanced order form
            </Link>
            <ContactSellerButton
              sellerAddress={product.sellerAddress}
              chainId={product.chainId}
              productId={String(product.id)}
            />
          </Card>

          {isSeller ? (
            <Card title="Seller tools">
              {!editing ? (
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setEditing(true)}
                    className="rounded-md border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={removeProduct}
                    disabled={sellerToolPhase !== "idle"}
                    className="rounded-md bg-red-700 px-4 py-2 text-sm font-medium text-white disabled:bg-slate-300"
                  >
                    {sellerToolPhase === "signing" ? "Sign in wallet..." : sellerToolPhase === "deleting" ? "Deleting..." : "Delete"}
                  </button>
                </div>
              ) : (
                <div className="space-y-3">
                  <Field label="Name" value={name} onChange={setName} />
                  <TextArea label="Description" value={description} onChange={setDescription} />
                  <Field label="Price" value={priceEth} onChange={setPriceEth} />
                  <Field label="Image URL" value={imageUrl} onChange={setImageUrl} />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={saveProduct}
                      disabled={sellerToolPhase !== "idle"}
                      className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:bg-slate-300"
                    >
                      {sellerToolPhase === "signing" ? "Sign in wallet..." : sellerToolPhase === "saving" ? "Saving..." : "Save"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditing(false)}
                      className="rounded-md border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
              {error ? <p className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ProductImage({ product }: { product: Product }) {
  if (!product.imageUrl) {
    return (
      <div className="flex aspect-[4/3] items-center justify-center rounded-lg bg-slate-100 text-sm font-medium text-slate-400">
        No image
      </div>
    );
  }

  return (
    <div
      className="aspect-[4/3] rounded-lg bg-slate-100 bg-cover bg-center"
      style={{ backgroundImage: `url("${product.imageUrl}")` }}
      aria-label={product.name}
    />
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase text-slate-400">{label}</p>
      <p className="break-all text-slate-700">{value}</p>
    </div>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-slate-700">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 outline-none"
      />
    </label>
  );
}

function TextArea({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-slate-700">{label}</span>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 min-h-24 w-full rounded-md border border-slate-300 px-3 py-2 outline-none"
      />
    </label>
  );
}
