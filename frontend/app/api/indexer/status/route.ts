import { NextResponse } from "next/server";
import { createPublicClient, http } from "viem";
import { arbitrumSepolia, polygonAmoy, sepolia } from "viem/chains";

import { withErrorBoundary } from "@/lib/api/withErrorBoundary";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

const indexedChains = [
  { id: sepolia.id, chain: sepolia, rpcUrl: process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL ?? process.env.SEPOLIA_RPC_URL },
  { id: polygonAmoy.id, chain: polygonAmoy, rpcUrl: process.env.NEXT_PUBLIC_AMOY_RPC_URL ?? process.env.AMOY_RPC_URL }
] as const;

// Average block time per chain (seconds). Used to convert block-lag into a
// human-relevant seconds-lag estimate. Coarse — Arbitrum produces blocks at
// ~250 ms, but the estimate is for "is the indexer keeping up", not for
// physics-grade timing.
const AVERAGE_BLOCK_SECONDS: Record<number, number> = {
  [sepolia.id]: 12,
  [polygonAmoy.id]: 2,
  [arbitrumSepolia.id]: 0.25
};

const arbSepoliaRpcUrl =
  process.env.NEXT_PUBLIC_ARBITRUM_SEPOLIA_RPC_URL ?? process.env.ARBITRUM_SEPOLIA_RPC_URL;

export const GET = withErrorBoundary(async () => {
  const chainStatuses = await Promise.all(
    indexedChains.map(async ({ id: chainId, chain, rpcUrl }) => {
      try {
        const client = createPublicClient({ chain, transport: http(rpcUrl) });
        const [state, currentBlock] = await Promise.all([
          prisma.indexerState.findUnique({ where: { chainId } }),
          client.getBlockNumber()
        ]);
        const lastIndexed = state?.lastBlock ?? 0n;
        const lag = currentBlock > lastIndexed ? currentBlock - lastIndexed : 0n;

        return {
          chainId,
          lastIndexedBlock: lastIndexed.toString(),
          currentBlock: currentBlock.toString(),
          lagBlocks: Number(lag),
          status: lag > 30n ? "lagging" : lag > 5n ? "syncing" : "healthy"
        };
      } catch (caught) {
        return {
          chainId,
          lastIndexedBlock: null,
          currentBlock: null,
          lagBlocks: null,
          status: "unknown",
          error: caught instanceof Error ? caught.message : "Failed to read indexer status"
        };
      }
    })
  );

  // V3.2 surface. We only know about Arbitrum Sepolia for now, and only if
  // the marketplace env is configured — otherwise the field is null. We
  // expose lagSeconds (estimate) in addition to lagBlocks because on
  // Arbitrum a 100-block lag is ~25 s, which is the metric humans want.
  const v3_2MarketplaceAddress =
    process.env.NEXT_PUBLIC_V3_2_ARBITRUMSEPOLIA_MARKETPLACE_ADDRESS ??
    process.env.V3_2_ARBITRUMSEPOLIA_MARKETPLACE_ADDRESS;

  let v3_2: V3_2Status | null = null;
  if (v3_2MarketplaceAddress) {
    try {
      const client = createPublicClient({ chain: arbitrumSepolia, transport: http(arbSepoliaRpcUrl) });
      const lowerAddress = v3_2MarketplaceAddress.toLowerCase();
      const [state, currentBlock, orderCount] = await Promise.all([
        prisma.indexerStateV3_2.findUnique({
          where: { chainId_marketplaceAddress: { chainId: arbitrumSepolia.id, marketplaceAddress: lowerAddress } }
        }),
        client.getBlockNumber(),
        prisma.onChainOrderV3_2.count({
          where: { chainId: arbitrumSepolia.id, marketplaceAddress: lowerAddress }
        })
      ]);
      const lastIndexed = state?.lastBlock ?? 0n;
      const lagBlocks = currentBlock > lastIndexed ? currentBlock - lastIndexed : 0n;
      const lagSeconds = Math.round(Number(lagBlocks) * AVERAGE_BLOCK_SECONDS[arbitrumSepolia.id]);

      v3_2 = {
        chainId: arbitrumSepolia.id,
        marketplaceAddress: v3_2MarketplaceAddress,
        lastIndexedBlock: lastIndexed.toString(),
        currentBlock: currentBlock.toString(),
        lagBlocks: Number(lagBlocks),
        lagSeconds,
        orderCount,
        status: lagBlocks > 30n ? "lagging" : lagBlocks > 5n ? "syncing" : "healthy"
      };
    } catch (caught) {
      v3_2 = {
        chainId: arbitrumSepolia.id,
        marketplaceAddress: v3_2MarketplaceAddress,
        lastIndexedBlock: null,
        currentBlock: null,
        lagBlocks: null,
        lagSeconds: null,
        orderCount: null,
        status: "unknown",
        error: caught instanceof Error ? caught.message : "Failed to read v3.2 indexer status"
      };
    }
  }

  // v3.2 Kleros adapter indexer status. Same shape as v3_2 above, but
  // counts come from the adapter mirror columns: escalatedCount =
  // orders with klerosDisputeId set, ruledCount = orders with
  // klerosRuling set.
  const v3_2KlerosAdapterAddress =
    process.env.NEXT_PUBLIC_V3_2_ARBITRUMSEPOLIA_KLEROS_ADAPTER_ADDRESS ??
    process.env.V3_2_ARBITRUMSEPOLIA_KLEROS_ADAPTER_ADDRESS;

  let v3_2_kleros: V3_2KlerosStatus | null = null;
  if (v3_2KlerosAdapterAddress) {
    try {
      const client = createPublicClient({ chain: arbitrumSepolia, transport: http(arbSepoliaRpcUrl) });
      const lowerAdapter = v3_2KlerosAdapterAddress.toLowerCase();
      const [state, currentBlock, escalatedCount, ruledCount] = await Promise.all([
        prisma.indexerStateV3_2KlerosAdapter.findUnique({
          where: { chainId_adapterAddress: { chainId: arbitrumSepolia.id, adapterAddress: lowerAdapter } }
        }),
        client.getBlockNumber(),
        prisma.onChainOrderV3_2.count({
          where: { chainId: arbitrumSepolia.id, klerosDisputeId: { not: null } }
        }),
        prisma.onChainOrderV3_2.count({
          where: { chainId: arbitrumSepolia.id, klerosRuling: { not: null } }
        })
      ]);
      const lastIndexed = state?.lastIndexedBlock ?? 0n;
      const lagBlocks = currentBlock > lastIndexed ? currentBlock - lastIndexed : 0n;
      const lagSeconds = Math.round(Number(lagBlocks) * AVERAGE_BLOCK_SECONDS[arbitrumSepolia.id]);

      v3_2_kleros = {
        chainId: arbitrumSepolia.id,
        adapterAddress: v3_2KlerosAdapterAddress,
        lastIndexedBlock: lastIndexed.toString(),
        currentBlock: currentBlock.toString(),
        lagBlocks: Number(lagBlocks),
        lagSeconds,
        escalatedCount,
        ruledCount,
        status: lagBlocks > 30n ? "lagging" : lagBlocks > 5n ? "syncing" : "healthy"
      };
    } catch (caught) {
      v3_2_kleros = {
        chainId: arbitrumSepolia.id,
        adapterAddress: v3_2KlerosAdapterAddress,
        lastIndexedBlock: null,
        currentBlock: null,
        lagBlocks: null,
        lagSeconds: null,
        escalatedCount: null,
        ruledCount: null,
        status: "unknown",
        error: caught instanceof Error ? caught.message : "Failed to read v3.2 kleros indexer status"
      };
    }
  }

  return NextResponse.json({ chains: chainStatuses, v3_2, v3_2_kleros });
});

type V3_2Status = {
  chainId: number;
  marketplaceAddress: string;
  lastIndexedBlock: string | null;
  currentBlock: string | null;
  lagBlocks: number | null;
  lagSeconds: number | null;
  orderCount: number | null;
  status: "healthy" | "syncing" | "lagging" | "unknown";
  error?: string;
};

type V3_2KlerosStatus = {
  chainId: number;
  adapterAddress: string;
  lastIndexedBlock: string | null;
  currentBlock: string | null;
  lagBlocks: number | null;
  lagSeconds: number | null;
  escalatedCount: number | null;
  ruledCount: number | null;
  status: "healthy" | "syncing" | "lagging" | "unknown";
  error?: string;
};
