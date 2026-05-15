import { NextRequest, NextResponse } from "next/server";

type Handler<Ctx> = (req: NextRequest, ctx: Ctx) => Promise<NextResponse> | NextResponse;

// Wraps a Next.js route handler so unexpected errors return JSON instead
// of an empty 500. The client always gets a parseable body, even when the
// handler crashes before sending a response (the original v3.1 viewer bug:
// prisma.onChainOrderV3_1.findUnique threw because the table didn't exist
// yet, Next.js returned a bodyless 500, frontend's .json() exploded with
// "Unexpected end of JSON input").
//
// Idempotent: wrapping a handler that already has its own try/catch is
// harmless. The outer catch only fires for errors the inner handler
// genuinely failed to convert into a NextResponse.
export function withErrorBoundary<Ctx>(handler: Handler<Ctx>): Handler<Ctx> {
  return async (req, ctx) => {
    try {
      return await handler(req, ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Server-side: log with stack for debugging. Client-side: get a safe
      // shape — never the stack, but the message is fine since it usually
      // names the prisma model / RPC method that failed.
      console.error(`[api] ${req.method} ${req.nextUrl.pathname} crashed:`, err);
      return NextResponse.json(
        {
          error: "internal_error",
          message,
          path: req.nextUrl.pathname
        },
        { status: 500 }
      );
    }
  };
}
