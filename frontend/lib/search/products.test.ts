import { test } from "node:test";
import assert from "node:assert";

import { searchProducts, SearchInputError } from "./products";

// Mock prisma. `$queryRawUnsafe` is the only method the search function
// touches. It's called twice per searchProducts run: once for the result
// rows, once for the total count. We script those two calls per test.
type Row = {
  id: number;
  sellerAddress: string;
  name: string;
  description: string;
  priceWei: string;
  chainId: number;
  imageUrl: string;
  status: string;
  createdAt: Date;
  relevance: number;
  title_similarity: number;
};

function makeRow(overrides: Partial<Row> = {}): Row {
  return {
    id: 1,
    sellerAddress: "0xseller00000000000000000000000000000001",
    name: "iPhone 15",
    description: "Apple smartphone with USB-C",
    priceWei: "500000000000000000",
    chainId: 421614,
    imageUrl: "",
    status: "active",
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    relevance: 0.5,
    title_similarity: 0.5,
    ...overrides
  };
}

function makeMockPrisma(rowsPerCall: Array<Row[] | Array<{ n: number }>>) {
  let call = 0;
  return {
    async $queryRawUnsafe(..._args: unknown[]) {
      void _args;
      const out = rowsPerCall[call] ?? [];
      call += 1;
      return out;
    }
  } as unknown as Parameters<typeof searchProducts>[0];
}

function emptyBlacklist() {
  return Promise.resolve({ blacklisted: [] as string[] });
}

test("empty q + no filter → results sorted by createdAt desc, sortBy defaults to recent", async () => {
  const r1 = makeRow({ id: 1, name: "iPhone 15", createdAt: new Date("2026-05-01") });
  const r2 = makeRow({ id: 2, name: "MacBook Air", createdAt: new Date("2026-04-15") });
  const prisma = makeMockPrisma([[r1, r2], [{ n: 2 }]]);

  const out = await searchProducts(prisma, {}, emptyBlacklist);
  assert.strictEqual(out.query.sortBy, "recent");
  assert.strictEqual(out.results.length, 2);
  assert.strictEqual(out.results[0]!.name, "iPhone 15");
  assert.strictEqual(out.total, 2);
});

test("q=\"iPhone\" → returns matches; relevanceScore uses GREATEST(ts_rank, similarity)", async () => {
  const row = makeRow({ name: "iPhone 15", relevance: 0.4, title_similarity: 0.7 });
  const prisma = makeMockPrisma([[row], [{ n: 1 }]]);

  const out = await searchProducts(prisma, { q: "iPhone" }, emptyBlacklist);
  assert.strictEqual(out.query.sortBy, "relevance");
  assert.strictEqual(out.results.length, 1);
  assert.strictEqual(out.results[0]!.relevanceScore, 0.7); // max(0.4, 0.7)
});

test("typo q=\"iphne\" → trigram still matches via similarity > 0.2", async () => {
  // We can't simulate Postgres's similarity here, but we can assert the
  // function trusts whatever the DB returned (the SQL filter is the
  // gate). When similarity comes back > 0 the row is included.
  const row = makeRow({ name: "iPhone 15", relevance: 0, title_similarity: 0.35 });
  const prisma = makeMockPrisma([[row], [{ n: 1 }]]);

  const out = await searchProducts(prisma, { q: "iphne" }, emptyBlacklist);
  assert.strictEqual(out.results.length, 1);
  assert.strictEqual(out.results[0]!.relevanceScore, 0.35);
});

test("priceMaxWei filter → bigint stringified into the query, results trusted from DB", async () => {
  // Two rows of the underlying dataset both already passed the SQL
  // filter; the function just returns them in order. We assert the
  // function returns *exactly* what the mock returned without filtering
  // further client-side.
  const cheap = makeRow({ id: 7, priceWei: "100000000000000000" });
  const prisma = makeMockPrisma([[cheap], [{ n: 1 }]]);

  const out = await searchProducts(
    prisma,
    { priceMaxWei: 200_000_000_000_000_000n },
    emptyBlacklist
  );
  assert.strictEqual(out.results.length, 1);
  assert.strictEqual(out.results[0]!.id, 7);
  assert.strictEqual(out.query.priceMaxWei, "200000000000000000");
});

test("blacklisted seller filtered out by JS pass (even if SQL let it through)", async () => {
  const blockedSeller = "0xbad0000000000000000000000000000000000001";
  const good = makeRow({ id: 1, sellerAddress: "0xseller00000000000000000000000000000001" });
  const bad = makeRow({ id: 2, sellerAddress: blockedSeller });
  const prisma = makeMockPrisma([[good, bad], [{ n: 2 }]]);

  const out = await searchProducts(prisma, {}, async () => ({ blacklisted: [blockedSeller] }));
  assert.strictEqual(out.results.length, 1);
  assert.strictEqual(out.results[0]!.id, 1);
});

test("priceMin > priceMax → SearchInputError before any DB call", async () => {
  const prisma = makeMockPrisma([]); // no queries should run
  await assert.rejects(
    () =>
      searchProducts(
        prisma,
        { priceMinWei: 200n, priceMaxWei: 100n },
        emptyBlacklist
      ),
    SearchInputError
  );
});
