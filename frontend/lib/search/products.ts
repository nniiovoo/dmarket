import type { PrismaClient } from "@prisma/client";

import { loadBlacklistFacts } from "@/lib/risk/integrations/blacklist";

// Phase I.1 product search. Postgres full-text + trigram. Designed so
// Phase I.2 (NLU) can call this directly without an HTTP round-trip —
// `searchProducts` takes a structured input the NLU stage will produce.
//
// Blacklist filtering happens twice on purpose:
//   1. SQL-level `NOT EXISTS (SELECT FROM Blacklist)` — fast, avoids
//      paginating over rows we'd then throw away.
//   2. A second pass in JS via `loadBlacklistFacts` — same source of
//      truth, but matches the path the rest of the app exercises, so
//      future changes to that helper (e.g. an in-memory cache) take
//      effect here too. The SQL filter is strictly a superset; the JS
//      pass usually returns the same rows.

export type SearchSortBy = "relevance" | "price_asc" | "price_desc" | "recent";

export interface SearchProductsInput {
  q?: string;
  priceMaxWei?: bigint;
  priceMinWei?: bigint;
  chainId?: number;
  sortBy?: SearchSortBy;
  limit?: number;
  offset?: number;
}

export interface SearchResultRow {
  id: number;
  name: string;
  description: string;
  priceWei: string;
  sellerAddress: string;
  chainId: number;
  imageUrl: string;
  status: string;
  createdAt: string; // ISO
  relevanceScore: number; // 0..1
}

export interface SearchProductsResult {
  results: SearchResultRow[];
  total: number;
  query: {
    q: string;
    priceMaxWei: string | null;
    priceMinWei: string | null;
    chainId: number | null;
    sortBy: SearchSortBy;
    limit: number;
    offset: number;
  };
}

export class SearchInputError extends Error {}

const LIMIT_MAX = 50;
const LIMIT_DEFAULT = 20;
const TRIGRAM_THRESHOLD = 0.2; // pg_trgm similarity floor

type RawRow = {
  id: number;
  sellerAddress: string;
  name: string;
  description: string;
  priceWei: string;
  chainId: number;
  imageUrl: string;
  status: string;
  createdAt: Date;
  relevance: number | null;
  title_similarity: number | null;
};

export async function searchProducts(
  prisma: PrismaClient,
  input: SearchProductsInput,
  loadFacts: typeof loadBlacklistFacts = loadBlacklistFacts
): Promise<SearchProductsResult> {
  const q = (input.q ?? "").trim();
  const priceMaxWei = input.priceMaxWei ?? null;
  const priceMinWei = input.priceMinWei ?? null;
  const chainId = input.chainId ?? null;
  const sortBy: SearchSortBy = input.sortBy ?? (q ? "relevance" : "recent");
  const limit = Math.min(LIMIT_MAX, Math.max(1, input.limit ?? LIMIT_DEFAULT));
  const offset = Math.max(0, input.offset ?? 0);

  if (priceMaxWei !== null && priceMinWei !== null && priceMinWei > priceMaxWei) {
    throw new SearchInputError("priceMinWei greater than priceMaxWei");
  }

  // Pull a wider window so the JS-side blacklist pass doesn't shrink the
  // user-visible page below `limit`. Worst-case it equals what the SQL
  // already filtered to.
  const fetchLimit = limit * 2;

  const rows = (await prisma.$queryRawUnsafe(
    `
    SELECT
      p.id, p."sellerAddress", p."name", p."description", p."priceWei",
      p."chainId", p."imageUrl", p."status", p."createdAt",
      CASE WHEN $1 = '' THEN 0
           ELSE ts_rank(p."searchVector", websearch_to_tsquery('english', $1)) END AS relevance,
      CASE WHEN $1 = '' THEN 0
           ELSE similarity(p."name", $1) END AS title_similarity
    FROM "Product" p
    WHERE
      p."status" = 'active'
      AND (
        $1 = ''
        OR p."searchVector" @@ websearch_to_tsquery('english', $1)
        OR similarity(p."name", $1) > ${TRIGRAM_THRESHOLD}
      )
      AND ($2::numeric IS NULL OR p."priceWei"::numeric <= $2)
      AND ($3::numeric IS NULL OR p."priceWei"::numeric >= $3)
      AND ($4::int     IS NULL OR p."chainId" = $4)
      AND NOT EXISTS (
        SELECT 1 FROM "Blacklist" b
        WHERE LOWER(b."address") = LOWER(p."sellerAddress")
      )
    ORDER BY
      CASE WHEN $5 = 'relevance'
           THEN GREATEST(
             CASE WHEN $1 = '' THEN 0
                  ELSE ts_rank(p."searchVector", websearch_to_tsquery('english', $1)) END,
             CASE WHEN $1 = '' THEN 0
                  ELSE similarity(p."name", $1) END
           ) END DESC NULLS LAST,
      CASE WHEN $5 = 'price_asc'  THEN p."priceWei"::numeric END ASC NULLS LAST,
      CASE WHEN $5 = 'price_desc' THEN p."priceWei"::numeric END DESC NULLS LAST,
      CASE WHEN $5 = 'recent'     THEN p."createdAt" END DESC NULLS LAST,
      p."createdAt" DESC
    LIMIT $6 OFFSET $7
    `,
    q,
    priceMaxWei !== null ? priceMaxWei.toString() : null,
    priceMinWei !== null ? priceMinWei.toString() : null,
    chainId,
    sortBy,
    fetchLimit,
    offset
  )) as RawRow[];

  const uniqueSellers = Array.from(new Set(rows.map((r) => r.sellerAddress)));
  const { blacklisted } = await loadFacts(uniqueSellers);
  const blockedSet = new Set(blacklisted.map((a) => a.toLowerCase()));
  const filtered = rows.filter((r) => !blockedSet.has(r.sellerAddress.toLowerCase()));

  const results: SearchResultRow[] = filtered.slice(0, limit).map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    priceWei: r.priceWei,
    sellerAddress: r.sellerAddress,
    chainId: r.chainId,
    imageUrl: r.imageUrl,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    relevanceScore: clamp01(Math.max(r.relevance ?? 0, r.title_similarity ?? 0))
  }));

  const totalRaw = (await prisma.$queryRawUnsafe(
    `
    SELECT COUNT(*)::int AS n FROM "Product" p
    WHERE
      p."status" = 'active'
      AND (
        $1 = ''
        OR p."searchVector" @@ websearch_to_tsquery('english', $1)
        OR similarity(p."name", $1) > ${TRIGRAM_THRESHOLD}
      )
      AND ($2::numeric IS NULL OR p."priceWei"::numeric <= $2)
      AND ($3::numeric IS NULL OR p."priceWei"::numeric >= $3)
      AND ($4::int     IS NULL OR p."chainId" = $4)
      AND NOT EXISTS (
        SELECT 1 FROM "Blacklist" b WHERE LOWER(b."address") = LOWER(p."sellerAddress")
      )
    `,
    q,
    priceMaxWei !== null ? priceMaxWei.toString() : null,
    priceMinWei !== null ? priceMinWei.toString() : null,
    chainId
  )) as Array<{ n: number }>;
  const total = totalRaw[0]?.n ?? 0;

  return {
    results,
    total,
    query: {
      q,
      priceMaxWei: priceMaxWei !== null ? priceMaxWei.toString() : null,
      priceMinWei: priceMinWei !== null ? priceMinWei.toString() : null,
      chainId,
      sortBy,
      limit,
      offset
    }
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
