// V3.2 live watcher. Mirrors liveWatchV3_1 but binds to the V3.2 marketplace
// ABI + address and routes logs through processLogsV3_2.

import escrowMarketplaceERC20AbiJson from "../../abi/EscrowMarketplaceERC20.json";
import { normalizeLogs } from "./catchUp";
import { advanceIndexerStateV3_2, processLogsV3_2 } from "./catchUpV3_2";
import {
  createIndexerClient,
  getIndexerV3_2MarketplaceAddress,
  INDEXER_POLL_INTERVAL_MS
} from "./config";

export function liveWatchV3_2(chainId: number): () => void {
  const client = createIndexerClient(chainId);
  let queue = Promise.resolve();

  const handleLogs: Parameters<typeof client.watchContractEvent>[0]["onLogs"] = (rawLogs) => {
    queue = queue
      .then(async () => {
        const logs = normalizeLogs(rawLogs);
        await processLogsV3_2(chainId, logs, client);

        if (logs.length > 0) {
          const lastBlock = logs.reduce(
            (highest, log) => (log.blockNumber > highest ? log.blockNumber : highest),
            logs[0].blockNumber
          );
          await advanceIndexerStateV3_2(chainId, lastBlock);
          console.log(`[v3.2 chain ${chainId}] live indexed ${logs.length} logs through block ${lastBlock}`);
        }
      })
      .catch((error: unknown) => {
        console.error(`[v3.2 chain ${chainId}] live watch failed`, error);
      });
  };

  const stop = client.watchContractEvent({
    address: getIndexerV3_2MarketplaceAddress(chainId),
    abi: escrowMarketplaceERC20AbiJson,
    pollingInterval: INDEXER_POLL_INTERVAL_MS,
    onLogs: handleLogs,
    onError: (error) => console.error(`[v3.2 chain ${chainId}] marketplace watch error`, error)
  });

  console.log(`[v3.2 chain ${chainId}] live watch started`);

  return () => {
    stop();
  };
}
