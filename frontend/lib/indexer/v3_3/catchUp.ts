// Catch-up loop for the four v3.3 shop-economy contracts.
//
// Each contract has its own cursor in IndexerStateV3_3ShopEconomy
// keyed on (chainId, contractAddress). The catch-up walks them
// independently — a single contract failing doesn't stall the others.

import type { Log } from "viem";
import type { PrismaClient } from "@prisma/client";

import { prisma } from "../../db";
import { normalizeLogs } from "../catchUp";
import {
  createIndexerClient,
  INDEXER_CHUNK_SIZE_BLOCKS,
  INDEXER_REQUEST_DELAY_MS
} from "../config";
import { compareLogs, type IndexedLog } from "../eventDecoder";
import {
  decodeDistributorLog,
  decodeMarketplaceLog,
  decodeShareMarketLog,
  decodeShopNftLog,
  decodeShopSharesLog
} from "./decoders";
import {
  applyDistributorEvents,
  applyShareMarketEvents,
  applyShopNftEvents,
  applyShopSharesEvents
} from "./applyEvents";
import { applyMarketplaceEvents } from "./applyMarketplaceEvent";
import {
  getContractAddress,
  getDeploymentBlock,
  V3_3_CONTRACT_TYPES,
  type V3_3ContractType
} from "./config";

type IndexerClient = ReturnType<typeof createIndexerClient>;
type RawLog = Log & {
  blockNumber: bigint | null;
  logIndex: number | null;
  transactionHash: `0x${string}` | null;
};

export interface ContractCatchUpResult {
  contractType: V3_3ContractType;
  address: string;
  fromBlock: bigint;
  toBlock: bigint;
  logs: number;
  skipped?: boolean;
}

export async function catchUpShopEconomy(chainId: number): Promise<ContractCatchUpResult[]> {
  const results: ContractCatchUpResult[] = [];
  for (const contractType of V3_3_CONTRACT_TYPES) {
    try {
      results.push(await catchUpContract(chainId, contractType));
    } catch (err) {
      console.error(
        `[v3.3 shop-economy ${contractType} chain ${chainId}] catch-up failed`,
        err
      );
    }
  }
  return results;
}

export async function catchUpContract(
  chainId: number,
  contractType: V3_3ContractType
): Promise<ContractCatchUpResult> {
  const address = getContractAddress(chainId, contractType);
  if (!address) {
    return {
      contractType,
      address: "",
      fromBlock: 0n,
      toBlock: 0n,
      logs: 0,
      skipped: true
    };
  }

  const lowerAddress = address.toLowerCase();
  const client = createIndexerClient(chainId);
  await throttleRpc();
  const latestBlock = await client.getBlockNumber();
  const cursor = await prisma.indexerStateV3_3ShopEconomy.findUnique({
    where: { chainId_contractAddress: { chainId, contractAddress: lowerAddress } }
  });
  const deploymentBlock = getDeploymentBlock(chainId, contractType);
  const cursorBlock = cursor?.lastIndexedBlock ?? deploymentBlock - 1n;
  const startBlock = cursorBlock + 1n > deploymentBlock ? cursorBlock + 1n : deploymentBlock;

  if (startBlock > latestBlock) {
    await advanceCursor(chainId, lowerAddress, contractType, latestBlock);
    return {
      contractType,
      address: lowerAddress,
      fromBlock: startBlock,
      toBlock: latestBlock,
      logs: 0
    };
  }

  let totalLogs = 0;
  for (
    let from = startBlock;
    from <= latestBlock;
    from += INDEXER_CHUNK_SIZE_BLOCKS + 1n
  ) {
    const toBlock = from + INDEXER_CHUNK_SIZE_BLOCKS < latestBlock ? from + INDEXER_CHUNK_SIZE_BLOCKS : latestBlock;
    const logs = await getLogsAdaptive(client, address, from, toBlock);
    await processLogs(prisma, chainId, contractType, logs, client);
    await advanceCursor(chainId, lowerAddress, contractType, toBlock);
    totalLogs += logs.length;
    if (logs.length > 0) {
      console.log(
        `[v3.3 ${contractType} chain ${chainId}] blocks ${from}-${toBlock} (${logs.length} logs)`
      );
    }
  }
  return {
    contractType,
    address: lowerAddress,
    fromBlock: startBlock,
    toBlock: latestBlock,
    logs: totalLogs
  };
}

export async function processLogs(
  db: PrismaClient,
  chainId: number,
  contractType: V3_3ContractType,
  logs: IndexedLog[],
  client = createIndexerClient(chainId)
): Promise<void> {
  if (logs.length === 0) return;

  const sorted = [...logs].sort(compareLogs);
  const timestamps = await fetchBlockTimestamps(client, sorted);

  switch (contractType) {
    case "shopNft": {
      const events = sorted
        .map((l) => decodeShopNftLog(l, timestamps.get(l.blockNumber) ?? 0n))
        .filter((e): e is NonNullable<typeof e> => e !== undefined);
      await applyShopNftEvents(db, events);
      return;
    }
    case "shopShares": {
      const events = sorted
        .map((l) => decodeShopSharesLog(l, timestamps.get(l.blockNumber) ?? 0n))
        .filter((e): e is NonNullable<typeof e> => e !== undefined);
      await applyShopSharesEvents(db, events);
      return;
    }
    case "distributor": {
      const events = sorted
        .map((l) => decodeDistributorLog(l, timestamps.get(l.blockNumber) ?? 0n))
        .filter((e): e is NonNullable<typeof e> => e !== undefined);
      await applyDistributorEvents(db, events);
      return;
    }
    case "shareMarket": {
      const events = sorted
        .map((l) => decodeShareMarketLog(l, timestamps.get(l.blockNumber) ?? 0n))
        .filter((e): e is NonNullable<typeof e> => e !== undefined);
      await applyShareMarketEvents(db, events);
      return;
    }
    case "marketplace": {
      const events = sorted
        .map((l) => decodeMarketplaceLog(l, timestamps.get(l.blockNumber) ?? 0n))
        .filter((e): e is NonNullable<typeof e> => e !== undefined);
      const marketAddr = sorted[0]?.address.toLowerCase() ?? "";
      await applyMarketplaceEvents(db, chainId, marketAddr, events);
      return;
    }
  }
}

export async function advanceCursor(
  chainId: number,
  contractAddress: string,
  contractType: V3_3ContractType,
  lastBlock: bigint
): Promise<void> {
  const existing = await prisma.indexerStateV3_3ShopEconomy.findUnique({
    where: { chainId_contractAddress: { chainId, contractAddress } }
  });
  if (existing && existing.lastIndexedBlock >= lastBlock) return;
  await prisma.indexerStateV3_3ShopEconomy.upsert({
    where: { chainId_contractAddress: { chainId, contractAddress } },
    update: { lastIndexedBlock: lastBlock, contractType },
    create: { chainId, contractAddress, contractType, lastIndexedBlock: lastBlock }
  });
}

async function getLogsAdaptive(
  client: IndexerClient,
  address: string,
  fromBlock: bigint,
  toBlock: bigint
): Promise<IndexedLog[]> {
  try {
    await throttleRpc();
    const raw = (await client.getLogs({
      address: address as `0x${string}`,
      fromBlock,
      toBlock
    })) as ReadonlyArray<RawLog>;
    return normalizeLogs(raw);
  } catch (err) {
    if (fromBlock >= toBlock || !isBlockRangeError(err)) throw err;
    const midpoint = (fromBlock + toBlock) / 2n;
    const left = await getLogsAdaptive(client, address, fromBlock, midpoint);
    const right = await getLogsAdaptive(client, address, midpoint + 1n, toBlock);
    return [...left, ...right];
  }
}

async function fetchBlockTimestamps(
  client: IndexerClient,
  logs: readonly IndexedLog[]
): Promise<Map<bigint, bigint>> {
  const blockNumbers = [...new Set(logs.map((l) => l.blockNumber.toString()))].map(BigInt);
  const out = new Map<bigint, bigint>();
  for (const blockNumber of blockNumbers) {
    await throttleRpc();
    const block = await client.getBlock({ blockNumber });
    out.set(block.number, block.timestamp);
  }
  return out;
}

async function throttleRpc(): Promise<void> {
  if (INDEXER_REQUEST_DELAY_MS <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, INDEXER_REQUEST_DELAY_MS));
}

function isBlockRangeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /block range|eth_getLogs|too many blocks|query returned more than|response size/i.test(message);
}
