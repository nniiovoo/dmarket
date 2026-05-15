"use client";

import { ProductRecommendationCard } from "./ProductRecommendationCard";
import type { CandidateWithMeta } from "@/lib/ai/recommend";

export type ChatRole = "user" | "ai" | "system";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  candidates?: CandidateWithMeta[];
  /// Set on AI messages produced by /api/ai/recommend so the UI can show
  /// "via DeepSeek · $0.000123" — useful for cost-tuning during dev.
  meta?: {
    providerName: string;
    model: string;
    costUsd: number;
  };
  error?: boolean;
}

interface Props {
  message: ChatMessage;
}

export function ChatMessageView({ message }: Props) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-lg bg-black px-3 py-2 text-sm text-white">{message.text}</div>
      </div>
    );
  }
  if (message.role === "system") {
    return (
      <div className="flex justify-center">
        <div className="rounded-md bg-gray-100 px-3 py-1 text-xs text-gray-600">{message.text}</div>
      </div>
    );
  }
  // AI
  return (
    <div className="flex flex-col gap-2">
      <div className={`max-w-[90%] rounded-lg ${message.error ? "bg-red-50 text-red-800" : "bg-gray-100 text-gray-900"} px-3 py-2 text-sm`}>
        {message.text}
        {message.meta ? (
          <div className="mt-1 text-[10px] uppercase tracking-wide text-gray-500">
            via {message.meta.providerName} · {message.meta.model} · ${message.meta.costUsd.toFixed(6)}
          </div>
        ) : null}
      </div>
      {message.candidates && message.candidates.length > 0 ? (
        <div className="flex flex-col gap-2">
          {message.candidates.map((c) => (
            <ProductRecommendationCard key={c.product.id} candidate={c} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
