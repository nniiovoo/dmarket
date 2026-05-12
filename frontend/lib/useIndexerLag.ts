"use client";

import { useQuery } from "@tanstack/react-query";
import { useChainId } from "wagmi";

import { fetchIndexerStatus } from "@/lib/api/indexer";

export function useIndexerLag() {
  const chainId = useChainId();
  const query = useQuery({
    queryKey: ["indexer-status"],
    queryFn: fetchIndexerStatus,
    refetchInterval: 30_000,
    staleTime: 25_000
  });
  const chainStatus = query.data?.chains.find((chain) => chain.chainId === chainId);

  return {
    isLagging: chainStatus?.status === "lagging",
    isSyncing: chainStatus?.status === "syncing",
    lagBlocks: chainStatus?.lagBlocks ?? 0,
    status: chainStatus?.status,
    isLoading: query.isLoading
  };
}
