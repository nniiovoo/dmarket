"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { formatEther } from "viem";

import { Card, EmptyState, SkeletonLine } from "@/components/Card";
import { V3_1EvidenceSection } from "@/components/evidence/V3_1EvidenceSection";
import { getExplorerAddressUrl } from "@/lib/chains";
import type { ApiOrder, OrderStatusName } from "@/lib/orders";

// Minimum viable V3.1 order view. Dispute evidence is wired up (via the
// shared SubmitEvidenceDialog + V3_1EvidenceSection); other widgets — Kleros
// escalation, oracle, indexer history — can be folded in later when V3.1
// gets its own adapter / indexer. At that point, factor this and the V3
// order page into a shared <OrderDetailPanel /> component.

type V3_1Order = {
  source: "indexer" | "chain";
  chainId: number;
  onChainOrderId: string;
  buyer: string;
  seller: string;
  productId: string;
  amountWei: string;
  status: string;
  createdAt: string | null;
  paidAt: string | null;
  shippedAt: string | null;
  completedAt: string | null;
  refundedAt: string | null;
  disputedAt: string | null;
  // Shipping fields surfaced by the indexer; the on-chain fallback returns
  // nulls. Used to fill out the ApiOrder shape that <V3_1EvidenceSection />
  // and its child <SubmitEvidenceDialog /> consume.
  carrier?: string | null;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  shippingNote?: string | null;
  shippingUpdatedAt?: string | null;
};

function toApiOrder(o: V3_1Order): ApiOrder {
  return {
    chainId: o.chainId,
    onChainOrderId: o.onChainOrderId,
    buyer: o.buyer,
    seller: o.seller,
    productId: o.productId,
    amountWei: o.amountWei,
    status: o.status as OrderStatusName,
    createdAt: o.createdAt,
    paidAt: o.paidAt,
    shippedAt: o.shippedAt,
    completedAt: o.completedAt,
    refundedAt: o.refundedAt,
    disputedAt: o.disputedAt,
    carrier: o.carrier ?? null,
    trackingNumber: o.trackingNumber ?? null,
    trackingUrl: o.trackingUrl ?? null,
    shippingNote: o.shippingNote ?? null,
    shippingUpdatedAt: o.shippingUpdatedAt ?? null,
    lastTxHash: null,
    product: null,
    marketplaceVersion: "v3.1"
  };
}

function shortAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatTime(iso: string | null) {
  return iso ? new Date(iso).toLocaleString() : "—";
}

export default function V3_1OrderDetailPage() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const chainIdParam = searchParams.get("chainId");

  const [order, setOrder] = useState<V3_1Order | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);

  const orderId = params.id;
  const chainId = chainIdParam ? Number(chainIdParam) : NaN;

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!orderId || !Number.isInteger(chainId) || chainId <= 0) {
        setError("Missing or invalid ?chainId=… query string");
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(undefined);

      try {
        // Parse the response body in two steps. response.json() throws a
        // SyntaxError on empty/non-JSON bodies (the classic "Unexpected end
        // of JSON input" UI bug when an API route 500s before sending a
        // body). Read the text first so we can show the user something
        // useful in that degenerate case, even if some endpoint is missing
        // the withErrorBoundary wrapper.
        const response = await fetch(`/api/v3_1/orders/${orderId}?chainId=${chainId}`);
        const rawBody = await response.text();
        let parsed: V3_1Order | { error?: string } | null = null;
        try {
          parsed = rawBody.length > 0 ? (JSON.parse(rawBody) as V3_1Order | { error?: string }) : null;
        } catch {
          if (!cancelled) {
            const snippet = rawBody.slice(0, 200);
            setError(
              `Server returned non-JSON (status ${response.status}): ${snippet || "(empty body)"}`
            );
          }
          return;
        }

        if (cancelled) return;

        if (!response.ok || (parsed && typeof parsed === "object" && "error" in parsed && parsed.error)) {
          const message = parsed && "error" in parsed ? parsed.error : null;
          setError(message ?? `Order not found (status ${response.status})`);
        } else if (parsed) {
          setOrder(parsed as V3_1Order);
        } else {
          setError(`Empty response from server (status ${response.status})`);
        }
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : "Failed to load order");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [orderId, chainId]);

  return (
    <div className="space-y-6">
      <div>
        <Link href="/" className="text-sm text-blue-700 underline">
          Back home
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-slate-950">
          V3.1 Order #{orderId}
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Chain {Number.isFinite(chainId) ? chainId : "—"}
          {order ? ` · ${order.source === "indexer" ? "from indexer" : "live on-chain read"}` : ""}
        </p>
      </div>

      {loading ? (
        <Card>
          <SkeletonLine />
          <SkeletonLine className="mt-2 w-2/3" />
        </Card>
      ) : error ? (
        <EmptyState title="Order unavailable" body={error} />
      ) : order ? (
        <>
          <Card title="Summary">
            <div className="flex flex-wrap items-center gap-3 text-sm text-slate-600">
              <span className="rounded bg-slate-100 px-2 py-0.5 font-medium text-slate-800">
                {order.status}
              </span>
              <span>
                <span className="font-mono">{formatEther(BigInt(order.amountWei))}</span> ETH
              </span>
              <span>Product #{order.productId}</span>
            </div>
          </Card>

          <Card title="Parties">
            <div className="grid gap-3 text-sm md:grid-cols-2">
              <Info
                label="Buyer"
                value={shortAddress(order.buyer)}
                href={getExplorerAddressUrl(order.chainId, order.buyer)}
              />
              <Info
                label="Seller"
                value={shortAddress(order.seller)}
                href={getExplorerAddressUrl(order.chainId, order.seller)}
              />
            </div>
          </Card>

          <Card title="Timeline">
            <div className="grid gap-3 text-sm md:grid-cols-2">
              <Info label="Created" value={formatTime(order.createdAt)} />
              <Info label="Paid" value={formatTime(order.paidAt)} />
              <Info label="Shipped" value={formatTime(order.shippedAt)} />
              <Info label="Completed" value={formatTime(order.completedAt)} />
              {order.disputedAt ? <Info label="Disputed" value={formatTime(order.disputedAt)} /> : null}
              {order.refundedAt ? <Info label="Refunded" value={formatTime(order.refundedAt)} /> : null}
            </div>
          </Card>

          <V3_1EvidenceSection order={toApiOrder(order)} />
        </>
      ) : null}
    </div>
  );
}

function Info({ label, value, href }: { label: string; value: string; href?: string }) {
  return (
    <div className="rounded-md bg-slate-50 p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      {href ? (
        <a href={href} target="_blank" rel="noreferrer" className="mt-1 block break-all text-blue-700 underline">
          {value}
        </a>
      ) : (
        <p className="mt-1 break-all text-slate-950">{value}</p>
      )}
    </div>
  );
}
