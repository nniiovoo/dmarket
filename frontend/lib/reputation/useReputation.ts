"use client";

import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";

import type { ScoreComponents } from "@/lib/reputation/score";

export type OnChainAttestation = {
  score: number;
  version: number;
  issuedAt: string;
  expiry: string;
  txHash: string;
  registryAddress: string;
};

export type CachedAttestation = {
  score: number;
  components: ScoreComponents;
  sampleSize: number;
  computedAt: string;
};

export type ReputationResponse = {
  subject: Address;
  onChain: OnChainAttestation | null;
  cached: CachedAttestation | null;
  sampleSize: number;
};

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

async function fetchReputation(address: Address): Promise<ReputationResponse> {
  const res = await fetch(`/api/reputation/${address}`);
  const data = (await res.json()) as ReputationResponse | { error?: string };
  if (!res.ok) {
    const message = "error" in data && data.error ? data.error : "Failed to fetch reputation";
    throw new Error(message);
  }
  return data as ReputationResponse;
}

export function useReputation(address: Address | undefined) {
  const query = useQuery({
    queryKey: ["reputation", address?.toLowerCase()],
    queryFn: () => fetchReputation(address as Address),
    enabled: address !== undefined,
    // Reputation changes slowly (cron is on a 15-min cadence at most, and
    // an on-chain attestation is good for 30 days). A long staleTime keeps
    // the UI snappy on repeat renders without hammering the API.
    staleTime: ONE_DAY_MS,
    refetchOnWindowFocus: false,
    retry: 1
  });

  return {
    data: query.data,
    isLoading: query.isLoading,
    error: query.error as Error | null,
    refetch: query.refetch
  };
}
