"use client";

import Link from "next/link";
import { useAccount } from "wagmi";

import { useUserShopId } from "@/lib/v3_3/useUserShopId";

/// Banner on /shops nudging connected wallets that don't yet own a
/// ShopNFT to mint one. Hidden when the wallet already owns a shop or
/// no wallet is connected (the banner has no value to an observer).
export function MintShopBanner() {
  const { isConnected } = useAccount();
  const { shopId, hasShop } = useUserShopId();
  if (!isConnected) return null;
  // Skip while the chain read is in flight to avoid a flash. shopId
  // resolves to 0n when the address owns no shop.
  if (shopId === undefined) return null;
  if (hasShop) return null;

  return (
    <div className="mb-6 flex flex-col items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p className="font-semibold">You don&apos;t have a shop yet.</p>
        <p className="text-xs text-amber-800">
          Mint a ShopNFT to start selling on ChainUs. Costs the mint fee (~0.001 ETH on testnet) and
          gives you a transferable, tokenisable shop identity.
        </p>
      </div>
      <Link
        href="/shops/new"
        className="whitespace-nowrap rounded-md bg-amber-900 px-3 py-1.5 text-sm font-medium text-amber-50 hover:bg-amber-800"
      >
        Create your shop →
      </Link>
    </div>
  );
}
