"use client";

import { useChainId } from "wagmi";

import { isSupportedChain } from "@/lib/contracts";

export function NetworkNotice() {
  const chainId = useChainId();

  if (isSupportedChain(chainId)) {
    return null;
  }

  return (
    <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
      Switch to Sepolia or Polygon Amoy to interact with the marketplace.
    </div>
  );
}
