import escrowMarketplaceV2AbiJson from "../../abi/EscrowMarketplaceV2.json";
import { advanceIndexerState, normalizeLogs, processLogs } from "./catchUp";
import { createIndexerClient, getIndexerMarketplaceAddress, INDEXER_POLL_INTERVAL_MS } from "./config";

export function liveWatch(chainId: number): () => void {
  const client = createIndexerClient(chainId);
  let queue = Promise.resolve();

  const stop = client.watchContractEvent({
    address: getIndexerMarketplaceAddress(chainId),
    abi: escrowMarketplaceV2AbiJson,
    pollingInterval: INDEXER_POLL_INTERVAL_MS,
    onLogs: (rawLogs) => {
      queue = queue
        .then(async () => {
          const logs = normalizeLogs(rawLogs);
          await processLogs(chainId, logs, client);

          if (logs.length > 0) {
            const lastBlock = logs.reduce((highest, log) => (log.blockNumber > highest ? log.blockNumber : highest), logs[0].blockNumber);
            await advanceIndexerState(chainId, lastBlock);
            console.log(`[chain ${chainId}] live indexed ${logs.length} logs through block ${lastBlock}`);
          }
        })
        .catch((error: unknown) => {
          console.error(`[chain ${chainId}] live watch failed`, error);
        });
    },
    onError: (error) => {
      console.error(`[chain ${chainId}] watch error`, error);
    }
  });

  console.log(`[chain ${chainId}] live watch started`);
  return stop;
}
