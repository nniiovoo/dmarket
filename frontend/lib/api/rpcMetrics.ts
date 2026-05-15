// Lightweight in-memory helpers for the JSON-RPC proxy:
//   - LRU cache for eth_call / eth_blockNumber
//   - Request counters + latency samples
//   - Structured log helper (hashed IP)
//
// Single-process only. A multi-node deploy will need Redis / a real metrics
// sink; that's an explicit follow-up, not in scope here.

import { createHash } from "node:crypto";

// -----------------------------
// LRU cache
// -----------------------------

const CACHE_MAX_ENTRIES = 500;

type CacheEntry = { value: unknown; expiresAt: number };

// Map preserves insertion order — delete + set on hit refreshes recency,
// and the oldest entry is always the first iterator key for eviction.
const cache = new Map<string, CacheEntry>();

export function cacheGet(key: string): unknown | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  // Refresh recency.
  cache.delete(key);
  cache.set(key, entry);
  return entry.value;
}

export function cacheSet(key: string, value: unknown, ttlMs: number): void {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function cacheSize(): number {
  return cache.size;
}

// Exposed for the smoke script — production code shouldn't call this.
export function __cacheClearForTests(): void {
  cache.clear();
}

// Compute a cache key for a method+params pair, or null if not cacheable.
export function cacheKeyFor(
  chain: string,
  method: string,
  params: unknown
): { key: string; ttlMs: number } | null {
  if (method === "eth_blockNumber") {
    return { key: `${chain}|blockNumber`, ttlMs: 6_000 };
  }
  if (method === "eth_call" && Array.isArray(params)) {
    const call = params[0] as { to?: unknown; data?: unknown } | undefined;
    if (!call || typeof call !== "object") return null;
    const to = typeof call.to === "string" ? call.to.toLowerCase() : "";
    const data = typeof call.data === "string" ? call.data : "";
    const blockTag = typeof params[1] === "string" ? params[1] : "latest";
    if (!to || !data) return null;
    return { key: `${chain}|${to}|${data}|${blockTag}`, ttlMs: 12_000 };
  }
  return null;
}

// -----------------------------
// Counters + latency
// -----------------------------

export type RequestStatus =
  | "ok"
  | "cache_hit"
  | "rate_limited"
  | "method_not_allowed"
  | "upstream_error"
  | "bad_request";

type CounterKey = string; // `${chain}|${method}|${status}`
const requestCounters = new Map<CounterKey, number>();
const cacheHitCounters = new Map<string, number>(); // `${chain}|${method}`

const LATENCY_SAMPLE_CAP = 100;
const latencySamples = new Map<string, number[]>(); // chain -> recent ms

export function incRequest(chain: string, method: string, status: RequestStatus): void {
  const key = `${chain}|${method}|${status}`;
  requestCounters.set(key, (requestCounters.get(key) ?? 0) + 1);
}

export function incCacheHit(chain: string, method: string): void {
  const key = `${chain}|${method}`;
  cacheHitCounters.set(key, (cacheHitCounters.get(key) ?? 0) + 1);
}

export function recordLatency(chain: string, ms: number): void {
  let arr = latencySamples.get(chain);
  if (!arr) {
    arr = [];
    latencySamples.set(chain, arr);
  }
  arr.push(ms);
  if (arr.length > LATENCY_SAMPLE_CAP) arr.splice(0, arr.length - LATENCY_SAMPLE_CAP);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

type LabelObj = Record<string, string>;
type Counter = { labels: LabelObj; value: number };

function explodeRequestCounters(): Counter[] {
  const out: Counter[] = [];
  for (const [k, v] of requestCounters) {
    const [chain, method, status] = k.split("|");
    out.push({ labels: { chain: chain!, method: method!, status: status! }, value: v });
  }
  return out;
}

function explodeCacheHits(): Counter[] {
  const out: Counter[] = [];
  for (const [k, v] of cacheHitCounters) {
    const [chain, method] = k.split("|");
    out.push({ labels: { chain: chain!, method: method! }, value: v });
  }
  return out;
}

export function snapshotMetrics() {
  const latency: Record<string, { p50: number; p95: number; samples: number }> = {};
  for (const [chain, arr] of latencySamples) {
    const sorted = [...arr].sort((a, b) => a - b);
    latency[chain] = {
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      samples: arr.length
    };
  }
  return {
    counters: {
      rpc_requests_total: explodeRequestCounters(),
      rpc_cache_hits_total: explodeCacheHits()
    },
    latency
  };
}

// -----------------------------
// Logging helpers
// -----------------------------

export function hashIp(ip: string): string {
  return createHash("sha256").update(ip).digest("hex").slice(0, 8);
}

type LogFields = {
  ts: string;
  chain: string;
  method: string;
  status: RequestStatus;
  durationMs: number;
  ip: string;
};

export function logRequest(fields: LogFields): void {
  console.log(JSON.stringify(fields));
}
