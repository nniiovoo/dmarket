// Smoke test for the JSON-RPC proxy LRU cache + metrics wiring.
// Run with: npx tsx scripts/smokeRpcCache.ts
//
// Fakes globalThis.fetch (the upstream) and invokes the POST handler twice
// to assert that the second call is served from cache.

import {
  __cacheClearForTests,
  cacheKeyFor,
  cacheGet,
  cacheSet,
  snapshotMetrics
} from "../lib/api/rpcMetrics";

process.env.SEPOLIA_RPC_URL = "http://upstream.invalid/rpc";

let upstreamCalls = 0;
const fakeFetch: typeof fetch = async () => {
  upstreamCalls += 1;
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x123" }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
};
globalThis.fetch = fakeFetch;

const { POST } = await import("../app/api/rpc/[chain]/route");

function mkRequest(body: unknown) {
  return new Request("http://test/api/rpc/sepolia", {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": "10.0.0.1" },
    body: JSON.stringify(body)
  }) as unknown as Parameters<typeof POST>[0];
}

function ctx() {
  return { params: Promise.resolve({ chain: "sepolia" }) } as Parameters<typeof POST>[1];
}

function assert(label: string, cond: unknown): void {
  if (!cond) {
    console.error(`FAIL ${label}`);
    process.exit(1);
  }
  console.log(`PASS ${label}`);
}

__cacheClearForTests();

// 1) eth_blockNumber: first call hits upstream, second is cached.
upstreamCalls = 0;
const bn1 = await POST(mkRequest({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber" }), ctx());
const bn2 = await POST(mkRequest({ jsonrpc: "2.0", id: 2, method: "eth_blockNumber" }), ctx());
assert("eth_blockNumber upstream called once", upstreamCalls === 1);
assert("eth_blockNumber first ok", bn1.status === 200);
assert("eth_blockNumber second served from cache", bn2.status === 200);

// 2) eth_call: cache key derived from to/data/blockTag.
upstreamCalls = 0;
const callBody = {
  jsonrpc: "2.0",
  id: 1,
  method: "eth_call",
  params: [{ to: "0xabc", data: "0xdead" }, "latest"]
};
await POST(mkRequest(callBody), ctx());
await POST(mkRequest({ ...callBody, id: 2 }), ctx());
assert("eth_call upstream called once", upstreamCalls === 1);

// 3) Cache key contract: same inputs -> same key, blockTag matters.
const k1 = cacheKeyFor("sepolia", "eth_call", [{ to: "0xA", data: "0x1" }, "latest"]);
const k2 = cacheKeyFor("sepolia", "eth_call", [{ to: "0xa", data: "0x1" }, "latest"]);
const k3 = cacheKeyFor("sepolia", "eth_call", [{ to: "0xA", data: "0x1" }, "pending"]);
assert("cache key case-insensitive on to", k1?.key === k2?.key);
assert("cache key sensitive to blockTag", k1?.key !== k3?.key);

// 4) Non-cacheable method returns null.
assert("eth_chainId not cached", cacheKeyFor("sepolia", "eth_chainId", []) === null);

// 5) TTL expiry: set with 1ms TTL, wait, expect miss.
cacheSet("ttl-test", { result: "x" }, 1);
await new Promise((r) => setTimeout(r, 5));
assert("ttl expired entry purged on get", cacheGet("ttl-test") === undefined);

// 6) Counters incremented.
const snap = snapshotMetrics();
const okCount = snap.counters.rpc_requests_total
  .filter((c) => c.labels.status === "ok")
  .reduce((a, b) => a + b.value, 0);
const hitCount = snap.counters.rpc_requests_total
  .filter((c) => c.labels.status === "cache_hit")
  .reduce((a, b) => a + b.value, 0);
assert("ok count >= 2", okCount >= 2);
assert("cache_hit count >= 2", hitCount >= 2);

console.log("ALL PASS");
