import Anthropic from "@anthropic-ai/sdk";

// All LLM calls go through this module. Future model swaps, retry
// policies, fallback routing, etc. get added here so callers don't need
// to know which provider / model is in play.

export const LLM_MODEL = "claude-sonnet-4-6";

// Sonnet 4.6 pricing as of 2026-05. Values are dollars per million tokens.
// Cached-input is 90% off; cache writes carry a 25% premium over the base
// input rate but we don't currently distinguish writes vs uncached input
// in our cost accounting (small-prompt single-tool-call payloads, the
// 25% delta is ~hundredths of a cent per request).
const PRICE_INPUT_PER_MTOK = 3.0;
const PRICE_OUTPUT_PER_MTOK = 15.0;
const PRICE_CACHED_INPUT_PER_MTOK = 0.3;

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

export function computeCostUsd(
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number
): number {
  const uncachedInput = Math.max(0, inputTokens - cachedInputTokens);
  return (
    (uncachedInput * PRICE_INPUT_PER_MTOK) / 1_000_000 +
    (cachedInputTokens * PRICE_CACHED_INPUT_PER_MTOK) / 1_000_000 +
    (outputTokens * PRICE_OUTPUT_PER_MTOK) / 1_000_000
  );
}

export class LLMConfigError extends Error {
  readonly status = 503;
}

let cachedClient: Anthropic | null = null;

/// Returns a process-scoped Anthropic SDK client. Throws LLMConfigError
/// (which the API route maps to 503) when ANTHROPIC_API_KEY is not set,
/// so the rest of the codebase doesn't have to guard every call site.
export function getLLMClient(): Anthropic {
  if (cachedClient !== null) return cachedClient;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || key.trim() === "") {
    throw new LLMConfigError(
      "ANTHROPIC_API_KEY is not set. Add it to .env (or your runtime secrets) before calling any AI endpoint."
    );
  }
  cachedClient = new Anthropic({ apiKey: key });
  return cachedClient;
}

// Test-only seam — let unit tests inject a stub Anthropic client
// without touching env / having to mock the constructor.
export function __setLLMClientForTesting(client: Anthropic | null): void {
  cachedClient = client;
}
