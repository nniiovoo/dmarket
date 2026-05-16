// v3.3 shop-economy indexer config. Parallels the v3 / v3.1 / v3.2
// blocks in `../config.ts` but covers the four event-emitting contracts
// of Phase K (ShopNFT, ShopShares, RevenueDistributor, ShareMarket).
//
// All four contracts are only deployed on Arbitrum Sepolia today. The
// addresses are read from env (NEXT_PUBLIC_ takes precedence so the
// same code path works on both the indexer daemon and the Next.js
// server-side request handler).

import type { Address } from "viem";
import { arbitrumSepolia } from "viem/chains";

import { loadIndexerEnv } from "../config";

// Pull V3_3_* addresses out of .env / .env.local before any of the
// env-reading helpers below run. Cheap to call repeatedly — the
// helper short-circuits on already-set vars.
loadIndexerEnv();

export type V3_3ContractType =
  | "shopNft"
  | "shopShares"
  | "distributor"
  | "shareMarket"
  | "marketplace"
  | "klerosAdapter";

export const V3_3_CONTRACT_TYPES: readonly V3_3ContractType[] = [
  "shopNft",
  "shopShares",
  "distributor",
  "shareMarket",
  "marketplace",
  "klerosAdapter"
] as const;

// -------------------------------------------------------------------------
// Address resolution
// -------------------------------------------------------------------------

function readAddressEnv(...names: readonly string[]): Address | undefined {
  for (const n of names) {
    const v = process.env[n];
    if (v && v.trim() !== "") return v.trim() as Address;
  }
  return undefined;
}

export function getShopNftAddress(chainId: number): Address | undefined {
  if (chainId !== arbitrumSepolia.id) return undefined;
  return readAddressEnv(
    "NEXT_PUBLIC_V3_3_ARBITRUMSEPOLIA_SHOP_NFT_ADDRESS",
    "V3_3_ARBITRUMSEPOLIA_SHOP_NFT_ADDRESS"
  );
}

export function getShopSharesAddress(chainId: number): Address | undefined {
  if (chainId !== arbitrumSepolia.id) return undefined;
  return readAddressEnv(
    "NEXT_PUBLIC_V3_3_ARBITRUMSEPOLIA_SHOP_SHARES_ADDRESS",
    "V3_3_ARBITRUMSEPOLIA_SHOP_SHARES_ADDRESS"
  );
}

export function getDistributorAddress(chainId: number): Address | undefined {
  if (chainId !== arbitrumSepolia.id) return undefined;
  return readAddressEnv(
    "NEXT_PUBLIC_V3_3_ARBITRUMSEPOLIA_REVENUE_DISTRIBUTOR_ADDRESS",
    "V3_3_ARBITRUMSEPOLIA_REVENUE_DISTRIBUTOR_ADDRESS"
  );
}

export function getShareMarketAddress(chainId: number): Address | undefined {
  if (chainId !== arbitrumSepolia.id) return undefined;
  return readAddressEnv(
    "NEXT_PUBLIC_V3_3_ARBITRUMSEPOLIA_SHARE_MARKET_ADDRESS",
    "V3_3_ARBITRUMSEPOLIA_SHARE_MARKET_ADDRESS"
  );
}

export function getV3_3MarketplaceAddress(chainId: number): Address | undefined {
  if (chainId !== arbitrumSepolia.id) return undefined;
  return readAddressEnv(
    "NEXT_PUBLIC_V3_3_ARBITRUMSEPOLIA_MARKETPLACE_ADDRESS",
    "V3_3_ARBITRUMSEPOLIA_MARKETPLACE_ADDRESS"
  );
}

export function getV3_3KlerosAdapterAddress(chainId: number): Address | undefined {
  if (chainId !== arbitrumSepolia.id) return undefined;
  return readAddressEnv(
    "NEXT_PUBLIC_V3_3_ARBITRUMSEPOLIA_KLEROS_ADAPTER_ADDRESS",
    "V3_3_ARBITRUMSEPOLIA_KLEROS_ADAPTER_ADDRESS"
  );
}

export function getContractAddress(
  chainId: number,
  contractType: V3_3ContractType
): Address | undefined {
  switch (contractType) {
    case "shopNft":
      return getShopNftAddress(chainId);
    case "shopShares":
      return getShopSharesAddress(chainId);
    case "distributor":
      return getDistributorAddress(chainId);
    case "shareMarket":
      return getShareMarketAddress(chainId);
    case "marketplace":
      return getV3_3MarketplaceAddress(chainId);
    case "klerosAdapter":
      return getV3_3KlerosAdapterAddress(chainId);
  }
}

// -------------------------------------------------------------------------
// Chains in scope
// -------------------------------------------------------------------------

function chainHasV3_3ShopEconomy(chainId: number): boolean {
  // We need at least one contract configured. In practice deploys are
  // batched (K.1 → K.3a → K.3b → K.4 → L.1) but a partial config
  // shouldn't brick the daemon — each contract is iterated independently
  // in the catch-up loop.
  return Boolean(
    getShopNftAddress(chainId) ||
      getShopSharesAddress(chainId) ||
      getDistributorAddress(chainId) ||
      getShareMarketAddress(chainId) ||
      getV3_3MarketplaceAddress(chainId) ||
      getV3_3KlerosAdapterAddress(chainId)
  );
}

const ALL_CANDIDATES = [arbitrumSepolia.id] as const;
export const INDEXED_V3_3_SHOP_ECONOMY_CHAIN_IDS = ALL_CANDIDATES.filter(
  chainHasV3_3ShopEconomy
) as readonly number[];

// -------------------------------------------------------------------------
// Deployment blocks (one less than the actual deploy tx block, so the
// indexer captures the contract-creation tx itself if anyone ever
// indexes events from it). Env overrides are honoured.
// -------------------------------------------------------------------------

function readPositiveBigIntEnv(name: string, fallback: bigint): bigint {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  try {
    const parsed = BigInt(raw.trim());
    return parsed >= 0n ? parsed : fallback;
  } catch {
    return fallback;
  }
}

// Defaults captured from Arbitrum Sepolia tx receipts:
//   ShopNFT (K.1):         0xca9e1a87… in block 268_768_884
//   ShopShares (K.3a):     0xb46dec32… in block 268_775_538
//   Distributor (K.3a):    0xf1f0d2ed… in block 268_775_609
//   Marketplace (K.3b):    0x00479cc7… in block 268_777_562
//   ShareMarket (K.4):     0xd9cd0fbc… in block 268_780_661
//   KlerosAdapter (L.1):   0xbdd54667… in block 268_796_181
// Defaults are one block earlier so the deploy log itself is in range.

export function getDeploymentBlock(
  chainId: number,
  contractType: V3_3ContractType
): bigint {
  if (chainId !== arbitrumSepolia.id) return 0n;
  switch (contractType) {
    case "shopNft":
      return readPositiveBigIntEnv("INDEXER_V3_3_SHOP_NFT_FROM_BLOCK", 268_768_883n);
    case "shopShares":
      return readPositiveBigIntEnv("INDEXER_V3_3_SHOP_SHARES_FROM_BLOCK", 268_775_537n);
    case "distributor":
      return readPositiveBigIntEnv("INDEXER_V3_3_DISTRIBUTOR_FROM_BLOCK", 268_775_608n);
    case "shareMarket":
      return readPositiveBigIntEnv("INDEXER_V3_3_SHARE_MARKET_FROM_BLOCK", 268_780_660n);
    case "marketplace":
      return readPositiveBigIntEnv("INDEXER_V3_3_MARKETPLACE_FROM_BLOCK", 268_777_561n);
    case "klerosAdapter":
      return readPositiveBigIntEnv("INDEXER_V3_3_KLEROS_ADAPTER_FROM_BLOCK", 268_796_180n);
  }
}

// -------------------------------------------------------------------------
// NATIVE token sentinel — used by RevenueDistributor for ETH revenue.
// -------------------------------------------------------------------------
export const NATIVE_TOKEN: Address = "0x0000000000000000000000000000000000000000";
