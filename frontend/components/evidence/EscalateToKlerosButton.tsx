"use client";

import { useEffect, useRef, useState } from "react";
import { formatEther, type Address, type Hash } from "viem";
import { useAccount, useChainId, useReadContract, useWaitForTransactionReceipt, useWriteContract } from "wagmi";

import {
  getKlerosCaseUrl,
  getV3ContractAddresses,
  isKlerosAdapterDeployed,
  klerosV2DisputeAdapterAbi
} from "@/lib/contracts";
import { decodeDappError } from "@/lib/errors";
import type { ApiOrder } from "@/lib/orders";

const arbitratorAbi = [
  {
    type: "function",
    name: "arbitrationCost",
    stateMutability: "view",
    inputs: [{ name: "_extraData", type: "bytes" }],
    outputs: [{ name: "cost", type: "uint256" }]
  }
] as const;

export function EscalateToKlerosButton({
  order,
  onEscalated
}: {
  order: ApiOrder;
  onEscalated?: () => void;
}) {
  const currentChainId = useChainId();
  const { address } = useAccount();
  const v3 = getV3ContractAddresses(order.chainId);
  const adapter = v3?.klerosAdapter;
  const onOrderChain = currentChainId === order.chainId;
  const klerosEnabled = isKlerosAdapterDeployed(order.chainId);

  const { data: existingDisputeIDRaw } = useReadContract({
    address: adapter,
    abi: klerosV2DisputeAdapterAbi,
    functionName: "orderToDisputeID",
    args: [BigInt(order.onChainOrderId)],
    chainId: order.chainId,
    query: { enabled: klerosEnabled && order.status === "Disputed" }
  });

  const { data: arbitratorAddrRaw } = useReadContract({
    address: adapter,
    abi: klerosV2DisputeAdapterAbi,
    functionName: "arbitrator",
    chainId: order.chainId,
    query: { enabled: klerosEnabled }
  });

  const { data: extraDataRaw } = useReadContract({
    address: adapter,
    abi: klerosV2DisputeAdapterAbi,
    functionName: "arbitratorExtraData",
    chainId: order.chainId,
    query: { enabled: klerosEnabled }
  });

  const existingDisputeID = typeof existingDisputeIDRaw === "bigint" ? existingDisputeIDRaw : undefined;
  const arbitratorAddr = typeof arbitratorAddrRaw === "string" ? (arbitratorAddrRaw as Address) : undefined;
  const extraData = typeof extraDataRaw === "string" ? (extraDataRaw as `0x${string}`) : undefined;

  const { data: costRaw } = useReadContract({
    address: arbitratorAddr,
    abi: arbitratorAbi,
    functionName: "arbitrationCost",
    args: extraData !== undefined ? [extraData] : undefined,
    chainId: order.chainId,
    query: { enabled: arbitratorAddr !== undefined && extraData !== undefined }
  });

  const cost = typeof costRaw === "bigint" ? costRaw : undefined;
  const { writeContractAsync, isPending: walletPending } = useWriteContract();
  const [hash, setHash] = useState<Hash | undefined>();
  const [error, setError] = useState<string | undefined>();
  const handledReceipt = useRef<Hash | undefined>(undefined);
  const receipt = useWaitForTransactionReceipt({ hash });
  const receiptPending = hash !== undefined && receipt.isPending;
  const busy = walletPending || receiptPending;

  useEffect(() => {
    if (receipt.isSuccess && handledReceipt.current !== hash) {
      handledReceipt.current = hash;
      onEscalated?.();
    }
  }, [receipt.isSuccess, hash, onEscalated]);

  if (!klerosEnabled || !adapter) return null;
  if (order.status !== "Disputed") return null;

  const normalizedAddress = address?.toLowerCase();
  const isParty =
    normalizedAddress !== undefined &&
    (normalizedAddress === order.buyer.toLowerCase() ||
      normalizedAddress === order.seller.toLowerCase());

  if (existingDisputeID !== undefined && existingDisputeID !== 0n) {
    const url = getKlerosCaseUrl(order.chainId, existingDisputeID);
    return (
      <div className="mt-3 rounded border border-emerald-300 bg-emerald-50 p-3 text-sm">
        <div className="font-semibold text-emerald-900">
          Escalated to Kleros: dispute #{existingDisputeID.toString()}
        </div>
        {url && (
          <a href={url} target="_blank" rel="noreferrer" className="mt-1 inline-block text-emerald-700 hover:underline">
            View on Kleros V2 ↗
          </a>
        )}
      </div>
    );
  }

  const submit = async () => {
    if (!adapter) {
      setError("Kleros adapter not deployed on this chain");
      return;
    }
    if (!isParty) {
      setError("Only the buyer or seller can escalate to Kleros");
      return;
    }
    if (cost === undefined) {
      setError("Could not read arbitration cost yet - refresh and try again");
      return;
    }
    setError(undefined);
    try {
      const txHash = await writeContractAsync({
        address: adapter,
        abi: klerosV2DisputeAdapterAbi,
        functionName: "escalateToKleros",
        args: [BigInt(order.onChainOrderId)],
        value: cost
      });
      setHash(txHash);
    } catch (err: unknown) {
      const decoded = decodeDappError(err);
      setError(`${decoded.title}: ${decoded.message}`);
    }
  };

  const formattedCost = cost === undefined ? "?" : `${formatEther(cost)} ETH`;

  return (
    <div className="mt-3 rounded border border-amber-300 bg-amber-50 p-3 text-sm">
      <div className="font-semibold text-amber-900">Escalate to Kleros V2</div>
      <div className="mt-1 text-amber-800">
        Hand this dispute to the decentralized Kleros V2 court for binding ruling. Arbitration fee:{" "}
        <span className="font-mono">{formattedCost}</span>
      </div>

      {error && <div className="mt-2 rounded bg-red-50 p-2 text-xs text-red-700">{error}</div>}

      {!onOrderChain && (
        <div className="mt-2 text-xs text-amber-700">
          Switch wallet to chain {order.chainId} to escalate.
        </div>
      )}
      {!isParty && <div className="mt-2 text-xs text-amber-700">You are not a party of this order.</div>}

      <button
        onClick={submit}
        disabled={busy || !isParty || !onOrderChain || cost === undefined}
        className="mt-3 rounded bg-amber-600 px-3 py-1.5 text-sm text-white hover:bg-amber-700 disabled:opacity-50"
      >
        {busy ? "Escalating..." : "Escalate to Kleros"}
      </button>
    </div>
  );
}
