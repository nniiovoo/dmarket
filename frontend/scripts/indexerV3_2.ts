// Stand-alone v3.2 indexer runner. The unified scripts/indexer.ts already
// picks v3.2 up alongside v3 and v3.1 — this script exists for ops cases
// where you want to run JUST the v3.2 indexer (e.g. backfilling on a
// dedicated worker without touching the v3 cursor).
//
// Behaviour matches scripts/indexer.ts: continuous loop by default,
// pass --once for a single catch-up pass and exit.

import { prisma } from "../lib/db";
import { catchUpV3_2 } from "../lib/indexer/catchUpV3_2";
import {
  DEPLOYMENT_BLOCK_V3_2,
  getIndexerV3_2MarketplaceAddress,
  INDEXED_V3_2_CHAIN_IDS,
  INDEXER_POLL_INTERVAL_MS
} from "../lib/indexer/config";
import { liveWatchV3_2 } from "../lib/indexer/liveWatchV3_2";

const once = process.argv.includes("--once");

async function main() {
  if (INDEXED_V3_2_CHAIN_IDS.length === 0) {
    console.warn(
      "v3.2 indexer: no chains configured. Set NEXT_PUBLIC_V3_2_ARBITRUMSEPOLIA_MARKETPLACE_ADDRESS to enable."
    );
    await prisma.$disconnect();
    return;
  }

  for (const chainId of INDEXED_V3_2_CHAIN_IDS) {
    try {
      await catchUpFromState(chainId);
    } catch (error) {
      console.error(`[v3.2 chain ${chainId}] initial catch-up failed, will retry on next tick`, error);
    }
  }

  if (once) {
    await prisma.$disconnect();
    return;
  }

  const stoppers = INDEXED_V3_2_CHAIN_IDS.map((chainId) => liveWatchV3_2(chainId));
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
  for (const chainId of INDEXED_V3_2_CHAIN_IDS) {
    try {
      await catchUpFromState(chainId);
    } catch (error) {
      console.error(`[v3.2 chain ${chainId}] periodic catch-up failed`, error);
    }
  }
}

async function catchUpFromState(chainId: number) {
  const marketplaceAddress = getIndexerV3_2MarketplaceAddress(chainId).toLowerCase();
  const state = await prisma.indexerStateV3_2.findUnique({
    where: { chainId_marketplaceAddress: { chainId, marketplaceAddress } }
  });
  const fromBlock = state ? state.lastBlock + 1n : DEPLOYMENT_BLOCK_V3_2[chainId];
  const lastProcessed = await catchUpV3_2(chainId, fromBlock);

  console.log(`[v3.2 chain ${chainId}] caught up to block ${lastProcessed}`);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
