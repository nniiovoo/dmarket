"use client";

import { useEffect, useRef, useState } from "react";
import type { Hash } from "viem";
import { useAccount, useWaitForTransactionReceipt, useWriteContract } from "wagmi";

import {
  evidenceRegistryV3Abi,
  getV3ContractAddresses
} from "@/lib/contracts";
import { decodeDappError } from "@/lib/errors";
import type { ApiOrder } from "@/lib/orders";
import { useEnsureChain } from "@/lib/useEnsureChain";

export function SubmitEvidenceDialog({
  order,
  onClose,
  onSubmitted
}: {
  order: ApiOrder;
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const { address: connectedAddress } = useAccount();
  const v3 = getV3ContractAddresses(order.chainId);
  const registryAddress = v3?.evidenceRegistry;

  const { writeContractAsync, isPending: walletPending } = useWriteContract();
  const { ensure, switching } = useEnsureChain();
  const [evidenceURI, setEvidenceURI] = useState("");
  const [fireOracle, setFireOracle] = useState(false);
  const [hash, setHash] = useState<Hash | undefined>();
  const [error, setError] = useState<string | undefined>();
  const handledReceipt = useRef<Hash | undefined>(undefined);
  const receipt = useWaitForTransactionReceipt({ hash });
  const receiptPending = hash !== undefined && receipt.isPending;
  const busy = walletPending || receiptPending || switching;
  const trimmedURI = evidenceURI.trim();

  const normalizedConnected = connectedAddress?.toLowerCase();
  const isParty =
    normalizedConnected !== undefined &&
    (normalizedConnected === order.buyer.toLowerCase() ||
      normalizedConnected === order.seller.toLowerCase());

  useEffect(() => {
    if (receipt.isSuccess && handledReceipt.current !== hash) {
      handledReceipt.current = hash;
      onSubmitted();
      onClose();
    }
  }, [receipt.isSuccess, hash, onSubmitted, onClose]);

  const submit = async () => {
    if (!registryAddress) {
      setError("EvidenceRegistry is not deployed on this chain");
      return;
    }
    if (!isParty) {
      setError("Only the buyer or seller of this order can submit evidence");
      return;
    }
    if (trimmedURI.length === 0) {
      setError("Evidence URI is required");
      return;
    }
    setError(undefined);
    try {
      try {
        await ensure(order.chainId);
      } catch {
        setError("Network switch required");
        return;
      }

      const args = [BigInt(order.onChainOrderId), trimmedURI] as const;
      const txHash = await writeContractAsync({
        address: registryAddress,
        abi: evidenceRegistryV3Abi,
        chainId: order.chainId,
        functionName: fireOracle ? "submitEvidenceWithOracleQuery" : "submitEvidence",
        args
      });
      setHash(txHash);
    } catch (err: unknown) {
      const decoded = decodeDappError(err);
      setError(`${decoded.title}: ${decoded.message}`);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4">
      <div className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-950">Submit dispute evidence</h2>
          <button onClick={onClose} disabled={busy} className="text-slate-500 hover:text-slate-700">
            ✕
          </button>
        </div>

        {!registryAddress && (
          <div className="mt-3 rounded bg-amber-50 p-2 text-sm text-amber-800">
            EvidenceRegistry is not configured on this chain yet.
          </div>
        )}
        {registryAddress && !isParty && (
          <div className="mt-3 rounded bg-amber-50 p-2 text-sm text-amber-800">
            You are not a party of this order.
          </div>
        )}

        <label className="mt-4 block text-sm">
          <span className="text-slate-700">Evidence URI</span>
          <input
            type="text"
            value={evidenceURI}
            onChange={(e) => setEvidenceURI(e.target.value)}
            placeholder="ipfs://… or https://…"
            disabled={busy}
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
          />
          <span className="mt-1 block text-xs text-slate-500">
            Off-chain pointer (IPFS hash, signed Arweave URL, or HTTPS). The hash is committed on-chain.
          </span>
        </label>

        <label className="mt-3 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={fireOracle}
            onChange={(e) => setFireOracle(e.target.checked)}
            disabled={busy}
          />
          <span>Trigger fresh Chainlink delivery oracle query (costs LINK from platform subscription, 1h cooldown per order)</span>
        </label>

        {error && (
          <div className="mt-3 rounded bg-red-50 p-2 text-sm text-red-700">{error}</div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={busy}
            className="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={busy || !registryAddress || !isParty || trimmedURI.length === 0}
            className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {switching ? "Switching network..." : busy ? "Submitting…" : fireOracle ? "Submit + Query Oracle" : "Submit Evidence"}
          </button>
        </div>
      </div>
    </div>
  );
}
