import { prisma } from "../lib/db";
import { catchUp } from "../lib/indexer/catchUp";
import { catchUpV3_1 } from "../lib/indexer/catchUpV3_1";
import { catchUpV3_2 } from "../lib/indexer/catchUpV3_2";
import { catchUpV3_2Kleros } from "../lib/indexer/catchUpV3_2Kleros";
import {
  DEPLOYMENT_BLOCK,
  DEPLOYMENT_BLOCK_V3_1,
  DEPLOYMENT_BLOCK_V3_2,
  DEPLOYMENT_BLOCK_V3_2_KLEROS,
  getIndexerV3_2KlerosAdapterAddress,
  getIndexerV3_2MarketplaceAddress,
  INDEXED_CHAIN_IDS,
  INDEXED_V3_1_CHAIN_IDS,
  INDEXED_V3_2_CHAIN_IDS,
  INDEXED_V3_2_KLEROS_CHAIN_IDS,
  INDEXER_POLL_INTERVAL_MS
} from "../lib/indexer/config";
import { liveWatch } from "../lib/indexer/liveWatch";
import { liveWatchV3_1 } from "../lib/indexer/liveWatchV3_1";
import { liveWatchV3_2 } from "../lib/indexer/liveWatchV3_2";
import { liveWatchV3_2Kleros } from "../lib/indexer/liveWatchV3_2Kleros";
import { catchUpShopEconomy } from "../lib/indexer/v3_3/catchUp";
import { liveWatchShopEconomy } from "../lib/indexer/v3_3/liveWatch";
import { INDEXED_V3_3_SHOP_ECONOMY_CHAIN_IDS } from "../lib/indexer/v3_3/config";

const once = process.argv.includes("--once");

async function main() {
  for (const chainId of INDEXED_CHAIN_IDS) {
    try {
      await catchUpFromState(chainId);
    } catch (error) {
      // Transient RPC failures (rate limits, brief outages) shouldn't kill the
      // indexer at startup — log and let the periodic loop retry.
      console.error(`[chain ${chainId}] initial catch-up failed, will retry on next tick`, error);
    }
  }

  // V3.1 catch-up runs as a separate pass over its own cursor table. Even
  // when the chainId overlaps with the V3 indexer above, the two writes
  // target different rows (OnChainOrder vs OnChainOrderV3_1).
  for (const chainId of INDEXED_V3_1_CHAIN_IDS) {
    try {
      await catchUpV3_1FromState(chainId);
    } catch (error) {
      console.error(`[v3.1 chain ${chainId}] initial catch-up failed, will retry on next tick`, error);
    }
  }

  // V3.2 catch-up — parallel marketplace with its own cursor keyed on
  // (chainId, marketplaceAddress). Writes go to OnChainOrderV3_2.
  for (const chainId of INDEXED_V3_2_CHAIN_IDS) {
    try {
      await catchUpV3_2FromState(chainId);
    } catch (error) {
      console.error(`[v3.2 chain ${chainId}] initial catch-up failed, will retry on next tick`, error);
    }
  }

  // V3.2 Kleros adapter catch-up — independent stream that mirrors
  // adapter events onto the existing OnChainOrderV3_2 rows. Failure
  // here MUST NOT abort the marketplace pass above.
  for (const chainId of INDEXED_V3_2_KLEROS_CHAIN_IDS) {
    try {
      await catchUpV3_2KlerosFromState(chainId);
    } catch (error) {
      console.error(`[v3.2 kleros chain ${chainId}] initial catch-up failed, will retry on next tick`, error);
    }
  }

  // V3.3 shop-economy catch-up — four independent contracts
  // (ShopNFT / ShopShares / RevenueDistributor / ShareMarket), each
  // with its own cursor. Failures inside one contract don't stall the
  // others. The whole pass is wrapped so a chain-level failure can't
  // affect the v3.2 / Kleros passes above.
  for (const chainId of INDEXED_V3_3_SHOP_ECONOMY_CHAIN_IDS) {
    try {
      await catchUpShopEconomy(chainId);
    } catch (error) {
      console.error(
        `[v3.3 shop-economy chain ${chainId}] initial catch-up failed, will retry on next tick`,
        error
      );
    }
  }

  if (once) {
    await prisma.$disconnect();
    return;
  }

  const stoppers = INDEXED_CHAIN_IDS.map((chainId) => liveWatch(chainId));
  const v3_1Stoppers = INDEXED_V3_1_CHAIN_IDS.map((chainId) => liveWatchV3_1(chainId));
  const v3_2Stoppers = INDEXED_V3_2_CHAIN_IDS.map((chainId) => liveWatchV3_2(chainId));
  const v3_2KlerosStoppers = INDEXED_V3_2_KLEROS_CHAIN_IDS.map((chainId) => liveWatchV3_2Kleros(chainId));
  const v3_3ShopEconomyStoppers = INDEXED_V3_3_SHOP_ECONOMY_CHAIN_IDS.flatMap((chainId) =>
    liveWatchShopEconomy(chainId)
  );
  const interval = setInterval(() => {
    void runPeriodicCatchUp();
  }, INDEXER_POLL_INTERVAL_MS);

  async function shutdown() {
    clearInterval(interval);
    stoppers.forEach((stop) => stop());
    v3_1Stoppers.forEach((stop) => stop());
    v3_2Stoppers.forEach((stop) => stop());
    v3_2KlerosStoppers.forEach((stop) => stop());
    v3_3ShopEconomyStoppers.forEach((stop) => stop());
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

  for (const chainId of INDEXED_V3_1_CHAIN_IDS) {
    try {
      await catchUpV3_1FromState(chainId);
    } catch (error) {
      console.error(`[v3.1 chain ${chainId}] periodic catch-up failed`, error);
    }
  }

  for (const chainId of INDEXED_V3_2_CHAIN_IDS) {
    try {
      await catchUpV3_2FromState(chainId);
    } catch (error) {
      console.error(`[v3.2 chain ${chainId}] periodic catch-up failed`, error);
    }
  }

  for (const chainId of INDEXED_V3_2_KLEROS_CHAIN_IDS) {
    try {
      await catchUpV3_2KlerosFromState(chainId);
    } catch (error) {
      console.error(`[v3.2 kleros chain ${chainId}] periodic catch-up failed`, error);
    }
  }

  for (const chainId of INDEXED_V3_3_SHOP_ECONOMY_CHAIN_IDS) {
    try {
      await catchUpShopEconomy(chainId);
    } catch (error) {
      console.error(`[v3.3 shop-economy chain ${chainId}] periodic catch-up failed`, error);
    }
  }
}

async function catchUpFromState(chainId: number) {
  const state = await prisma.indexerState.findUnique({ where: { chainId } });
  const fromBlock = state ? state.lastBlock + 1n : DEPLOYMENT_BLOCK[chainId];
  const lastProcessed = await catchUp(chainId, fromBlock);

  console.log(`[chain ${chainId}] caught up to block ${lastProcessed}`);
}

async function catchUpV3_1FromState(chainId: number) {
  const state = await prisma.indexerStateV3_1.findUnique({ where: { chainId } });
  const fromBlock = state ? state.lastBlock + 1n : DEPLOYMENT_BLOCK_V3_1[chainId];
  const lastProcessed = await catchUpV3_1(chainId, fromBlock);

  console.log(`[v3.1 chain ${chainId}] caught up to block ${lastProcessed}`);
}

async function catchUpV3_2FromState(chainId: number) {
  const marketplaceAddress = getIndexerV3_2MarketplaceAddress(chainId).toLowerCase();
  const state = await prisma.indexerStateV3_2.findUnique({
    where: { chainId_marketplaceAddress: { chainId, marketplaceAddress } }
  });
  const fromBlock = state ? state.lastBlock + 1n : DEPLOYMENT_BLOCK_V3_2[chainId];
  const lastProcessed = await catchUpV3_2(chainId, fromBlock);

  console.log(`[v3.2 chain ${chainId}] caught up to block ${lastProcessed}`);
}

async function catchUpV3_2KlerosFromState(chainId: number) {
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
