// TODO(prod): gate behind auth header — reveals indexer health to anyone.

import { NextResponse } from "next/server";
import { createPublicClient, http } from "viem";
import { arbitrumSepolia, polygonAmoy, sepolia } from "viem/chains";

import { withErrorBoundary } from "@/lib/api/withErrorBoundary";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

type ChainVersion = "v3" | "v3_1";

type ChainStatus = "healthy" | "stale" | "uninitialized" | "unknown";

export interface ChainMetric {
  chainId: number;
  version: ChainVersion;
  lastBlock: number | null;
  headBlock: number | null;
  blockLag: number | null;
  secondsSinceUpdate: number | null;
  status: ChainStatus;
}

interface IndexerCursor {
  chainId: number;
  lastBlock: bigint;
  updatedAt: Date;
}

type ChainConfig = {
  chainId: number;
  version: ChainVersion;
  rpcUrl: string | undefined;
};

const CHAIN_CONFIGS: ChainConfig[] = [
  {
    chainId: sepolia.id,
    version: "v3",
    rpcUrl: process.env.SEPOLIA_RPC_URL || process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL
  },
  {
    chainId: polygonAmoy.id,
    version: "v3",
    rpcUrl: process.env.AMOY_RPC_URL || process.env.NEXT_PUBLIC_AMOY_RPC_URL
  },
  {
    chainId: arbitrumSepolia.id,
    version: "v3",
    rpcUrl:
      process.env.ARBITRUM_SEPOLIA_RPC_URL || process.env.NEXT_PUBLIC_ARBITRUM_SEPOLIA_RPC_URL
  },
  {
    chainId: arbitrumSepolia.id,
    version: "v3_1",
    rpcUrl:
      process.env.ARBITRUM_SEPOLIA_RPC_URL || process.env.NEXT_PUBLIC_ARBITRUM_SEPOLIA_RPC_URL
  }
];

const CHAIN_BY_ID: Record<number, (typeof sepolia) | (typeof polygonAmoy) | (typeof arbitrumSepolia)> = {
  [sepolia.id]: sepolia,
  [polygonAmoy.id]: polygonAmoy,
  [arbitrumSepolia.id]: arbitrumSepolia
};

const HEALTHY_LAG_BLOCKS = 50;
const HEALTHY_SECONDS = 90;
const RPC_TIMEOUT_MS = 5_000;

export function computeStatus(
  cursor: IndexerCursor | undefined,
  headBlock: number | null,
  nowMs: number
): ChainStatus {
  if (!cursor) return "uninitialized";
  if (headBlock === null) return "unknown";
  const lag = headBlock - Number(cursor.lastBlock);
  const secondsAgo = (nowMs - cursor.updatedAt.getTime()) / 1_000;
  return lag <= HEALTHY_LAG_BLOCKS && secondsAgo <= HEALTHY_SECONDS ? "healthy" : "stale";
}

async function fetchHeadBlock(chainId: number, rpcUrl: string | undefined): Promise<number | null> {
  if (!rpcUrl) return null;
  const chain = CHAIN_BY_ID[chainId];
  if (!chain) return null;
  const client = createPublicClient({ chain, transport: http(rpcUrl) });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  try {
    const raw = await client.getBlockNumber();
    return raw > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(raw);
  } finally {
    clearTimeout(timer);
  }
}

export async function buildChainMetrics(
  configs: ChainConfig[],
  v3Cursors: IndexerCursor[],
  v3_1Cursors: IndexerCursor[],
  nowMs: number
): Promise<ChainMetric[]> {
  const headResults = await Promise.allSettled(
    configs.map((c) => fetchHeadBlock(c.chainId, c.rpcUrl))
  );

  return configs.map((config, i) => {
    const headBlock =
      headResults[i].status === "fulfilled" ? headResults[i].value : null;

    const cursors = config.version === "v3_1" ? v3_1Cursors : v3Cursors;
    const cursor = cursors.find((c) => c.chainId === config.chainId);
    const status = computeStatus(cursor, headBlock, nowMs);

    const lastBlock = cursor
      ? cursor.lastBlock > BigInt(Number.MAX_SAFE_INTEGER)
        ? Number.MAX_SAFE_INTEGER
        : Number(cursor.lastBlock)
      : null;

    const blockLag =
      lastBlock !== null && headBlock !== null ? headBlock - lastBlock : null;

    const secondsSinceUpdate =
      cursor ? (nowMs - cursor.updatedAt.getTime()) / 1_000 : null;

    return {
      chainId: config.chainId,
      version: config.version,
      lastBlock,
      headBlock,
      blockLag,
      secondsSinceUpdate,
      status
    };
  });
}

export const GET = withErrorBoundary(async () => {
  const nowMs = Date.now();

  const [v3Cursors, v3_1Cursors] = await Promise.all([
    prisma.indexerState.findMany(),
    prisma.indexerStateV3_1.findMany()
  ]);

  const chains = await buildChainMetrics(CHAIN_CONFIGS, v3Cursors, v3_1Cursors, nowMs);

  return NextResponse.json({
    ok: true,
    generatedAt: new Date(nowMs).toISOString(),
    chains
  });
});
