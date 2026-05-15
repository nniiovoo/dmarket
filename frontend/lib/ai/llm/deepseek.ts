import OpenAI from "openai";

import { OpenAIProvider } from "./openai";
import { LLMProviderConfigError, type ProviderName } from "./types";

// DeepSeek provider — reuses the OpenAI SDK against DeepSeek's
// OpenAI-compatible endpoint. The only differences from
// OpenAIProvider are the API key, baseURL, model name, and pricing.
//
// TODO(I.5+): DeepSeek bills cache-hit input at $0.014/MT (vs cache-miss
// $0.14/MT). They expose hit/miss counts via
// `usage.prompt_cache_hit_tokens`, but plumbing that through requires a
// non-OpenAI-shaped usage payload and a careful test pass. Punt for
// MVP — undercharging USD is a reporting glitch, not a correctness one.

const MODEL = "deepseek-chat";
const PROVIDER_NAME: ProviderName = "deepseek";

// USD per million tokens (deepseek-chat, cache-miss rate, 2026-05).
const PRICE_INPUT = 0.14;
const PRICE_OUTPUT = 0.28;

export class DeepSeekProvider extends OpenAIProvider {
  override readonly name = PROVIDER_NAME;
  override readonly model = MODEL;

  protected override baseConfig(): { apiKey: string; baseURL: string } {
    const key = process.env.DEEPSEEK_API_KEY;
    if (!key || key.trim() === "") {
      throw new LLMProviderConfigError(
        "DEEPSEEK_API_KEY is not set. Sign up at https://platform.deepseek.com to get one (¥10 buys ~70k cache-miss requests at the I.2 prompt size)."
      );
    }
    return { apiKey: key, baseURL: "https://api.deepseek.com/v1" };
  }

  protected override price(): { input: number; output: number } {
    return { input: PRICE_INPUT, output: PRICE_OUTPUT };
  }

  protected override providerName(): ProviderName {
    return PROVIDER_NAME;
  }

  protected override modelName(): string {
    return MODEL;
  }

  // Constructor accepts an OpenAI override for tests, matching the
  // parent. The SDK doesn't care which endpoint the override points at.
  constructor(clientOverride?: OpenAI) {
    super(clientOverride);
  }
}
