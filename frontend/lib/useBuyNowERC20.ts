"use client";

import { useCallback, useState } from "react";
import { erc20Abi, type Address, type Hash } from "viem";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";

import { PRIMARY_CHAIN_ID } from "@/lib/chains";
import { getV3_2ContractAddresses, escrowMarketplaceERC20Abi } from "@/lib/contractsV3_2";
import { decodeDappError, type DappError } from "@/lib/errors";
import { findCreatedOrderIdV3_2 } from "@/lib/orderEvents";
import { useEnsureChain } from "@/lib/useEnsureChain";

export type BuyNowERC20Status =
  | "idle"
  | "checking-allowance"
  | "approving"
  | "creating-order"
  | "paying"
  | "success"
  | "error";

export type BuyNowERC20TxHashes = {
  approve?: Hash;
  create?: Hash;
  pay?: Hash;
};

export type UseBuyNowERC20Args = {
  sellerAddress: Address;
  productId: bigint;
  paymentToken: Address;
  amount: bigint;
};

export type UseBuyNowERC20Return = {
  status: BuyNowERC20Status;
  orderId: bigint | null;
  txHash: BuyNowERC20TxHashes;
  error: DappError | null;
  execute: () => Promise<void>;
  reset: () => void;
};

export function useBuyNowERC20({
  sellerAddress,
  productId,
  paymentToken,
  amount
}: UseBuyNowERC20Args): UseBuyNowERC20Return {
  const { address } = useAccount();
  const publicClient = usePublicClient({ chainId: PRIMARY_CHAIN_ID });
  const { writeContractAsync } = useWriteContract();
  const { ensure } = useEnsureChain();

  const [status, setStatus] = useState<BuyNowERC20Status>("idle");
  const [orderId, setOrderId] = useState<bigint | null>(null);
  const [txHash, setTxHash] = useState<BuyNowERC20TxHashes>({});
  const [error, setError] = useState<DappError | null>(null);

  const reset = useCallback(() => {
    setStatus("idle");
    setOrderId(null);
    setTxHash({});
    setError(null);
  }, []);

  const execute = useCallback(async () => {
    setError(null);
    setOrderId(null);
    setTxHash({});

    const v3_2 = getV3_2ContractAddresses(PRIMARY_CHAIN_ID);
    if (!v3_2) {
      setStatus("error");
      setError({
        title: "Configuration missing",
        message: "V3.2 marketplace address is not configured for this chain.",
        tone: "warning",
        category: "wrong-network"
      });
      return;
    }

    if (!address) {
      setStatus("error");
      setError({
        title: "Connect wallet first",
        message: "Connect a buyer wallet, then try again.",
        tone: "warning",
        category: "user-rejected"
      });
      return;
    }

    if (!publicClient) {
      setStatus("error");
      setError({
        title: "RPC unavailable",
        message: "Primary chain public client is unavailable.",
        tone: "warning",
        category: "unknown"
      });
      return;
    }

    try {
      await ensure(PRIMARY_CHAIN_ID);
    } catch {
      setStatus("error");
      setError({
        title: "Network switch required",
        message: "Switch to Arbitrum Sepolia to continue.",
        tone: "warning",
        category: "wrong-network"
      });
      return;
    }

    const marketplace = v3_2.marketplace;

    try {
      // Step 1: read current allowance.
      setStatus("checking-allowance");
      const currentAllowance = (await publicClient.readContract({
        address: paymentToken,
        abi: erc20Abi,
        functionName: "allowance",
        args: [address, marketplace]
      })) as bigint;

      // Step 2: if needed, approve. USDT-safety: if allowance is nonzero but
      // below `amount`, reset to 0 first before raising it. mUSD does not
      // require this, but keeping the branch future-proofs for USDT.
      if (currentAllowance < amount) {
        setStatus("approving");
        if (currentAllowance > 0n) {
          const resetHash = await writeContractAsync({
            address: paymentToken,
            abi: erc20Abi,
            chainId: PRIMARY_CHAIN_ID,
            functionName: "approve",
            args: [marketplace, 0n]
          });
          await publicClient.waitForTransactionReceipt({ hash: resetHash });
        }

        const approveHash = await writeContractAsync({
          address: paymentToken,
          abi: erc20Abi,
          chainId: PRIMARY_CHAIN_ID,
          functionName: "approve",
          args: [marketplace, amount]
        });
        setTxHash((prev) => ({ ...prev, approve: approveHash }));
        await publicClient.waitForTransactionReceipt({ hash: approveHash });
      }

      // Step 3: createOrder(seller, paymentToken, productId, amount).
      setStatus("creating-order");
      const createHash = await writeContractAsync({
        address: marketplace,
        abi: escrowMarketplaceERC20Abi,
        chainId: PRIMARY_CHAIN_ID,
        functionName: "createOrder",
        args: [sellerAddress, paymentToken, productId, amount]
      });
      setTxHash((prev) => ({ ...prev, create: createHash }));
      const createReceipt = await publicClient.waitForTransactionReceipt({ hash: createHash });
      const newOrderId = findCreatedOrderIdV3_2(createReceipt);
      if (newOrderId === undefined) {
        throw new Error("OrderCreated event not found in receipt");
      }
      setOrderId(newOrderId);

      // Step 4: payOrderERC20(orderId). The marketplace pulls `amount` via
      // safeTransferFrom — the approval set above must still be in place.
      setStatus("paying");
      const payHash = await writeContractAsync({
        address: marketplace,
        abi: escrowMarketplaceERC20Abi,
        chainId: PRIMARY_CHAIN_ID,
        functionName: "payOrderERC20",
        args: [newOrderId]
      });
      setTxHash((prev) => ({ ...prev, pay: payHash }));
      await publicClient.waitForTransactionReceipt({ hash: payHash });

      setStatus("success");
    } catch (caught) {
      setStatus("error");
      setError(decodeDappError(caught));
    }
  }, [address, amount, ensure, paymentToken, productId, publicClient, sellerAddress, writeContractAsync]);

  return { status, orderId, txHash, error, execute, reset };
}
