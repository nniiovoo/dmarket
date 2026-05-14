"use client";

import { useEffect } from "react";
import { useAccount, useChainId, useSwitchChain } from "wagmi";

import { PRIMARY_CHAIN_ID, isPrimaryChain } from "@/lib/chains";

export function usePromptPrimaryChain() {
  const { isConnected, address } = useAccount();
  const chainId = useChainId();
  const { switchChainAsync } = useSwitchChain();

  useEffect(() => {
    if (!isConnected || !address) return;
    if (isPrimaryChain(chainId)) return;

    const promptKey = `chainus:primary-chain-prompted:${address.toLowerCase()}`;
    if (window.sessionStorage.getItem(promptKey) === "1") return;

    window.sessionStorage.setItem(promptKey, "1");
    switchChainAsync({ chainId: PRIMARY_CHAIN_ID }).catch(() => {
      // User rejected the wallet prompt. NetworkNotice remains as the fallback.
    });
  }, [isConnected, address, chainId, switchChainAsync]);
}
