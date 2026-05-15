import OpenAI from "openai";

import {
  LLMProviderConfigError,
  type LLMCallOptions,
  type LLMProvider,
  type LLMToolResponse,
  type ProviderName
} from "./types";

// OpenAI provider — gpt-4o-mini + function-calling.
//
// We do not surface OpenAI's automatic prompt caching: the API only
// hints at it via `usage.prompt_tokens_details.cached_tokens` and the
// billing discount is applied internally; we'd duplicate the
// computation incorrectly if we tried to subtract here. cachedInputTokens
// stays at 0 for this provider.

const MODEL = "gpt-4o-mini";
const PROVIDER_NAME: ProviderName = "openai";

// USD per million tokens (gpt-4o-mini, 2026-05).
const PRICE_INPUT = 0.15;
const PRICE_OUTPUT = 0.6;

export class OpenAIProvider implements LLMProvider {
  // Field types declared explicitly so DeepSeekProvider can re-assign a
  // different literal without "Type '\"deepseek-chat\"' is not
  // assignable to type '\"gpt-4o-mini\"'" errors at the subclass.
  readonly name: ProviderName = PROVIDER_NAME;
  readonly model: string = MODEL;

  private cachedClient: OpenAI | null = null;

  constructor(private readonly clientOverride?: OpenAI) {}

  protected baseConfig(): { apiKey: string; baseURL?: string } {
    const key = process.env.OPENAI_API_KEY;
    if (!key || key.trim() === "") {
      throw new LLMProviderConfigError(
        "OPENAI_API_KEY is not set. Add it to .env (or your runtime secrets) before calling the OpenAI provider."
      );
    }
    return { apiKey: key };
  }

  protected getClient(): OpenAI {
    if (this.clientOverride) return this.clientOverride;
    if (this.cachedClient) return this.cachedClient;
    this.cachedClient = new OpenAI(this.baseConfig());
    return this.cachedClient;
  }

  /// Pricing in USD per million tokens. Subclassed by DeepSeekProvider
  /// to plug in its own rates against the same OpenAI-compatible SDK.
  protected price(): { input: number; output: number } {
    return { input: PRICE_INPUT, output: PRICE_OUTPUT };
  }

  protected providerName(): ProviderName {
    return PROVIDER_NAME;
  }

  protected modelName(): string {
    return MODEL;
  }

  async callWithTool<T>(opts: LLMCallOptions): Promise<LLMToolResponse<T>> {
    const completion = await this.getClient().chat.completions.create({
      model: this.modelName(),
      max_tokens: opts.maxTokens,
      messages: [
        { role: "system", content: opts.systemPrompt },
        { role: "user", content: opts.userMessage }
      ],
      tools: [
        {
          type: "function",
          function: {
            name: opts.toolName,
            description: opts.toolDescription,
            parameters: opts.toolInputSchema as Record<string, unknown>
          }
        }
      ],
      tool_choice: { type: "function", function: { name: opts.toolName } }
    });

    const choice = completion.choices[0];
    const toolCall = choice?.message?.tool_calls?.[0];
    if (!toolCall || toolCall.type !== "function") {
      throw new Error(`${this.providerName()} response did not include a function tool_call`);
    }
    if (toolCall.function.name !== opts.toolName) {
      throw new Error(`Unexpected tool name ${toolCall.function.name}`);
    }
    let input: T;
    try {
      input = JSON.parse(toolCall.function.arguments) as T;
    } catch (err) {
      throw new Error(`Failed to parse tool arguments as JSON: ${err instanceof Error ? err.message : String(err)}`);
    }

    const inputTokens = completion.usage?.prompt_tokens ?? 0;
    const outputTokens = completion.usage?.completion_tokens ?? 0;
    const rates = this.price();
    const costUsd =
      (inputTokens * rates.input) / 1_000_000 + (outputTokens * rates.output) / 1_000_000;

    return {
      toolCall: { toolName: toolCall.function.name, input },
      usage: { inputTokens, cachedInputTokens: 0, outputTokens, costUsd },
      providerName: this.providerName(),
      model: this.modelName()
    };
  }
}
