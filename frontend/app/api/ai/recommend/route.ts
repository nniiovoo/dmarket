import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { withErrorBoundary } from "@/lib/api/withErrorBoundary";
import { addCost, checkBudget } from "@/lib/ai/budget";
import { LLMConfigError } from "@/lib/ai/llm";
import { NLUParseError, NLUSchemaError } from "@/lib/ai/nlu";
import { recommendProducts } from "@/lib/ai/recommend";
import { prisma } from "@/lib/db";
import { createRateLimiter } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  query: z.string().min(1).max(500)
});

const DEFAULT_PER_MINUTE_LIMIT = 10;

function getRateLimit(): number {
  const raw = process.env.AI_QUERY_RATE_LIMIT_PER_MINUTE;
  if (!raw) return DEFAULT_PER_MINUTE_LIMIT;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_PER_MINUTE_LIMIT;
  return Math.floor(value);
}

const limiter = createRateLimiter({
  name: "ai-recommend",
  max: getRateLimit(),
  windowMs: 60 * 1000
});

export const POST = withErrorBoundary(async (request: NextRequest) => {
  const requestId = randomUUID();

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body", requestId }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten(), requestId },
      { status: 400 }
    );
  }

  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown";

  const ipLimit = await limiter.check(ip);
  if (!ipLimit.ok) {
    return NextResponse.json(
      { error: "Rate limit exceeded", resetAt: ipLimit.resetAt, requestId },
      { status: 429 }
    );
  }

  const budget = checkBudget(ip);
  if (!budget.ok) {
    return NextResponse.json(
      {
        error: "Daily AI budget exceeded for this IP",
        costUsdSoFar: budget.costUsdSoFar,
        capUsd: budget.capUsd,
        resetAt: budget.resetAt,
        requestId
      },
      { status: 429 }
    );
  }

  try {
    const recommendation = await recommendProducts(parsed.data.query, { prisma });
    addCost(ip, recommendation.usage.costUsd);
    return NextResponse.json({ recommendation, requestId });
  } catch (err) {
    if (err instanceof LLMConfigError) {
      return NextResponse.json({ error: err.message, requestId }, { status: err.status });
    }
    if (err instanceof NLUParseError || err instanceof NLUSchemaError) {
      return NextResponse.json(
        { error: "Could not parse natural-language query", reason: err.message, requestId },
        { status: 502 }
      );
    }
    throw err;
  }
});
