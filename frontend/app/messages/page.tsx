"use client";

// Two-pane messenger. Left: ConversationList (sidebar). Right:
// ConversationThread (active thread). Active thread id lives in ?id=…
// so direct links from email notifications and the "Contact seller"
// button work the same as in-app clicks.

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

import { EmptyState } from "@/components/Card";
import { ConversationList } from "@/components/messages/ConversationList";
import { ConversationThread } from "@/components/messages/ConversationThread";
import { useSiweAuth } from "@/lib/useSiweAuth";

export default function MessagesPage() {
  return (
    <Suspense fallback={<div className="text-sm text-slate-500">Loading…</div>}>
      <MessagesInner />
    </Suspense>
  );
}

function MessagesInner() {
  const siwe = useSiweAuth();
  const searchParams = useSearchParams();
  const activeId = searchParams.get("id") ?? undefined;

  if (siwe.status === "checking") {
    return (
      <div className="text-sm text-slate-500">Loading session…</div>
    );
  }

  if (!siwe.matchesConnected) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold text-slate-950">Messages</h1>
        <EmptyState
          title="Sign in required"
          body="Sign in with your wallet to read and send messages."
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold text-slate-950">Messages</h1>
      <div className="grid h-[70vh] min-h-[480px] grid-cols-1 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm md:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
        <ConversationList activeId={activeId} />
        <div className="hidden md:block">
          {activeId ? (
            <ConversationThread conversationId={activeId} />
          ) : (
            <EmptyPane />
          )}
        </div>
        {/* On mobile, when no thread is selected the sidebar fills the
            screen; once selected, the thread takes over the only column. */}
        <div className="md:hidden">
          {activeId ? <ConversationThread conversationId={activeId} /> : null}
        </div>
      </div>
    </div>
  );
}

function EmptyPane() {
  return (
    <div className="grid h-full place-items-center bg-slate-50 p-8 text-center">
      <div className="max-w-sm">
        <p className="text-sm font-medium text-slate-700">Select a conversation</p>
        <p className="mt-1 text-sm text-slate-500">
          Pick a thread on the left, or open a product and tap “Contact seller” to start a new
          one.
        </p>
      </div>
    </div>
  );
}
