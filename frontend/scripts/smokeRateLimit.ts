/**
 * Smoke test for lib/rateLimit.ts  (<80 lines)
 * Run: npx tsx scripts/smokeRateLimit.ts
 */
import { createRateLimiter, isRedisEnabled } from "../lib/rateLimit";

function assert(condition: boolean, msg: string): void {
  if (!condition) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`PASS: ${msg}`);
}

// ── 1. Memory fallback (no Upstash env vars) ──────────────────────────────
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

assert(!isRedisEnabled(), "isRedisEnabled() is false when env vars absent");

const mem = createRateLimiter({ name: "smoke-mem", max: 2, windowMs: 60_000 });

async function runMemTests(): Promise<void> {
  const r1 = await mem.check("user1");
  assert(r1.ok && r1.remaining === 1, "call 1: ok, remaining=1");

  const r2 = await mem.check("user1");
  assert(r2.ok && r2.remaining === 0, "call 2: ok, remaining=0");

  const r3 = await mem.check("user1");
  assert(!r3.ok && r3.remaining === 0, "call 3: blocked, remaining=0");

  // Different key is independent.
  const r4 = await mem.check("user2");
  assert(r4.ok && r4.remaining === 1, "call 4 (user2): ok, remaining=1");

  // 7 more calls on user1, all must still be blocked (no throw).
  for (let i = 5; i <= 10; i++) {
    const r = await mem.check("user1");
    assert(!r.ok, `call ${i}: still blocked`);
  }
}

// ── 2. Redis path → fake URL → falls back silently, no throw ─────────────
async function runRedisFallbackTest(): Promise<void> {
  process.env.UPSTASH_REDIS_REST_URL = "https://fake.upstash.invalid";
  process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";

  assert(isRedisEnabled(), "isRedisEnabled() is true when env vars present");

  const redis = createRateLimiter({ name: "smoke-redis", max: 5, windowMs: 60_000 });

  let threw = false;
  let result;
  try {
    result = await redis.check("anykey");
  } catch {
    threw = true;
  }

  assert(!threw, "no exception thrown on Redis network failure");
  assert(result !== undefined && typeof result.ok === "boolean", "result has ok field");

  // Clean up env.
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
}

(async () => {
  await runMemTests();
  await runRedisFallbackTest();
  console.log("\nAll smoke tests passed.");
})();
