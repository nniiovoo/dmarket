"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount } from "wagmi";

import { useSiweAuth } from "@/lib/useSiweAuth";
import { ChatMessageView, type ChatMessage } from "./ChatMessage";
import type { RecommendResult } from "@/lib/ai/recommend";

// /shop chat box.
//
// State is intentionally in-memory only — refreshing the page wipes
// history. Persisting chat threads server-side opens a privacy-vs-cost
// debate (LLM costs scale with stored context, "the agent saved my
// shopping list" is a feature not a bug). MVP: no persistence.
//
// Auth model: the user must complete SIWE before /api/ai/recommend can
// fold their wallet address into per-account rate-limit / budget keys.
// (recommend.ts itself doesn't require auth, but consistency with the
// public /api/ai/search endpoint keeps the UX uniform.)

let nextId = 0;
function mid(): string {
  return `m${++nextId}`;
}

export function ShopChatBox() {
  const { isConnected } = useAccount();
  const { sessionAddress, status: siweStatus, signIn } = useSiweAuth();
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: mid(),
      role: "ai",
      text:
        "Hi — I'm ChainUs's AI shopper. Ask me for something to buy and I'll surface the top 3 candidates with seller reputation, then prep an order draft for your wallet to sign."
    }
  ]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll on new message — only scroll the chat container, not the
  // whole page (that would yank the input box off-screen).
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || pending) return;

    setMessages((prev) => [...prev, { id: mid(), role: "user", text }]);
    setInput("");
    setPending(true);

    try {
      const res = await fetch("/api/ai/recommend", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: text })
      });
      const body = (await res.json().catch(() => ({}))) as
        | { recommendation: RecommendResult; requestId: string }
        | { error: string; reason?: string; message?: string; requestId?: string };

      if (!res.ok || !("recommendation" in body)) {
        const err = "error" in body ? body : { error: "unknown_error" };
        const note =
          res.status === 503
            ? "The AI provider isn't configured on the server. Set DEEPSEEK_API_KEY (or OPENAI_API_KEY / ANTHROPIC_API_KEY) and restart."
            : res.status === 429
            ? "Rate limit or daily AI budget hit — try again in a minute."
            : res.status === 502
            ? "I couldn't parse your request as a shopping query. Try rephrasing it."
            : err.error;
        setMessages((prev) => [
          ...prev,
          {
            id: mid(),
            role: "ai",
            text: `${note}${"reason" in err && err.reason ? ` (${err.reason})` : ""}`,
            error: true
          }
        ]);
        return;
      }

      const rec = body.recommendation;
      const replyText =
        rec.candidates.length === 0
          ? `${rec.explanation} Nothing matched in the catalog right now — try broadening the query or removing price filters.`
          : `${rec.explanation} Here are the top ${rec.candidates.length}:`;
      setMessages((prev) => [
        ...prev,
        {
          id: mid(),
          role: "ai",
          text: replyText,
          candidates: rec.candidates,
          meta: {
            providerName: rec.usage.providerName,
            model: rec.usage.model,
            costUsd: rec.usage.costUsd
          }
        }
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { id: mid(), role: "ai", text: `Request failed: ${err instanceof Error ? err.message : String(err)}`, error: true }
      ]);
    } finally {
      setPending(false);
    }
  }, [input, pending]);

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const needsAuth = !sessionAddress;

  return (
    <div className="mx-auto flex h-[calc(100vh-8rem)] max-w-3xl flex-col rounded-lg border border-gray-200 bg-white shadow-sm">
      <header className="border-b border-gray-200 px-5 py-3">
        <h1 className="text-base font-semibold">ChainUs Shop · Powered by AI</h1>
        <p className="text-xs text-gray-500">
          Tell the assistant what you want. It searches the catalog, applies seller reputation, and hands the
          wallet-signing step back to you.
        </p>
      </header>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
        {messages.map((m) => (
          <ChatMessageView key={m.id} message={m} />
        ))}
        {pending ? (
          <div className="flex justify-start">
            <div className="rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-600">
              <span className="inline-block animate-pulse">AI is thinking…</span>
            </div>
          </div>
        ) : null}
      </div>

      {needsAuth ? (
        <div className="border-t border-amber-200 bg-amber-50 px-5 py-3 text-sm text-amber-900">
          <div className="flex items-center justify-between gap-3">
            <span>
              {isConnected
                ? "Sign in with your wallet to start shopping. Your address is bound to the AI session."
                : "Connect your wallet (top-right) to start shopping."}
            </span>
            <button
              type="button"
              onClick={() => void signIn()}
              disabled={!isConnected || siweStatus === "signing" || siweStatus === "verifying"}
              className="rounded-md bg-black px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
            >
              {siweStatus === "signing" || siweStatus === "verifying" ? "Signing…" : "Sign in"}
            </button>
          </div>
        </div>
      ) : null}

      <div className="border-t border-gray-200 px-5 py-3">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            placeholder={needsAuth ? "Sign in first" : "Type your shopping question…"}
            disabled={needsAuth || pending}
            className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-black focus:outline-none disabled:bg-gray-50"
          />
          <button
            type="button"
            onClick={() => void send()}
            disabled={needsAuth || pending || input.trim().length === 0}
            className="rounded-md bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
