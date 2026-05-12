import { NextResponse } from "next/server";
import { createPublicClient, http } from "viem";
import { polygonAmoy, sepolia } from "viem/chains";

import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

const indexedChains = [
  { id: sepolia.id, chain: sepolia, rpcUrl: process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL ?? process.env.SEPOLIA_RPC_URL },
  { id: polygonAmoy.id, chain: polygonAmoy, rpcUrl: process.env.NEXT_PUBLIC_AMOY_RPC_URL ?? process.env.AMOY_RPC_URL }
] as const;

export async function GET() {
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

  return NextResponse.json({ chains: chainStatuses });
}
