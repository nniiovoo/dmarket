// wagmi-friendly addresses + ABIs for the Phase K v3.3 stack. Mirrors
// the shape of lib/contractsV3_2.ts so the role/action components can
// import once and pass `{ address, abi }` straight to useReadContract
// / useWriteContract.

import type { Abi, Address } from "viem";
import { arbitrumSepolia } from "wagmi/chains";

import shopNftAbiJson from "@/abi/ShopNFT.json";
import shopSharesAbiJson from "@/abi/ShopShares.json";
import revenueDistributorAbiJson from "@/abi/RevenueDistributor.json";
import escrowMarketplaceV3_3AbiJson from "@/abi/EscrowMarketplaceV3_3.json";
import shareMarketAbiJson from "@/abi/ShareMarket.json";

export const shopNftAbi = shopNftAbiJson as Abi;
export const shopSharesAbi = shopSharesAbiJson as Abi;
export const revenueDistributorAbi = revenueDistributorAbiJson as Abi;
export const escrowMarketplaceV3_3Abi = escrowMarketplaceV3_3AbiJson as Abi;
export const shareMarketAbi = shareMarketAbiJson as Abi;

export type V3_3ContractAddresses = {
  shopNft: Address;
  shopShares: Address;
  distributor: Address;
  marketplace: Address;
  shareMarket: Address;
};

function envAddr(...names: readonly string[]): Address | undefined {
  for (const n of names) {
    const v = process.env[n];
    if (v && v.trim() !== "") return v.trim() as Address;
  }
  return undefined;
}

export function getV3_3ShopNftAddress(chainId: number | undefined): Address | undefined {
  if (chainId !== arbitrumSepolia.id) return undefined;
  return envAddr("NEXT_PUBLIC_V3_3_ARBITRUMSEPOLIA_SHOP_NFT_ADDRESS");
}

export function getV3_3ShopSharesAddress(chainId: number | undefined): Address | undefined {
  if (chainId !== arbitrumSepolia.id) return undefined;
  return envAddr("NEXT_PUBLIC_V3_3_ARBITRUMSEPOLIA_SHOP_SHARES_ADDRESS");
}

export function getV3_3DistributorAddress(chainId: number | undefined): Address | undefined {
  if (chainId !== arbitrumSepolia.id) return undefined;
  return envAddr("NEXT_PUBLIC_V3_3_ARBITRUMSEPOLIA_REVENUE_DISTRIBUTOR_ADDRESS");
}

export function getV3_3MarketplaceAddress(chainId: number | undefined): Address | undefined {
  if (chainId !== arbitrumSepolia.id) return undefined;
  return envAddr("NEXT_PUBLIC_V3_3_ARBITRUMSEPOLIA_MARKETPLACE_ADDRESS");
}

export function getV3_3ShareMarketAddress(chainId: number | undefined): Address | undefined {
  if (chainId !== arbitrumSepolia.id) return undefined;
  return envAddr("NEXT_PUBLIC_V3_3_ARBITRUMSEPOLIA_SHARE_MARKET_ADDRESS");
}

export function getV3_3Addresses(chainId: number | undefined): V3_3ContractAddresses | undefined {
  const shopNft = getV3_3ShopNftAddress(chainId);
  const shopShares = getV3_3ShopSharesAddress(chainId);
  const distributor = getV3_3DistributorAddress(chainId);
  const marketplace = getV3_3MarketplaceAddress(chainId);
  const shareMarket = getV3_3ShareMarketAddress(chainId);
  if (!shopNft || !shopShares || !distributor || !marketplace || !shareMarket) return undefined;
  return { shopNft, shopShares, distributor, marketplace, shareMarket };
}

export function hasV3_3OnChain(chainId: number | undefined): boolean {
  return getV3_3Addresses(chainId) !== undefined;
}

/// Sentinel passed to the RevenueDistributor for the chain's native asset.
export const NATIVE_TOKEN: Address = "0x0000000000000000000000000000000000000000";
