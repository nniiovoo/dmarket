// Tiny client for the /api/inbox endpoint. Kept separate from the route's
// types so the UI can import it without dragging in node-only modules.

export type InboxItem = {
  chainId: number;
  onChainOrderId: string;
  marketplaceVersion: "v3" | "v3.1";
  counterparty: string;
  counterpartyRole: "buyer" | "seller";
  orderStatus: string;
  lastMessage: {
    senderAddress: string;
    bodyPreview: string;
    createdAt: string;
    hasAttachment: boolean;
  } | null;
  unreadCount: number;
};

export type InboxResponse = { inbox: InboxItem[] };

export async function fetchInbox(): Promise<InboxResponse> {
  const res = await fetch("/api/inbox", { credentials: "include" });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `Failed to load inbox (${res.status})`);
  }
  return (await res.json()) as InboxResponse;
}

// Convenience for the nav badge — sum of all unreadCount across the user's
// threads. Returns 0 on any failure so we never block the nav render.
export async function fetchInboxUnreadCount(): Promise<number> {
  try {
    const data = await fetchInbox();
    return data.inbox.reduce((acc, item) => acc + item.unreadCount, 0);
  } catch {
    return 0;
  }
}
