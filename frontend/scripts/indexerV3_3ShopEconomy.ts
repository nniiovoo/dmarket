// Standalone runner for the v3.3 shop-economy indexer (Phase K.5a).
//
// Usage:
//   npx tsx scripts/indexerV3_3ShopEconomy.ts            # continuous loop
//   npx tsx scripts/indexerV3_3ShopEconomy.ts --once     # one catch-up pass, exit
//   npx tsx scripts/indexerV3_3ShopEconomy.ts --contract shopNft
//
// --contract restricts to a single contract type. Useful when backfilling
// a misbehaving stream without retouching the others.

import { prisma } from "../lib/db";
import {
  INDEXED_V3_3_SHOP_ECONOMY_CHAIN_IDS,
  V3_3_CONTRACT_TYPES,
  type V3_3ContractType
} from "../lib/indexer/v3_3/config";
import { catchUpContract, catchUpShopEconomy } from "../lib/indexer/v3_3/catchUp";
import { liveWatchShopEconomy } from "../lib/indexer/v3_3/liveWatch";
import { INDEXER_POLL_INTERVAL_MS } from "../lib/indexer/config";

const argv = process.argv.slice(2);
const once = argv.includes("--once");

function parseContractFilter(): V3_3ContractType | null {
  const idx = argv.indexOf("--contract");
  if (idx === -1) return null;
  const next = argv[idx + 1];
  if (!next) throw new Error("--contract requires a value");
  if (!V3_3_CONTRACT_TYPES.includes(next as V3_3ContractType)) {
    throw new Error(
      `--contract must be one of: ${V3_3_CONTRACT_TYPES.join(", ")}`
    );
  }
  return next as V3_3ContractType;
}

async function main() {
  const onlyContract = parseContractFilter();

  if (INDEXED_V3_3_SHOP_ECONOMY_CHAIN_IDS.length === 0) {
    console.warn(
      "v3.3 shop-economy indexer: no chains configured. Set V3_3_ARBITRUMSEPOLIA_SHOP_NFT_ADDRESS (and friends) in .env to enable."
    );
    await prisma.$disconnect();
    return;
  }

  for (const chainId of INDEXED_V3_3_SHOP_ECONOMY_CHAIN_IDS) {
    try {
      if (onlyContract) {
        const r = await catchUpContract(chainId, onlyContract);
        console.log(
          `[v3.3 shop-economy chain ${chainId}] ${onlyContract}: ${r.skipped ? "skipped (no address)" : `${r.logs} logs, ${r.fromBlock}-${r.toBlock}`}`
        );
      } else {
        const results = await catchUpShopEconomy(chainId);
        for (const r of results) {
          console.log(
            `[v3.3 shop-economy chain ${chainId}] ${r.contractType}: ${r.skipped ? "skipped (no address)" : `${r.logs} logs, ${r.fromBlock}-${r.toBlock}`}`
          );
        }
      }
    } catch (err) {
      console.error(
        `[v3.3 shop-economy chain ${chainId}] initial catch-up failed`,
        err
      );
    }
  }

  if (once) {
    await prisma.$disconnect();
    return;
  }

  const stoppers = INDEXED_V3_3_SHOP_ECONOMY_CHAIN_IDS.flatMap((chainId) =>
    liveWatchShopEconomy(chainId)
  );
  const interval = setInterval(() => {
    void runPeriodicCatchUp();
  }, INDEXER_POLL_INTERVAL_MS);

  async function shutdown() {
    clearInterval(interval);
    stoppers.forEach((s) => s());
    await prisma.$disconnect();
    process.exit(0);
  }
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

async function runPeriodicCatchUp() {
  for (const chainId of INDEXED_V3_3_SHOP_ECONOMY_CHAIN_IDS) {
    try {
      await catchUpShopEconomy(chainId);
    } catch (err) {
      console.error(
        `[v3.3 shop-economy chain ${chainId}] periodic catch-up failed`,
        err
      );
    }
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
