"use client";

import { useChainId } from "wagmi";

import { PRIMARY_CHAIN, isLegacyChain, isPrimaryChain, supportedChains } from "@/lib/chains";

export function NetworkNotice() {
  const chainId = useChainId();

  if (isPrimaryChain(chainId)) return null;

  const chainName = supportedChains.find((chain) => chain.id === chainId)?.name ?? `chain ${chainId}`;

  if (isLegacyChain(chainId)) {
    return (
      <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
        You&apos;re on a legacy chain. The current marketplace runs on{" "}
        <span className="font-semibold">{PRIMARY_CHAIN.name}</span>. Browsing is fine; actions will prompt your
        wallet to switch.
      </div>
    );
  }

  return (
    <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
      Browsing from {chainId ? `chain ${chainId}` : "an unknown chain"}. ChainUs runs on{" "}
      <span className="font-semibold">{PRIMARY_CHAIN.name}</span> — you&apos;ll be prompted to switch when you take
      an action.
    </div>
  );
}
