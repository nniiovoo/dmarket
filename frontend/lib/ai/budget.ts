// Per-IP daily USD budget for AI endpoints. Matches the in-memory-fallback
// shape of `lib/rateLimit.ts`: production hosts behind a load balancer
// SHOULD point this at Redis (Upstash REST works) so multi-instance
// deployments share the counter. For now we keep an in-process Map +
// 24h TTL.

const DEFAULT_DAILY_CAP_USD = 1.0;

interface BudgetEntry {
  costUsd: number;
  resetAt: number; // unix ms when the entry expires
}

const memStore = new Map<string, BudgetEntry>();

export interface BudgetCheckResult {
  ok: boolean;
  costUsdSoFar: number;
  capUsd: number;
  resetAt: number;
}

export function getDailyCapUsd(): number {
  const raw = process.env.AI_QUERY_DAILY_USD_CAP;
  if (!raw) return DEFAULT_DAILY_CAP_USD;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_DAILY_CAP_USD;
  return value;
}

// Check whether `key` is over budget. Pure read — call before issuing
// the expensive request. The caller adds the realised cost via
// `addCost(...)` after the request completes.
export function checkBudget(key: string, capUsd: number = getDailyCapUsd()): BudgetCheckResult {
  const now = Date.now();
  const entry = memStore.get(key);
  if (!entry || entry.resetAt <= now) {
    return { ok: true, costUsdSoFar: 0, capUsd, resetAt: now + 24 * 60 * 60 * 1000 };
  }
  return {
    ok: entry.costUsd < capUsd,
    costUsdSoFar: entry.costUsd,
    capUsd,
    resetAt: entry.resetAt
  };
}

export function addCost(key: string, costUsd: number, capUsd: number = getDailyCapUsd()): BudgetCheckResult {
  const now = Date.now();
  const existing = memStore.get(key);
  const isFresh = !existing || existing.resetAt <= now;
  const resetAt = isFresh ? now + 24 * 60 * 60 * 1000 : existing!.resetAt;
  const nextCost = (isFresh ? 0 : existing!.costUsd) + costUsd;
  memStore.set(key, { costUsd: nextCost, resetAt });
  return { ok: nextCost < capUsd, costUsdSoFar: nextCost, capUsd, resetAt };
}

// Test seam
export function __resetBudgetForTesting(): void {
  memStore.clear();
}
