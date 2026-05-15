"use client";

// Per-order private chat. Buyer + seller can send; platform admins (via
// authorizeForOrder) can read but the input box is hidden for them. Polls
// the server every 5 seconds — no WebSocket / SSE yet (see follow-ups).
//
// Messages may carry a single image attachment (5 MB cap, image MIME types
// only). The backend serves attachment bytes through an auth-gated
// endpoint, so the URL we render here is only useful to authorized viewers.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAccount } from "wagmi";

import { Card } from "@/components/Card";
import type { ApiOrder } from "@/lib/orders";
import { useSiweAuth } from "@/lib/useSiweAuth";

type ChatAttachment = {
  contentType: string;
  fileName: string;
  size: number;
  url: string;
};

type ChatMessage = {
  id: string;
  senderAddress: string;
  body: string;
  createdAt: string;
  attachment?: ChatAttachment;
};

type ChatListResponse = { messages: ChatMessage[] };
type ChatSendResponse = { message?: ChatMessage; error?: string };

const POLL_INTERVAL_MS = 5_000;
const MAX_BODY_CHARS = 8000;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const ALLOWED_ATTACHMENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic"
]);

export function OrderChatPanel({ order }: { order: ApiOrder }) {
  const { address: connectedAddress } = useAccount();
  const siwe = useSiweAuth();
  const queryClient = useQueryClient();

  const [draft, setDraft] = useState("");
  const [attachment, setAttachment] = useState<File | undefined>(undefined);
  const [attachmentPreview, setAttachmentPreview] = useState<string | undefined>(undefined);
  const [sendError, setSendError] = useState<string | undefined>();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);

  const buyerLower = order.buyer.toLowerCase();
  const sellerLower = order.seller.toLowerCase();
  const connectedLower = connectedAddress?.toLowerCase();
  const isParty =
    connectedLower !== undefined && (connectedLower === buyerLower || connectedLower === sellerLower);

  const queryKey = useMemo(
    () => ["chat", order.chainId, order.onChainOrderId, order.marketplaceVersion] as const,
    [order.chainId, order.onChainOrderId, order.marketplaceVersion]
  );

  // Only poll once the user has a SIWE session; the API will 401 otherwise
  // and we'd just burn requests. The UI shows a sign-in prompt below in that
  // case.
  const polling = siwe.matchesConnected;

  const chatQuery = useQuery({
    queryKey,
    queryFn: async (): Promise<ChatListResponse> => {
      const url = `/api/orders/${order.chainId}/${order.onChainOrderId}/chat?version=${encodeURIComponent(order.marketplaceVersion)}`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `Failed to load chat (${res.status})`);
      }
      return (await res.json()) as ChatListResponse;
    },
    enabled: polling,
    refetchInterval: polling ? POLL_INTERVAL_MS : false
  });

  // Generate a local preview URL for the picked attachment, and revoke it
  // when the file changes / unmounts. createObjectURL allocates a slot in
  // the document's URL store that doesn't get GC'd until you revoke it —
  // tracking the URL in state is the simplest way to ship it to the render
  // path. React 19's set-state-in-effect rule flags this, but in our case
  // the setState fires exactly once per attachment change (not a cascade),
  // so the warning isn't actionable.
  useEffect(() => {
    if (!attachment) return;
    const url = URL.createObjectURL(attachment);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAttachmentPreview(url);
    return () => {
      URL.revokeObjectURL(url);
      setAttachmentPreview(undefined);
    };
  }, [attachment]);

  const sendMutation = useMutation({
    mutationFn: async (input: { body: string; file?: File }): Promise<ChatMessage> => {
      const endpoint = `/api/orders/${order.chainId}/${order.onChainOrderId}/chat`;
      let res: Response;
      if (input.file) {
        // Multipart path. The server-side parser keys off the
        // Content-Type header starting with multipart/form-data — fetch
        // sets that automatically when the body is a FormData.
        const form = new FormData();
        form.set("version", order.marketplaceVersion);
        form.set("body", input.body);
        form.set("file", input.file);
        res = await fetch(endpoint, {
          method: "POST",
          credentials: "include",
          body: form
        });
      } else {
        res = await fetch(endpoint, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ version: order.marketplaceVersion, body: input.body })
        });
      }
      const data = (await res.json().catch(() => ({}))) as ChatSendResponse;
      if (!res.ok || !data.message) {
        throw new Error(data.error ?? `Send failed (${res.status})`);
      }
      return data.message;
    },
    onSuccess: () => {
      setDraft("");
      setAttachment(undefined);
      if (fileInputRef.current) fileInputRef.current.value = "";
      setSendError(undefined);
      void queryClient.invalidateQueries({ queryKey });
    },
    onError: (err: unknown) => {
      setSendError(err instanceof Error ? err.message : "Send failed");
    }
  });

  // Keep the view pinned to the bottom when new messages arrive. We trigger
  // off the message count rather than a deep compare — close enough for a
  // chat list.
  const messageCount = chatQuery.data?.messages.length ?? 0;
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messageCount]);

  const handleSend = useCallback(() => {
    const trimmed = draft.trim();
    if (trimmed.length === 0 && !attachment) return;
    if (sendMutation.isPending) return;
    setSendError(undefined);
    sendMutation.mutate({ body: trimmed, file: attachment });
  }, [draft, attachment, sendMutation]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Send on Enter, newline on Shift+Enter — same as most chat apps.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const pickAttachment = (file: File | undefined) => {
    setSendError(undefined);
    if (!file) {
      setAttachment(undefined);
      return;
    }
    if (!ALLOWED_ATTACHMENT_TYPES.has(file.type)) {
      setSendError(`Unsupported file type ${file.type}. Allowed: JPEG / PNG / WebP / GIF / HEIC.`);
      return;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      setSendError(`${file.name} is larger than 5 MB.`);
      return;
    }
    setAttachment(file);
  };

  return (
    <Card title="Order chat (private to buyer + seller)">
      <div
        ref={scrollerRef}
        className="max-h-[360px] min-h-[160px] overflow-y-auto rounded-md border border-slate-200 bg-slate-50 p-3"
      >
        <ChatBody
          query={chatQuery}
          buyerLower={buyerLower}
          sellerLower={sellerLower}
          connectedLower={connectedLower}
          polling={polling}
        />
      </div>

      <ChatComposer
        connected={connectedAddress !== undefined}
        siweReady={siwe.matchesConnected}
        siweStatus={siwe.status}
        onSignIn={() => void siwe.signIn()}
        isParty={isParty}
        draft={draft}
        onDraftChange={setDraft}
        onSend={handleSend}
        onKeyDown={onKeyDown}
        sending={sendMutation.isPending}
        sendError={sendError}
        attachment={attachment}
        attachmentPreview={attachmentPreview}
        onPickAttachment={pickAttachment}
        fileInputRef={fileInputRef}
      />
    </Card>
  );
}

// ---- internals ----

function ChatBody({
  query,
  buyerLower,
  sellerLower,
  connectedLower,
  polling
}: {
  query: ReturnType<typeof useQuery<ChatListResponse>>;
  buyerLower: string;
  sellerLower: string;
  connectedLower: string | undefined;
  polling: boolean;
}) {
  if (!polling) {
    return <p className="text-sm text-slate-500">Sign in to load messages.</p>;
  }
  if (query.isPending) {
    return <p className="text-sm text-slate-500">Loading messages…</p>;
  }
  if (query.isError) {
    const message = query.error instanceof Error ? query.error.message : "Failed to load chat";
    return <p className="text-sm text-red-600">Failed to load chat: {message}</p>;
  }

  const messages = query.data?.messages ?? [];
  if (messages.length === 0) {
    return <p className="text-sm text-slate-500">No messages yet. Start the conversation.</p>;
  }

  return (
    <ul className="space-y-3">
      {messages.map((m) => (
        <ChatBubble
          key={m.id}
          message={m}
          buyerLower={buyerLower}
          sellerLower={sellerLower}
          connectedLower={connectedLower}
        />
      ))}
    </ul>
  );
}

function ChatBubble({
  message,
  buyerLower,
  sellerLower,
  connectedLower
}: {
  message: ChatMessage;
  buyerLower: string;
  sellerLower: string;
  connectedLower: string | undefined;
}) {
  const sender = message.senderAddress.toLowerCase();
  const mine = connectedLower !== undefined && sender === connectedLower;

  let label: string;
  if (mine) {
    label = "You";
  } else if (sender === buyerLower) {
    label = "Buyer";
  } else if (sender === sellerLower) {
    label = "Seller";
  } else {
    label = `${sender.slice(0, 6)}…${sender.slice(-4)}`;
  }

  const hasBody = message.body.length > 0;

  return (
    <li className={`flex ${mine ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[80%] ${mine ? "items-end" : "items-start"} flex flex-col`}>
        <div className="flex items-baseline gap-2 px-1 text-xs text-slate-500">
          <span className="font-medium text-slate-700">{label}</span>
          <time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleString()}</time>
        </div>
        {message.attachment ? (
          <a
            href={message.attachment.url}
            target="_blank"
            rel="noreferrer"
            className="mt-1 block"
            title={`${message.attachment.fileName} · ${formatBytes(message.attachment.size)}`}
          >
            {/* Auth-gated URL — the browser will follow with the SIWE
                cookie. eslint-disable for the next/image rule: these are
                private dynamically-served bytes, not optimisable static
                assets. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={message.attachment.url}
              alt={message.attachment.fileName}
              className="max-h-[200px] max-w-[200px] rounded border border-slate-200 bg-white object-contain"
            />
          </a>
        ) : null}
        {hasBody ? (
          <div
            className={`mt-1 whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm ${
              mine ? "bg-blue-600 text-white" : "bg-white text-slate-900 border border-slate-200"
            }`}
          >
            {message.body}
          </div>
        ) : null}
        {message.attachment ? (
          <div className="mt-1 px-1 text-[11px] text-slate-500">
            {message.attachment.fileName} · {formatBytes(message.attachment.size)}
          </div>
        ) : null}
      </div>
    </li>
  );
}

function ChatComposer({
  connected,
  siweReady,
  siweStatus,
  onSignIn,
  isParty,
  draft,
  onDraftChange,
  onSend,
  onKeyDown,
  sending,
  sendError,
  attachment,
  attachmentPreview,
  onPickAttachment,
  fileInputRef
}: {
  connected: boolean;
  siweReady: boolean;
  siweStatus: ReturnType<typeof useSiweAuth>["status"];
  onSignIn: () => void;
  isParty: boolean;
  draft: string;
  onDraftChange: (v: string) => void;
  onSend: () => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  sending: boolean;
  sendError: string | undefined;
  attachment: File | undefined;
  attachmentPreview: string | undefined;
  onPickAttachment: (f: File | undefined) => void;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
}) {
  if (!connected) {
    return (
      <div className="mt-3 rounded bg-amber-50 p-2 text-sm text-amber-800">
        Connect your wallet to chat.
      </div>
    );
  }
  if (!siweReady) {
    const signingInProgress = siweStatus === "signing" || siweStatus === "verifying";
    return (
      <div className="mt-3 flex items-center justify-between gap-3 rounded bg-amber-50 p-2 text-sm text-amber-800">
        <span>Sign in with your wallet to chat.</span>
        <button
          type="button"
          onClick={onSignIn}
          disabled={signingInProgress}
          className="rounded bg-blue-600 px-3 py-1 text-xs text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {signingInProgress ? "Signing…" : "Sign in"}
        </button>
      </div>
    );
  }
  if (!isParty) {
    // Admins land here too — they can read above but can't write.
    return (
      <div className="mt-3 rounded bg-slate-50 p-2 text-sm text-slate-600">
        Only the buyer and seller of this order can chat here.
      </div>
    );
  }

  const overLimit = draft.length > MAX_BODY_CHARS;
  const canSend = (draft.trim().length > 0 || attachment !== undefined) && !overLimit && !sending;

  return (
    <div className="mt-3 space-y-2">
      <textarea
        value={draft}
        onChange={(e) => onDraftChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Type a message… (Enter to send, Shift+Enter for newline)"
        rows={3}
        disabled={sending}
        className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none disabled:bg-slate-100"
      />

      {attachment ? (
        <div className="flex items-center gap-3 rounded border border-slate-200 bg-slate-50 p-2 text-xs">
          {attachmentPreview ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={attachmentPreview}
              alt={attachment.name}
              className="h-12 w-12 rounded object-cover"
            />
          ) : (
            <div className="grid h-12 w-12 place-items-center rounded bg-slate-200 text-[10px] text-slate-600">
              IMG
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium text-slate-700">{attachment.name}</div>
            <div className="text-slate-500">{formatBytes(attachment.size)}</div>
          </div>
          <button
            type="button"
            onClick={() => {
              onPickAttachment(undefined);
              if (fileInputRef.current) fileInputRef.current.value = "";
            }}
            disabled={sending}
            aria-label="Remove attachment"
            className="rounded p-1 text-slate-400 hover:bg-slate-200 hover:text-slate-700"
          >
            ✕
          </button>
        </div>
      ) : (
        <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-slate-600 hover:text-slate-900">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif,image/heic"
            disabled={sending}
            onChange={(e) => onPickAttachment(e.target.files?.[0] ?? undefined)}
            className="hidden"
          />
          <span className="rounded border border-dashed border-slate-300 px-2 py-1">
            📎 Add image (≤5 MB)
          </span>
        </label>
      )}

      <div className="flex items-center justify-between text-xs text-slate-500">
        <span className={overLimit ? "text-red-600" : ""}>
          {draft.length}/{MAX_BODY_CHARS}
        </span>
        <button
          type="button"
          onClick={onSend}
          disabled={!canSend}
          className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
      {sendError && <div className="rounded bg-red-50 p-2 text-sm text-red-700">{sendError}</div>}
    </div>
  );
}

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
