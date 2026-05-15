"use client";

// User-facing inbox: every order the connected wallet participates in,
// each with its most recent chat snippet + unread count. Clicking a row
// drops the user back into the order detail page (V3 or V3.1 path).

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";

import { Card, EmptyState, SkeletonLine } from "@/components/Card";
import { fetchInbox, type InboxItem } from "@/lib/api/inbox";
import { useSiweAuth } from "@/lib/useSiweAuth";

const POLL_INTERVAL_MS = 15_000;

export default function InboxPage() {
  const siwe = useSiweAuth();
  const enabled = siwe.sessionAddress !== null;

  const inboxQuery = useQuery({
    queryKey: ["inbox", siwe.sessionAddress ?? ""],
    queryFn: fetchInbox,
    enabled,
    refetchInterval: enabled ? POLL_INTERVAL_MS : false
  });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-slate-950">Your conversations</h1>

      {!enabled ? (
        <EmptyState
          title="Sign in required"
          body="Sign in with your wallet to view your inbox."
        />
      ) : inboxQuery.isPending ? (
        <Card>
          <SkeletonLine />
          <SkeletonLine className="mt-2 w-2/3" />
          <SkeletonLine className="mt-2 w-1/2" />
        </Card>
      ) : inboxQuery.isError ? (
        <EmptyState
          title="Inbox unavailable"
          body={inboxQuery.error instanceof Error ? inboxQuery.error.message : "Failed to load inbox"}
        />
      ) : (inboxQuery.data?.inbox.length ?? 0) === 0 ? (
        <EmptyState
          title="No conversations yet"
          body="Buy or list something to start chatting."
        />
      ) : (
        <ul className="space-y-2">
          {inboxQuery.data!.inbox.map((item) => (
            <InboxRow key={threadKey(item)} item={item} />
          ))}
        </ul>
      )}
    </div>
  );
}

function threadKey(item: InboxItem) {
  return `${item.marketplaceVersion}:${item.chainId}:${item.onChainOrderId}`;
}

function orderHref(item: InboxItem) {
  // V3 and V3.1 use different route shapes — match what each detail page
  // already serves.
  return item.marketplaceVersion === "v3.1"
    ? `/v3_1/orders/${item.onChainOrderId}?chainId=${item.chainId}`
    : `/orders/${item.onChainOrderId}?chainId=${item.chainId}`;
}

function InboxRow({ item }: { item: InboxItem }) {
  const previewText = item.lastMessage?.bodyPreview ?? "No messages yet";
  const previewMuted = item.lastMessage === null;
  const counterpartyShort = `${item.counterparty.slice(0, 6)}…${item.counterparty.slice(-4)}`;

  return (
    <li>
      <Link
        href={orderHref(item)}
        className="flex items-stretch gap-4 rounded-lg border border-slate-200 bg-white p-4 hover:border-slate-300 hover:bg-slate-50"
      >
        <div className="flex w-32 shrink-0 flex-col gap-1">
          <span className="font-mono text-sm text-slate-700">{counterpartyShort}</span>
          <span className="inline-flex w-fit items-center rounded bg-slate-100 px-1.5 py-0.5 text-[11px] uppercase tracking-wide text-slate-600">
            {item.counterpartyRole}
          </span>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm text-slate-700">
            <span className="font-medium">
              {item.marketplaceVersion === "v3.1" ? "V3.1 Order" : "Order"} #{item.onChainOrderId}
            </span>
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-700">
              {item.orderStatus}
            </span>
            <span className="text-xs text-slate-400">chain {item.chainId}</span>
          </div>
          <p
            className={`mt-1 truncate text-sm ${previewMuted ? "italic text-slate-400" : "text-slate-600"}`}
            title={item.lastMessage?.bodyPreview}
          >
            {item.lastMessage?.hasAttachment && !item.lastMessage.bodyPreview.startsWith("📎") ? "📎 " : ""}
            {previewText}
          </p>
        </div>

        <div className="flex w-24 shrink-0 flex-col items-end justify-between gap-2 text-right">
          <span className="text-xs text-slate-500">
            {item.lastMessage ? formatRelative(item.lastMessage.createdAt) : "—"}
          </span>
          {item.unreadCount > 0 ? (
            <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-red-600 px-1.5 py-0.5 text-xs font-semibold text-white">
              {item.unreadCount}
            </span>
          ) : null}
        </div>
      </Link>
    </li>
  );
}

// Lightweight relative time formatter — no external deps. Re-renders on
// page poll, so the labels age naturally as the inbox refreshes.
function formatRelative(iso: string) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const deltaSec = Math.floor((Date.now() - then) / 1000);
  if (deltaSec < 5) return "just now";
  if (deltaSec < 60) return `${deltaSec}s ago`;
  const min = Math.floor(deltaSec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(then).toLocaleDateString();
}
