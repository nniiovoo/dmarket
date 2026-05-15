import type { PrismaClient } from "@prisma/client";
import { getAddress, type Address } from "viem";

import { evaluate } from "@/lib/risk/engine";
import { defaultRules } from "@/lib/risk/defaultRules";
import { computeSellerScore } from "@/lib/reputation/score";
import { searchProducts, type SearchResultRow, type SearchProductsInput } from "@/lib/search/products";

import { parseUserQuery } from "./nlu";
import type { Confidence } from "./nlu";
import { addUsage, emptyUsage, type TokenUsage } from "./llm";

// Phase I.2 product recommender. Composes three stages:
//
//   1. parseUserQuery(query)   → SearchProductsInput  (Claude tool-use)
//   2. searchProducts(input)   → ranked candidate rows (Phase I.1)
//   3. reputation + risk pass  → at most 3 winners
//
// The reputation pass calls computeSellerScore directly (no HTTP round
// trip); risk uses the same `defaultRules` the rest of the app does.
// Each step's output is logged in the returned `pipeline` block so the
// UI can show the funnel ("23 search hits → 8 above reputation floor →
// 5 risk-clean → 3 displayed").

export const DEFAULT_MIN_REPUTATION = 600;
const MAX_CANDIDATES = 3;
// SellerScore.sampleSize threshold below which the formula returns a
// sentinel (500) rather than a meaningful score. Mirrored from
// frontend/lib/reputation/score.ts MIN_SAMPLE_SIZE. We don't want to
// reject a brand-new seller out of hand — sentinel rows pass the
// reputation gate with a `sentinel: true` marker so the UI can call
// them out.
const REPUTATION_SAMPLE_FLOOR = 5;

export interface CandidateReputation {
  score: number | null;
  sampleSize: number;
  sentinel: boolean;
}

export interface CandidateWithMeta {
  product: SearchResultRow;
  reputation: CandidateReputation;
  reasoning: string;
}

export interface RecommendOptions {
  minReputation?: number;
  searchMultiplier?: number; // how many extra candidates to fetch
}

export interface RecommendPipelineStats {
  searchHits: number;
  afterReputationFilter: number;
  afterRiskFilter: number;
}

export interface RecommendResult {
  parsed: SearchProductsInput;
  confidence: Confidence;
  explanation: string;
  candidates: CandidateWithMeta[];
  usage: TokenUsage;
  pipeline: RecommendPipelineStats;
}

export interface RecommendDependencies {
  prisma: PrismaClient;
  // Test-injectable seams (default to the production implementations).
  parseQuery?: typeof parseUserQuery;
  search?: typeof searchProducts;
  scoreSeller?: typeof computeSellerScore;
}

export async function recommendProducts(
  query: string,
  deps: RecommendDependencies,
  options: RecommendOptions = {}
): Promise<RecommendResult> {
  const minReputation = options.minReputation ?? DEFAULT_MIN_REPUTATION;
  const searchMultiplier = options.searchMultiplier ?? 3;
  const parseQuery = deps.parseQuery ?? parseUserQuery;
  const search = deps.search ?? searchProducts;
  const scoreSeller = deps.scoreSeller ?? computeSellerScore;

  const nlu = await parseQuery(query);

  // Pull a wider candidate window than we'll display — filters below can
  // reject up to ~50% in practice, and refetching with a higher offset
  // is more expensive than overfetching by 3x.
  const requestedLimit = nlu.parsed.limit ?? 10;
  const widenedLimit = Math.min(requestedLimit * searchMultiplier, 60);
  const searchResult = await search(deps.prisma, { ...nlu.parsed, limit: widenedLimit });

  const searchHits = searchResult.results.length;
  // NLU is the only API-spending step today; reputation + risk are pure
  // DB reads. If recommend ever issues a second LLM call (e.g. a
  // re-rank pass), switch this to a let + addUsage(...) accumulator.
  const usage: TokenUsage = nlu.usage;

  // Reputation pass. Compute per unique seller so a seller with many
  // listings only pays one score-compute. Sentinel sellers pass through
  // with sentinel=true; meaningful scores must be >= minReputation.
  const uniqueSellers = Array.from(new Set(searchResult.results.map((r) => r.sellerAddress.toLowerCase())));
  const scoreBySeller = new Map<string, CandidateReputation>();
  for (const sellerLower of uniqueSellers) {
    const subject = getAddress(sellerLower) as Address;
    const sellerScore = await scoreSeller(subject, deps.prisma);
    const sentinel = sellerScore.sampleSize < REPUTATION_SAMPLE_FLOOR;
    scoreBySeller.set(sellerLower, {
      score: sentinel ? null : sellerScore.raw,
      sampleSize: sellerScore.sampleSize,
      sentinel
    });
  }

  const reputationFiltered = searchResult.results.filter((row) => {
    const rep = scoreBySeller.get(row.sellerAddress.toLowerCase());
    if (!rep) return false;
    if (rep.sentinel) return true; // new sellers pass for visibility
    return (rep.score ?? 0) >= minReputation;
  });

  // Risk pass. The default rule set only blocks on
  // `seller.address ∈ SELLER_BLOCKLIST`, but threading the call through
  // `evaluate` future-proofs us against new rules added there.
  const riskFiltered = reputationFiltered.filter((row) => {
    const facts = {
      seller: { address: row.sellerAddress.toLowerCase() },
      order: { amountUsd: 0 },
      buyer: { accountAgeDays: 999 }
    };
    const results = evaluate(facts, defaultRules);
    return !results.some((r) => r.action.type === "block");
  });

  // Two-key sort: reputation tier (>=700 first), then relevance.
  // Sentinel sellers sit in the "no on-chain score" bucket — we treat
  // them as below the high-trust bucket but above genuinely low scores.
  const ordered = [...riskFiltered].sort((a, b) => {
    const aRep = scoreBySeller.get(a.sellerAddress.toLowerCase())!;
    const bRep = scoreBySeller.get(b.sellerAddress.toLowerCase())!;
    const aTier = tierFor(aRep);
    const bTier = tierFor(bRep);
    if (aTier !== bTier) return bTier - aTier;
    return b.relevanceScore - a.relevanceScore;
  });

  const candidates: CandidateWithMeta[] = ordered.slice(0, MAX_CANDIDATES).map((row) => {
    const rep = scoreBySeller.get(row.sellerAddress.toLowerCase())!;
    return {
      product: row,
      reputation: rep,
      reasoning: buildReasoning(row, rep)
    };
  });

  return {
    parsed: nlu.parsed,
    confidence: nlu.confidence,
    explanation: nlu.explanation,
    candidates,
    usage,
    pipeline: {
      searchHits,
      afterReputationFilter: reputationFiltered.length,
      afterRiskFilter: riskFiltered.length
    }
  };

  function tierFor(rep: CandidateReputation): number {
    if (!rep.sentinel && rep.score !== null && rep.score >= 700) return 2;
    if (rep.sentinel) return 1;
    return 0;
  }
}

function buildReasoning(product: SearchResultRow, rep: CandidateReputation): string {
  const parts: string[] = [];
  if (rep.sentinel) {
    parts.push(`Seller has only ${rep.sampleSize} order(s) — no on-chain score yet`);
  } else if (rep.score !== null) {
    parts.push(`Seller score ${rep.score}/1000 across ${rep.sampleSize} orders`);
  }
  if (product.relevanceScore > 0) {
    parts.push(`relevance ${product.relevanceScore.toFixed(2)}`);
  }
  return parts.join("; ") || "Matched search query";
}

// Surface helper for callers (route + tests) that want to start with an
// empty accumulator.
export function emptyResultUsage(): TokenUsage {
  return addUsage(emptyUsage(), emptyUsage());
}
