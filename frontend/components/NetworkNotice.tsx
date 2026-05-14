"use client";

import { useAccount, useChainId } from "wagmi";

import { PRIMARY_CHAIN, isLegacyChain, isPrimaryChain, supportedChains } from "@/lib/chains";

export function NetworkNotice() {
  const chainId = useChainId();
  const { isConnected } = useAccount();

  if (!isConnected) {
    return (
      <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        Connect your wallet. ChainUs runs on {PRIMARY_CHAIN.name}.
      </div>
    );
  }

  if (isPrimaryChain(chainId)) return null;

  const chainName = supportedChains.find((chain) => chain.id === chainId)?.name ?? `chain ${chainId}`;

  if (isLegacyChain(chainId)) {
    return (
      <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        You&apos;re on {chainName} (legacy). Switch to {PRIMARY_CHAIN.name} to use the current marketplace.
      </div>
    );
  }

  return (
    <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
      This site runs on {PRIMARY_CHAIN.name}. We&apos;ve prompted your wallet to switch.
    </div>
  );
}
