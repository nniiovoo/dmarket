"use client";

import type { ShopSummary } from "@/lib/api/shops";
import { ShopCard } from "./ShopCard";

interface Props {
  shops: ShopSummary[];
}

export function ShopGrid({ shops }: Props) {
  if (shops.length === 0) return null;
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {shops.map((shop) => (
        <ShopCard key={shop.shopId} shop={shop} />
      ))}
    </div>
  );
}
