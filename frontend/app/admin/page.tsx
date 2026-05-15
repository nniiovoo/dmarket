"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAccount, useReadContract } from "wagmi";

import { V3_2AdminSection } from "@/components/admin/V3_2AdminSection";
import { Card, EmptyState, SkeletonLine } from "@/components/Card";
import { NetworkNotice } from "@/components/NetworkNotice";
import { OrderBadge } from "@/components/OrderBadge";
import { TxPanel } from "@/components/TxPanel";
import { PRIMARY_CHAIN_ID } from "@/lib/chains";
import { getActiveMarketplace, hasMarketplace } from "@/lib/contracts";
import { formatAmount, normalizeOrder, OrderStatus, sameAddress } from "@/lib/order";

const refetchInterval = 12_000;

export default function AdminPage() {
  const { address, isConnected } = useAccount();
  const active = getActiveMarketplace(PRIMARY_CHAIN_ID);
  const supported = hasMarketplace(PRIMARY_CHAIN_ID);
  const [orderIdInput, setOrderIdInput] = useState("");
  const orderId = useMemo(() => parseOrderId(orderIdInput), [orderIdInput]);

  const ownerQuery = useReadContract({
    address: active?.address,
    abi: active?.abi,
    chainId: PRIMARY_CHAIN_ID,
    functionName: "owner",
    query: { enabled: supported, refetchInterval }
  });

  const orderQuery = useReadContract({
    address: active?.address,
    abi: active?.abi,
    chainId: PRIMARY_CHAIN_ID,
    functionName: "getOrder",
    args: orderId === undefined ? undefined : [orderId],
    query: { enabled: supported && orderId !== undefined, retry: false, refetchInterval }
  });

  const owner = ownerQuery.data as string | undefined;
  const order = normalizeOrder(orderQuery.data);
  const isOwner = sameAddress(address, owner);

  function refetchAll() {
    void ownerQuery.refetch();
    void orderQuery.refetch();
  }

  // ── Blacklist state ──────────────────────────────────────────────────────────
  // TODO: long-term, call /api/auth/siwe/me and check the address against an
  // admin-list endpoint so non-owner admins (EVIDENCE_ADMIN_ADDRESSES) can also
  // see this section without being the on-chain marketplace owner.
  interface BlacklistEntry {
    address: string;
    reason: string;
    addedBy: string;
    createdAt: string;
  }

  const [blEntries, setBlEntries] = useState<BlacklistEntry[] | null>(null);
  const [blLoading, setBlLoading] = useState(false);
  const [blError, setBlError] = useState<string | null>(null);
  const [blAddr, setBlAddr] = useState("");
  const [blReason, setBlReason] = useState("");
  const [blFormError, setBlFormError] = useState<string | null>(null);
  const [blSubmitting, setBlSubmitting] = useState(false);
  const blFetchedRef = useRef(false);

  const fetchBlacklist = useCallback(async () => {
    setBlLoading(true);
    setBlError(null);
    try {
      const res = await fetch("/api/admin/blacklist", { credentials: "include" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as BlacklistEntry[];
      setBlEntries(data);
    } catch (err) {
      setBlError(err instanceof Error ? err.message : "Failed to load blacklist");
    } finally {
      setBlLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isOwner || blFetchedRef.current) return;
    blFetchedRef.current = true;
    void fetchBlacklist();
  }, [isOwner, fetchBlacklist]);

  async function handleBlacklistAdd(event: React.FormEvent) {
    event.preventDefault();
    setBlFormError(null);
    const addr = blAddr.trim();
    const reason = blReason.trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) {
      setBlFormError("Invalid Ethereum address (must be 0x + 40 hex chars).");
      return;
    }
    if (!reason) {
      setBlFormError("Reason is required.");
      return;
    }
    setBlSubmitting(true);
    try {
      const res = await fetch("/api/admin/blacklist", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: addr.toLowerCase(), reason }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setBlAddr("");
      setBlReason("");
      await fetchBlacklist();
    } catch (err) {
      setBlFormError(err instanceof Error ? err.message : "Failed to add address");
    } finally {
      setBlSubmitting(false);
    }
  }

  async function handleBlacklistRemove(entryAddress: string) {
    if (!window.confirm("Remove this address from the blacklist?")) return;
    try {
      const res = await fetch(`/api/admin/blacklist/${encodeURIComponent(entryAddress)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      await fetchBlacklist();
    } catch (err) {
      setBlError(err instanceof Error ? err.message : "Failed to remove address");
    }
  }

  function truncate(value: string, len: number) {
    return value.length > len ? value.slice(0, len) + "…" : value;
  }

  function shortAddr(value: string) {
    return value.length >= 10 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
  }

  return (
    <div className="space-y-6">
      <NetworkNotice />
      <div>
        <h1 className="text-2xl font-semibold text-slate-950">Admin</h1>
        <p className="mt-2 text-slate-600">Owner tools for disputes and emergency refunds.</p>
      </div>

      <Card title="Owner status">
        {!isConnected ? (
          <EmptyState title="Connect wallet" body="Connect the owner wallet to use admin actions." />
        ) : !supported ? (
          <EmptyState title="Configuration missing" body="Arbitrum marketplace addresses are not configured." />
        ) : ownerQuery.isLoading ? (
          <SkeletonLine className="w-1/2" />
        ) : (
          <div className="space-y-2 text-sm">
            <p>
              Owner: <span className="break-all font-medium">{owner}</span>
            </p>
            <p className={isOwner ? "text-emerald-700" : "text-amber-700"}>
              {isOwner ? "Connected wallet is owner." : "Connected wallet is not owner. Actions are disabled."}
            </p>
          </div>
        )}
      </Card>

      <Card title="Load order">
        <div className="flex gap-2">
          <input
            value={orderIdInput}
            onChange={(event) => setOrderIdInput(event.target.value)}
            placeholder="Order ID"
            className="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-2"
          />
          {orderId !== undefined ? (
            <Link href={`/orders/${orderId.toString()}`} className="rounded-md bg-slate-100 px-4 py-2 text-sm font-medium text-slate-800">
              Detail
            </Link>
          ) : null}
        </div>
      </Card>

      {orderId === undefined ? (
        <EmptyState title="Enter an order ID" body="Admin actions load after you enter a valid order ID." />
      ) : orderQuery.isLoading ? (
        <Card>
          <SkeletonLine />
          <SkeletonLine className="mt-2 w-2/3" />
        </Card>
      ) : order === undefined || orderQuery.isError ? (
        <EmptyState title="Order not found" body="This order does not exist on the selected network." />
      ) : (
        <Card title={`Order #${orderId.toString()}`} action={<OrderBadge status={order.status} />}>
          <div className="mb-4 grid gap-3 text-sm md:grid-cols-2">
            <p>
              Buyer: <span className="break-all font-medium">{order.buyer}</span>
            </p>
            <p>
              Seller: <span className="break-all font-medium">{order.seller}</span>
            </p>
            <p>Amount: {formatAmount(order.amount)} ETH / MATIC</p>
            <p>Product ID: {order.productId.toString()}</p>
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            <TxPanel
              label="Refund buyer"
              description="Resolve a disputed order by refunding buyer."
              disabled={!isOwner || order.status !== OrderStatus.Disputed}
              disabledReason={!isOwner ? "Only owner can resolve disputes." : "Order must be Disputed."}
              onConfirmed={refetchAll}
              buildTransaction={() => ({
                address: active?.address,
                abi: active?.abi,
                chainId: PRIMARY_CHAIN_ID,
                functionName: "resolveDispute",
                args: [orderId, true]
              })}
            />
            <TxPanel
              label="Release seller"
              description="Resolve a disputed order by paying seller."
              disabled={!isOwner || order.status !== OrderStatus.Disputed}
              disabledReason={!isOwner ? "Only owner can resolve disputes." : "Order must be Disputed."}
              onConfirmed={refetchAll}
              buildTransaction={() => ({
                address: active?.address,
                abi: active?.abi,
                chainId: PRIMARY_CHAIN_ID,
                functionName: "resolveDispute",
                args: [orderId, false]
              })}
            />
            <TxPanel
              label="Emergency refund"
              description="Refund buyer without requiring dispute."
              disabled={!isOwner || ![OrderStatus.Paid, OrderStatus.Shipped, OrderStatus.Disputed].includes(order.status)}
              disabledReason={!isOwner ? "Only owner can emergency refund." : "Order must have escrowed funds."}
              onConfirmed={refetchAll}
              buildTransaction={() => ({
                address: active?.address,
                abi: active?.abi,
                chainId: PRIMARY_CHAIN_ID,
                functionName: "ownerEmergencyRefund",
                args: [orderId]
              })}
            />
          </div>
        </Card>
      )}

      {isOwner && (
        <Card title="Blacklist">
          {blError && (
            <p className="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{blError}</p>
          )}

          {blLoading ? (
            <>
              <SkeletonLine />
              <SkeletonLine className="mt-2 w-2/3" />
            </>
          ) : blEntries && blEntries.length === 0 ? (
            <EmptyState title="No blacklisted addresses" body="Add an address below to block it from the platform." />
          ) : blEntries && blEntries.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
                    <th className="pb-2 pr-4">Address</th>
                    <th className="pb-2 pr-4">Reason</th>
                    <th className="pb-2 pr-4">Added by</th>
                    <th className="pb-2 pr-4">Date</th>
                    <th className="pb-2" />
                  </tr>
                </thead>
                <tbody>
                  {blEntries.map((entry) => (
                    <tr key={entry.address} className="border-b border-slate-100 last:border-0">
                      <td className="py-2 pr-4 font-mono">{shortAddr(entry.address)}</td>
                      <td className="py-2 pr-4 text-slate-700">{truncate(entry.reason, 60)}</td>
                      <td className="py-2 pr-4 font-mono text-slate-500">{shortAddr(entry.addedBy)}</td>
                      <td className="py-2 pr-4 text-slate-500">{new Date(entry.createdAt).toLocaleString()}</td>
                      <td className="py-2">
                        <button
                          onClick={() => void handleBlacklistRemove(entry.address)}
                          className="rounded bg-red-50 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-100"
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          <form onSubmit={(e) => void handleBlacklistAdd(e)} className="mt-4 space-y-2">
            {blFormError && (
              <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{blFormError}</p>
            )}
            <div className="flex gap-2">
              <input
                value={blAddr}
                onChange={(e) => setBlAddr(e.target.value)}
                placeholder="0x address"
                className="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-2 font-mono text-sm"
              />
              <input
                value={blReason}
                onChange={(e) => setBlReason(e.target.value)}
                placeholder="Reason"
                className="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
              <button
                type="submit"
                disabled={blSubmitting}
                className="rounded-md bg-slate-800 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                Add
              </button>
            </div>
          </form>
        </Card>
      )}

      {isConnected ? <V3_2AdminSection /> : null}
    </div>
  );
}

function parseOrderId(value: string) {
  try {
    const parsed = BigInt(value);
    return parsed > 0n ? parsed : undefined;
  } catch {
    return undefined;
  }
}
