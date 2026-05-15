export type RateLimitResult = { ok: boolean; remaining: number; resetAt: number };

export interface RateLimiter {
  check(key: string): Promise<RateLimitResult>;
}

export function isRedisEnabled(): boolean {
  return !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

// In-memory store shared across calls within the same process.
const memStore = new Map<string, { count: number; resetAt: number }>();

function memCheck(storeKey: string, max: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  const resetAt = now + windowMs;
  const entry = memStore.get(storeKey);

  if (!entry || entry.resetAt <= now) {
    memStore.set(storeKey, { count: 1, resetAt });
    return { ok: true, remaining: max - 1, resetAt };
  }

  if (entry.count >= max) {
    return { ok: false, remaining: 0, resetAt: entry.resetAt };
  }

  entry.count += 1;
  return { ok: true, remaining: max - entry.count, resetAt: entry.resetAt };
}

// Throttle warn logs to at most once per minute per limiter name.
const lastWarnAt = new Map<string, number>();

function maybeWarn(name: string, error: unknown): void {
  const now = Date.now();
  if ((lastWarnAt.get(name) ?? 0) + 60_000 > now) return;
  lastWarnAt.set(name, now);
  console.warn(JSON.stringify({ level: "warn", msg: "ratelimit_redis_unavailable", name, error: String(error) }));
}

async function redisCheck(
  url: string,
  token: string,
  storeKey: string,
  max: number,
  windowSec: number
): Promise<number> {
  const res = await fetch(`${url}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify([
      ["INCR", storeKey],
      ["EXPIRE", storeKey, String(windowSec), "NX"]
    ])
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as [{ result: number }, unknown];
  return body[0].result;
}

export function createRateLimiter(opts: { name: string; max: number; windowMs: number }): RateLimiter {
  const { name, max, windowMs } = opts;
  const windowSec = Math.ceil(windowMs / 1000);

  return {
    async check(key: string): Promise<RateLimitResult> {
      const storeKey = `rl:${name}:${key}`;

      if (!isRedisEnabled()) {
        return memCheck(storeKey, max, windowMs);
      }

      const url = process.env.UPSTASH_REDIS_REST_URL!;
      const token = process.env.UPSTASH_REDIS_REST_TOKEN!;

      try {
        const count = await redisCheck(url, token, storeKey, max, windowSec);
        const remaining = Math.max(0, max - count);
        return { ok: count <= max, remaining, resetAt: Date.now() + windowMs };
      } catch (err) {
        maybeWarn(name, err);
        return memCheck(storeKey, max, windowMs);
      }
    }
  };
}
