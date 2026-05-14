"use client";

import { useEffect, useState } from "react";
import { formatEther, type Address } from "viem";
import { useAccount, useChainId, usePublicClient, useWriteContract } from "wagmi";

import { PRIMARY_CHAIN, PRIMARY_CHAIN_ID, isPrimaryChain } from "@/lib/chains";
import { getActiveMarketplace } from "@/lib/contracts";
import { executeBridge, getCrossChainQuote, type CrossChainQuote } from "@/lib/lifi";
import { findCreatedOrderId } from "@/lib/orderEvents";
import { useEnsureChain } from "@/lib/useEnsureChain";

const NATIVE = "0x0000000000000000000000000000000000000000" as `0x${string}`;

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

  const [quote, setQuote] = useState<CrossChainQuote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState<string | undefined>();
  const [status, setStatus] = useState("Ready");
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus>({ kind: "idle" });
  const [paymentStatus, setPaymentStatus] = useState<PaymentStatus>({ kind: "idle" });
  const fullPurchaseMode = seller !== undefined && productId !== undefined;

  useEffect(() => {
    if (onPrimary || !isConnected || !address || !chainId) {
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

    getCrossChainQuote({
      fromChainId: chainId,
      fromToken: NATIVE,
      fromAmount: amountWei.toString(),
      fromAddress: address,
      toChainId: PRIMARY_CHAIN_ID,
      toToken: NATIVE
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
  }, [onPrimary, isConnected, address, chainId, amountWei]);

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

      {onPrimary ? (
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
