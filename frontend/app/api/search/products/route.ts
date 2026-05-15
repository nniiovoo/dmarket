import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { withErrorBoundary } from "@/lib/api/withErrorBoundary";
import { prisma } from "@/lib/db";
import { createRateLimiter } from "@/lib/rateLimit";
import { SearchInputError, searchProducts, type SearchSortBy } from "@/lib/search/products";
import { SUPPORTED_CHAIN_IDS } from "@/lib/validation";

export const dynamic = "force-dynamic";

const SORT_BY_VALUES: readonly SearchSortBy[] = ["relevance", "price_asc", "price_desc", "recent"];

// Per-IP rate limit. Search hits two heavy SQL queries each (results +
// total), so a tighter cap than the read-only reputation endpoint.
const ipLimiter = createRateLimiter({ name: "search-products-ip", max: 30, windowMs: 60 * 1000 });

const querySchema = z.object({
  q: z.string().max(200).optional(),
  priceMaxWei: z
    .string()
    .regex(/^\d+$/, "priceMaxWei must be a non-negative integer string")
    .optional(),
  priceMinWei: z
    .string()
    .regex(/^\d+$/, "priceMinWei must be a non-negative integer string")
    .optional(),
  chainId: z.coerce
    .number()
    .int()
    .refine(
      (value) => SUPPORTED_CHAIN_IDS.includes(value as (typeof SUPPORTED_CHAIN_IDS)[number]),
      { message: "Unsupported chain" }
    )
    .optional(),
  sortBy: z.enum(SORT_BY_VALUES as [SearchSortBy, ...SearchSortBy[]]).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  offset: z.coerce.number().int().min(0).optional()
});

export const GET = withErrorBoundary(async (request: NextRequest) => {
  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams.entries()));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown";
  const ipResult = await ipLimiter.check(ip);
  if (!ipResult.ok) {
    return NextResponse.json({ error: "Rate limit exceeded", resetAt: ipResult.resetAt }, { status: 429 });
  }

  try {
    const result = await searchProducts(prisma, {
      q: parsed.data.q,
      priceMaxWei: parsed.data.priceMaxWei !== undefined ? BigInt(parsed.data.priceMaxWei) : undefined,
      priceMinWei: parsed.data.priceMinWei !== undefined ? BigInt(parsed.data.priceMinWei) : undefined,
      chainId: parsed.data.chainId,
      sortBy: parsed.data.sortBy,
      limit: parsed.data.limit,
      offset: parsed.data.offset
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof SearchInputError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
});
