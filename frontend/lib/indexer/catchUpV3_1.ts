// V3.1 catch-up. Mirrors lib/indexer/catchUp.ts but targets V3.1 marketplace
// (separate address) and writes to OnChainOrderV3_1 + IndexerStateV3_1.
//
// Decoding is shared with V3 because the event signatures are identical
// (V3.1 inherits the marketplace from V3). The only on-chain differences
// are the storage layout for createAndPayWithAuth and the auth nonces map,
// neither of which emit new events relevant to this indexer.

import type { Log } from "viem";

import { prisma } from "../db";
import { applyEventV3_1 } from "./applyEventV3_1";
import {
  createIndexerClient,
  DEPLOYMENT_BLOCK_V3_1,
  getIndexerV3_1MarketplaceAddress,
  INDEXER_CHUNK_SIZE_BLOCKS,
  INDEXER_REQUEST_DELAY_MS
} from "./config";
import { compareLogs, decodeLogs, type IndexedLog } from "./eventDecoder";
import { normalizeLogs } from "./catchUp";

type IndexerClient = ReturnType<typeof createIndexerClient>;

export async function catchUpV3_1(chainId: number, fromBlock: bigint): Promise<bigint> {
  const client = createIndexerClient(chainId);
  await throttleRpc();
  const latestBlock = await client.getBlockNumber();
  const deploymentBlock = DEPLOYMENT_BLOCK_V3_1[chainId];
  const startBlock = maxBigInt(fromBlock, deploymentBlock ?? fromBlock);

  if (startBlock > latestBlock) {
    await advanceIndexerStateV3_1(chainId, latestBlock);
    return latestBlock;
  }

  let lastProcessed = startBlock - 1n;

  for (let from = startBlock; from <= latestBlock; from += INDEXER_CHUNK_SIZE_BLOCKS + 1n) {
    const toBlock = minBigInt(from + INDEXER_CHUNK_SIZE_BLOCKS, latestBlock);
    const logs = await getLogsAdaptiveV3_1(chainId, client, from, toBlock);

    await processLogsV3_1(chainId, logs, client);
    await advanceIndexerStateV3_1(chainId, toBlock);
    lastProcessed = toBlock;
    console.log(`[v3.1 chain ${chainId}] indexed blocks ${from}-${toBlock} (${logs.length} logs)`);
  }

  return maxBigInt(lastProcessed, latestBlock);
}

export async function processLogsV3_1(
  chainId: number,
  logs: IndexedLog[],
  client = createIndexerClient(chainId)
) {
  if (logs.length === 0) {
    return;
  }

  const sortedLogs = [...logs].sort(compareLogs);
  const timestampByBlock = await fetchBlockTimestamps(client, sortedLogs);

  const marketplaceAddr = getIndexerV3_1MarketplaceAddress(chainId).toLowerCase();
  const marketplaceLogs = sortedLogs.filter((log) => log.address.toLowerCase() === marketplaceAddr);
  const marketplaceEvents = decodeLogs(marketplaceLogs, timestampByBlock);

  for (const event of marketplaceEvents) {
    await applyEventV3_1(prisma, chainId, event);
  }
}

export async function advanceIndexerStateV3_1(chainId: number, lastBlock: bigint) {
  const existing = await prisma.indexerStateV3_1.findUnique({ where: { chainId } });

  if (existing && existing.lastBlock >= lastBlock) {
    return;
  }

  await prisma.indexerStateV3_1.upsert({
    where: { chainId },
    update: { lastBlock },
    create: { chainId, lastBlock }
  });
}

async function getLogsAdaptiveV3_1(
  chainId: number,
  client: IndexerClient,
  fromBlock: bigint,
  toBlock: bigint
): Promise<IndexedLog[]> {
  try {
    await throttleRpc();
    const rawLogs = (await client.getLogs({
      address: getIndexerV3_1MarketplaceAddress(chainId),
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
    if (fromBlock >= toBlock || !isBlockRangeError(error)) {
      throw error;
    }

    const midpoint = (fromBlock + toBlock) / 2n;
    const left = await getLogsAdaptiveV3_1(chainId, client, fromBlock, midpoint);
    const right = await getLogsAdaptiveV3_1(chainId, client, midpoint + 1n, toBlock);

    return [...left, ...right];
  }
}

async function throttleRpc() {
  if (INDEXER_REQUEST_DELAY_MS <= 0) {
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, INDEXER_REQUEST_DELAY_MS));
}

function isBlockRangeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /block range|eth_getLogs|too many blocks|query returned more than|response size/i.test(message);
}

async function fetchBlockTimestamps(client: IndexerClient, logs: IndexedLog[]) {
  const blockNumbers = [...new Set(logs.map((log) => log.blockNumber.toString()))].map((blockNumber) => BigInt(blockNumber));
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
