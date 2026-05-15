// Server-side JSON-RPC proxy.
//
// Reasons:
//   1. Keeps the paid RPC key (Alchemy / Infura) out of the client bundle.
//   2. Lets us rate-limit per IP independently of provider quota.
//   3. Single place to add caching / fan-out / observability later.
//
// Read methods only. Write methods (sending raw transactions) must stay on
// the wallet's own injected provider — relaying them through a server-held
// key is a security footgun (key custody for arbitrary user txs).
//
// Method routing matches the chain segment in the URL:
//   /api/rpc/sepolia          → SEPOLIA_RPC_URL (or NEXT_PUBLIC_*)
//   /api/rpc/polygon-amoy     → AMOY_RPC_URL    (or NEXT_PUBLIC_*)
//   /api/rpc/arbitrum-sepolia → ARBITRUM_SEPOLIA_RPC_URL (or NEXT_PUBLIC_*)

import { NextRequest, NextResponse } from "next/server";

import { withErrorBoundary } from "@/lib/api/withErrorBoundary";

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ chain: string }>;
};

// Whitelist of methods the proxy will forward. Everything else returns 405.
// Kept conservative — add new entries deliberately when the UI needs them.
const ALLOWED_METHODS = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_call",
  "eth_getLogs",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_getTransactionCount",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
  "eth_getBalance",
  "eth_getCode",
  "eth_getStorageAt",
  "net_version",
  "web3_clientVersion"
]);

// Per-IP rate limit. In-memory Map — fine for a single dev/server process;
// in a multi-node deploy this needs to move to Redis (noted in follow-ups).
// 300 calls / minute / IP is generous: a busy order detail page issues
// roughly 1 multicall every 12s, plus chat polling, well under 50/min.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 300;
const ipHits = new Map<string, { count: number; resetAt: number }>();

function checkIpRateLimit(ip: string): boolean {
  const now = Date.now();
  const current = ipHits.get(ip);
  if (!current || current.resetAt <= now) {
    ipHits.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (current.count >= RATE_LIMIT_MAX) return false;
  current.count += 1;
  return true;
}

function clientIp(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    // x-forwarded-for can be "ip1, ip2, ..." — first is the original client.
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = request.headers.get("x-real-ip");
  if (real) return real;
  return "unknown";
}

function upstreamUrlFor(chain: string): string | undefined {
  // Prefer server-only env vars (no NEXT_PUBLIC_ prefix) so the actual
  // upstream URL — including any embedded API key — never ships in the
  // client bundle. Fall back to NEXT_PUBLIC_* so a freshly-cloned repo
  // still works without an extra env setup step.
  if (chain === "sepolia") {
    return process.env.SEPOLIA_RPC_URL || process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL;
  }
  if (chain === "polygon-amoy") {
    return process.env.AMOY_RPC_URL || process.env.NEXT_PUBLIC_AMOY_RPC_URL;
  }
  if (chain === "arbitrum-sepolia") {
    return (
      process.env.ARBITRUM_SEPOLIA_RPC_URL ||
      process.env.NEXT_PUBLIC_ARBITRUM_SEPOLIA_RPC_URL
    );
  }
  return undefined;
}

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
};

function rejectBatch() {
  // We don't support JSON-RPC batches yet. Easy to add later by mapping each
  // sub-request through the method whitelist; for now keep the surface small.
  return NextResponse.json(
    { error: "Batched JSON-RPC requests are not supported by this proxy" },
    { status: 400 }
  );
}

export const POST = withErrorBoundary(async (request: NextRequest, context: RouteContext) => {
  const { chain } = await context.params;

  const upstream = upstreamUrlFor(chain);
  if (!upstream) {
    return NextResponse.json({ error: `Unknown chain segment: ${chain}` }, { status: 404 });
  }

  if (!checkIpRateLimit(clientIp(request))) {
    return NextResponse.json(
      { error: "Too many RPC requests from this IP. Slow down for a minute." },
      { status: 429 }
    );
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be valid JSON" }, { status: 400 });
  }

  if (Array.isArray(payload)) {
    return rejectBatch();
  }

  if (typeof payload !== "object" || payload === null) {
    return NextResponse.json({ error: "Body must be a JSON-RPC object" }, { status: 400 });
  }

  const rpc = payload as JsonRpcRequest;
  if (typeof rpc.method !== "string") {
    return NextResponse.json({ error: "Missing JSON-RPC method" }, { status: 400 });
  }
  if (!ALLOWED_METHODS.has(rpc.method)) {
    return NextResponse.json(
      { error: `Method ${rpc.method} not allowed by proxy.` },
      { status: 405 }
    );
  }

  // Forward. We pin a short timeout so a stuck upstream doesn't tie up the
  // serverless function — the client falls through to its next transport.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(upstream, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rpc),
      signal: controller.signal
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: "upstream_unreachable",
        detail: err instanceof Error ? err.message : String(err)
      },
      { status: 502 }
    );
  } finally {
    clearTimeout(timeout);
  }

  // Surface upstream JSON as-is. Don't blindly cast to JSON — some 429
  // responses come back as HTML; falling back to raw text keeps the
  // diagnostic visible to the client.
  const contentType = upstreamResponse.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    const text = await upstreamResponse.text();
    return NextResponse.json(
      {
        error: "upstream_non_json",
        status: upstreamResponse.status,
        snippet: text.slice(0, 500)
      },
      { status: upstreamResponse.status >= 400 ? upstreamResponse.status : 502 }
    );
  }

  const body = await upstreamResponse.json();
  return NextResponse.json(body, { status: upstreamResponse.status });
});

// GET exists only so a quick browser visit doesn't 404 confusingly during dev.
// All real traffic uses POST.
export async function GET() {
  return NextResponse.json(
    {
      error: "Use POST with a JSON-RPC body. This endpoint proxies read RPC methods only."
    },
    { status: 405 }
  );
}
