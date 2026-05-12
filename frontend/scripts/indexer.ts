import { prisma } from "../lib/db";
import { catchUp } from "../lib/indexer/catchUp";
import { DEPLOYMENT_BLOCK, INDEXED_CHAIN_IDS, INDEXER_POLL_INTERVAL_MS } from "../lib/indexer/config";
import { liveWatch } from "../lib/indexer/liveWatch";

const once = process.argv.includes("--once");

async function main() {
  for (const chainId of INDEXED_CHAIN_IDS) {
    await catchUpFromState(chainId);
  }

  if (once) {
    await prisma.$disconnect();
    return;
  }

  const stoppers = INDEXED_CHAIN_IDS.map((chainId) => liveWatch(chainId));
  const interval = setInterval(() => {
    void runPeriodicCatchUp();
  }, INDEXER_POLL_INTERVAL_MS);

  async function shutdown() {
    clearInterval(interval);
    stoppers.forEach((stop) => stop());
    await prisma.$disconnect();
    process.exit(0);
  }

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

async function runPeriodicCatchUp() {
  for (const chainId of INDEXED_CHAIN_IDS) {
    try {
      await catchUpFromState(chainId);
    } catch (error) {
      console.error(`[chain ${chainId}] periodic catch-up failed`, error);
    }
  }
}

async function catchUpFromState(chainId: number) {
  const state = await prisma.indexerState.findUnique({ where: { chainId } });
  const fromBlock = state ? state.lastBlock + 1n : DEPLOYMENT_BLOCK[chainId];
  const lastProcessed = await catchUp(chainId, fromBlock);

  console.log(`[chain ${chainId}] caught up to block ${lastProcessed}`);
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
