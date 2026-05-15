import escrowMarketplaceV3_1AbiJson from "../../abi/EscrowMarketplaceV3_1.json";
import { normalizeLogs } from "./catchUp";
import { advanceIndexerStateV3_1, processLogsV3_1 } from "./catchUpV3_1";
import {
  createIndexerClient,
  getIndexerV3_1MarketplaceAddress,
  INDEXER_POLL_INTERVAL_MS
} from "./config";

export function liveWatchV3_1(chainId: number): () => void {
  const client = createIndexerClient(chainId);
  let queue = Promise.resolve();

  const handleLogs: Parameters<typeof client.watchContractEvent>[0]["onLogs"] = (rawLogs) => {
    queue = queue
      .then(async () => {
        const logs = normalizeLogs(rawLogs);
        await processLogsV3_1(chainId, logs, client);

        if (logs.length > 0) {
          const lastBlock = logs.reduce(
            (highest, log) => (log.blockNumber > highest ? log.blockNumber : highest),
            logs[0].blockNumber
          );
          await advanceIndexerStateV3_1(chainId, lastBlock);
          console.log(
            `[v3.1 chain ${chainId}] live indexed ${logs.length} logs through block ${lastBlock}`
          );
        }
      })
      .catch((error: unknown) => {
        console.error(`[v3.1 chain ${chainId}] live watch failed`, error);
      });
  };

  const stopMarketplace = client.watchContractEvent({
    address: getIndexerV3_1MarketplaceAddress(chainId),
    abi: escrowMarketplaceV3_1AbiJson,
    pollingInterval: INDEXER_POLL_INTERVAL_MS,
    onLogs: handleLogs,
    onError: (error) =>
      console.error(`[v3.1 chain ${chainId}] marketplace watch error`, error)
  });

  console.log(`[v3.1 chain ${chainId}] live watch started`);

  return () => {
    stopMarketplace();
  };
}
