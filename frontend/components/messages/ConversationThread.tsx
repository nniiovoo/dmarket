"use client";

// Main pane of /messages. Shows a single conversation's messages with a
// composer at the bottom. Polls every 5s while the user is on this thread.

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAccount } from "wagmi";

import { Avatar } from "@/components/messages/ConversationList";
import {
  fetchMessages,
  type ConversationMessage,
  type ConversationDetail
} from "@/lib/api/messages";
import { useSiweAuth } from "@/lib/useSiweAuth";

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

export function ConversationThread({ conversationId }: { conversationId: string }) {
  const { address: connectedAddress } = useAccount();
  const siwe = useSiweAuth();
  const queryClient = useQueryClient();

  const [draft, setDraft] = useState("");
  const [attachment, setAttachment] = useState<File | undefined>(undefined);
  const [attachmentPreview, setAttachmentPreview] = useState<string | undefined>(undefined);
  const [sendError, setSendError] = useState<string | undefined>();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const polling = siwe.matchesConnected;

  const messagesQuery = useQuery({
    queryKey: ["messages", conversationId],
    queryFn: () => fetchMessages(conversationId),
    enabled: polling,
    refetchInterval: polling ? POLL_INTERVAL_MS : false
  });

  // Generate preview URL for picked attachment + revoke on change/unmount.
  // Same pattern as the old chat panel; React 19 set-state-in-effect rule
  // tolerates the setter inside an effect body when the alternative is
  // worse.
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

  // Pin to bottom when new messages arrive.
  const messageCount = messagesQuery.data?.messages.length ?? 0;
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messageCount, conversationId]);

  const sendMutation = useMutation({
    mutationFn: async (input: { body: string; file?: File }): Promise<ConversationMessage> => {
      const endpoint = `/api/conversations/${conversationId}/messages`;
      let res: Response;
      if (input.file) {
        const form = new FormData();
        form.set("body", input.body);
        form.set("file", input.file);
        res = await fetch(endpoint, { method: "POST", credentials: "include", body: form });
      } else {
        res = await fetch(endpoint, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body: input.body })
        });
      }
      const data = (await res.json().catch(() => ({}))) as {
        message?: ConversationMessage;
        error?: string;
      };
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
      void queryClient.invalidateQueries({ queryKey: ["messages", conversationId] });
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
    },
    onError: (err: unknown) => {
      setSendError(err instanceof Error ? err.message : "Send failed");
    }
  });

  const handleSend = useCallback(() => {
    const trimmed = draft.trim();
    if (trimmed.length === 0 && !attachment) return;
    if (sendMutation.isPending) return;
    setSendError(undefined);
    sendMutation.mutate({ body: trimmed, file: attachment });
  }, [draft, attachment, sendMutation]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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

  const detail = messagesQuery.data?.conversation;
  const overLimit = draft.length > MAX_BODY_CHARS;
  const canSend =
    polling && (draft.trim().length > 0 || attachment !== undefined) && !overLimit && !sendMutation.isPending;

  return (
    <section className="flex h-full min-h-[480px] flex-1 flex-col bg-slate-50">
      <Header detail={detail} />
      <div ref={scrollerRef} className="flex-1 overflow-y-auto px-4 py-4">
        <ThreadBody query={messagesQuery} connectedAddress={connectedAddress} polling={polling} detail={detail} />
      </div>
      <Composer
        polling={polling}
        siweStatus={siwe.status}
        onSignIn={() => void siwe.signIn()}
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
        canSend={canSend}
        overLimit={overLimit}
      />
    </section>
  );
}

function Header({ detail }: { detail: ConversationDetail | undefined }) {
  if (!detail) {
    return (
      <header className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-3">
        <div className="h-9 w-9 rounded-full bg-slate-200" />
        <div className="flex-1">
          <div className="h-4 w-32 rounded bg-slate-200" />
        </div>
      </header>
    );
  }
  const counterpartyShort = `${detail.counterparty.slice(0, 6)}…${detail.counterparty.slice(-4)}`;
  return (
    <header className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-3">
      <Avatar address={detail.counterparty} size={36} />
      <div className="min-w-0 flex-1">
        <div className="font-mono text-sm text-slate-800">{counterpartyShort}</div>
        <div className="text-[11px] text-slate-500">
          chain {detail.chainId}
          {detail.initialProductId ? ` · started from product #${detail.initialProductId}` : ""}
        </div>
      </div>
    </header>
  );
}

function ThreadBody({
  query,
  connectedAddress,
  polling,
  detail
}: {
  query: ReturnType<typeof useQuery<Awaited<ReturnType<typeof fetchMessages>>>>;
  connectedAddress: string | undefined;
  polling: boolean;
  detail: ConversationDetail | undefined;
}) {
  if (!polling) {
    return <p className="py-12 text-center text-sm text-slate-500">Sign in to load this conversation.</p>;
  }
  if (query.isPending) {
    return <p className="py-12 text-center text-sm text-slate-500">Loading messages…</p>;
  }
  if (query.isError) {
    return (
      <p className="py-12 text-center text-sm text-red-600">
        Failed to load: {query.error instanceof Error ? query.error.message : "unknown"}
      </p>
    );
  }
  const messages = query.data?.messages ?? [];
  if (messages.length === 0) {
    return (
      <p className="py-12 text-center text-sm text-slate-500">
        No messages yet. Say hi to {detail ? `${detail.counterparty.slice(0, 6)}…` : "the seller"}.
      </p>
    );
  }
  return (
    <ul className="space-y-2">
      {messages.map((m) => (
        <ThreadBubble key={m.id} message={m} connectedAddress={connectedAddress} />
      ))}
    </ul>
  );
}

function ThreadBubble({
  message,
  connectedAddress
}: {
  message: ConversationMessage;
  connectedAddress: string | undefined;
}) {
  const sender = message.senderAddress.toLowerCase();
  const mine = connectedAddress !== undefined && sender === connectedAddress.toLowerCase();
  const hasBody = message.body.length > 0;

  return (
    <li className={`flex ${mine ? "justify-end" : "justify-start"}`}>
      <div className={`flex max-w-[78%] flex-col ${mine ? "items-end" : "items-start"}`}>
        <div className="flex items-baseline gap-2 px-1 text-[11px] text-slate-500">
          <time dateTime={message.createdAt}>
            {new Date(message.createdAt).toLocaleString()}
          </time>
        </div>
        {message.attachment ? (
          <a
            href={message.attachment.url}
            target="_blank"
            rel="noreferrer"
            className="mt-1 block"
            title={`${message.attachment.fileName} · ${formatBytes(message.attachment.size)}`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={message.attachment.url}
              alt={message.attachment.fileName}
              className="max-h-[240px] max-w-[240px] rounded-lg border border-slate-200 bg-white object-contain"
            />
          </a>
        ) : null}
        {hasBody ? (
          <div
            className={`mt-1 whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm shadow-sm ${
              mine
                ? "bg-blue-600 text-white"
                : "border border-slate-200 bg-white text-slate-900"
            }`}
          >
            {message.body}
          </div>
        ) : null}
      </div>
    </li>
  );
}

function Composer({
  polling,
  siweStatus,
  onSignIn,
  draft,
  onDraftChange,
  onSend,
  onKeyDown,
  sending,
  sendError,
  attachment,
  attachmentPreview,
  onPickAttachment,
  fileInputRef,
  canSend,
  overLimit
}: {
  polling: boolean;
  siweStatus: ReturnType<typeof useSiweAuth>["status"];
  onSignIn: () => void;
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
  canSend: boolean;
  overLimit: boolean;
}) {
  if (!polling) {
    const signingInProgress = siweStatus === "signing" || siweStatus === "verifying";
    return (
      <div className="border-t border-slate-200 bg-white p-4">
        <div className="flex items-center justify-between gap-3 rounded bg-amber-50 p-3 text-sm text-amber-800">
          <span>Sign in with your wallet to read and send messages.</span>
          <button
            type="button"
            onClick={onSignIn}
            disabled={signingInProgress}
            className="rounded bg-blue-600 px-3 py-1 text-xs text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {signingInProgress ? "Signing…" : "Sign in"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2 border-t border-slate-200 bg-white p-4">
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
