"use client";

import { Card } from "@/components/Card";
import { TxPanel } from "@/components/TxPanel";
import { PRIMARY_CHAIN_ID } from "@/lib/chains";
import { getV3_3ShopSharesAddress, shopSharesAbi } from "@/lib/contractsV3_3";

interface Props {
  shopId: number;
  onConfirmed?: () => void;
}

/// One-shot 10 000-share mint to the current ShopNFT owner. The owner
/// detail page should only mount this when sharesInitialized === false.
export function InitializeSharesButton({ shopId, onConfirmed }: Props) {
  const address = getV3_3ShopSharesAddress(PRIMARY_CHAIN_ID);
  if (!address) {
    return (
      <Card>
        <p className="text-sm text-amber-700">ShopShares contract not configured on this chain.</p>
      </Card>
    );
  }
  return (
    <Card title="Initialise shares">
      <p className="mb-3 text-sm text-slate-600">
        Mint the fixed 10 000-share supply for this shop. All shares go to your wallet on
        confirmation; sell them via the Sell-shares form, gift them off-chain — your call.
        This action is one-time per shop.
      </p>
      <TxPanel
        label="Initialise shares"
        description="Mints 10 000 shares of this shopId to your wallet. One-time."
        onConfirmed={onConfirmed}
        buildTransaction={() => ({
          address,
          abi: shopSharesAbi,
          chainId: PRIMARY_CHAIN_ID,
          functionName: "initializeShares",
          args: [BigInt(shopId)]
        })}
      />
    </Card>
  );
}
