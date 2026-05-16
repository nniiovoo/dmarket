"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { formatEther } from "viem";
import { useAccount, useReadContract } from "wagmi";

import { Card } from "@/components/Card";
import { TxPanel } from "@/components/TxPanel";
import { PRIMARY_CHAIN_ID } from "@/lib/chains";
import { getV3_3ShopNftAddress, shopNftAbi } from "@/lib/contractsV3_3";
import { useUserShopId } from "@/lib/v3_3/useUserShopId";

export default function MintShopPage() {
  const router = useRouter();
  const { isConnected } = useAccount();
  const shopNftAddress = getV3_3ShopNftAddress(PRIMARY_CHAIN_ID);

  const mintFeeQuery = useReadContract({
    address: shopNftAddress,
    abi: shopNftAbi,
    functionName: "mintFeeWei",
    query: { enabled: Boolean(shopNftAddress) }
  });
  const mintFee = mintFeeQuery.data as bigint | undefined;

  const { shopId, refresh: refreshShopId } = useUserShopId();
  const [submitted, setSubmitted] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [imageUrl, setImageUrl] = useState("");

  // After mint confirms, useUserShopId() refetches and we navigate to
  // the new detail page. The mint-shopIdOf invariant guarantees the
  // caller is the new owner.
  useEffect(() => {
    if (!submitted) return;
    if (shopId !== undefined && shopId > 0n) {
      router.push(`/shops/${shopId.toString()}`);
    }
  }, [submitted, shopId, router]);

  return (
    <main className="mx-auto max-w-2xl px-4 py-6">
      <div className="mb-4">
        <Link href="/shops" className="text-sm text-blue-600 hover:underline">
          ← Back to shops
        </Link>
      </div>

      <h1 className="text-2xl font-semibold text-slate-950">Create your shop</h1>
      <p className="mt-2 text-sm text-slate-600">
        Minting a ShopNFT gives your wallet a transferable shop identity. Each ShopNFT enforces a
        1-seller-1-shop invariant — you can hold at most one shop at a time. The 10 000 token
        supply is minted separately after this step.
      </p>

      {!shopNftAddress ? (
        <Card>
          <p className="text-sm text-amber-700">
            ShopNFT contract not configured on this chain. Set
            <code className="ml-1 rounded bg-slate-100 px-1">NEXT_PUBLIC_V3_3_ARBITRUMSEPOLIA_SHOP_NFT_ADDRESS</code>.
          </p>
        </Card>
      ) : !isConnected ? (
        <Card>
          <p className="text-sm text-slate-700">
            Connect your wallet to mint a shop. The mint fee is paid in the chain&apos;s native
            asset.
          </p>
        </Card>
      ) : (
        <div className="space-y-4">
          <Card title="Shop details">
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium uppercase tracking-wide text-slate-600">
                  Name
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="My Shop"
                  maxLength={64}
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-black focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium uppercase tracking-wide text-slate-600">
                  Description
                </label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={3}
                  maxLength={500}
                  placeholder="A short description shown to buyers."
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-black focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium uppercase tracking-wide text-slate-600">
                  Image URL (optional)
                </label>
                <input
                  type="url"
                  value={imageUrl}
                  onChange={(e) => setImageUrl(e.target.value)}
                  placeholder="https://… or ipfs://…"
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-black focus:outline-none"
                />
              </div>
              <p className="text-xs text-slate-500">
                Mint fee: <span className="font-mono">{mintFee === undefined ? "…" : `${formatEther(mintFee)} ETH`}</span>
              </p>
            </div>
          </Card>

          <TxPanel
            label="Mint shop"
            description="Pays the platform mint fee and creates your ShopNFT in one transaction."
            disabled={name.trim().length === 0 || mintFee === undefined}
            disabledReason={
              mintFee === undefined ? "Loading mint fee…" : "Name is required."
            }
            onConfirmed={() => {
              setSubmitted(true);
              refreshShopId();
            }}
            buildTransaction={() => ({
              address: shopNftAddress,
              abi: shopNftAbi,
              chainId: PRIMARY_CHAIN_ID,
              functionName: "mintShop",
              args: [name.trim(), description.trim(), imageUrl.trim()],
              value: mintFee
            })}
          />
        </div>
      )}
    </main>
  );
}
