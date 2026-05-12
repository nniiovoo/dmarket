import Link from "next/link";
import { formatEther } from "viem";

import { OrderBadge } from "@/components/OrderBadge";
import type { ApiOrder } from "@/lib/orders";

type OrderCardProps = Pick<ApiOrder, "chainId" | "onChainOrderId" | "status" | "amountWei" | "product"> & {
  isPending?: boolean;
};

export function OrderCard({ chainId, onChainOrderId, status, amountWei, product, isPending }: OrderCardProps) {
  return (
    <Link
      href={`/orders/${onChainOrderId}`}
      className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-3 rounded-md border border-slate-200 p-3 transition hover:bg-slate-50 sm:grid-cols-[3.5rem_minmax(0,1fr)_auto]"
    >
      <div className="flex h-14 w-14 items-center justify-center overflow-hidden rounded-md bg-slate-100 text-xs text-slate-500">
        {product?.imageUrl ? (
          <div
            aria-label={product.name}
            className="h-full w-full bg-cover bg-center"
            role="img"
            style={{ backgroundImage: `url(${product.imageUrl})` }}
          />
        ) : (
          <span>No image</span>
        )}
      </div>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate font-medium text-slate-950">{product?.name ?? "Product not found"}</p>
          {product?.status === "inactive" ? (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">[已下架]</span>
          ) : null}
          {isPending ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
              处理中
            </span>
          ) : null}
        </div>
        <p className="mt-1 text-sm text-slate-500">
          Order #{onChainOrderId} · Chain {chainId} · {formatOrderAmount(amountWei)} ETH / MATIC
        </p>
      </div>
      <div className="col-span-2 flex items-center sm:col-span-1">
        <OrderBadge status={status} />
      </div>
    </Link>
  );
}

function formatOrderAmount(amountWei: string) {
  try {
    return formatEther(BigInt(amountWei));
  } catch {
    return "-";
  }
}
