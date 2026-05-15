// V3.2 catch-up loop. Mirrors catchUpV3_1.ts but targets the V3.2 ERC-20
// marketplace and writes to OnChainOrderV3_2 + IndexerStateV3_2. Cursor is
// keyed on (chainId, marketplaceAddress) so a re-deploy gets a clean slate.

import type { Log } from "viem";

import { prisma } from "../db";
import { applyEventV3_2 } from "./applyEventV3_2";
import { normalizeLogs } from "./catchUp";
import {
  createIndexerClient,
  DEPLOYMENT_BLOCK_V3_2,
  getIndexerV3_2MarketplaceAddress,
  INDEXER_CHUNK_SIZE_BLOCKS,
  INDEXER_REQUEST_DELAY_MS
} from "./config";
import { compareLogs, type IndexedLog } from "./eventDecoder";
import { decodeLogsV3_2 } from "./eventDecoderV3_2";

type IndexerClient = ReturnType<typeof createIndexerClient>;

export async function catchUpV3_2(chainId: number, fromBlock: bigint): Promise<bigint> {
  const client = createIndexerClient(chainId);
  await throttleRpc();
  const latestBlock = await client.getBlockNumber();
  const deploymentBlock = DEPLOYMENT_BLOCK_V3_2[chainId];
  const startBlock = maxBigInt(fromBlock, deploymentBlock ?? fromBlock);

  if (startBlock > latestBlock) {
    await advanceIndexerStateV3_2(chainId, latestBlock);
    return latestBlock;
  }

  let lastProcessed = startBlock - 1n;

  for (let from = startBlock; from <= latestBlock; from += INDEXER_CHUNK_SIZE_BLOCKS + 1n) {
    const toBlock = minBigInt(from + INDEXER_CHUNK_SIZE_BLOCKS, latestBlock);
    const logs = await getLogsAdaptiveV3_2(chainId, client, from, toBlock);

    await processLogsV3_2(chainId, logs, client);
    await advanceIndexerStateV3_2(chainId, toBlock);
    lastProcessed = toBlock;
    console.log(`[v3.2 chain ${chainId}] indexed blocks ${from}-${toBlock} (${logs.length} logs)`);
  }

  return maxBigInt(lastProcessed, latestBlock);
}

export async function processLogsV3_2(
  chainId: number,
  logs: IndexedLog[],
  client = createIndexerClient(chainId)
) {
  if (logs.length === 0) return;

  const sortedLogs = [...logs].sort(compareLogs);
  const timestampByBlock = await fetchBlockTimestamps(client, sortedLogs);

  const marketplaceAddr = getIndexerV3_2MarketplaceAddress(chainId).toLowerCase();
  const marketplaceLogs = sortedLogs.filter((log) => log.address.toLowerCase() === marketplaceAddr);
  const events = decodeLogsV3_2(marketplaceLogs, timestampByBlock);

  // Per-event try/catch — a single malformed event must not abort the batch
  // and force the cursor to stall.
  for (const event of events) {
    try {
      await applyEventV3_2(prisma, chainId, marketplaceAddr, event);
    } catch (error) {
      console.error(
        `[v3.2 chain ${chainId}] applyEvent failed for ${event.kind} order=${event.orderId.toString()}`,
        error
      );
    }
  }
}

export async function advanceIndexerStateV3_2(chainId: number, lastBlock: bigint) {
  const marketplaceAddress = getIndexerV3_2MarketplaceAddress(chainId).toLowerCase();
  const existing = await prisma.indexerStateV3_2.findUnique({
    where: { chainId_marketplaceAddress: { chainId, marketplaceAddress } }
  });

  if (existing && existing.lastBlock >= lastBlock) {
    return;
  }

  await prisma.indexerStateV3_2.upsert({
    where: { chainId_marketplaceAddress: { chainId, marketplaceAddress } },
    update: { lastBlock },
    create: { chainId, marketplaceAddress, lastBlock }
  });
}

async function getLogsAdaptiveV3_2(
  chainId: number,
  client: IndexerClient,
  fromBlock: bigint,
  toBlock: bigint
): Promise<IndexedLog[]> {
  try {
    await throttleRpc();
    const rawLogs = (await client.getLogs({
      address: getIndexerV3_2MarketplaceAddress(chainId),
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
    const left = await getLogsAdaptiveV3_2(chainId, client, fromBlock, midpoint);
    const right = await getLogsAdaptiveV3_2(chainId, client, midpoint + 1n, toBlock);
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
