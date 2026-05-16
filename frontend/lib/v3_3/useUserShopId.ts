"use client";

import { useAccount, useReadContract } from "wagmi";

import { getV3_3ShopNftAddress, shopNftAbi } from "@/lib/contractsV3_3";
import { PRIMARY_CHAIN_ID } from "@/lib/chains";

export interface UseUserShopIdResult {
  /// The connected wallet's shopId, or `0n` if it doesn't own a ShopNFT.
  /// `undefined` while loading or when no wallet is connected.
  shopId: bigint | undefined;
  /// True only when the query has loaded and shopId > 0.
  hasShop: boolean;
  refresh: () => void;
}

/// Reads ShopNFT.shopIdOf(connectedAddress) — useful for "do I already
/// own a shop?" gates (e.g. hiding the Mint banner once the user owns
/// one).
export function useUserShopId(): UseUserShopIdResult {
  const { address } = useAccount();
  const shopNft = getV3_3ShopNftAddress(PRIMARY_CHAIN_ID);

  const query = useReadContract({
    address: shopNft,
    abi: shopNftAbi,
    functionName: "shopIdOf",
    args: address !== undefined ? [address] : undefined,
    query: { enabled: Boolean(shopNft) && address !== undefined }
  });

  const shopId = query.data as bigint | undefined;
  return {
    shopId,
    hasShop: shopId !== undefined && shopId > 0n,
    refresh: () => void query.refetch()
  };
}
