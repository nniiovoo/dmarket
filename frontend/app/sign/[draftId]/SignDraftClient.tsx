"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { erc20Abi, parseSignature, type Address, type Hash } from "viem";
import { useAccount, usePublicClient, useSignTypedData, useWriteContract } from "wagmi";

import { WalletButton } from "@/components/WalletButton";
import { escrowMarketplaceERC20Abi } from "@/lib/contractsV3_2";
import { useEnsureChain } from "@/lib/useEnsureChain";
import { findCreatedOrderIdV3_2 } from "@/lib/orderEvents";
import {
  PAYMENT_AUTH_DOMAIN_NAME,
  PAYMENT_AUTH_DOMAIN_VERSION,
  PAYMENT_AUTH_TYPES
} from "@/lib/ai/draftOrder";

interface Props {
  draftId: string;
  buyer: Address;
  seller: Address;
  paymentToken: Address;
  productId: string; // uint256 string
  amount: string; // uint256 string
  nonce: string; // uint256 string
  deadlineUnixSec: string;
  chainId: number;
  marketplaceAddress: Address;
  origin: string;
}

type Status =
  | "idle"
  | "wrong-wallet"
  | "checking-allowance"
  | "approving"
  | "signing"
  | "submitting"
  | "confirming"
  | "success"
  | "error";

export function SignDraftClient(props: Props) {
  const router = useRouter();
  const { address, isConnected } = useAccount();
  const publicClient = usePublicClient({ chainId: props.chainId });
  const { ensure } = useEnsureChain();
  const { signTypedDataAsync } = useSignTypedData();
  const { writeContractAsync } = useWriteContract();

  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [approveTx, setApproveTx] = useState<Hash | null>(null);
  const [submitTx, setSubmitTx] = useState<Hash | null>(null);

  const expectedBuyer = props.buyer.toLowerCase();
  const walletMatches = isConnected && address?.toLowerCase() === expectedBuyer;

  const eip712 = useMemo(
    () => ({
      domain: {
        name: PAYMENT_AUTH_DOMAIN_NAME,
        version: PAYMENT_AUTH_DOMAIN_VERSION,
        chainId: props.chainId,
        verifyingContract: props.marketplaceAddress
      },
      types: PAYMENT_AUTH_TYPES,
      primaryType: "PaymentAuth" as const,
      message: {
        buyer: props.buyer,
        seller: props.seller,
        paymentToken: props.paymentToken,
        productId: BigInt(props.productId),
        amount: BigInt(props.amount),
        nonce: BigInt(props.nonce),
        deadline: BigInt(props.deadlineUnixSec)
      }
    }),
    [props]
  );

  const execute = useCallback(async () => {
    setErrorMsg(null);
    setStatus("idle");

    if (!walletMatches) {
      setStatus("wrong-wallet");
      return;
    }
    if (!publicClient) {
      setErrorMsg("No public client.");
      setStatus("error");
      return;
    }

    try {
      try {
        await ensure(props.chainId);
      } catch (err) {
        setErrorMsg(`Could not switch network: ${err instanceof Error ? err.message : String(err)}`);
        setStatus("error");
        return;
      }

      // 1) Allowance + approve, ERC-20 only.
      if (props.paymentToken !== "0x0000000000000000000000000000000000000000") {
        setStatus("checking-allowance");
        const current = (await publicClient.readContract({
          address: props.paymentToken,
          abi: erc20Abi,
          functionName: "allowance",
          args: [props.buyer, props.marketplaceAddress]
        })) as bigint;

        const needed = BigInt(props.amount);
        if (current < needed) {
          setStatus("approving");
          // USDT-style race-free approve: reset to 0 first if there's a stale
          // allowance. mUSD doesn't need it but we keep the pattern.
          if (current > 0n) {
            const resetHash = await writeContractAsync({
              address: props.paymentToken,
              abi: erc20Abi,
              functionName: "approve",
              args: [props.marketplaceAddress, 0n]
            });
            await publicClient.waitForTransactionReceipt({ hash: resetHash });
          }
          const approveHash = await writeContractAsync({
            address: props.paymentToken,
            abi: erc20Abi,
            functionName: "approve",
            args: [props.marketplaceAddress, needed]
          });
          setApproveTx(approveHash);
          await publicClient.waitForTransactionReceipt({ hash: approveHash });
        }
      }

      // 2) Sign EIP-712 PaymentAuth.
      setStatus("signing");
      const signature = await signTypedDataAsync(eip712);
      // viem accepts the packed signature directly.
      parseSignature(signature); // sanity-check it parses

      // 3) Submit createAndPayWithAuth — user pays gas.
      setStatus("submitting");
      const authStruct = {
        buyer: props.buyer,
        seller: props.seller,
        paymentToken: props.paymentToken,
        productId: BigInt(props.productId),
        amount: BigInt(props.amount),
        nonce: BigInt(props.nonce),
        deadline: BigInt(props.deadlineUnixSec)
      };

      const hash = await writeContractAsync({
        address: props.marketplaceAddress,
        abi: escrowMarketplaceERC20Abi,
        functionName: "createAndPayWithAuth",
        args: [authStruct, signature]
      });
      setSubmitTx(hash);

      setStatus("confirming");
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      const orderId = findCreatedOrderIdV3_2(receipt);

      // Notify the backend so the draft row gets signedAt + txHash.
      await fetch(`/api/ai/draft-order/${props.draftId}/mark-signed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ txHash: hash, orderId: orderId?.toString() ?? null })
      }).catch(() => undefined);

      setStatus("success");

      if (orderId !== undefined && orderId !== null) {
        router.push(`/orders/${props.chainId}/${orderId.toString()}`);
      }
    } catch (err) {
      console.error("[sign-draft] failed", err);
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  }, [
    eip712,
    ensure,
    props,
    publicClient,
    router,
    signTypedDataAsync,
    walletMatches,
    writeContractAsync
  ]);

  return (
    <div className="mt-6 space-y-4">
      <div className="rounded-md border border-gray-200 p-4">
        <div className="text-xs uppercase tracking-wide text-gray-500">Connect</div>
        <div className="mt-2 flex items-center justify-between">
          <span className="text-sm">
            {isConnected
              ? walletMatches
                ? "Wallet matches the buyer address. ✓"
                : "Wallet does not match. Connect the wallet that authorized this draft."
              : "Not connected"}
          </span>
          <WalletButton />
        </div>
      </div>

      <div className="rounded-md border border-gray-200 p-4">
        <button
          type="button"
          onClick={() => void execute()}
          disabled={!walletMatches || status === "approving" || status === "signing" || status === "submitting" || status === "confirming"}
          className="rounded-md bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          {status === "approving"
            ? "Approving token…"
            : status === "checking-allowance"
            ? "Checking allowance…"
            : status === "signing"
            ? "Sign in wallet…"
            : status === "submitting"
            ? "Submitting transaction…"
            : status === "confirming"
            ? "Waiting for confirmation…"
            : status === "success"
            ? "Done — redirecting…"
            : "Approve → Sign → Pay"}
        </button>

        <ul className="mt-3 space-y-1 text-xs text-gray-500">
          <li>1. Approve marketplace to spend the payment token (if not already approved).</li>
          <li>2. Sign the EIP-712 PaymentAuth in your wallet (off-chain — no gas).</li>
          <li>3. Submit createAndPayWithAuth on Arbitrum Sepolia (you pay the gas).</li>
        </ul>

        {approveTx ? (
          <div className="mt-3 text-xs">
            Approve tx:{" "}
            <a className="text-blue-600 underline" href={`https://sepolia.arbiscan.io/tx/${approveTx}`} target="_blank" rel="noreferrer">
              {approveTx.slice(0, 10)}…
            </a>
          </div>
        ) : null}
        {submitTx ? (
          <div className="mt-1 text-xs">
            Order tx:{" "}
            <a className="text-blue-600 underline" href={`https://sepolia.arbiscan.io/tx/${submitTx}`} target="_blank" rel="noreferrer">
              {submitTx.slice(0, 10)}…
            </a>
          </div>
        ) : null}

        {status === "wrong-wallet" ? (
          <div className="mt-3 text-xs text-red-600">
            Connected wallet doesn&apos;t match the draft buyer ({props.buyer.slice(0, 6)}…{props.buyer.slice(-4)}).
            Switch wallets and try again.
          </div>
        ) : null}
        {errorMsg && status === "error" ? <div className="mt-3 text-xs text-red-600">{errorMsg}</div> : null}
      </div>

      <p className="text-xs text-gray-500">
        After confirmation we&apos;ll send you to <span className="font-mono">{props.origin}</span>/orders/&lt;orderId&gt; so you
        can track shipping and trigger receipt-confirmation when it arrives.
      </p>
    </div>
  );
}
