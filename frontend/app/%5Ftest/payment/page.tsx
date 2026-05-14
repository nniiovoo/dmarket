"use client";

import { useSearchParams } from "next/navigation";
import { parseEther } from "viem";

import { PayViaAnyChain } from "@/components/payment/PayViaAnyChain";

export default function PaymentTestPage() {
  const searchParams = useSearchParams();
  const liveMode = searchParams.get("execute") === "true";

  return (
    <div className="mx-auto max-w-md p-6">
      <h1 className="mb-2 text-xl font-bold">PayViaAnyChain demo</h1>
      <div
        className={`mb-3 inline-block rounded px-2 py-0.5 text-xs ${
          liveMode ? "bg-red-100 text-red-700" : "bg-slate-100 text-slate-600"
        }`}
      >
        {liveMode ? "LIVE MODE - real bridge tx will be signed" : "DRY RUN - clicks won't spend ETH"}
      </div>

      <PayViaAnyChain
        amountWei={parseEther("0.001")}
        label="Test order"
        executeMode={liveMode ? "live" : "dry"}
        seller="0x6eCc616BfB1A6Dd2e82D461Ba958D47A823C1d55"
        productId={42n}
        onDirectConfirm={() => console.log("[demo] direct path confirmed")}
        onCrossChainConfirm={(quote) => console.log("[demo] cross-chain confirmed", quote)}
        onBridgeComplete={(info) => console.log("[demo] bridge complete", info)}
        onOrderCreated={(orderId, txHash) => console.log("[demo] order created", orderId, txHash)}
        onError={(message) => console.error("[demo] error", message)}
      />
      <div className="mt-4 text-xs text-slate-500">
        {liveMode
          ? "Add ?execute=false to URL to return to dry-run."
          : "Add ?execute=true to URL to enable real bridge execution."}
      </div>
    </div>
  );
}
