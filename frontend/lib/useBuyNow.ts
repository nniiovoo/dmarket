"use client";

import { useEffect, useRef, useState } from "react";
import { parseEther } from "viem";
import type { Hash } from "viem";
import { useAccount, useChainId, useWaitForTransactionReceipt, useWriteContract } from "wagmi";

import { getActiveMarketplace, hasMarketplace } from "@/lib/contracts";
import { decodeDappError, type DappError } from "@/lib/errors";
import { findCreatedOrderId } from "@/lib/orderEvents";

export type BuyNowState =
  | { kind: "idle" }
  | { kind: "waitingSignature" }
  | { kind: "submitted"; hash: Hash }
  | { kind: "confirmed"; hash: Hash; orderId?: bigint }
  | { kind: "failed"; error: DappError };

export function useBuyNow() {
  const chainId = useChainId();
  const { address, connector } = useAccount();
  const active = getActiveMarketplace(chainId);
  const supported = hasMarketplace(chainId);
  const { writeContractAsync } = useWriteContract();
  const [state, setState] = useState<BuyNowState>({ kind: "idle" });
  const handledReceipt = useRef<Hash | undefined>(undefined);
  const submittedHash = state.kind === "submitted" ? state.hash : undefined;
  const receipt = useWaitForTransactionReceipt({ hash: submittedHash });

  useEffect(() => {
    if (state.kind === "idle") {
      return undefined;
    }

    const timeout = window.setTimeout(() => {
      setState({ kind: "idle" });
      handledReceipt.current = undefined;
    }, 0);

    return () => window.clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainId]);

  useEffect(() => {
    if (!receipt.isSuccess || submittedHash === undefined || handledReceipt.current === submittedHash) {
      return;
    }

    handledReceipt.current = submittedHash;
    const orderId = findCreatedOrderId(receipt.data);

    window.setTimeout(() => {
      setState({ kind: "confirmed", hash: submittedHash, orderId });
    }, 0);
  }, [receipt.data, receipt.isSuccess, submittedHash]);

  useEffect(() => {
    if (!receipt.isError || submittedHash === undefined) {
      return;
    }

    window.setTimeout(() => {
      setState({
        kind: "failed",
        error: {
          title: "Confirmation failed",
          message: "The transaction was submitted, but browser confirmation failed. Check your wallet activity or the explorer.",
          tone: "warning",
          category: "unknown"
        }
      });
    }, 0);
  }, [receipt.isError, submittedHash]);

  async function buyNow(args: { seller: string; productId: bigint; priceEth: string }) {
    if (!supported || active === undefined) {
      setState({
        kind: "failed",
        error: {
          title: "Unsupported network",
          message: "Switch to a supported chain.",
          tone: "warning",
          category: "wrong-network"
        }
      });
      return;
    }

    if (address === undefined) {
      setState({
        kind: "failed",
        error: {
          title: "Connect wallet first",
          message: "Connect a buyer wallet, then click Buy now again.",
          tone: "warning",
          category: "user-rejected"
        }
      });
      return;
    }

    const connectorChainId = await connector?.getChainId();
    if (connectorChainId !== chainId || !hasMarketplace(connectorChainId)) {
      setState({
        kind: "failed",
        error: {
          title: "Wallet is on the wrong network",
          message: "Your wallet is not actually on the selected testnet yet. Switch MetaMask to a supported chain, then refresh and try again.",
          tone: "warning",
          category: "wrong-network"
        }
      });
      return;
    }

    handledReceipt.current = undefined;
    setState({ kind: "waitingSignature" });

    try {
      const hash = await writeContractAsync({
        address: active.address,
        abi: active.abi,
        chainId,
        functionName: "createAndPay",
        args: [args.seller, args.productId],
        value: parseEther(args.priceEth)
      });

      setState({ kind: "submitted", hash });
    } catch (caught) {
      setState({ kind: "failed", error: decodeDappError(caught) });
    }
  }

  function reset() {
    handledReceipt.current = undefined;
    setState({ kind: "idle" });
  }

  return { state, buyNow, reset };
}
