// v3.2 Kleros adapter live watcher. Mirrors liveWatchV3_2 but binds to
// the adapter ABI + address and routes logs through processLogsV3_2Kleros.

import klerosAdapterAbiJson from "../../abi/KlerosV2DisputeAdapterV3_2.json";
import { normalizeLogs } from "./catchUp";
import { advanceIndexerStateV3_2Kleros, processLogsV3_2Kleros } from "./catchUpV3_2Kleros";
import {
  createIndexerClient,
  getIndexerV3_2KlerosAdapterAddress,
  INDEXER_POLL_INTERVAL_MS
} from "./config";

export function liveWatchV3_2Kleros(chainId: number): () => void {
  const client = createIndexerClient(chainId);
  let queue = Promise.resolve();

  const handleLogs: Parameters<typeof client.watchContractEvent>[0]["onLogs"] = (rawLogs) => {
    queue = queue
      .then(async () => {
        const logs = normalizeLogs(rawLogs);
        await processLogsV3_2Kleros(chainId, logs, client);

        if (logs.length > 0) {
          const lastBlock = logs.reduce(
            (highest, log) => (log.blockNumber > highest ? log.blockNumber : highest),
            logs[0].blockNumber
          );
          await advanceIndexerStateV3_2Kleros(chainId, lastBlock);
          console.log(
            `[v3.2 kleros chain ${chainId}] live indexed ${logs.length} logs through block ${lastBlock}`
          );
        }
      })
      .catch((error: unknown) => {
        console.error(`[v3.2 kleros chain ${chainId}] live watch failed`, error);
      });
  };

  const stop = client.watchContractEvent({
    address: getIndexerV3_2KlerosAdapterAddress(chainId),
    abi: klerosAdapterAbiJson,
    pollingInterval: INDEXER_POLL_INTERVAL_MS,
    onLogs: handleLogs,
    onError: (error) => console.error(`[v3.2 kleros chain ${chainId}] adapter watch error`, error)
  });

  console.log(`[v3.2 kleros chain ${chainId}] live watch started`);

  return () => {
    stop();
  };
}
