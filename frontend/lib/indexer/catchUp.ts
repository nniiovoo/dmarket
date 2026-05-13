import type { Address, Log } from "viem";

import { prisma } from "../db";
import { applyEvent } from "./applyEvent";
import { applyEvidenceEvent } from "./applyEvidenceEvent";
import {
  createIndexerClient,
  DEPLOYMENT_BLOCK,
  getIndexerEvidenceRegistryAddress,
  getIndexerMarketplaceAddress,
  INDEXER_CHUNK_SIZE_BLOCKS,
  INDEXER_REQUEST_DELAY_MS
} from "./config";
import { compareLogs, decodeLogs, type IndexedLog } from "./eventDecoder";
import { decodeEvidenceLogs } from "./evidenceEventDecoder";

type IndexerClient = ReturnType<typeof createIndexerClient>;
type RawIndexerLog = Log & {
  blockNumber: bigint | null;
  logIndex: number | null;
  transactionHash: `0x${string}` | null;
};

export async function catchUp(chainId: number, fromBlock: bigint): Promise<bigint> {
  const client = createIndexerClient(chainId);
  await throttleRpc();
  const latestBlock = await client.getBlockNumber();
  const deploymentBlock = DEPLOYMENT_BLOCK[chainId];
  const startBlock = maxBigInt(fromBlock, deploymentBlock ?? fromBlock);

  if (startBlock > latestBlock) {
    await advanceIndexerState(chainId, latestBlock);
    return latestBlock;
  }

  let lastProcessed = startBlock - 1n;

  for (let from = startBlock; from <= latestBlock; from += INDEXER_CHUNK_SIZE_BLOCKS + 1n) {
    const toBlock = minBigInt(from + INDEXER_CHUNK_SIZE_BLOCKS, latestBlock);
    const logs = await getLogsAdaptive(chainId, client, from, toBlock);

    await processLogs(chainId, logs, client);
    await advanceIndexerState(chainId, toBlock);
    lastProcessed = toBlock;
    console.log(`[chain ${chainId}] indexed blocks ${from}-${toBlock} (${logs.length} logs)`);
  }

  return maxBigInt(lastProcessed, latestBlock);
}

export async function processLogs(chainId: number, logs: IndexedLog[], client = createIndexerClient(chainId)) {
  if (logs.length === 0) {
    return;
  }

  const sortedLogs = [...logs].sort(compareLogs);
  const timestampByBlock = await fetchBlockTimestamps(client, sortedLogs);

  const marketplaceAddr = getIndexerMarketplaceAddress(chainId).toLowerCase();
  const registryAddr = getIndexerEvidenceRegistryAddress(chainId)?.toLowerCase();

  const marketplaceLogs = sortedLogs.filter((log) => log.address.toLowerCase() === marketplaceAddr);
  const registryLogs = registryAddr
    ? sortedLogs.filter((log) => log.address.toLowerCase() === registryAddr)
    : [];

  const marketplaceEvents = decodeLogs(marketplaceLogs, timestampByBlock);
  const evidenceEvents = decodeEvidenceLogs(registryLogs, timestampByBlock);

  for (const event of marketplaceEvents) {
    await applyEvent(prisma, chainId, event);
  }
  for (const event of evidenceEvents) {
    await applyEvidenceEvent(prisma, chainId, event);
  }
}

export async function advanceIndexerState(chainId: number, lastBlock: bigint) {
  const existing = await prisma.indexerState.findUnique({ where: { chainId } });

  if (existing && existing.lastBlock >= lastBlock) {
    return;
  }

  await prisma.indexerState.upsert({
    where: { chainId },
    update: { lastBlock },
    create: { chainId, lastBlock }
  });
}

export function normalizeLogs(logs: readonly RawIndexerLog[]): IndexedLog[] {
  return logs.flatMap((log) => {
    if (log.blockNumber === null || log.logIndex === null || log.transactionHash === null) {
      return [];
    }

    const indexedLog: IndexedLog = {
      ...log,
      blockNumber: log.blockNumber,
      logIndex: log.logIndex,
      transactionHash: log.transactionHash
    };

    return [indexedLog];
  });
}

async function getLogsAdaptive(chainId: number, client: IndexerClient, fromBlock: bigint, toBlock: bigint): Promise<IndexedLog[]> {
  try {
    await throttleRpc();
    const addresses: Address[] = [getIndexerMarketplaceAddress(chainId)];
    const registryAddr = getIndexerEvidenceRegistryAddress(chainId);
    if (registryAddr !== undefined) {
      addresses.push(registryAddr);
    }

    const rawLogs = await client.getLogs({
      address: addresses,
      fromBlock,
      toBlock
    });

    return normalizeLogs(rawLogs);
  } catch (error) {
    if (fromBlock >= toBlock || !isBlockRangeError(error)) {
      throw error;
    }

    const midpoint = (fromBlock + toBlock) / 2n;
    const left = await getLogsAdaptive(chainId, client, fromBlock, midpoint);
    const right = await getLogsAdaptive(chainId, client, midpoint + 1n, toBlock);

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
