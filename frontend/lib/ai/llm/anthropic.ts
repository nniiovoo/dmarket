import Anthropic from "@anthropic-ai/sdk";
import type { MessageCreateParamsNonStreaming, Tool } from "@anthropic-ai/sdk/resources";

// `MessageCreateParamsNonStreaming["tools"]` is a union of Tool, ToolBash,
// ToolComputerUse, etc. We only ever build the plain Tool variant and
// pass it through; the SDK accepts the union at the call site.

import {
  LLMProviderConfigError,
  type LLMCallOptions,
  type LLMProvider,
  type LLMToolResponse,
  type ProviderName
} from "./types";

// Anthropic provider — Sonnet 4.6 + tool-use + prompt caching.
// Ported from the pre-Phase-I.5 nlu.ts which talked to the SDK
// directly. Pricing held over from the same file.

const MODEL = "claude-sonnet-4-6";
const PROVIDER_NAME: ProviderName = "anthropic";

// USD per million tokens.
const PRICE_INPUT = 3.0;
const PRICE_OUTPUT = 15.0;
const PRICE_CACHED_INPUT = 0.3;

export class AnthropicProvider implements LLMProvider {
  readonly name = PROVIDER_NAME;
  readonly model = MODEL;

  private cachedClient: Anthropic | null = null;

  /// Test seam — production callers get a fresh client off the
  /// lazy-initialised env-backed singleton.
  constructor(private readonly clientOverride?: Anthropic) {}

  private getClient(): Anthropic {
    if (this.clientOverride) return this.clientOverride;
    if (this.cachedClient) return this.cachedClient;
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key || key.trim() === "") {
      throw new LLMProviderConfigError(
        "ANTHROPIC_API_KEY is not set. Add it to .env (or your runtime secrets) before calling the Anthropic provider."
      );
    }
    this.cachedClient = new Anthropic({ apiKey: key });
    return this.cachedClient;
  }

  async callWithTool<T>(opts: LLMCallOptions): Promise<LLMToolResponse<T>> {
    const tool: Tool = {
      name: opts.toolName,
      description: opts.toolDescription,
      input_schema: opts.toolInputSchema as Tool.InputSchema
    };
    const systemBlock: MessageCreateParamsNonStreaming["system"] = [
      opts.cacheable
        ? { type: "text", text: opts.systemPrompt, cache_control: { type: "ephemeral" } }
        : { type: "text", text: opts.systemPrompt }
    ];

    const response = await this.getClient().messages.create({
      model: MODEL,
      max_tokens: opts.maxTokens,
      system: systemBlock,
      tools: [tool],
      tool_choice: { type: "tool", name: opts.toolName },
      messages: [{ role: "user", content: opts.userMessage }]
    });

    const toolUse = response.content.find((b) => b.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      throw new Error("Anthropic response did not include a tool_use block");
    }
    if (toolUse.name !== opts.toolName) {
      throw new Error(`Unexpected tool name ${toolUse.name}`);
    }

    const usage = response.usage as {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
    const inputTokens = usage.input_tokens ?? 0;
    const cachedInputTokens = usage.cache_read_input_tokens ?? 0;
    const outputTokens = usage.output_tokens ?? 0;
    const uncached = Math.max(0, inputTokens - cachedInputTokens);
    const costUsd =
      (uncached * PRICE_INPUT) / 1_000_000 +
      (cachedInputTokens * PRICE_CACHED_INPUT) / 1_000_000 +
      (outputTokens * PRICE_OUTPUT) / 1_000_000;

    return {
      toolCall: { toolName: toolUse.name, input: toolUse.input as T },
      usage: { inputTokens, cachedInputTokens, outputTokens, costUsd },
      providerName: PROVIDER_NAME,
      model: MODEL
    };
  }
}
