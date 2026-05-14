"use client";

import { useAccount } from "wagmi";

import { Card } from "@/components/Card";
import { LEGACY_CHAIN_IDS, supportedChains } from "@/lib/chains";

export default function LegacyPage() {
  const { address } = useAccount();
  const legacyChains = supportedChains.filter((chain) => LEGACY_CHAIN_IDS.includes(chain.id));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-950">Legacy orders (V2 testnet)</h1>
        <p className="mt-2 text-sm text-slate-600">
          These are historical orders on Sepolia and Polygon Amoy. The current ChainUs marketplace runs on Arbitrum
          Sepolia. Connect a wallet that holds these orders to view them.
        </p>
      </div>

      <Card title="Legacy chains">
        <div className="space-y-3 text-sm text-slate-700">
          <p>Connected wallet: {address ?? "not connected"}</p>
          <ul className="list-disc space-y-1 pl-5">
            {legacyChains.map((chain) => (
              <li key={chain.id}>
                {chain.name} (chainId {chain.id})
              </li>
            ))}
          </ul>
          <p className="text-slate-500">
            Legacy order rendering will reuse the same order cards as the home page in a follow-up.
          </p>
        </div>
      </Card>
    </div>
  );
}
