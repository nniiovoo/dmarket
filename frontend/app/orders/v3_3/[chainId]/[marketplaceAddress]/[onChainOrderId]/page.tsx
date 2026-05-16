"use client";

import Link from "next/link";
import { notFound, useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { formatEther, formatUnits, type Address } from "viem";

import { Card, EmptyState, SkeletonLine } from "@/components/Card";
import { V3_3KlerosSection } from "@/components/orders/V3_3KlerosSection";
import { PRIMARY_CHAIN_ID } from "@/lib/chains";
import { getAcceptedTokens } from "@/lib/contractsV3_2";
import { getV3_3KlerosAdapterAddress } from "@/lib/contractsV3_3";
import { useOrderRole } from "@/lib/v3_2/useOrderRole";

const NATIVE = "0x0000000000000000000000000000000000000000";
const ARBISCAN_TX_BASE = "https://sepolia.arbiscan.io/tx";
const ARBISCAN_ADDRESS_BASE = "https://sepolia.arbiscan.io/address";

interface V3_3OrderResponse {
  chainId: number;
  marketplaceAddress: string;
  onChainOrderId: string;
  buyer: string;
  seller: string;
  shopId: number;
  paymentToken: string;
  productId: string;
  amount: string;
  status: string;
  statusCode: number;
  createdAt: string;
  paidAt: string | null;
  shippedAt: string | null;
  completedAt: string | null;
  disputedAt: string | null;
  feeAmount: string | null;
  sellerAmount: string | null;
  lastEventBlock: string;
  lastEventTxHash: string;
  lastSyncedAt: string;
}

function shortAddress(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function formatAmount(amount: string, paymentToken: string): string {
  const big = BigInt(amount);
  if (paymentToken.toLowerCase() === NATIVE) return `${formatEther(big)} ETH`;
  const meta = getAcceptedTokens(PRIMARY_CHAIN_ID).find(
    (t) => t.address.toLowerCase() === paymentToken.toLowerCase()
  );
  if (meta) return `${formatUnits(big, meta.decimals)} ${meta.symbol}`;
  return `${big.toString()} base units`;
}

function fmtIso(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

export default function V3_3OrderPage() {
  const params = useParams<{
    chainId: string;
    marketplaceAddress: string;
    onChainOrderId: string;
  }>();

  const chainId = Number(params.chainId);
  const marketplaceAddress = params.marketplaceAddress;
  const onChainOrderId = params.onChainOrderId;
  const invalid =
    !Number.isInteger(chainId) ||
    chainId <= 0 ||
    !/^0x[0-9a-fA-F]{40}$/.test(marketplaceAddress) ||
    !/^\d+$/.test(onChainOrderId);

  const [order, setOrder] = useState<V3_3OrderResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [missing, setMissing] = useState(false);

  // Hook must be called unconditionally. Pass zero-address fallbacks when
  // the order hasn't loaded yet; the hook returns 'observer' in that case,
  // which is fine because the Kleros section only renders for Disputed
  // orders below (and Disputed implies `order` is non-null here).
  const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as Address;
  const { role } = useOrderRole({
    buyer: (order?.buyer ?? ZERO_ADDR) as Address,
    seller: (order?.seller ?? ZERO_ADDR) as Address
  });
  const klerosAdapterAddress = getV3_3KlerosAdapterAddress(chainId);

  useEffect(() => {
    if (invalid) return;
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(undefined);
      setMissing(false);
      try {
        const res = await fetch(
          `/api/orders/v3_3/${chainId}/${marketplaceAddress}/${onChainOrderId}`
        );
        if (cancelled) return;
        if (res.status === 404) {
          setMissing(true);
          return;
        }
        if (!res.ok) {
          throw new Error(`API returned ${res.status}`);
        }
        const body = (await res.json()) as V3_3OrderResponse;
        if (cancelled) return;
        setOrder(body);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [chainId, marketplaceAddress, onChainOrderId, invalid]);

  if (invalid) notFound();
  if (missing) notFound();

  return (
    <main className="mx-auto max-w-3xl px-4 py-6">
      <div className="mb-4">
        <Link href="/portfolio" className="text-sm text-blue-600 hover:underline">
          ← Back to portfolio
        </Link>
      </div>

      <h1 className="text-2xl font-semibold text-slate-950">v3.3 Order</h1>

      {error ? (
        <Card>
          <EmptyState title="Couldn't load this order" body={error} />
        </Card>
      ) : loading || !order ? (
        <div className="mt-4 space-y-3">
          <SkeletonLine className="h-6 w-1/2" />
          <SkeletonLine />
          <SkeletonLine className="w-3/4" />
        </div>
      ) : (
        <div className="mt-4 space-y-5">
          <Card>
            <div className="grid gap-y-2 gap-x-6 text-sm sm:grid-cols-3">
              <Field label="Order id">#{order.onChainOrderId}</Field>
              <Field label="Shop">
                <Link href={`/shops/${order.shopId}`} className="text-blue-600 hover:underline">
                  #{order.shopId}
                </Link>
              </Field>
              <Field label="Status">
                <StatusPill status={order.status} />
              </Field>
              <Field label="Amount">
                <span className="font-mono">{formatAmount(order.amount, order.paymentToken)}</span>
              </Field>
              <Field label="Payment token">
                {order.paymentToken.toLowerCase() === NATIVE
                  ? "ETH (native)"
                  : shortAddress(order.paymentToken)}
              </Field>
              <Field label="Product id">{order.productId}</Field>
              <Field label="Buyer">
                <Link
                  href={`${ARBISCAN_ADDRESS_BASE}/${order.buyer}`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-blue-600 hover:underline"
                >
                  {shortAddress(order.buyer)}
                </Link>
              </Field>
              <Field label="Seller">
                <Link
                  href={`${ARBISCAN_ADDRESS_BASE}/${order.seller}`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-blue-600 hover:underline"
                >
                  {shortAddress(order.seller)}
                </Link>
              </Field>
              <Field label="Marketplace">
                <Link
                  href={`${ARBISCAN_ADDRESS_BASE}/${order.marketplaceAddress}`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-blue-600 hover:underline"
                >
                  {shortAddress(order.marketplaceAddress)}
                </Link>
              </Field>
            </div>
          </Card>

          {order.status === "Disputed" && klerosAdapterAddress ? (
            <V3_3KlerosSection
              order={{ onChainOrderId: order.onChainOrderId }}
              chainId={chainId}
              adapterAddress={klerosAdapterAddress}
              role={role}
            />
          ) : null}

          <Card title="Timeline">
            <ul className="space-y-1 text-sm">
              <TimelineRow label="Created" iso={order.createdAt} />
              <TimelineRow label="Paid" iso={order.paidAt} />
              <TimelineRow label="Shipped" iso={order.shippedAt} />
              <TimelineRow label="Completed" iso={order.completedAt} />
              <TimelineRow label="Disputed" iso={order.disputedAt} />
            </ul>
          </Card>

          {order.feeAmount !== null || order.sellerAmount !== null ? (
            <Card title="Revenue split">
              <div className="grid gap-y-1 gap-x-6 text-sm sm:grid-cols-2">
                <Field label="Seller receives">
                  <span className="font-mono">
                    {order.sellerAmount
                      ? formatAmount(order.sellerAmount, order.paymentToken)
                      : "—"}
                  </span>
                </Field>
                <Field label="Platform fee (routed to distributor)">
                  <span className="font-mono">
                    {order.feeAmount
                      ? formatAmount(order.feeAmount, order.paymentToken)
                      : "—"}
                  </span>
                </Field>
              </div>
              <p className="mt-2 text-xs text-slate-500">
                Fee accrues pro-rata to current shareholders of shop #{order.shopId}.
                Shareholders can claim from the shop&apos;s detail page.
              </p>
            </Card>
          ) : null}

          <Card title="Last event">
            <p className="text-sm text-slate-700">
              block {order.lastEventBlock}{" "}
              <Link
                href={`${ARBISCAN_TX_BASE}/${order.lastEventTxHash}`}
                target="_blank"
                rel="noreferrer"
                className="text-blue-600 hover:underline"
              >
                tx ↗
              </Link>
            </p>
            <p className="text-xs text-slate-500">
              Indexer last synced at {fmtIso(order.lastSyncedAt)}.
            </p>
          </Card>
        </div>
      )}
    </main>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <div className="text-slate-900">{children}</div>
    </div>
  );
}

function TimelineRow({ label, iso }: { label: string; iso: string | null }) {
  return (
    <li className="flex items-center justify-between">
      <span className="text-slate-600">{label}</span>
      <span className={iso ? "font-mono text-slate-900" : "text-slate-400"}>{fmtIso(iso)}</span>
    </li>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === "Completed"
      ? "bg-emerald-100 text-emerald-900"
      : status === "Refunded" || status === "Cancelled"
      ? "bg-slate-100 text-slate-600"
      : status === "Disputed"
      ? "bg-red-100 text-red-900"
      : "bg-blue-100 text-blue-900";
  return (
    <span className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${tone}`}>
      {status}
    </span>
  );
}
