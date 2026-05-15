// v3.2 Kleros adapter catch-up. Mirrors catchUpV3_2.ts but targets the
// adapter contract address and writes to OnChainOrderV3_2's adapter
// mirror columns (plus its own cursor table IndexerStateV3_2KlerosAdapter).

import type { Log } from "viem";

import { prisma } from "../db";
import { applyAdapterEventV3_2 } from "./applyEventV3_2Kleros";
import { normalizeLogs } from "./catchUp";
import {
  createIndexerClient,
  DEPLOYMENT_BLOCK_V3_2_KLEROS,
  getIndexerV3_2KlerosAdapterAddress,
  getIndexerV3_2MarketplaceAddress,
  INDEXER_CHUNK_SIZE_BLOCKS,
  INDEXER_REQUEST_DELAY_MS
} from "./config";
import { compareLogs, type IndexedLog } from "./eventDecoder";
import { decodeAdapterLogs } from "./eventDecoderV3_2Kleros";

type IndexerClient = ReturnType<typeof createIndexerClient>;

export async function catchUpV3_2Kleros(chainId: number, fromBlock: bigint): Promise<bigint> {
  const client = createIndexerClient(chainId);
  await throttleRpc();
  const latestBlock = await client.getBlockNumber();
  const deploymentBlock = DEPLOYMENT_BLOCK_V3_2_KLEROS[chainId];
  const startBlock = maxBigInt(fromBlock, deploymentBlock ?? fromBlock);

  if (startBlock > latestBlock) {
    await advanceIndexerStateV3_2Kleros(chainId, latestBlock);
    return latestBlock;
  }

  let lastProcessed = startBlock - 1n;

  for (let from = startBlock; from <= latestBlock; from += INDEXER_CHUNK_SIZE_BLOCKS + 1n) {
    const toBlock = minBigInt(from + INDEXER_CHUNK_SIZE_BLOCKS, latestBlock);
    const logs = await getLogsAdaptiveV3_2Kleros(chainId, client, from, toBlock);

    await processLogsV3_2Kleros(chainId, logs, client);
    await advanceIndexerStateV3_2Kleros(chainId, toBlock);
    lastProcessed = toBlock;
    console.log(`[v3.2 kleros chain ${chainId}] indexed blocks ${from}-${toBlock} (${logs.length} logs)`);
  }

  return maxBigInt(lastProcessed, latestBlock);
}

export async function processLogsV3_2Kleros(
  chainId: number,
  logs: IndexedLog[],
  client = createIndexerClient(chainId)
) {
  if (logs.length === 0) return;

  const sortedLogs = [...logs].sort(compareLogs);
  const timestampByBlock = await fetchBlockTimestamps(client, sortedLogs);

  const adapterAddr = getIndexerV3_2KlerosAdapterAddress(chainId).toLowerCase();
  const adapterLogs = sortedLogs.filter((log) => log.address.toLowerCase() === adapterAddr);
  const events = decodeAdapterLogs(adapterLogs, timestampByBlock);

  // Adapter events all reference one marketplace — looked up from env
  // rather than from each event. We resolve it once per batch.
  const marketplaceAddr = getIndexerV3_2MarketplaceAddress(chainId).toLowerCase();

  for (const event of events) {
    try {
      await applyAdapterEventV3_2(prisma, chainId, marketplaceAddr, event);
    } catch (error) {
      console.error(
        `[v3.2 kleros chain ${chainId}] applyEvent failed for ${event.kind} order=${event.orderId.toString()}`,
        error
      );
    }
  }
}

export async function advanceIndexerStateV3_2Kleros(chainId: number, lastBlock: bigint) {
  const adapterAddress = getIndexerV3_2KlerosAdapterAddress(chainId).toLowerCase();
  const existing = await prisma.indexerStateV3_2KlerosAdapter.findUnique({
    where: { chainId_adapterAddress: { chainId, adapterAddress } }
  });

  if (existing && existing.lastIndexedBlock >= lastBlock) {
    return;
  }

  await prisma.indexerStateV3_2KlerosAdapter.upsert({
    where: { chainId_adapterAddress: { chainId, adapterAddress } },
    update: { lastIndexedBlock: lastBlock },
    create: { chainId, adapterAddress, lastIndexedBlock: lastBlock }
  });
}

async function getLogsAdaptiveV3_2Kleros(
  chainId: number,
  client: IndexerClient,
  fromBlock: bigint,
  toBlock: bigint
): Promise<IndexedLog[]> {
  try {
    await throttleRpc();
    const rawLogs = (await client.getLogs({
      address: getIndexerV3_2KlerosAdapterAddress(chainId),
      fromBlock,
      toBlock
    })) as ReadonlyArray<
      Log & {
        blockNumber: bigint | null;
        logIndex: number | null;
        transactionHash: `0x${string}` | null;
      }
    >;

    return normalizeLogs(rawLogs);
  } catch (error) {
    if (fromBlock >= toBlock || !isBlockRangeError(error)) throw error;

    const midpoint = (fromBlock + toBlock) / 2n;
    const left = await getLogsAdaptiveV3_2Kleros(chainId, client, fromBlock, midpoint);
    const right = await getLogsAdaptiveV3_2Kleros(chainId, client, midpoint + 1n, toBlock);
    return [...left, ...right];
  }
}

async function throttleRpc() {
  if (INDEXER_REQUEST_DELAY_MS <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, INDEXER_REQUEST_DELAY_MS));
}

function isBlockRangeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /block range|eth_getLogs|too many blocks|query returned more than|response size/i.test(message);
}

async function fetchBlockTimestamps(client: IndexerClient, logs: IndexedLog[]) {
  const blockNumbers = [...new Set(logs.map((log) => log.blockNumber.toString()))].map((blockNumber) =>
    BigInt(blockNumber)
  );
  const timestampByBlock = new Map<bigint, bigint>();

  for (const blockNumber of blockNumbers) {
    await throttleRpc();
    const block = await client.getBlock({ blockNumber });
    timestampByBlock.set(block.number, block.timestamp);
  }

  return timestampByBlock;
}

function minBigInt(a: bigint, b: bigint) {
  return a < b ? a : b;
}

function maxBigInt(a: bigint, b: bigint) {
  return a > b ? a : b;
}
