// Stand-alone runner for the v3.2 Kleros adapter indexer. The unified
// scripts/indexer.ts already picks the adapter stream up alongside v3 /
// v3.1 / v3.2 marketplace — this script exists for ops cases where you
// want to backfill or replay just the adapter without touching the
// marketplace cursor.

import { prisma } from "../lib/db";
import { catchUpV3_2Kleros } from "../lib/indexer/catchUpV3_2Kleros";
import {
  DEPLOYMENT_BLOCK_V3_2_KLEROS,
  getIndexerV3_2KlerosAdapterAddress,
  INDEXED_V3_2_KLEROS_CHAIN_IDS,
  INDEXER_POLL_INTERVAL_MS
} from "../lib/indexer/config";
import { liveWatchV3_2Kleros } from "../lib/indexer/liveWatchV3_2Kleros";

const once = process.argv.includes("--once");

async function main() {
  if (INDEXED_V3_2_KLEROS_CHAIN_IDS.length === 0) {
    console.warn(
      "v3.2 kleros indexer: no chains configured. Set NEXT_PUBLIC_V3_2_ARBITRUMSEPOLIA_KLEROS_ADAPTER_ADDRESS (and the marketplace env) to enable."
    );
    await prisma.$disconnect();
    return;
  }

  for (const chainId of INDEXED_V3_2_KLEROS_CHAIN_IDS) {
    try {
      await catchUpFromState(chainId);
    } catch (error) {
      console.error(`[v3.2 kleros chain ${chainId}] initial catch-up failed, will retry on next tick`, error);
    }
  }

  if (once) {
    await prisma.$disconnect();
    return;
  }

  const stoppers = INDEXED_V3_2_KLEROS_CHAIN_IDS.map((chainId) => liveWatchV3_2Kleros(chainId));
  const interval = setInterval(() => {
    void periodic();
  }, INDEXER_POLL_INTERVAL_MS);

  async function shutdown() {
    clearInterval(interval);
    stoppers.forEach((stop) => stop());
    await prisma.$disconnect();
    process.exit(0);
  }

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

async function periodic() {
  for (const chainId of INDEXED_V3_2_KLEROS_CHAIN_IDS) {
    try {
      await catchUpFromState(chainId);
    } catch (error) {
      console.error(`[v3.2 kleros chain ${chainId}] periodic catch-up failed`, error);
    }
  }
}

async function catchUpFromState(chainId: number) {
  const adapterAddress = getIndexerV3_2KlerosAdapterAddress(chainId).toLowerCase();
  const state = await prisma.indexerStateV3_2KlerosAdapter.findUnique({
    where: { chainId_adapterAddress: { chainId, adapterAddress } }
  });
  const fromBlock = state ? state.lastIndexedBlock + 1n : DEPLOYMENT_BLOCK_V3_2_KLEROS[chainId];
  const lastProcessed = await catchUpV3_2Kleros(chainId, fromBlock);

  console.log(`[v3.2 kleros chain ${chainId}] caught up to block ${lastProcessed}`);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
