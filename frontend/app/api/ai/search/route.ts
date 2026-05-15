// POST /api/ai/search — public, auth'd product search endpoint.
//
// Wraps the Phase I.2 recommend pipeline (NLU + reputation/risk filter +
// top-3 selection) behind dual-auth (SIWE session OR OAuth Bearer JWT).
// The recommend handler at /api/ai/recommend is intentionally kept open
// for our own staging UI; this public endpoint is what the GPT/MCP
// integration talks to.

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { withErrorBoundary } from "@/lib/api/withErrorBoundary";
import { addCost, checkBudget } from "@/lib/ai/budget";
import { LLMConfigError } from "@/lib/ai/llm";
import { NLUParseError, NLUSchemaError } from "@/lib/ai/nlu";
import { recommendProducts } from "@/lib/ai/recommend";
import { requireAuth } from "@/lib/ai/auth";
import { prisma } from "@/lib/db";
import { createRateLimiter } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  query: z.string().min(1).max(500)
});

const DEFAULT_PER_MINUTE_LIMIT = 20;

function getRateLimit(): number {
  const raw = process.env.AI_PUBLIC_RATE_LIMIT_PER_MINUTE;
  if (!raw) return DEFAULT_PER_MINUTE_LIMIT;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_PER_MINUTE_LIMIT;
  return Math.floor(value);
}

const limiter = createRateLimiter({
  name: "ai-public-search",
  max: getRateLimit(),
  windowMs: 60 * 1000
});

export const POST = withErrorBoundary(async (request: NextRequest) => {
  const requestId = randomUUID();

  const auth = await requireAuth(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error, reason: auth.reason, requestId }, { status: auth.status });
  }

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

  // Rate-limit and budget per-address so the same wallet can't open many
  // OAuth tokens to dodge the cap.
  const bucketKey = auth.caller.address.toLowerCase();

  const limit = await limiter.check(bucketKey);
  if (!limit.ok) {
    return NextResponse.json(
      { error: "Rate limit exceeded", resetAt: limit.resetAt, requestId },
      { status: 429 }
    );
  }

  const budget = checkBudget(bucketKey);
  if (!budget.ok) {
    return NextResponse.json(
      {
        error: "Daily AI budget exceeded for this account",
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
    addCost(bucketKey, recommendation.usage.costUsd);
    return NextResponse.json({
      recommendation,
      caller: { address: auth.caller.address, via: auth.caller.via },
      requestId
    });
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
