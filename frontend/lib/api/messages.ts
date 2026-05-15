// Client-side fetchers for the unified messenger. Kept in lib/api so the
// nav badge can pull unread counts without dragging the full UI module in.

export type ConversationSummary = {
  id: string;
  chainId: number;
  counterparty: string;
  participantA: string;
  participantB: string;
  initialProductId: string | null;
  lastMessageAt: string;
  unreadCount: number;
  lastMessage: {
    senderAddress: string;
    bodyPreview: string;
    createdAt: string;
    hasAttachment: boolean;
    mine: boolean;
  } | null;
};

export type ConversationListResponse = {
  conversations: ConversationSummary[];
};

export type ConversationDetail = {
  id: string;
  chainId: number;
  participantA: string;
  participantB: string;
  counterparty: string;
  initialProductId: string | null;
};

export type ConversationAttachment = {
  contentType: string;
  fileName: string;
  size: number;
  url: string;
};

export type ConversationMessage = {
  id: string;
  senderAddress: string;
  body: string;
  createdAt: string;
  attachment?: ConversationAttachment;
};

export type MessageListResponse = {
  messages: ConversationMessage[];
  conversation: ConversationDetail;
};

export async function fetchConversations(): Promise<ConversationListResponse> {
  const res = await fetch("/api/conversations", { credentials: "include" });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `Failed to load conversations (${res.status})`);
  }
  return (await res.json()) as ConversationListResponse;
}

export async function fetchInboxUnreadCount(): Promise<number> {
  try {
    const data = await fetchConversations();
    return data.conversations.reduce((acc, c) => acc + c.unreadCount, 0);
  } catch {
    return 0;
  }
}

export async function fetchMessages(conversationId: string): Promise<MessageListResponse> {
  const res = await fetch(`/api/conversations/${conversationId}/messages`, {
    credentials: "include"
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `Failed to load messages (${res.status})`);
  }
  return (await res.json()) as MessageListResponse;
}

export async function startConversation(params: {
  chainId: number;
  otherParty: string;
  productId?: string;
}): Promise<{ id: string }> {
  const res = await fetch("/api/conversations", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params)
  });
  const data = (await res.json().catch(() => ({}))) as {
    conversation?: { id: string };
    error?: string;
  };
  if (!res.ok || !data.conversation) {
    throw new Error(data.error ?? `Failed to start conversation (${res.status})`);
  }
  return { id: data.conversation.id };
}
