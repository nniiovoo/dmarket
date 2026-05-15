// Multi-provider LLM abstraction (Phase I.5).
//
// The shape here is deliberately narrow: every provider must support
// "call the model with a single tool, force the tool, return its parsed
// input". That's the only LLM operation the AI ordering layer actually
// uses (the NLU stage). Anything richer — multi-turn, streaming,
// multi-tool routing — belongs in a follow-up if and when a feature
// needs it. Keeping the surface tiny means swapping providers is a
// single class implementation, not a refactor.

export interface LLMToolCall<T = unknown> {
  toolName: string;
  input: T;
}

export interface LLMUsage {
  inputTokens: number;
  /// Tokens served from the provider's prompt cache. 0 for providers
  /// that don't expose caching (OpenAI auto-caches internally but does
  /// not bill differently for it; DeepSeek does, but we don't surface
  /// the savings yet — see deepseek.ts TODO).
  cachedInputTokens: number;
  outputTokens: number;
  /// USD, computed from the provider's per-million-token rates at call
  /// time. Provider-specific so callers can compare apples to apples.
  costUsd: number;
}

export interface LLMToolResponse<T = unknown> {
  toolCall: LLMToolCall<T>;
  usage: LLMUsage;
  providerName: ProviderName;
  model: string;
}

export interface LLMCallOptions {
  systemPrompt: string;
  userMessage: string;
  toolName: string;
  toolDescription: string;
  /// JSON Schema for the tool's input. Same object goes to Anthropic's
  /// `input_schema` and OpenAI/DeepSeek's `function.parameters` — the
  /// JSON Schema dialects are compatible enough for our usage.
  toolInputSchema: object;
  maxTokens: number;
  /// Hint to providers that this prompt is a stable system prompt and
  /// should be marked for caching where supported. Anthropic uses
  /// `cache_control: ephemeral`; OpenAI/DeepSeek ignore this flag and
  /// rely on their automatic caching paths.
  cacheable?: boolean;
}

export type ProviderName = "anthropic" | "openai" | "deepseek";

export interface LLMProvider {
  readonly name: ProviderName;
  readonly model: string;
  callWithTool<T>(opts: LLMCallOptions): Promise<LLMToolResponse<T>>;
}

/// Thrown when the chosen provider has no API key configured. Carries
/// `readonly status = 503` so the existing `instanceof LLMConfigError`
/// checks in `/api/ai/recommend` and `/api/ai/search` keep mapping us
/// to HTTP 503 — `LLMConfigError` is re-exported from `./index` as
/// an alias for back-compat with Phase I.2 callers.
export class LLMConfigError extends Error {
  readonly status = 503;
}

export class LLMProviderConfigError extends LLMConfigError {}

// Token usage shape kept here so `lib/ai/llm/index.ts` can re-export it
// for legacy I.2 callers that still imported `{ TokenUsage }` from
// `@/lib/ai/llm`. New code should prefer `NLUUsage` (from `../nlu`)
// or `LLMUsage` above, both of which extend the same fields.
export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export function emptyUsage(): TokenUsage {
  return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costUsd: 0 };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    costUsd: a.costUsd + b.costUsd
  };
}
