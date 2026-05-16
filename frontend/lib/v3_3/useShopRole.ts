"use client";

import { useAccount, useReadContract } from "wagmi";
import type { Address } from "viem";

import {
  getV3_3ShopNftAddress,
  getV3_3ShopSharesAddress,
  shopNftAbi,
  shopSharesAbi
} from "@/lib/contractsV3_3";
import { PRIMARY_CHAIN_ID } from "@/lib/chains";

export type ShopRole = "owner" | "shareholder" | "observer";

export interface UseShopRoleResult {
  role: ShopRole;
  connectedAddress: Address | undefined;
  isOwner: boolean;
  isShareholder: boolean;
  shareBalance: bigint | undefined;
  ownerAddress: Address | undefined;
  refresh: () => void;
}

/// Resolves the connected wallet's role for a given shopId by reading
/// ShopNFT.ownerOf(shopId) + ShopShares.balanceOf(account, shopId).
/// Returns "observer" when no wallet is connected — used to gate every
/// action button on the detail page.
export function useShopRole(shopId: number | undefined): UseShopRoleResult {
  const { address: connectedAddress } = useAccount();
  const chainId = PRIMARY_CHAIN_ID;
  const shopNft = getV3_3ShopNftAddress(chainId);
  const shopShares = getV3_3ShopSharesAddress(chainId);

  const ownerQuery = useReadContract({
    address: shopNft,
    abi: shopNftAbi,
    functionName: "ownerOf",
    args: shopId !== undefined ? [BigInt(shopId)] : undefined,
    query: { enabled: Boolean(shopNft) && shopId !== undefined && shopId > 0 }
  });

  const balanceQuery = useReadContract({
    address: shopShares,
    abi: shopSharesAbi,
    functionName: "balanceOf",
    args:
      connectedAddress !== undefined && shopId !== undefined
        ? [connectedAddress, BigInt(shopId)]
        : undefined,
    query: {
      enabled:
        Boolean(shopShares) && connectedAddress !== undefined && shopId !== undefined && shopId > 0
    }
  });

  const ownerAddress = ownerQuery.data as Address | undefined;
  const shareBalance = balanceQuery.data as bigint | undefined;
  const isOwner = Boolean(
    connectedAddress &&
      ownerAddress &&
      connectedAddress.toLowerCase() === ownerAddress.toLowerCase()
  );
  const isShareholder = Boolean(shareBalance !== undefined && shareBalance > 0n);

  let role: ShopRole;
  if (!connectedAddress) role = "observer";
  else if (isOwner) role = "owner";
  else if (isShareholder) role = "shareholder";
  else role = "observer";

  function refresh() {
    void ownerQuery.refetch();
    void balanceQuery.refetch();
  }

  return {
    role,
    connectedAddress,
    isOwner,
    isShareholder,
    shareBalance,
    ownerAddress,
    refresh
  };
}
