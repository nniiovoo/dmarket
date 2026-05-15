import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import type { Address, Chain } from "viem";
import { createPublicClient, http } from "viem";
import { arbitrumSepolia, polygonAmoy, sepolia } from "viem/chains";

loadIndexerEnv();

// Chains the indexer should watch. Arbitrum Sepolia is V3-only; it only
// joins the indexed set when its V3 marketplace address is configured,
// otherwise the indexer skips it silently rather than throwing on startup.
function chainHasV3Configured(chainId: number): boolean {
  if (chainId === arbitrumSepolia.id) {
    return Boolean(
      process.env.NEXT_PUBLIC_V3_ARBITRUMSEPOLIA_MARKETPLACE_ADDRESS ??
        process.env.V3_ARBITRUMSEPOLIA_MARKETPLACE_ADDRESS
    );
  }
  return true;
}

const ALL_CANDIDATE_CHAINS = [sepolia.id, polygonAmoy.id, arbitrumSepolia.id] as const;
export const INDEXED_CHAIN_IDS = ALL_CANDIDATE_CHAINS.filter(chainHasV3Configured) as readonly number[];

// Chains the V3.1 indexer should watch. Currently V3.1 only exists on
// Arbitrum Sepolia, and only if its marketplace env is configured.
function chainHasV3_1Configured(chainId: number): boolean {
  if (chainId === arbitrumSepolia.id) {
    return Boolean(
      process.env.NEXT_PUBLIC_V3_1_ARBITRUMSEPOLIA_MARKETPLACE_ADDRESS ??
        process.env.V3_1_ARBITRUMSEPOLIA_MARKETPLACE_ADDRESS
    );
  }
  return false;
}

const ALL_CANDIDATE_V3_1_CHAINS = [arbitrumSepolia.id] as const;
export const INDEXED_V3_1_CHAIN_IDS = ALL_CANDIDATE_V3_1_CHAINS.filter(chainHasV3_1Configured) as readonly number[];

export const DEPLOYMENT_BLOCK: Record<number, bigint> = {
  [sepolia.id]: 10835467n,
  [polygonAmoy.id]: 38206485n,
  // V3 marketplace deploy tx is around 268217354. Free-tier Alchemy on
  // Arbitrum Sepolia caps eth_getLogs to ~10 blocks, so a full backfill
  // from deploy would mean 60k+ single-block RPC calls. Use env override
  // INDEXER_ARBSEPOLIA_FROM_BLOCK to jump forward (e.g. set to current tip
  // when starting indexer fresh). Default below covers from-deploy in case
  // a paid RPC is used.
  [arbitrumSepolia.id]: readPositiveBigIntEnv("INDEXER_ARBSEPOLIA_FROM_BLOCK", 268217000n)
};

// V3.1 marketplace ships only on Arbitrum Sepolia at this time. The deploy
// tx sits ~268278000 give or take; same Alchemy 10-block cap caveat
// applies, so the env override INDEXER_V3_1_ARBSEPOLIA_FROM_BLOCK is the
// expected way to point the indexer at a recent block when starting fresh.
export const DEPLOYMENT_BLOCK_V3_1: Record<number, bigint> = {
  [arbitrumSepolia.id]: readPositiveBigIntEnv("INDEXER_V3_1_ARBSEPOLIA_FROM_BLOCK", 268278000n)
};

export const INDEXER_CHUNK_SIZE_BLOCKS = readPositiveBigIntEnv("INDEXER_CHUNK_SIZE_BLOCKS", 5000n);
export const INDEXER_POLL_INTERVAL_MS = readPositiveNumberEnv("INDEXER_POLL_INTERVAL_MS", 15_000);
export const INDEXER_REQUEST_DELAY_MS = readNonNegativeNumberEnv("INDEXER_REQUEST_DELAY_MS", 75);

const fallbackAddresses: Record<number, Address> = {
  [sepolia.id]: "0x3d08d1549aBD309a124a3C77CbE8bCc39a0eB366",
  [polygonAmoy.id]: "0xC8141a88633fa08121E6B9244e5d1Ad1a441FcfD"
  // Note: no Arbitrum Sepolia fallback — V2 is not deployed there. The
  // arbitrumSepolia branch in getIndexerMarketplaceAddress reads V3 env vars
  // and throws if they're missing.
};

const chainsById: Record<number, Chain> = {
  [sepolia.id]: sepolia,
  [polygonAmoy.id]: polygonAmoy,
  [arbitrumSepolia.id]: arbitrumSepolia
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

  if (chainId === arbitrumSepolia.id) {
    // Arbitrum Sepolia is V3-only; V2 doesn't exist there. Read from V3
    // env vars (NEXT_PUBLIC_ takes precedence so the same code path works
    // on both indexer worker and Next.js server-side).
    const address =
      (process.env.NEXT_PUBLIC_V3_ARBITRUMSEPOLIA_MARKETPLACE_ADDRESS as Address | undefined) ??
      (process.env.V3_ARBITRUMSEPOLIA_MARKETPLACE_ADDRESS as Address | undefined);

    if (!address) {
      throw new Error("V3 marketplace not configured on arbitrumSepolia");
    }

    return address;
  }

  throw new Error(`Unsupported indexer chain: ${chainId}`);
}

// V3.1 marketplace address resolver. Only arbitrumSepolia is supported.
// Returns the configured V3.1 marketplace; throws if the env is missing
// (callers should gate on INDEXED_V3_1_CHAIN_IDS so this never fires).
export function getIndexerV3_1MarketplaceAddress(chainId: number): Address {
  if (chainId === arbitrumSepolia.id) {
    const address =
      (process.env.NEXT_PUBLIC_V3_1_ARBITRUMSEPOLIA_MARKETPLACE_ADDRESS as Address | undefined) ??
      (process.env.V3_1_ARBITRUMSEPOLIA_MARKETPLACE_ADDRESS as Address | undefined);

    if (!address) {
      throw new Error("V3.1 marketplace not configured on arbitrumSepolia");
    }

    return address;
  }

  throw new Error(`V3.1 indexer is not enabled for chain ${chainId}`);
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

  if (chainId === arbitrumSepolia.id) {
    return (
      (process.env.NEXT_PUBLIC_V3_ARBITRUMSEPOLIA_EVIDENCE_REGISTRY_ADDRESS as Address | undefined) ??
      (process.env.V3_ARBITRUMSEPOLIA_EVIDENCE_REGISTRY_ADDRESS as Address | undefined)
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

  if (chainId === arbitrumSepolia.id) {
    return process.env.NEXT_PUBLIC_ARBITRUM_SEPOLIA_RPC_URL ?? process.env.ARBITRUM_SEPOLIA_RPC_URL;
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
