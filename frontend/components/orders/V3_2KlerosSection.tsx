"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { formatEther, type Address } from "viem";
import { useReadContract } from "wagmi";

import { Card } from "@/components/Card";
import { TxPanel } from "@/components/TxPanel";
import { getExplorerAddressUrl } from "@/lib/chains";
import { klerosAdapterV3_2Abi } from "@/lib/contractsV3_2";
import { getKlerosCaseUrl } from "@/lib/v3_2/klerosUrls";
import type { OrderRole } from "@/lib/v3_2/useOrderRole";

type Props = {
  order: { onChainOrderId: string };
  chainId: number;
  adapterAddress: Address;
  role: OrderRole;
};

// Marketplace's DISPUTE_RESOLUTION_DELAY. Kept in seconds to match
// `escalatedAt` (uint64 unix seconds). Mirror constant rather than
// reading from chain because we use it only for UX formatting.
const DISPUTE_RESOLUTION_DELAY_SECONDS = 3 * 24 * 60 * 60;

export function V3_2KlerosSection({ order, chainId, adapterAddress, role }: Props) {
  const router = useRouter();
  const orderIdBigInt = BigInt(order.onChainOrderId);

  const klerosIdQuery = useReadContract({
    address: adapterAddress,
    abi: klerosAdapterV3_2Abi,
    chainId,
    functionName: "klerosDisputeIdByOrder",
    args: [orderIdBigInt],
    query: { refetchInterval: 12_000 }
  });
  const escalatedAtQuery = useReadContract({
    address: adapterAddress,
    abi: klerosAdapterV3_2Abi,
    chainId,
    functionName: "escalatedAt",
    args: [orderIdBigInt],
    query: { refetchInterval: 12_000 }
  });
  const orderEscalatedQuery = useReadContract({
    address: adapterAddress,
    abi: klerosAdapterV3_2Abi,
    chainId,
    functionName: "orderEscalated",
    args: [orderIdBigInt],
    query: { refetchInterval: 12_000 }
  });
  const pendingRulingQuery = useReadContract({
    address: adapterAddress,
    abi: klerosAdapterV3_2Abi,
    chainId,
    functionName: "pendingRulings",
    args: [orderIdBigInt],
    query: { refetchInterval: 12_000 }
  });
  const costQuery = useReadContract({
    address: adapterAddress,
    abi: klerosAdapterV3_2Abi,
    chainId,
    functionName: "getArbitrationCost",
    query: { refetchInterval: 60_000, staleTime: 30_000 }
  });

  const onConfirmed = useCallback(() => {
    setTimeout(() => router.refresh(), 5_000);
  }, [router]);

  // Refresh once a minute so the "Apply ruling now" button enables itself
  // when the 3-day cooldown elapses without requiring a manual page refresh.
  // Initialised from a state-setter (lazy) so render itself stays pure.
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const escalated = orderEscalatedQuery.data === true;
  const klerosDisputeId = klerosIdQuery.data as bigint | undefined;
  const escalatedAt = escalatedAtQuery.data as bigint | undefined;
  const pendingRuling = pendingRulingQuery.data as bigint | undefined;
  const arbitrationCost = costQuery.data as bigint | undefined;

  // ── A. Not escalated yet ─────────────────────────────────────────
  if (!escalated) {
    const canEscalate = role === "buyer" || role === "seller";
    return (
      <Card title="Dispute open">
        <p className="text-sm text-slate-700">
          This order is in dispute. Either party can escalate to Kleros V2 for binding arbitration by jurors.
        </p>
        <div className="mt-3 rounded-md bg-slate-50 p-3 text-sm">
          <p>
            <span className="font-medium">Arbitration cost:</span>{" "}
            {arbitrationCost !== undefined ? (
              <span className="font-mono">{formatEther(arbitrationCost)} ETH</span>
            ) : (
              <span className="text-slate-500">loading…</span>
            )}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Paid to Kleros to fund the jurors who will rule on this dispute.
          </p>
        </div>
        <div className="mt-4">
          {arbitrationCost !== undefined ? (
            <TxPanel
              label="Escalate to Kleros"
              description={
                canEscalate
                  ? "Sends the arbitration fee and creates the Kleros case."
                  : "Only the buyer or seller of this order can escalate."
              }
              disabled={!canEscalate}
              disabledReason={canEscalate ? undefined : "Connect the buyer or seller wallet."}
              buildTransaction={() => ({
                address: adapterAddress,
                abi: klerosAdapterV3_2Abi,
                chainId,
                functionName: "escalateToKleros",
                args: [orderIdBigInt],
                value: arbitrationCost
              })}
              onConfirmed={onConfirmed}
            />
          ) : (
            <p className="text-sm text-slate-500">Loading arbitration cost…</p>
          )}
        </div>
      </Card>
    );
  }

  const adapterAddressUrl = getExplorerAddressUrl(chainId, adapterAddress);
  const klerosCaseUrl = getKlerosCaseUrl(chainId, klerosDisputeId);
  const escalatedAtDate = escalatedAt && escalatedAt > 0n ? new Date(Number(escalatedAt) * 1000) : undefined;

  // ── C. Kleros ruled but waiting for marketplace's 3-day cooldown ─
  if (pendingRuling !== undefined && pendingRuling > 0n && escalatedAt !== undefined) {
    const unlocksAtSecs = escalatedAt + BigInt(DISPUTE_RESOLUTION_DELAY_SECONDS);
    const unlocksAt = new Date(Number(unlocksAtSecs) * 1000);
    const unlocked = nowMs >= unlocksAt.getTime();
    return (
      <Card title="Kleros has ruled — applying to marketplace">
        <p className="text-sm text-slate-700">
          Kleros jurors have reached a verdict. The marketplace enforces a 3-day post-dispute timelock before the ruling can be applied.
        </p>
        <div className="mt-3 rounded-md bg-slate-50 p-3 text-sm">
          <p>
            <span className="font-medium">Unlocks at:</span> {unlocksAt.toLocaleString()}
            {unlocked ? <span className="ml-2 text-emerald-700">— unlocked</span> : null}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Anyone can apply the ruling once the timelock elapses.
          </p>
        </div>
        <div className="mt-4">
          <TxPanel
            label="Apply ruling now"
            description="Calls adapter.applyKlerosRuling(orderId) — pushes the Kleros verdict to the marketplace."
            disabled={!unlocked}
            disabledReason={unlocked ? undefined : "Wait until the marketplace timelock unlocks."}
            buildTransaction={() => ({
              address: adapterAddress,
              abi: klerosAdapterV3_2Abi,
              chainId,
              functionName: "applyKlerosRuling",
              args: [orderIdBigInt]
            })}
            onConfirmed={onConfirmed}
          />
        </div>
      </Card>
    );
  }

  // ── B. Escalated, awaiting jurors ────────────────────────────────
  return (
    <Card title="Awaiting Kleros ruling">
      <p className="text-sm text-slate-700">
        Kleros dispute{klerosDisputeId !== undefined ? ` #${klerosDisputeId.toString()}` : ""} created
        {escalatedAtDate ? ` on ${escalatedAtDate.toLocaleDateString()}` : ""}.
      </p>
      <p className="mt-2 text-sm text-slate-600">
        Kleros jurors are reviewing this case. Typical timeline: 3–7 days for ruling.
      </p>
      <div className="mt-4 flex flex-wrap gap-3 text-sm">
        {klerosCaseUrl ? (
          <a
            href={klerosCaseUrl}
            target="_blank"
            rel="noreferrer"
            className="rounded-md bg-slate-900 px-3 py-2 font-medium text-white hover:bg-slate-800"
          >
            View on Kleros Court ↗
          </a>
        ) : null}
        {adapterAddressUrl ? (
          <a
            href={adapterAddressUrl}
            target="_blank"
            rel="noreferrer"
            className="rounded-md border border-slate-200 px-3 py-2 font-medium text-slate-700 hover:bg-slate-50"
          >
            View adapter on Arbiscan ↗
          </a>
        ) : null}
      </div>
    </Card>
  );
}
