/**
 * Smoke test for the pure-computation helpers exported from
 * app/api/indexer/metrics/route.ts. Tests all four status branches.
 */

import { buildChainMetrics, computeStatus } from "../app/api/indexer/metrics/route";
import type { ChainMetric } from "../app/api/indexer/metrics/route";

const NOW = 1_700_000_000_000; // fixed epoch ms

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`PASS: ${msg}`);
}

// ---------- computeStatus unit tests ----------

assert(
  computeStatus(undefined, 1000, NOW) === "uninitialized",
  "uninitialized when cursor missing"
);

assert(
  computeStatus({ chainId: 1, lastBlock: 100n, updatedAt: new Date(NOW - 10_000) }, null, NOW) ===
    "unknown",
  "unknown when head fetch failed"
);

assert(
  computeStatus(
    { chainId: 1, lastBlock: 1000n, updatedAt: new Date(NOW - 30_000) },
    1010,
    NOW
  ) === "healthy",
  "healthy when lag <= 50 and age <= 90s"
);

assert(
  computeStatus(
    { chainId: 1, lastBlock: 1000n, updatedAt: new Date(NOW - 30_000) },
    1060,
    NOW
  ) === "stale",
  "stale when blockLag > 50"
);

assert(
  computeStatus(
    { chainId: 1, lastBlock: 1000n, updatedAt: new Date(NOW - 100_000) },
    1010,
    NOW
  ) === "stale",
  "stale when secondsSinceUpdate > 90"
);

// ---------- buildChainMetrics integration tests ----------

type FakeConfig = { chainId: number; version: "v3" | "v3_1"; rpcUrl: string | undefined };

// FAKE_CONFIGS_NO_RPC (below) is the one we actually exercise — without a real
// RPC server the helper returns null headBlock synchronously, which is enough
// to verify the four status branches without standing up a mock HTTP server.

const v3Cursors = [
  { chainId: 11155111, lastBlock: 1234n,  updatedAt: new Date(NOW - 10_000) },
  { chainId: 80002,    lastBlock: 500n,   updatedAt: new Date(NOW - 200_000) }, // age > 90s
  { chainId: 421614,   lastBlock: 900n,   updatedAt: new Date(NOW - 5_000) }
];
const v3_1Cursors: typeof v3Cursors = []; // empty → uninitialized for chainId 421614 v3_1

// Replace fetchHeadBlock logic — we stub via the configs:
// real getBlockNumber would need a live RPC. Instead, test buildChainMetrics
// by passing configs whose rpcUrl is undefined for the "unknown" branch.

const FAKE_CONFIGS_NO_RPC: FakeConfig[] = [
  { chainId: 11155111, version: "v3",    rpcUrl: undefined }, // unknown (no rpcUrl)
  { chainId: 421614,   version: "v3_1",  rpcUrl: undefined }, // uninitialized (no cursor)
  { chainId: 80002,    version: "v3",    rpcUrl: undefined }  // unknown (stale cursor but no head)
];

async function runBuildMetrics() {
  // With undefined rpcUrl the helper returns null headBlock synchronously.
  const results: ChainMetric[] = await buildChainMetrics(
    FAKE_CONFIGS_NO_RPC as Parameters<typeof buildChainMetrics>[0],
    v3Cursors,
    v3_1Cursors,
    NOW
  );

  // Chain 11155111 v3 — cursor exists, head = null → unknown
  const r0 = results[0];
  assert(r0.chainId === 11155111, "result[0] chainId is 11155111");
  assert(r0.status === "unknown", "result[0] status is unknown (no rpcUrl)");
  assert(r0.lastBlock === 1234, "result[0] lastBlock is 1234");
  assert(r0.headBlock === null, "result[0] headBlock is null");
  assert(r0.blockLag === null, "result[0] blockLag is null");

  // Chain 421614 v3_1 — no cursor → uninitialized
  const r1 = results[1];
  assert(r1.status === "uninitialized", "result[1] status is uninitialized");
  assert(r1.lastBlock === null, "result[1] lastBlock is null");

  // Chain 80002 v3 — cursor exists (age > 90s), head = null → unknown
  const r2 = results[2];
  assert(r2.chainId === 80002, "result[2] chainId is 80002");
  assert(r2.status === "unknown", "result[2] status is unknown");
}

runBuildMetrics()
  .then(() => {
    console.log("\nAll smoke tests passed.");
    process.exit(0);
  })
  .catch((err) => {
    console.error("Unexpected error:", err);
    process.exit(1);
  });
