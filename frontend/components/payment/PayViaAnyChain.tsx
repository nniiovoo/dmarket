"use client";

import { useEffect, useState } from "react";
import { formatEther, type Address } from "viem";
import { useAccount, useChainId, usePublicClient, useWriteContract } from "wagmi";

import { PRIMARY_CHAIN, PRIMARY_CHAIN_ID, isPrimaryChain } from "@/lib/chains";
import {
  escrowMarketplaceV3_1Abi,
  getActiveMarketplace,
  getV3_1ContractAddresses,
  hasV3_1OnChain
} from "@/lib/contracts";
import { executeBridge, getBridgeStatus, getCrossChainQuote, type CrossChainQuote } from "@/lib/lifi";
import { findCreatedOrderId } from "@/lib/orderEvents";
import { useEnsureChain } from "@/lib/useEnsureChain";

const NATIVE = "0x0000000000000000000000000000000000000000" as `0x${string}`;
const RELAYER_ADDRESS = process.env.NEXT_PUBLIC_RELAYER_ADDRESS_ARBITRUMSEPOLIA as
  | Address
  | undefined;
const TESTNET_BYPASS_ENABLED = process.env.NEXT_PUBLIC_V3_1_TESTNET_BYPASS === "true";

// 2s / 4s / 8s backoff for transient RPC failures (Alchemy free tier 429,
// brief network blips, etc.). Matches the relayer-side withRpcRetry in
// scripts/v3_1Relayer.ts.
const TRANSIENT_RPC_PATTERNS = [
  /429/i,
  /too many requests/i,
  /compute units/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /socket hang up/i,
  /rate.?limit/i,
  /service unavailable/i,
  /503/
];

async function retryRpc<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const delays = [2000, 4000, 8000];
  let lastError: unknown;

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const message =
        error instanceof Error ? error.message : typeof error === "string" ? error : "";
      const transient = TRANSIENT_RPC_PATTERNS.some((pattern) => pattern.test(message));
      if (attempt >= delays.length || !transient) {
        throw error;
      }
      const delay = delays[attempt]!;
      console.warn(
        `[PayViaAnyChain] RPC retry attempt=${attempt + 1} delay=${delay / 1000}s label=${label} reason="${message.slice(0, 120)}"`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

type Props = {
  amountWei: bigint;
  label?: string;
  executeMode?: "dry" | "live";
  seller?: Address;
  productId?: bigint;
  onDirectConfirm?: () => void;
  onCrossChainConfirm?: (quote: CrossChainQuote) => void;
  onBridgeComplete?: (info: { quote: CrossChainQuote; bridgeTxHash?: string }) => void;
  onOrderCreated?: (orderId: bigint, txHash: string) => void;
  onError?: (message: string) => void;
};

type BridgeStatus =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "running"; stepName?: string; message?: string }
  | { kind: "complete"; bridgeTxHash?: string }
  | { kind: "failed"; error: string };

type PaymentStatus =
  | { kind: "idle" }
  | { kind: "switching" }
  | { kind: "signing" }
  | { kind: "confirming" }
  | { kind: "done"; orderId: bigint; txHash: string }
  | { kind: "failed"; error: string };

type PaymentAuth = {
  buyer: Address;
  seller: Address;
  productId: bigint;
  amount: bigint;
  nonce: bigint;
  deadline: bigint;
};

type Eip1193Provider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

type EthereumWindow = Window & {
  ethereum?: Eip1193Provider;
};

type SingleSigStatus =
  | { kind: "idle" }
  | { kind: "signing" }
  | { kind: "bridging"; message?: string; sourceTxHash?: string }
  | { kind: "relaying"; message?: string }
  | { kind: "done"; txHash: string; orderId: bigint }
  | { kind: "error"; step: "signing" | "bridging" | "relaying"; error: string };

type RouteStepWithExecution = {
  type?: string;
  execution?: {
    status?: string;
    process?: Array<{
      message?: string;
      txHash?: string;
    }>;
  };
};

export function PayViaAnyChain({
  amountWei,
  label,
  executeMode = "dry",
  seller,
  productId,
  onDirectConfirm,
  onCrossChainConfirm,
  onBridgeComplete,
  onOrderCreated,
  onError
}: Props) {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const onPrimary = isPrimaryChain(chainId);
  const publicClient = usePublicClient({ chainId: PRIMARY_CHAIN_ID });
  const { writeContractAsync } = useWriteContract();
  const { ensure } = useEnsureChain();
  const v3_1 = getV3_1ContractAddresses(PRIMARY_CHAIN_ID);
  const singleSigAvailable = hasV3_1OnChain(PRIMARY_CHAIN_ID);

  const [quote, setQuote] = useState<CrossChainQuote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState<string | undefined>();
  const [status, setStatus] = useState("Ready");
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus>({ kind: "idle" });
  const [paymentStatus, setPaymentStatus] = useState<PaymentStatus>({ kind: "idle" });
  const [singleSigEnabled, setSingleSigEnabled] = useState(false);
  const [singleSigBypassEnabled, setSingleSigBypassEnabled] = useState(false);
  const [singleSigStatus, setSingleSigStatus] = useState<SingleSigStatus>({ kind: "idle" });
  const [signedAuth, setSignedAuth] = useState<PaymentAuth | undefined>();
  const [paymentSignature, setPaymentSignature] = useState<string | undefined>();
  const fullPurchaseMode = seller !== undefined && productId !== undefined;

  useEffect(() => {
    const shouldBypassQuote = singleSigEnabled && singleSigBypassEnabled;

    if (onPrimary || !isConnected || !address || !chainId || shouldBypassQuote) {
      setQuote(null);
      setQuoteError(undefined);
      setQuoting(false);
      setBridgeStatus({ kind: "idle" });
      setPaymentStatus({ kind: "idle" });
      return;
    }

    let cancelled = false;
    setQuoting(true);
    setQuote(null);
    setQuoteError(undefined);
    setBridgeStatus({ kind: "idle" });
    setPaymentStatus({ kind: "idle" });

    if (singleSigEnabled && RELAYER_ADDRESS === undefined) {
      setQuoteError("NEXT_PUBLIC_RELAYER_ADDRESS_ARBITRUMSEPOLIA is not configured");
      setQuoting(false);
      return;
    }

    getCrossChainQuote({
      fromChainId: chainId,
      fromToken: NATIVE,
      fromAmount: amountWei.toString(),
      fromAddress: address,
      toChainId: PRIMARY_CHAIN_ID,
      toToken: NATIVE,
      toAddress: singleSigEnabled ? RELAYER_ADDRESS : undefined
    })
      .then((nextQuote) => {
        if (!cancelled) {
          setQuote(nextQuote);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setQuoteError(error instanceof Error ? error.message : "Quote failed");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setQuoting(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    onPrimary,
    isConnected,
    address,
    chainId,
    amountWei,
    singleSigEnabled,
    singleSigBypassEnabled
  ]);

  async function executePayment() {
    if (seller === undefined || productId === undefined) return;

    const active = getActiveMarketplace(PRIMARY_CHAIN_ID);
    if (!active) {
      const message = "Marketplace not configured on primary chain";
      setPaymentStatus({ kind: "failed", error: message });
      onError?.(message);
      return;
    }
    if (!publicClient) {
      const message = "Primary chain public client is unavailable";
      setPaymentStatus({ kind: "failed", error: message });
      onError?.(message);
      return;
    }

    try {
      setPaymentStatus({ kind: "switching" });
      await ensure(PRIMARY_CHAIN_ID);

      setPaymentStatus({ kind: "signing" });
      const txHash = await writeContractAsync({
        address: active.address,
        abi: active.abi,
        functionName: "createAndPay",
        args: [seller, productId],
        value: amountWei,
        chainId: PRIMARY_CHAIN_ID
      });

      setPaymentStatus({ kind: "confirming" });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      const orderId = findCreatedOrderId(receipt);
      if (orderId === undefined) {
        throw new Error("OrderCreated event not found in receipt");
      }

      setPaymentStatus({ kind: "done", orderId, txHash });
      onOrderCreated?.(orderId, txHash);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Payment failed";
      setPaymentStatus({ kind: "failed", error: message });
      onError?.(message);
    }
  }

  const handleDirectConfirm = async () => {
    console.log("[PayViaAnyChain] direct path confirmed");
    onDirectConfirm?.();

    if (fullPurchaseMode && executeMode === "live") {
      await executePayment();
      return;
    }

    setStatus("Direct payment simulated. No transaction was sent.");
  };

  const handleCrossChainConfirm = async () => {
    if (!quote) return;

    onCrossChainConfirm?.(quote);

    if (executeMode === "dry") {
      console.log("[PayViaAnyChain] DRY RUN - would execute bridge", quote);
      setStatus("Dry-run bridge started.");
      setBridgeStatus({ kind: "starting" });
      window.setTimeout(() => {
        setBridgeStatus({ kind: "running", message: "Simulated bridging..." });
      }, 500);
      window.setTimeout(() => {
        setStatus("Dry-run bridge complete. No funds were moved.");
        setBridgeStatus({ kind: "complete", bridgeTxHash: "0xdry-run" });
        onBridgeComplete?.({ quote, bridgeTxHash: "0xdry-run" });
      }, 2500);
      return;
    }

    console.log("[PayViaAnyChain] LIVE MODE - executing bridge", quote);
    setStatus("Live bridge started.");
    setBridgeStatus({ kind: "starting" });

    try {
      const finalRoute = await executeBridge({
        quote,
        onUpdate: (route) => {
          const activeStep = route.steps?.[route.steps.length - 1] as
            | RouteStepWithExecution
            | undefined;
          const exec = activeStep?.execution;
          const stepProcess = exec?.process?.[exec.process.length - 1];
          setBridgeStatus({
            kind: "running",
            stepName: activeStep?.type,
            message: stepProcess?.message ?? exec?.status ?? "Bridging..."
          });
        }
      });

      const lastStep = finalRoute.steps?.[finalRoute.steps.length - 1] as
        | RouteStepWithExecution
        | undefined;
      const lastTx = lastStep?.execution?.process?.find((process) => process.txHash)?.txHash;

      setStatus("Bridge complete. Funds are on the destination chain.");
      setBridgeStatus({ kind: "complete", bridgeTxHash: lastTx });
      onBridgeComplete?.({ quote, bridgeTxHash: lastTx });
      if (fullPurchaseMode) {
        await executePayment();
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Bridge execution failed";
      setStatus("Bridge failed.");
      setBridgeStatus({ kind: "failed", error: message });
    }
  };

  const signAndBridgeSingleSig = async () => {
    if (!fullPurchaseMode || seller === undefined || productId === undefined) {
      setSingleSigStatus({
        kind: "error",
        step: "signing",
        error: "Single-sig pay requires seller and productId"
      });
      return;
    }
    if (!address) {
      setSingleSigStatus({ kind: "error", step: "signing", error: "Wallet not connected" });
      return;
    }
    if (!publicClient || !v3_1) {
      setSingleSigStatus({
        kind: "error",
        step: "signing",
        error: "V3.1 marketplace is not configured on Arbitrum Sepolia"
      });
      return;
    }

    try {
      setSingleSigStatus({ kind: "signing" });
      if (singleSigBypassEnabled) {
        await ensure(PRIMARY_CHAIN_ID);
        // Give wagmi a beat to settle on the new chain before viem reads
        // chainId for signTypedData. Without this, the typed-data sign can
        // race the chain switch and viem throws "chain mismatch".
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      // authNonces is a read on Arbitrum Sepolia, which uses the user's RPC.
      // On Alchemy free tier this can 429 in a burst — wrap with a tiny
      // backoff retry so a transient rate-limit doesn't kill the sign flow.
      const nonce = (await retryRpc("authNonces", () =>
        publicClient.readContract({
          address: v3_1.marketplace,
          abi: escrowMarketplaceV3_1Abi,
          functionName: "authNonces",
          args: [address]
        })
      )) as bigint;
      const auth: PaymentAuth = {
        buyer: address,
        seller,
        productId,
        amount: amountWei,
        nonce,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 30 * 60)
      };
      const signature = await signPaymentAuth(address, v3_1.marketplace, auth);

      setSignedAuth(auth);
      setPaymentSignature(signature);
      if (singleSigBypassEnabled) {
        await submitSignedPayment(auth, signature);
        return;
      }
      await bridgeSingleSigPayment(auth, signature);
    } catch (error: unknown) {
      const message = getErrorMessage(error, "Failed to sign payment authorization");
      setSingleSigStatus({ kind: "error", step: "signing", error: message });
      onError?.(message);
    }
  };

  const bridgeSingleSigPayment = async (auth = signedAuth, signature = paymentSignature) => {
    if (!quote || !auth || !signature) return;

    if (executeMode === "dry") {
      console.log("[PayViaAnyChain] DRY RUN - would bridge to relayer and submit auth", {
        auth,
        signature,
        quote
      });
      setSingleSigStatus({ kind: "bridging", message: "Dry-run bridge simulation..." });
      window.setTimeout(() => {
        setSingleSigStatus({ kind: "relaying", message: "Dry-run relayer submission..." });
      }, 1200);
      window.setTimeout(() => {
        setSingleSigStatus({
          kind: "done",
          txHash: "0xdry-run",
          orderId: 0n
        });
      }, 2400);
      return;
    }

    try {
      setSingleSigStatus({ kind: "bridging", message: "Starting LI.FI bridge..." });
      let sourceTxHash: string | undefined;
      const finalRoute = await executeBridge({
        quote,
        onUpdate: (route) => {
          sourceTxHash = sourceTxHash ?? findRouteTxHash(route);
          const activeStep = route.steps?.[route.steps.length - 1] as
            | RouteStepWithExecution
            | undefined;
          const exec = activeStep?.execution;
          const stepProcess = exec?.process?.[exec.process.length - 1];
          setSingleSigStatus({
            kind: "bridging",
            sourceTxHash,
            message: stepProcess?.message ?? exec?.status ?? "Bridging to relayer..."
          });
        }
      });
      sourceTxHash = sourceTxHash ?? findRouteTxHash(finalRoute);
      if (sourceTxHash) {
        const bridgeStatus = await getBridgeStatus({
          txHash: sourceTxHash,
          bridge: getRouteTool(quote),
          fromChain: quote.fromChainId,
          toChain: quote.toChainId
        });
        setSingleSigStatus({
          kind: "bridging",
          sourceTxHash,
          message: `LI.FI status: ${bridgeStatus.status}`
        });
      }
      await submitSignedPayment(auth, signature);
    } catch (error: unknown) {
      const message = getErrorMessage(error, "Single-sig bridge failed");
      setSingleSigStatus({ kind: "error", step: "bridging", error: message });
      onError?.(message);
    }
  };

  const submitSignedPayment = async (auth = signedAuth, signature = paymentSignature) => {
    if (!auth || !signature) return;

    try {
      setSingleSigStatus({ kind: "relaying", message: "Submitting signed auth to relayer..." });
      const response = await fetch("/api/relayer/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chainId: PRIMARY_CHAIN_ID,
          signature,
          auth: {
            buyer: auth.buyer,
            seller: auth.seller,
            productId: auth.productId.toString(),
            amount: auth.amount.toString(),
            nonce: auth.nonce.toString(),
            deadline: auth.deadline.toString()
          }
        })
      });
      const result = (await response.json()) as
        | { ok: true; txHash: string; orderId: string }
        | { ok: false; error?: string };
      if (!response.ok || !result.ok) {
        throw new Error(result.ok ? "Relayer request failed" : (result.error ?? "Relayer request failed"));
      }

      const orderId = BigInt(result.orderId);
      setSingleSigStatus({ kind: "done", txHash: result.txHash, orderId });
      onOrderCreated?.(orderId, result.txHash);
    } catch (error: unknown) {
      const message = getErrorMessage(error, "Relayer submission failed");
      setSingleSigStatus({ kind: "error", step: "relaying", error: message });
      onError?.(message);
    }
  };

  const retrySingleSigStep = async () => {
    if (singleSigStatus.kind !== "error") return;
    if (singleSigStatus.step === "signing") {
      await signAndBridgeSingleSig();
    } else if (singleSigStatus.step === "bridging") {
      await bridgeSingleSigPayment();
    } else {
      await submitSignedPayment();
    }
  };

  if (!isConnected) {
    return (
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
        Connect your wallet to pay.
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div>
        <div className="text-sm font-semibold text-slate-900">
          Pay for {label ?? "this order"}
        </div>
        <div className="mt-0.5 text-xs text-slate-600">
          Price: <span className="font-mono">{formatEther(amountWei)}</span> ETH on{" "}
          {PRIMARY_CHAIN.name}
        </div>
      </div>

      <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
        Status: <span className="font-medium text-slate-900">{status}</span>
      </div>

      {/*
        Keep the toggles visible whenever single-sig is already armed, even
        after the wallet has switched to the primary chain mid-flow.
        Otherwise the UI vanishes the user's intent at the moment wagmi
        observes the new chainId and they have no way to back out.
      */}
      {singleSigAvailable && (!onPrimary || singleSigEnabled) && (
        <div className="space-y-2">
          <label className="flex items-center gap-2 rounded border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-medium text-blue-900">
            <input
              type="checkbox"
              checked={singleSigEnabled}
              onChange={(event) => {
                setSingleSigEnabled(event.target.checked);
                if (!event.target.checked) setSingleSigBypassEnabled(false);
              }}
            />
            Single-sig cross-chain pay (V3.1, experimental)
          </label>

          {singleSigEnabled && TESTNET_BYPASS_ENABLED && (
            <label className="block rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
              <span className="flex items-center gap-2 font-medium">
                <input
                  type="checkbox"
                  checked={singleSigBypassEnabled}
                  onChange={(event) => setSingleSigBypassEnabled(event.target.checked)}
                />
                Bypass LI.FI bridge (testnet smoke only)
              </span>
              <span className="mt-1 block">
                Skips the real cross-chain bridge. Only safe on testnet - relayer pays msg.value
                from its own balance.
              </span>
            </label>
          )}
        </div>
      )}

      {/*
        Check singleSigEnabled BEFORE onPrimary. Once the user has armed the
        V3.1 path, the wallet's chain may switch to primary mid-flow (the
        relayer needs the user on primary for the EIP-712 sign). We must not
        let that chain flip swap in <DirectPathCard /> — that would put a
        "Pay" button in front of the user that fires V3 createAndPay instead
        of V3.1 createAndPayWithAuth.
      */}
      {singleSigEnabled ? (
        <SingleSigCrossChainCard
          currentChainId={chainId}
          quote={quote}
          quoting={quoting}
          error={quoteError}
          status={singleSigStatus}
          relayerAddress={RELAYER_ADDRESS}
          bypassEnabled={singleSigBypassEnabled}
          onSign={signAndBridgeSingleSig}
          onRetry={retrySingleSigStep}
        />
      ) : onPrimary ? (
        <DirectPathCard amountWei={amountWei} onConfirm={handleDirectConfirm} />
      ) : (
        <CrossChainPathCard
          currentChainId={chainId}
          quote={quote}
          quoting={quoting}
          error={quoteError}
          bridgeStatus={bridgeStatus}
          onConfirm={handleCrossChainConfirm}
        />
      )}

      <PaymentStatusIndicator status={paymentStatus} />
    </div>
  );
}

const paymentAuthTypes = {
  PaymentAuth: [
    { name: "buyer", type: "address" },
    { name: "seller", type: "address" },
    { name: "productId", type: "uint256" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" }
  ]
} as const;

async function signPaymentAuth(
  signer: Address,
  verifyingContract: Address,
  auth: PaymentAuth
) {
  const provider =
    typeof window === "undefined" ? undefined : (window as EthereumWindow).ethereum;
  if (!provider) {
    throw new Error("Injected wallet provider not found");
  }

  // wagmi/viem intentionally rejects typed data whose domain.chainId differs
  // from the active wallet chain. This V3.1 flow signs an Arbitrum Sepolia
  // authorization while the wallet may still be on the source chain, so send
  // the EIP-712 payload directly to the wallet.
  const signature = await provider.request({
    method: "eth_signTypedData_v4",
    params: [
      signer,
      JSON.stringify({
        types: {
          EIP712Domain: [
            { name: "name", type: "string" },
            { name: "version", type: "string" },
            { name: "chainId", type: "uint256" },
            { name: "verifyingContract", type: "address" }
          ],
          PaymentAuth: paymentAuthTypes.PaymentAuth
        },
        primaryType: "PaymentAuth",
        domain: {
          name: "ChainUsEscrow",
          version: "3.1",
          chainId: PRIMARY_CHAIN_ID,
          verifyingContract
        },
        message: {
          buyer: auth.buyer,
          seller: auth.seller,
          productId: auth.productId.toString(),
          amount: auth.amount.toString(),
          nonce: auth.nonce.toString(),
          deadline: auth.deadline.toString()
        }
      })
    ]
  });

  if (typeof signature !== "string") {
    throw new Error("Wallet returned an invalid signature");
  }
  return signature;
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "object" && error !== null) {
    const maybeMessage = (error as { message?: unknown; details?: unknown; shortMessage?: unknown }).message;
    if (typeof maybeMessage === "string" && maybeMessage.length > 0) return maybeMessage;
    const maybeDetails = (error as { details?: unknown }).details;
    if (typeof maybeDetails === "string" && maybeDetails.length > 0) return maybeDetails;
    const maybeShortMessage = (error as { shortMessage?: unknown }).shortMessage;
    if (typeof maybeShortMessage === "string" && maybeShortMessage.length > 0) {
      return maybeShortMessage;
    }
  }
  if (typeof error === "string" && error.length > 0) return error;
  return fallback;
}

function DirectPathCard({
  amountWei,
  onConfirm
}: {
  amountWei: bigint;
  onConfirm?: () => void;
}) {
  return (
    <div className="rounded border border-emerald-200 bg-emerald-50 p-3">
      <div className="text-xs font-semibold text-emerald-800">Direct path</div>
      <div className="mt-0.5 text-xs text-emerald-700">
        Your wallet is already on {PRIMARY_CHAIN.name}. Pay in one signature.
      </div>
      <button
        onClick={onConfirm}
        className="mt-2 rounded bg-emerald-600 px-3 py-1.5 text-sm text-white hover:bg-emerald-700"
      >
        Pay {formatEther(amountWei)} ETH
      </button>
    </div>
  );
}

function CrossChainPathCard({
  currentChainId,
  quote,
  quoting,
  error,
  bridgeStatus,
  onConfirm
}: {
  currentChainId: number;
  quote: CrossChainQuote | null;
  quoting: boolean;
  error?: string;
  bridgeStatus: BridgeStatus;
  onConfirm: () => void;
}) {
  const bridgeBusy = bridgeStatus.kind !== "idle" && bridgeStatus.kind !== "failed";

  return (
    <div className="rounded border border-amber-200 bg-amber-50 p-3">
      <div className="text-xs font-semibold text-amber-900">Cross-chain path</div>
      <div className="mt-0.5 text-xs text-amber-800">
        Wallet on chain {currentChainId} to {PRIMARY_CHAIN.name}.
      </div>

      <div className="mt-3 space-y-1 text-xs">
        <Row label="Pay token" value="ETH" />
        {quoting && <div className="text-amber-700">Getting quote...</div>}
        {error && (
          <div className="rounded bg-red-50 p-2 text-red-700">
            Quote unavailable: {error}
          </div>
        )}
        {quote && (
          <>
            <Row
              label="You pay"
              value={`${formatEther(BigInt(quote.fromAmount))} ${quote.fromTokenSymbol}`}
            />
            <Row
              label="Marketplace receives"
              value={`${formatEther(BigInt(quote.toAmount))} ${quote.toTokenSymbol}`}
            />
            {quote.feeCostsUsd && <Row label="Bridge fee" value={`~$${quote.feeCostsUsd}`} />}
            {quote.gasCostsUsd && (
              <Row label="Gas on source chain" value={`~$${quote.gasCostsUsd}`} />
            )}
            <Row label="Estimated time" value={`~${quote.estimatedDurationSec}s`} />
          </>
        )}
      </div>

      <div className="mt-3 rounded bg-amber-100 p-2 text-[11px] text-amber-900">
        Two-step process:
        <ol className="ml-4 mt-1 list-decimal space-y-0.5">
          <li>Sign bridge transaction on your current chain</li>
          <li>
            After bridge completes (~{quote?.estimatedDurationSec ?? "45"}s), sign payment on{" "}
            {PRIMARY_CHAIN.name}
          </li>
        </ol>
      </div>

      <button
        onClick={onConfirm}
        disabled={!quote || quoting || bridgeBusy}
        className="mt-3 rounded bg-amber-600 px-3 py-1.5 text-sm text-white hover:bg-amber-700 disabled:opacity-50"
      >
        {quoting ? "Quoting..." : getBridgeButtonLabel(bridgeStatus)}
      </button>

      <BridgeProgressIndicator status={bridgeStatus} />
    </div>
  );
}

function SingleSigCrossChainCard({
  currentChainId,
  quote,
  quoting,
  error,
  status,
  relayerAddress,
  bypassEnabled,
  onSign,
  onRetry
}: {
  currentChainId: number;
  quote: CrossChainQuote | null;
  quoting: boolean;
  error?: string;
  status: SingleSigStatus;
  relayerAddress?: Address;
  bypassEnabled: boolean;
  onSign: () => void;
  onRetry: () => void;
}) {
  const busy =
    status.kind === "signing" ||
    status.kind === "bridging" ||
    status.kind === "relaying" ||
    status.kind === "done";
  const disabled = (!bypassEnabled && !quote) || quoting || busy || relayerAddress === undefined;

  // When the wallet has already flipped to the primary chain mid-flow and we
  // are waiting on the EIP-712 sign popup, surface that explicitly. Without
  // this, users see a frozen-looking card and may try to interact with the
  // page instead of approving the pending signature in MetaMask.
  const showSigningOnPrimaryHint =
    status.kind === "signing" && currentChainId === PRIMARY_CHAIN_ID;

  return (
    <div className="rounded border border-blue-200 bg-blue-50 p-3">
      <div className="text-xs font-semibold text-blue-900">Single-sig cross-chain path</div>
      <div className="mt-0.5 text-xs text-blue-800">
        Wallet on chain {currentChainId} signs one payment authorization. Funds bridge to the
        relayer on {PRIMARY_CHAIN.name}, then the relayer creates and pays the order.
      </div>

      {showSigningOnPrimaryHint && (
        <div className="mt-3 rounded border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-900">
          Wallet now on {PRIMARY_CHAIN.name}. Waiting for EIP-712 signature in your wallet —
          open MetaMask and approve the typed-data request. Do not press any button on this
          page until the signature popup shows up.
        </div>
      )}

      <div className="mt-3 space-y-1 text-xs">
        <Row label="Pay token" value="ETH" />
        {relayerAddress && <Row label="Bridge receiver" value={relayerAddress} />}
        {!relayerAddress && (
          <div className="rounded bg-red-50 p-2 text-red-700">
            Configure NEXT_PUBLIC_RELAYER_ADDRESS_ARBITRUMSEPOLIA before using V3.1 single-sig pay.
          </div>
        )}
        {bypassEnabled ? (
          <div className="rounded bg-red-50 p-2 text-red-700">
            Testnet bypass enabled: no LI.FI quote or bridge will run. After signature, the
            relayer submits createAndPayWithAuth using its own Arbitrum Sepolia ETH.
          </div>
        ) : (
          <>
            {quoting && <div className="text-blue-700">Getting quote...</div>}
            {error && (
              <div className="rounded bg-red-50 p-2 text-red-700">
                Quote unavailable: {error}
              </div>
            )}
            {quote && (
              <>
                <Row
                  label="You bridge"
                  value={`${formatEther(BigInt(quote.fromAmount))} ${quote.fromTokenSymbol}`}
                />
                <Row
                  label="Relayer receives"
                  value={`${formatEther(BigInt(quote.toAmount))} ${quote.toTokenSymbol}`}
                />
                {quote.feeCostsUsd && <Row label="Bridge fee" value={`~$${quote.feeCostsUsd}`} />}
                {quote.gasCostsUsd && (
                  <Row label="Gas on source chain" value={`~$${quote.gasCostsUsd}`} />
                )}
                <Row label="Estimated time" value={`~${quote.estimatedDurationSec}s`} />
              </>
            )}
          </>
        )}
      </div>

      <div className="mt-3 rounded bg-blue-100 p-2 text-[11px] text-blue-900">
        {bypassEnabled ? (
          <>
            Testnet bypass flow:
            <ol className="ml-4 mt-1 list-decimal space-y-0.5">
              <li>Sign EIP-712 PaymentAuth</li>
              <li>POST signed auth to the local relayer</li>
              <li>Relayer pays msg.value and submits createAndPayWithAuth on {PRIMARY_CHAIN.name}</li>
            </ol>
          </>
        ) : (
          <>
            Flow:
            <ol className="ml-4 mt-1 list-decimal space-y-0.5">
              <li>Sign EIP-712 PaymentAuth</li>
              <li>Bridge funds to the relayer address</li>
              <li>Relayer submits createAndPayWithAuth on {PRIMARY_CHAIN.name}</li>
            </ol>
          </>
        )}
      </div>

      <button
        onClick={onSign}
        disabled={disabled}
        className="mt-3 rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {getSingleSigButtonLabel(status, quoting)}
      </button>

      <SingleSigStatusIndicator status={status} onRetry={onRetry} />
    </div>
  );
}

function getSingleSigButtonLabel(status: SingleSigStatus, quoting: boolean) {
  if (quoting) return "Quoting...";
  if (status.kind === "signing") return "Signing...";
  if (status.kind === "bridging") return "Bridging...";
  if (status.kind === "relaying") return "Relaying...";
  if (status.kind === "done") return "Order created ✓";
  return "Sign authorization";
}

function SingleSigStatusIndicator({
  status,
  onRetry
}: {
  status: SingleSigStatus;
  onRetry: () => void;
}) {
  if (status.kind === "idle") return null;

  if (status.kind === "signing") {
    return (
      <Panel color="blue" title="Sign authorization">
        Approve the EIP-712 PaymentAuth signature in your wallet.
      </Panel>
    );
  }

  if (status.kind === "bridging") {
    return (
      <Panel color="blue" title="Bridging funds">
        <div>{status.message ?? "Waiting for LI.FI bridge status..."}</div>
        {status.sourceTxHash && <div className="break-all font-mono">source tx: {status.sourceTxHash}</div>}
      </Panel>
    );
  }

  if (status.kind === "relaying") {
    return (
      <Panel color="blue" title="Relayer submitting order">
        {status.message ?? "Submitting createAndPayWithAuth..."}
      </Panel>
    );
  }

  if (status.kind === "done") {
    const txUrl =
      status.txHash === "0xdry-run"
        ? undefined
        : `https://sepolia.arbiscan.io/tx/${status.txHash}`;
    // V3.1 marketplace is only deployed on Arbitrum Sepolia (chainId 421614)
    // — the relayer enforces this. Hardcoding the chainId in the link is
    // fine until V3.1 ships to another chain.
    const orderUrl = `/v3_1/orders/${status.orderId.toString()}?chainId=421614`;
    return (
      <Panel color="emerald" title={`✓ Order ${status.orderId.toString()} created`}>
        <div>Order created on Arbitrum Sepolia.</div>
        <a
          href={orderUrl}
          className="mt-1 block font-semibold underline"
        >
          View V3.1 order →
        </a>
        {txUrl ? (
          <a
            href={txUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-0.5 block break-all font-mono underline"
          >
            Tx: {status.txHash}
          </a>
        ) : (
          <div className="mt-0.5 break-all font-mono">Tx: {status.txHash}</div>
        )}
      </Panel>
    );
  }

  return (
    <div className="mt-3 rounded bg-red-50 p-2 text-xs text-red-800">
      <div className="font-semibold">Single-sig pay failed</div>
      <div className="mt-0.5 break-words">{status.error}</div>
      <button
        type="button"
        onClick={onRetry}
        className="mt-2 rounded bg-red-600 px-2 py-1 text-xs text-white hover:bg-red-700"
      >
        Retry {status.step}
      </button>
    </div>
  );
}

function getBridgeButtonLabel(status: BridgeStatus) {
  if (status.kind === "starting") return "Starting...";
  if (status.kind === "running") return "Bridging...";
  if (status.kind === "complete") return "Bridged ✓";
  return "Bridge & Pay →";
}

function BridgeProgressIndicator({ status }: { status: BridgeStatus }) {
  if (status.kind === "idle") return null;

  if (status.kind === "starting") {
    return (
      <div className="mt-3 rounded bg-blue-50 p-2 text-xs text-blue-800">
        Starting bridge transaction...
      </div>
    );
  }

  if (status.kind === "running") {
    return (
      <div className="mt-3 rounded bg-blue-50 p-2 text-xs text-blue-800">
        <div className="font-semibold">Bridging in progress</div>
        {status.stepName && <div className="mt-0.5">Step: {status.stepName}</div>}
        {status.message && <div className="mt-0.5">{status.message}</div>}
      </div>
    );
  }

  if (status.kind === "complete") {
    return (
      <div className="mt-3 rounded bg-emerald-50 p-2 text-xs text-emerald-800">
        <div className="font-semibold">✓ Bridge complete</div>
        {status.bridgeTxHash && status.bridgeTxHash !== "0xdry-run" && (
          <div className="mt-0.5 break-all font-mono">tx: {status.bridgeTxHash}</div>
        )}
        {status.bridgeTxHash === "0xdry-run" && (
          <div className="mt-0.5">(Dry run - no funds were moved.)</div>
        )}
        <div className="mt-0.5">
          Funds now on {PRIMARY_CHAIN.name}. Sign payment to complete order.
        </div>
      </div>
    );
  }

  if (status.kind === "failed") {
    return (
      <div className="mt-3 rounded bg-red-50 p-2 text-xs text-red-800">
        <div className="font-semibold">Bridge failed</div>
        <div className="mt-0.5 break-words">{status.error}</div>
      </div>
    );
  }

  return null;
}

function PaymentStatusIndicator({ status }: { status: PaymentStatus }) {
  if (status.kind === "idle") return null;

  if (status.kind === "switching") {
    return (
      <Panel color="blue" title="Switching network...">
        Approve the network switch in your wallet.
      </Panel>
    );
  }
  if (status.kind === "signing") {
    return (
      <Panel color="blue" title="Confirm payment in wallet...">
        Sign the createAndPay transaction.
      </Panel>
    );
  }
  if (status.kind === "confirming") {
    return (
      <Panel color="blue" title="Confirming on-chain...">
        Waiting for block confirmation.
      </Panel>
    );
  }
  if (status.kind === "done") {
    return (
      <Panel color="emerald" title={`✓ Order ${status.orderId.toString()} created`}>
        <div className="break-all font-mono">tx: {status.txHash}</div>
      </Panel>
    );
  }
  if (status.kind === "failed") {
    return (
      <Panel color="red" title="Payment failed">
        {status.error}
      </Panel>
    );
  }

  return null;
}

function Panel({
  color,
  title,
  children
}: {
  color: "blue" | "emerald" | "red";
  title: string;
  children: React.ReactNode;
}) {
  const cls = {
    blue: "bg-blue-50 text-blue-800",
    emerald: "bg-emerald-50 text-emerald-800",
    red: "bg-red-50 text-red-800"
  }[color];

  return (
    <div className={`mt-2 rounded ${cls} p-2 text-xs`}>
      <div className="font-semibold">{title}</div>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 text-amber-900">
      <span className="text-amber-700">{label}:</span>
      <span className="break-all text-right font-mono">{value}</span>
    </div>
  );
}

function getRouteTool(quote: CrossChainQuote) {
  return (quote.raw.steps?.[0] as { tool?: string } | undefined)?.tool;
}

function findRouteTxHash(route: { steps?: unknown[] }) {
  for (const step of route.steps ?? []) {
    const execution = (step as RouteStepWithExecution).execution;
    const txHash = execution?.process?.find((process) => process.txHash)?.txHash;
    if (txHash) return txHash;
  }
  return undefined;
}
