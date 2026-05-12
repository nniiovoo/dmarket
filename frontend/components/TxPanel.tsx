"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useAccount, useChainId, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import type { Hash } from "viem";

import { decodeDappError, type DappError } from "@/lib/errors";
import { getExplorerTxUrl, getFaucetUrl } from "@/lib/chains";
import { isSupportedChain } from "@/lib/contracts";

type TxPanelProps = {
  label: string;
  description?: string;
  disabled?: boolean;
  disabledReason?: string;
  buildTransaction: () => unknown;
  onConfirmed?: () => void;
  children?: ReactNode;
};

export function TxPanel({ label, description, disabled, disabledReason, buildTransaction, onConfirmed, children }: TxPanelProps) {
  const chainId = useChainId();
  const { connector } = useAccount();
  const [hash, setHash] = useState<Hash | undefined>();
  const [error, setError] = useState<DappError | undefined>();
  const confirmedHash = useRef<Hash | undefined>(undefined);
  const { writeContractAsync, isPending } = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash });
  const txUrl = getExplorerTxUrl(chainId, hash);
  const faucetUrl = getFaucetUrl(chainId);
  const supported = isSupportedChain(chainId);
  const effectiveDisabled = disabled || !supported;
  const effectiveDisabledReason = !supported ? "Switch to Sepolia or Polygon Amoy before sending transactions." : disabledReason;

  const status = useMemo(() => {
    if (error !== undefined) {
      return "failed";
    }
    if (receipt.isSuccess) {
      return "confirmed";
    }
    if (receipt.isPending && hash !== undefined) {
      return "submitted";
    }
    if (isPending) {
      return "pending";
    }
    return "idle";
  }, [error, hash, isPending, receipt.isPending, receipt.isSuccess]);

  useEffect(() => {
    if (receipt.isSuccess && hash !== undefined && confirmedHash.current !== hash) {
      confirmedHash.current = hash;
      onConfirmed?.();
    }
  }, [hash, onConfirmed, receipt.isSuccess]);

  async function submit() {
    setError(undefined);

    if (!supported) {
      setError({
        title: "Unsupported network",
        message: "Switch to Sepolia or Polygon Amoy before sending transactions.",
        tone: "warning",
        category: "wrong-network"
      });
      return;
    }

    const connectorChainId = await connector?.getChainId();
    if (connectorChainId !== chainId || !isSupportedChain(connectorChainId)) {
      setError({
        title: "Wallet is on the wrong network",
        message: "Your wallet is not actually on the selected testnet yet. Switch MetaMask to Sepolia or Polygon Amoy, then refresh and try again.",
        tone: "warning",
        category: "wrong-network"
      });
      return;
    }

    try {
      const nextHash = await writeContractAsync(withChainId(buildTransaction(), chainId) as never);
      setHash(nextHash);
    } catch (caught) {
      setError(decodeDappError(caught));
    }
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="font-medium text-slate-950">{label}</p>
          {description ? <p className="mt-1 text-sm text-slate-600">{description}</p> : null}
          {children}
        </div>
        <button
          type="button"
          onClick={submit}
          disabled={effectiveDisabled || isPending || receipt.isPending}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {!supported ? "Unsupported network" : isPending ? "Confirm in wallet..." : receipt.isPending ? "Waiting..." : label}
        </button>
      </div>
      {effectiveDisabled && effectiveDisabledReason ? <p className="mt-3 text-sm text-slate-500">{effectiveDisabledReason}</p> : null}
      {status !== "idle" ? (
        <div className="mt-3 rounded-md bg-white p-3 text-sm">
          <p className="font-medium capitalize text-slate-900">Status: {status}</p>
          {hash ? (
            <p className="mt-1 break-all text-slate-600">
              Tx:{" "}
              {txUrl ? (
                <a href={txUrl} target="_blank" rel="noreferrer" className="text-blue-700 underline">
                  {hash}
                </a>
              ) : (
                hash
              )}
            </p>
          ) : null}
          {error ? (
            <div className={`mt-2 ${error.tone === "danger" ? "text-red-700" : "text-amber-700"}`}>
              <p className="font-medium">{error.title}</p>
              <p>{error.message}</p>
              {error.category === "insufficient-funds" && faucetUrl ? (
                <a href={faucetUrl} target="_blank" rel="noreferrer" className="mt-1 inline-block underline">
                  Open faucet
                </a>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function withChainId(transaction: unknown, chainId: number) {
  if (typeof transaction !== "object" || transaction === null) {
    return transaction;
  }

  return { ...transaction, chainId };
}
