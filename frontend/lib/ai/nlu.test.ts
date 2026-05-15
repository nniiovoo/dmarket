import { test } from "node:test";
import assert from "node:assert";

import { parseUserQueryWithClient, NLUSchemaError } from "./nlu";
import { computeCostUsd } from "./llm";

type MockMessage = {
  content: Array<{
    type: "tool_use" | "text";
    name?: string;
    input?: unknown;
    text?: string;
  }>;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
};

function makeClient(message: MockMessage) {
  return {
    messages: {
      // The SDK exposes more than `create`, but our wrapper only uses
      // create. Cast as Pick<...> so the type doesn't require the rest.
      async create() {
        return message;
      }
    }
  } as unknown as Parameters<typeof parseUserQueryWithClient>[0];
}

test("happy path: tool_use → parsed fields aligned with fixture", async () => {
  const client = makeClient({
    content: [
      {
        type: "tool_use",
        name: "extract_query",
        input: {
          q: "iPhone 15",
          priceMaxWei: "500000000",
          sortBy: "relevance",
          limit: 10,
          offset: 0,
          confidence: "medium",
          explanation: "USDC at 6 decimals"
        }
      }
    ],
    usage: { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 0 }
  });

  const result = await parseUserQueryWithClient(client, "iPhone 15 under 500 USDC");
  assert.strictEqual(result.parsed.q, "iPhone 15");
  assert.strictEqual(result.parsed.priceMaxWei, 500_000_000n);
  assert.strictEqual(result.parsed.sortBy, "relevance");
  assert.strictEqual(result.parsed.limit, 10);
  assert.strictEqual(result.confidence, "medium");
  assert.ok(result.explanation.length > 0);
});

test("tool_use input fails Zod schema → NLUSchemaError", async () => {
  const client = makeClient({
    content: [
      {
        type: "tool_use",
        name: "extract_query",
        input: {
          // Missing `q` (required); sortBy uses an invalid value.
          sortBy: "magic",
          limit: 10,
          offset: 0,
          confidence: "high",
          explanation: "x"
        }
      }
    ],
    usage: { input_tokens: 1000, output_tokens: 40 }
  });

  await assert.rejects(() => parseUserQueryWithClient(client, "anything"), NLUSchemaError);
});

test("cost calc applies cached-input discount when cache_read tokens reported", async () => {
  const client = makeClient({
    content: [
      {
        type: "tool_use",
        name: "extract_query",
        input: {
          q: "headphones",
          sortBy: "price_asc",
          limit: 10,
          offset: 0,
          confidence: "high",
          explanation: "ok"
        }
      }
    ],
    usage: {
      input_tokens: 1500,
      cache_read_input_tokens: 1400, // most of the system prompt was cached
      output_tokens: 60
    }
  });

  const result = await parseUserQueryWithClient(client, "cheapest headphones");
  // uncached 100 * $3/MTok + cached 1400 * $0.30/MTok + output 60 * $15/MTok
  const expected = computeCostUsd(1500, 1400, 60);
  assert.strictEqual(result.usage.inputTokens, 1500);
  assert.strictEqual(result.usage.cachedInputTokens, 1400);
  assert.strictEqual(result.usage.outputTokens, 60);
  assert.ok(Math.abs(result.usage.costUsd - expected) < 1e-9);
  // sanity: cached cost is meaningfully cheaper than full-rate
  const fullRate = computeCostUsd(1500, 0, 60);
  assert.ok(result.usage.costUsd < fullRate * 0.5);
});
