// Lightweight status endpoint for the JSON-RPC proxy.
//
// Returns counters + latency p50/p95 collected in-process. Plain JSON shape —
// a Prometheus exporter can be layered on later if needed.
//
// TODO(prod): gate this behind an auth header or internal-network check before
// exposing publicly. It carries no secrets today, but it does leak traffic
// shape (per-chain RPC volume / cache hit rate) which is fingerprinting bait.

import { NextResponse } from "next/server";

import { snapshotMetrics } from "@/lib/api/rpcMetrics";

export const dynamic = "force-dynamic";

const startedAt = Date.now();

export async function GET() {
  const { counters, latency } = snapshotMetrics();
  return NextResponse.json({
    ok: true,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    counters,
    latency
  });
}
