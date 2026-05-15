import { test } from "node:test";
import assert from "node:assert";

import { parseUserQueryWithProvider, NLUSchemaError } from "./nlu";
import type { LLMCallOptions, LLMProvider, LLMToolResponse, LLMUsage } from "./llm";

function makeProvider(input: unknown, usage: LLMUsage): LLMProvider {
  return {
    name: "anthropic",
    model: "claude-sonnet-4-6",
    // Cast the response generic so the mock matches LLMProvider's
    // generic callWithTool signature. Tests don't observe T directly.
    callWithTool: (async (opts: LLMCallOptions) =>
      ({
        toolCall: { toolName: opts.toolName, input },
        usage,
        providerName: "anthropic",
        model: "claude-sonnet-4-6"
      } as LLMToolResponse<unknown>)) as LLMProvider["callWithTool"]
  };
}

test("happy path: tool_use → parsed fields aligned with fixture", async () => {
  const provider = makeProvider(
    {
      q: "iPhone 15",
      priceMaxWei: "500000000",
      sortBy: "relevance",
      limit: 10,
      offset: 0,
      confidence: "medium",
      explanation: "USDC at 6 decimals"
    },
    { inputTokens: 1200, cachedInputTokens: 0, outputTokens: 80, costUsd: 0.005 }
  );

  const result = await parseUserQueryWithProvider(provider, "iPhone 15 under 500 USDC");
  assert.strictEqual(result.parsed.q, "iPhone 15");
  assert.strictEqual(result.parsed.priceMaxWei, 500_000_000n);
  assert.strictEqual(result.parsed.sortBy, "relevance");
  assert.strictEqual(result.parsed.limit, 10);
  assert.strictEqual(result.confidence, "medium");
  assert.ok(result.explanation.length > 0);
  // Usage carries provider tag through to the caller.
  assert.strictEqual(result.usage.providerName, "anthropic");
  assert.strictEqual(result.usage.model, "claude-sonnet-4-6");
});

test("tool_use input fails Zod schema → NLUSchemaError", async () => {
  const provider = makeProvider(
    {
      // Missing `q` (required); sortBy uses an invalid value.
      sortBy: "magic",
      limit: 10,
      offset: 0,
      confidence: "high",
      explanation: "x"
    },
    { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 40, costUsd: 0.003 }
  );

  await assert.rejects(() => parseUserQueryWithProvider(provider, "anything"), NLUSchemaError);
});

test("usage propagates verbatim from the provider into the NLU result", async () => {
  const usage: LLMUsage = {
    inputTokens: 1500,
    cachedInputTokens: 1400,
    outputTokens: 60,
    costUsd: 0.0012
  };
  const provider = makeProvider(
    {
      q: "headphones",
      sortBy: "price_asc",
      limit: 10,
      offset: 0,
      confidence: "high",
      explanation: "ok"
    },
    usage
  );

  const result = await parseUserQueryWithProvider(provider, "cheapest headphones");
  assert.strictEqual(result.usage.inputTokens, 1500);
  assert.strictEqual(result.usage.cachedInputTokens, 1400);
  assert.strictEqual(result.usage.outputTokens, 60);
  assert.strictEqual(result.usage.costUsd, 0.0012);
});
