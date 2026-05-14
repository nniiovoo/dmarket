"use client";

import { useChainId, useSwitchChain } from "wagmi";

export function useEnsureChain() {
  const currentChainId = useChainId();
  const { switchChainAsync, isPending } = useSwitchChain();

  return {
    currentChainId,
    switching: isPending,
    ensure: async (targetChainId: number): Promise<void> => {
      if (currentChainId === targetChainId) return;
      await switchChainAsync({ chainId: targetChainId });
    }
  };
}
