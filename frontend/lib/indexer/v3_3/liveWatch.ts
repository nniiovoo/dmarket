// Live-watch for the four v3.3 shop-economy contracts. Subscribes via
// `watchContractEvent` per contract; on every batch of logs it pushes
// through the same processLogs path as catch-up. Stoppers are returned
// so the daemon can tear them down on shutdown.

import shopNftAbiJson from "../../../abi/ShopNFT.json";
import shopSharesAbiJson from "../../../abi/ShopShares.json";
import revenueDistributorAbiJson from "../../../abi/RevenueDistributor.json";
import shareMarketAbiJson from "../../../abi/ShareMarket.json";
import marketplaceAbiJson from "../../../abi/EscrowMarketplaceV3_3.json";
import klerosAdapterAbiJson from "../../../abi/KlerosV2DisputeAdapterV3_3.json";

import { prisma } from "../../db";
import { normalizeLogs } from "../catchUp";
import { createIndexerClient, INDEXER_POLL_INTERVAL_MS } from "../config";
import { advanceCursor, processLogs } from "./catchUp";
import { getContractAddress, V3_3_CONTRACT_TYPES, type V3_3ContractType } from "./config";

const ABI_BY_TYPE = {
  shopNft: shopNftAbiJson,
  shopShares: shopSharesAbiJson,
  distributor: revenueDistributorAbiJson,
  shareMarket: shareMarketAbiJson,
  marketplace: marketplaceAbiJson,
  klerosAdapter: klerosAdapterAbiJson
} as const;

/// Returns a list of stoppers — one per contract subscription that
/// could be started. Contracts without an address in env are silently
/// skipped (catch-up will also have skipped them).
export function liveWatchShopEconomy(chainId: number): Array<() => void> {
  const stoppers: Array<() => void> = [];
  for (const contractType of V3_3_CONTRACT_TYPES) {
    const stop = startContractWatch(chainId, contractType);
    if (stop) stoppers.push(stop);
  }
  return stoppers;
}

function startContractWatch(
  chainId: number,
  contractType: V3_3ContractType
): (() => void) | undefined {
  const address = getContractAddress(chainId, contractType);
  if (!address) return undefined;
  const lowerAddress = address.toLowerCase();
  const client = createIndexerClient(chainId);
  let queue: Promise<void> = Promise.resolve();

  const handle: Parameters<typeof client.watchContractEvent>[0]["onLogs"] = (rawLogs) => {
    queue = queue
      .then(async () => {
        const logs = normalizeLogs(rawLogs);
        await processLogs(prisma, chainId, contractType, logs, client);
        if (logs.length > 0) {
          const lastBlock = logs.reduce(
            (highest, log) => (log.blockNumber > highest ? log.blockNumber : highest),
            logs[0]!.blockNumber
          );
          await advanceCursor(chainId, lowerAddress, contractType, lastBlock);
          console.log(
            `[v3.3 ${contractType} chain ${chainId}] live indexed ${logs.length} logs through block ${lastBlock}`
          );
        }
      })
      .catch((err: unknown) => {
        console.error(`[v3.3 ${contractType} chain ${chainId}] live watch failed`, err);
      });
  };

  const stop = client.watchContractEvent({
    address: address as `0x${string}`,
    abi: ABI_BY_TYPE[contractType],
    pollingInterval: INDEXER_POLL_INTERVAL_MS,
    onLogs: handle,
    onError: (err) =>
      console.error(`[v3.3 ${contractType} chain ${chainId}] watch error`, err)
  });

  console.log(`[v3.3 ${contractType} chain ${chainId}] live watch started @ ${lowerAddress}`);
  return () => stop();
}
