import { test } from "node:test";
import assert from "node:assert";

import { recommendProducts, DEFAULT_MIN_REPUTATION } from "./recommend";
import type { NLUResult } from "./nlu";
import type { TokenUsage } from "./llm";
import type { SearchResultRow, SearchProductsResult } from "@/lib/search/products";
import type { SellerScore } from "@/lib/reputation/score";

const USAGE: TokenUsage = { inputTokens: 1200, cachedInputTokens: 0, outputTokens: 50, costUsd: 0.004 };

function row(overrides: Partial<SearchResultRow> = {}): SearchResultRow {
  return {
    id: 1,
    name: "Item",
    description: "",
    priceWei: "1000",
    sellerAddress: "0x0000000000000000000000000000000000000001",
    chainId: 421614,
    imageUrl: "",
    status: "active",
    createdAt: new Date().toISOString(),
    relevanceScore: 0.5,
    ...overrides
  };
}

function fakeNLU(parsedOverrides: Partial<NLUResult["parsed"]> = {}): NLUResult {
  return {
    parsed: {
      q: "headphones",
      sortBy: "relevance",
      limit: 10,
      offset: 0,
      ...parsedOverrides
    },
    confidence: "high",
    explanation: "stub",
    usage: USAGE
  };
}

function fakeSearch(rows: SearchResultRow[]): typeof import("@/lib/search/products").searchProducts {
  return async () => ({
    results: rows,
    total: rows.length,
    query: {
      q: "headphones",
      priceMaxWei: null,
      priceMinWei: null,
      chainId: null,
      sortBy: "relevance",
      limit: 30,
      offset: 0
    }
  } as SearchProductsResult);
}

function fakeScorer(scoresBySellerLower: Map<string, SellerScore>): typeof import("@/lib/reputation/score").computeSellerScore {
  return async (seller) => {
    const key = seller.toLowerCase();
    return (
      scoresBySellerLower.get(key) ?? {
        subject: seller,
        raw: 500,
        components: {
          completedOrders: 0,
          disputeRate: 0,
          refundRate: 0,
          avgFulfillmentHours: 0,
          accountAgeDays: 0
        },
        sampleSize: 0
      }
    );
  };
}

const fakePrisma = {} as Parameters<typeof recommendProducts>[1]["prisma"];

test("happy path: 5 search hits → reputation/risk filter → top 3 chosen by tier+relevance", async () => {
  const r1 = row({ id: 1, sellerAddress: "0xa".padEnd(42, "1"), relevanceScore: 0.9 });
  const r2 = row({ id: 2, sellerAddress: "0xb".padEnd(42, "2"), relevanceScore: 0.7 });
  const r3 = row({ id: 3, sellerAddress: "0xc".padEnd(42, "3"), relevanceScore: 0.6 });
  const r4 = row({ id: 4, sellerAddress: "0xd".padEnd(42, "4"), relevanceScore: 0.5 });
  const r5 = row({ id: 5, sellerAddress: "0xe".padEnd(42, "5"), relevanceScore: 0.95 });

  const scores = new Map<string, SellerScore>([
    // r1: high-tier (>=700)
    [r1.sellerAddress, { subject: r1.sellerAddress as `0x${string}`, raw: 750, sampleSize: 20, components: {} as SellerScore["components"] }],
    // r2: mid-tier (passes minRep, below 700)
    [r2.sellerAddress, { subject: r2.sellerAddress as `0x${string}`, raw: 650, sampleSize: 10, components: {} as SellerScore["components"] }],
    // r3: high-tier with lower relevance — should still beat r2 on tier
    [r3.sellerAddress, { subject: r3.sellerAddress as `0x${string}`, raw: 800, sampleSize: 15, components: {} as SellerScore["components"] }],
    // r4: below minRep → filtered out
    [r4.sellerAddress, { subject: r4.sellerAddress as `0x${string}`, raw: 400, sampleSize: 10, components: {} as SellerScore["components"] }],
    // r5: sentinel (sampleSize<5) → passes but tier=1
    [r5.sellerAddress, { subject: r5.sellerAddress as `0x${string}`, raw: 500, sampleSize: 2, components: {} as SellerScore["components"] }]
  ]);

  const result = await recommendProducts("cheapest headphones", {
    prisma: fakePrisma,
    parseQuery: async () => fakeNLU(),
    search: fakeSearch([r1, r2, r3, r4, r5]),
    scoreSeller: fakeScorer(scores)
  });

  assert.strictEqual(result.candidates.length, 3);
  // Tier 2 (high-rep) first: r3 (rep 800 + rel 0.6) and r1 (rep 750 + rel 0.9).
  // Among tier 2, sort by relevance desc → r1, r3. Then sentinel r5.
  assert.deepStrictEqual(
    result.candidates.map((c) => c.product.id),
    [1, 3, 5]
  );
  assert.strictEqual(result.candidates[2]!.reputation.sentinel, true);
  assert.strictEqual(result.candidates[2]!.reputation.score, null);
  assert.strictEqual(result.pipeline.searchHits, 5);
  assert.strictEqual(result.pipeline.afterReputationFilter, 4); // r4 removed
  assert.strictEqual(result.pipeline.afterRiskFilter, 4);
});

test("all candidates below minReputation → empty result, pipeline still reports counts", async () => {
  const r = row({ sellerAddress: "0xff".padEnd(42, "9") });
  const scores = new Map<string, SellerScore>([
    [r.sellerAddress, { subject: r.sellerAddress as `0x${string}`, raw: 300, sampleSize: 10, components: {} as SellerScore["components"] }]
  ]);
  const result = await recommendProducts("anything", {
    prisma: fakePrisma,
    parseQuery: async () => fakeNLU(),
    search: fakeSearch([r]),
    scoreSeller: fakeScorer(scores)
  });
  assert.strictEqual(result.candidates.length, 0);
  assert.strictEqual(result.pipeline.searchHits, 1);
  assert.strictEqual(result.pipeline.afterReputationFilter, 0);
});

test("sentinel sellers retained with sentinel=true regardless of minReputation", async () => {
  const r = row({ sellerAddress: "0xab".padEnd(42, "0") });
  const scores = new Map<string, SellerScore>([
    [r.sellerAddress, { subject: r.sellerAddress as `0x${string}`, raw: 500, sampleSize: 1, components: {} as SellerScore["components"] }]
  ]);
  const result = await recommendProducts("anything", {
    prisma: fakePrisma,
    parseQuery: async () => fakeNLU(),
    search: fakeSearch([r]),
    scoreSeller: fakeScorer(scores)
  });
  assert.strictEqual(result.candidates.length, 1);
  assert.strictEqual(result.candidates[0]!.reputation.sentinel, true);
  assert.strictEqual(result.candidates[0]!.reputation.score, null);
  assert.strictEqual(result.candidates[0]!.reputation.sampleSize, 1);
});

test("usage propagates from NLU into result", async () => {
  const r = row();
  const scores = new Map<string, SellerScore>([
    [r.sellerAddress, { subject: r.sellerAddress as `0x${string}`, raw: 800, sampleSize: 20, components: {} as SellerScore["components"] }]
  ]);
  const result = await recommendProducts("anything", {
    prisma: fakePrisma,
    parseQuery: async () => fakeNLU(),
    search: fakeSearch([r]),
    scoreSeller: fakeScorer(scores)
  });
  assert.strictEqual(result.usage.inputTokens, 1200);
  assert.strictEqual(result.usage.outputTokens, 50);
  assert.strictEqual(result.usage.costUsd, 0.004);
  // sanity: default min reputation respected so test is meaningful
  assert.ok(DEFAULT_MIN_REPUTATION === 600);
});
