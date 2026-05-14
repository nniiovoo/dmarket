"use client";

import { parseEther } from "viem";

import { PayViaAnyChain } from "@/components/payment/PayViaAnyChain";

export default function PaymentTestPage() {
  return (
    <div className="mx-auto max-w-md p-6">
      <h1 className="mb-4 text-xl font-bold">PayViaAnyChain demo</h1>
      <PayViaAnyChain
        amountWei={parseEther("0.001")}
        label="Test order"
        onDirectConfirm={() => console.log("[demo] direct path confirmed")}
        onCrossChainConfirm={(quote) => console.log("[demo] cross-chain confirmed", quote)}
      />
      <div className="mt-4 text-xs text-slate-500">
        This is a UI shell only. Actions are stubbed for Stage 2a Chunk 2.
      </div>
    </div>
  );
}
