"use client";

import { useState } from "react";

import { Card } from "@/components/Card";
import { TxPanel } from "@/components/TxPanel";
import { PRIMARY_CHAIN_ID } from "@/lib/chains";
import { getV3_3ShopNftAddress, shopNftAbi } from "@/lib/contractsV3_3";
import type { ShopSummary } from "@/lib/api/shops";

interface Props {
  shop: ShopSummary;
  onConfirmed?: () => void;
}

/// Collapsible "Edit shop info" panel for the current ShopNFT owner.
/// Only the mutable fields (name, description, imageUrl) — creator
/// and createdAt are immutable on-chain.
export function UpdateShopMetaForm({ shop, onConfirmed }: Props) {
  const address = getV3_3ShopNftAddress(PRIMARY_CHAIN_ID);
  const [expanded, setExpanded] = useState(false);
  const [name, setName] = useState(shop.name);
  const [description, setDescription] = useState(shop.description);
  const [imageUrl, setImageUrl] = useState(shop.imageUrl);

  if (!address) return null;

  const dirty =
    name !== shop.name || description !== shop.description || imageUrl !== shop.imageUrl;

  return (
    <Card>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="text-sm font-medium text-blue-600 hover:underline"
      >
        {expanded ? "▾" : "▸"} Edit shop info
      </button>
      {expanded ? (
        <div className="mt-4 space-y-3">
          <div>
            <label className="block text-xs font-medium uppercase tracking-wide text-slate-600">
              Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
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
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium uppercase tracking-wide text-slate-600">
              Image URL
            </label>
            <input
              type="url"
              value={imageUrl}
              onChange={(e) => setImageUrl(e.target.value)}
              placeholder="https://… or ipfs://…"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </div>
          <TxPanel
            label="Save changes"
            description="Updates the shop's name / description / image on-chain. Creator and createdAt stay immutable."
            disabled={!dirty}
            disabledReason="No changes to save."
            onConfirmed={() => {
              setExpanded(false);
              onConfirmed?.();
            }}
            buildTransaction={() => ({
              address,
              abi: shopNftAbi,
              chainId: PRIMARY_CHAIN_ID,
              functionName: "updateShopMeta",
              args: [BigInt(shop.shopId), name, description, imageUrl]
            })}
          />
        </div>
      ) : null}
    </Card>
  );
}
