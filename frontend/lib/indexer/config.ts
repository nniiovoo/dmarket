import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import type { Address, Chain } from "viem";
import { createPublicClient, http } from "viem";
import { polygonAmoy, sepolia } from "viem/chains";

loadIndexerEnv();

export const INDEXED_CHAIN_IDS = [sepolia.id, polygonAmoy.id] as const;

export const DEPLOYMENT_BLOCK: Record<number, bigint> = {
  [sepolia.id]: 10835467n,
  [polygonAmoy.id]: 38206485n
};

export const INDEXER_CHUNK_SIZE_BLOCKS = readPositiveBigIntEnv("INDEXER_CHUNK_SIZE_BLOCKS", 5000n);
export const INDEXER_POLL_INTERVAL_MS = readPositiveNumberEnv("INDEXER_POLL_INTERVAL_MS", 15_000);
export const INDEXER_REQUEST_DELAY_MS = readNonNegativeNumberEnv("INDEXER_REQUEST_DELAY_MS", 75);

const fallbackAddresses: Record<number, Address> = {
  [sepolia.id]: "0x3d08d1549aBD309a124a3C77CbE8bCc39a0eB366",
  [polygonAmoy.id]: "0xC8141a88633fa08121E6B9244e5d1Ad1a441FcfD"
};

const chainsById: Record<number, Chain> = {
  [sepolia.id]: sepolia,
  [polygonAmoy.id]: polygonAmoy
};

export function loadIndexerEnv() {
  for (const file of [".env", ".env.local"]) {
    const path = join(process.cwd(), file);

    if (!existsSync(path)) {
      continue;
    }

    for (const line of readFileSync(path, "utf8").split("\n")) {
      const trimmed = line.trim();

      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const separator = trimmed.indexOf("=");

      if (separator === -1) {
        continue;
      }

      const key = trimmed.slice(0, separator);
      const value = stripQuotes(trimmed.slice(separator + 1).trim());
      process.env[key] ??= value;
    }
  }
}

export function getIndexerChain(chainId: number) {
  const chain = chainsById[chainId];

  if (chain === undefined) {
    throw new Error(`Unsupported indexer chain: ${chainId}`);
  }

  return chain;
}

export function getIndexerMarketplaceAddress(chainId: number) {
  if (chainId === sepolia.id) {
    return (
      (process.env.NEXT_PUBLIC_V2_SEPOLIA_MARKETPLACE_ADDRESS as Address | undefined) ??
      (process.env.V2_SEPOLIA_MARKETPLACE_ADDRESS as Address | undefined) ??
      fallbackAddresses[chainId]
    );
  }

  if (chainId === polygonAmoy.id) {
    return (
      (process.env.NEXT_PUBLIC_V2_AMOY_MARKETPLACE_ADDRESS as Address | undefined) ??
      (process.env.V2_AMOY_MARKETPLACE_ADDRESS as Address | undefined) ??
      fallbackAddresses[chainId]
    );
  }

  throw new Error(`Unsupported indexer chain: ${chainId}`);
}

export function getIndexerEvidenceRegistryAddress(chainId: number): Address | undefined {
  if (chainId === sepolia.id) {
    return (
      (process.env.NEXT_PUBLIC_V3_SEPOLIA_EVIDENCE_REGISTRY_ADDRESS as Address | undefined) ??
      (process.env.V3_SEPOLIA_EVIDENCE_REGISTRY_ADDRESS as Address | undefined)
    );
  }

  if (chainId === polygonAmoy.id) {
    return (
      (process.env.NEXT_PUBLIC_V3_AMOY_EVIDENCE_REGISTRY_ADDRESS as Address | undefined) ??
      (process.env.V3_AMOY_EVIDENCE_REGISTRY_ADDRESS as Address | undefined)
    );
  }

  return undefined;
}

export function createIndexerClient(chainId: number) {
  const chain = getIndexerChain(chainId);
  const rpcUrl = getRpcUrl(chainId);

  return createPublicClient({
    chain,
    transport: http(rpcUrl)
  });
}

function getRpcUrl(chainId: number) {
  if (chainId === sepolia.id) {
    return process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL ?? process.env.SEPOLIA_RPC_URL;
  }

  if (chainId === polygonAmoy.id) {
    return process.env.NEXT_PUBLIC_AMOY_RPC_URL ?? process.env.AMOY_RPC_URL;
  }

  return undefined;
}

function readPositiveBigIntEnv(name: string, fallback: bigint) {
  const raw = process.env[name];

  if (raw === undefined) {
    return fallback;
  }

  try {
    const parsed = BigInt(raw);
    return parsed > 0n ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function readPositiveNumberEnv(name: string, fallback: number) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readNonNegativeNumberEnv(name: string, fallback: number) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function stripQuotes(value: string) {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }

  return value;
}
