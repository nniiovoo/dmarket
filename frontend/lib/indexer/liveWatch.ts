import escrowMarketplaceV2AbiJson from "../../abi/EscrowMarketplaceV2.json";
import evidenceRegistryV3AbiJson from "../../abi/EvidenceRegistryV3.json";
import { advanceIndexerState, normalizeLogs, processLogs } from "./catchUp";
import {
  createIndexerClient,
  getIndexerEvidenceRegistryAddress,
  getIndexerMarketplaceAddress,
  INDEXER_POLL_INTERVAL_MS
} from "./config";

export function liveWatch(chainId: number): () => void {
  const client = createIndexerClient(chainId);
  let queue = Promise.resolve();

  const handleLogs: Parameters<typeof client.watchContractEvent>[0]["onLogs"] = (rawLogs) => {
    queue = queue
      .then(async () => {
        const logs = normalizeLogs(rawLogs);
        await processLogs(chainId, logs, client);

        if (logs.length > 0) {
          const lastBlock = logs.reduce(
            (highest, log) => (log.blockNumber > highest ? log.blockNumber : highest),
            logs[0].blockNumber
          );
          await advanceIndexerState(chainId, lastBlock);
          console.log(`[chain ${chainId}] live indexed ${logs.length} logs through block ${lastBlock}`);
        }
      })
      .catch((error: unknown) => {
        console.error(`[chain ${chainId}] live watch failed`, error);
      });
  };

  const stopMarketplace = client.watchContractEvent({
    address: getIndexerMarketplaceAddress(chainId),
    abi: escrowMarketplaceV2AbiJson,
    pollingInterval: INDEXER_POLL_INTERVAL_MS,
    onLogs: handleLogs,
    onError: (error) => console.error(`[chain ${chainId}] marketplace watch error`, error)
  });

  const registryAddr = getIndexerEvidenceRegistryAddress(chainId);
  let stopRegistry: (() => void) | undefined;
  if (registryAddr !== undefined) {
    stopRegistry = client.watchContractEvent({
      address: registryAddr,
      abi: evidenceRegistryV3AbiJson,
      pollingInterval: INDEXER_POLL_INTERVAL_MS,
      onLogs: handleLogs,
      onError: (error) => console.error(`[chain ${chainId}] registry watch error`, error)
    });
  }

  console.log(
    `[chain ${chainId}] live watch started${registryAddr ? " (marketplace + registry)" : ""}`
  );

  return () => {
    stopMarketplace();
    stopRegistry?.();
  };
}
