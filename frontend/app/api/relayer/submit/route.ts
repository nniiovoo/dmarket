import { NextRequest, NextResponse } from "next/server";

import { withErrorBoundary } from "@/lib/api/withErrorBoundary";

const DEFAULT_RELAYER_URL = "http://localhost:4001/submit";

export const POST = withErrorBoundary(async (request: NextRequest) => {
  const body = await request.json();
  const relayerUrl = process.env.RELAYER_URL || DEFAULT_RELAYER_URL;

  try {
    const response = await fetch(relayerUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const payload = await response.json().catch(() => ({
      ok: false,
      error: "Relayer returned a non-JSON response"
    }));

    return NextResponse.json(payload, { status: response.status });
  } catch (error: unknown) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Relayer proxy failed"
      },
      { status: 502 }
    );
  }
});
