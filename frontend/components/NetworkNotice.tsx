"use client";

import { useChainId } from "wagmi";

import { hasMarketplace } from "@/lib/contracts";

export function NetworkNotice() {
  const chainId = useChainId();

  if (hasMarketplace(chainId)) return null;

  return (
    <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
      Switch to Sepolia, Polygon Amoy, or Arbitrum Sepolia to interact with the marketplace.
    </div>
  );
}
