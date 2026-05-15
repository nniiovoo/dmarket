"use client";

// Left sidebar of the /messages page. Lists the user's conversations with
// counterparty avatar, last message preview, relative time, and an unread
// badge. Clicking a row updates the ?id= query param so the right pane
// switches threads.

import { useQuery } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";

import { fetchConversations, type ConversationSummary } from "@/lib/api/messages";

const POLL_INTERVAL_MS = 15_000;

export function ConversationList({ activeId }: { activeId: string | undefined }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const query = useQuery({
    queryKey: ["conversations"],
    queryFn: fetchConversations,
    refetchInterval: POLL_INTERVAL_MS
  });

  const select = (id: string) => {
    const params = new URLSearchParams(searchParams);
    params.set("id", id);
    router.replace(`/messages?${params.toString()}`);
  };

  if (query.isPending) {
    return <SidebarShell><div className="p-4 text-sm text-slate-500">Loading…</div></SidebarShell>;
  }
  if (query.isError) {
    return (
      <SidebarShell>
        <div className="p-4 text-sm text-red-600">
          Failed to load: {query.error instanceof Error ? query.error.message : "unknown"}
        </div>
      </SidebarShell>
    );
  }

  const conversations = query.data?.conversations ?? [];

  if (conversations.length === 0) {
    return (
      <SidebarShell>
        <div className="p-6 text-sm text-slate-500">
          <p className="font-medium text-slate-700">No conversations yet</p>
          <p className="mt-1">
            Open a product and tap “Contact seller” to start one — or wait for someone to reach
            out.
          </p>
        </div>
      </SidebarShell>
    );
  }

  return (
    <SidebarShell>
      <ul className="divide-y divide-slate-100">
        {conversations.map((c) => (
          <ConversationRow
            key={c.id}
            conversation={c}
            isActive={c.id === activeId}
            onSelect={() => select(c.id)}
          />
        ))}
      </ul>
    </SidebarShell>
  );
}

function SidebarShell({ children }: { children: React.ReactNode }) {
  return (
    <aside className="flex h-full min-h-[480px] w-full max-w-sm flex-col overflow-y-auto border-r border-slate-200 bg-white">
      <div className="border-b border-slate-200 px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-700">Conversations</h2>
      </div>
      <div className="flex-1 overflow-y-auto">{children}</div>
    </aside>
  );
}

function ConversationRow({
  conversation: c,
  isActive,
  onSelect
}: {
  conversation: ConversationSummary;
  isActive: boolean;
  onSelect: () => void;
}) {
  const counterpartyShort = `${c.counterparty.slice(0, 6)}…${c.counterparty.slice(-4)}`;
  const preview = c.lastMessage?.bodyPreview || (c.lastMessage?.hasAttachment ? "📎 image" : "");
  const previewPrefix = c.lastMessage?.mine ? "You: " : "";

  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={`flex w-full items-start gap-3 px-4 py-3 text-left transition hover:bg-slate-50 ${
          isActive ? "bg-blue-50/60" : ""
        }`}
      >
        <Avatar address={c.counterparty} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate font-mono text-sm text-slate-700">{counterpartyShort}</span>
            <span className="shrink-0 text-[11px] text-slate-400">
              {c.lastMessage ? formatRelative(c.lastMessage.createdAt) : "—"}
            </span>
          </div>
          <div className="mt-0.5 flex items-center justify-between gap-2">
            <span className="truncate text-xs text-slate-500">
              {previewPrefix}{preview || <em className="italic">No preview</em>}
            </span>
            {c.unreadCount > 0 ? (
              <span className="ml-2 inline-flex min-w-[20px] shrink-0 items-center justify-center rounded-full bg-red-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                {c.unreadCount}
              </span>
            ) : null}
          </div>
        </div>
      </button>
    </li>
  );
}

// Tiny deterministic gradient avatar derived from the address. Doesn't try
// to look great — just gives the eye a stable anchor when scanning the list.
export function Avatar({ address, size = 36 }: { address: string; size?: number }) {
  const h1 = parseInt(address.slice(2, 6), 16) % 360;
  const h2 = parseInt(address.slice(-4), 16) % 360;
  const style: React.CSSProperties = {
    background: `linear-gradient(135deg, hsl(${h1} 70% 55%), hsl(${h2} 70% 45%))`,
    width: size,
    height: size,
    fontSize: size * 0.32
  };
  return (
    <div
      className="grid shrink-0 place-items-center rounded-full text-white shadow-inner"
      style={style}
      aria-hidden="true"
    >
      <span className="font-semibold">
        {address.slice(2, 4).toUpperCase()}
      </span>
    </div>
  );
}

function formatRelative(iso: string) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const deltaSec = Math.floor((Date.now() - then) / 1000);
  if (deltaSec < 5) return "just now";
  if (deltaSec < 60) return `${deltaSec}s`;
  const min = Math.floor(deltaSec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  return new Date(then).toLocaleDateString();
}
