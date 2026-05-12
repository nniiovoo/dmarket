"use client";

import Link from "next/link";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { formatEther } from "viem";
import { useAccount, useSignMessage } from "wagmi";

import { deleteProduct, updateProduct, type Product } from "@/lib/api/products";

export function MyProductRow({ product }: { product: Product }) {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<"idle" | "signing" | "saving">("idle");
  const [error, setError] = useState<string | undefined>();
  const busy = phase !== "idle";

  async function setActiveStatus(status: "active" | "inactive") {
    if (!address) {
      return;
    }

    if (status === "inactive" && !window.confirm("Take this product off the active marketplace?")) {
      return;
    }

    setError(undefined);
    setPhase("signing");

    try {
      const sellerAddress = address.toLowerCase();
      const signedMessage =
        status === "inactive"
          ? `ChainUs:DeleteProduct:${product.id}:${Date.now()}:${sellerAddress}`
          : `ChainUs:UpdateProduct:${product.id}:${Date.now()}:${sellerAddress}`;
      const signature = await signMessageAsync({ message: signedMessage });
      setPhase("saving");

      if (status === "inactive") {
        await deleteProduct(product.id, { sellerAddress, signature, signedMessage });
      } else {
        await updateProduct(product.id, { status, sellerAddress, signature, signedMessage });
      }

      void queryClient.invalidateQueries({ queryKey: ["seller", "products"] });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Product update failed");
      setPhase("idle");
    }
  }

  return (
    <div className="rounded-md border border-slate-200 p-3">
      <div className="grid gap-3 sm:grid-cols-[4rem_minmax(0,1fr)_auto] sm:items-center">
        <div className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-md bg-slate-100 text-xs text-slate-500">
          {product.imageUrl ? (
            <div
              aria-label={product.name}
              className="h-full w-full bg-cover bg-center"
              role="img"
              style={{ backgroundImage: `url("${product.imageUrl}")` }}
            />
          ) : (
            <span>No image</span>
          )}
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Link href={`/products/${product.id}`} className="truncate font-medium text-slate-950 hover:underline">
              {product.name}
            </Link>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">{product.status}</span>
          </div>
          <p className="mt-1 text-sm text-slate-500">
            Product #{product.id} · {formatEther(BigInt(product.priceWei))} ETH / MATIC
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href={`/seller/products/${product.id}/edit`}
            className="rounded-md border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700"
          >
            Edit
          </Link>
          {product.status === "inactive" ? (
            <button
              type="button"
              onClick={() => void setActiveStatus("active")}
              disabled={busy}
              className="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white disabled:bg-slate-300"
            >
              {product.status === "inactive" ? actionLabel(phase, "Restore", "Restoring...") : "Restore"}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void setActiveStatus("inactive")}
              disabled={busy}
              className="rounded-md bg-red-700 px-3 py-2 text-sm font-medium text-white disabled:bg-slate-300"
            >
              {actionLabel(phase, "Unlist", "Unlisting...")}
            </button>
          )}
        </div>
      </div>
      {error ? <p className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p> : null}
    </div>
  );
}

function actionLabel(phase: "idle" | "signing" | "saving", idleLabel: string, savingLabel: string) {
  if (phase === "signing") {
    return "Sign in wallet...";
  }
  if (phase === "saving") {
    return savingLabel;
  }

  return idleLabel;
}
