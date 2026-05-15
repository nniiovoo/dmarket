import { NextRequest, NextResponse } from "next/server";

import { withErrorBoundary } from "@/lib/api/withErrorBoundary";
import { prisma } from "@/lib/db";
import { fetchTrackingFrom17track } from "@/lib/tracking/17track";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

type RouteContext = {
  params: Promise<{ chainId: string; onChainOrderId: string }>;
};

export const GET = withErrorBoundary(async (_request: NextRequest, context: RouteContext) => {
  try {
    const params = await context.params;
    const chainId = Number(params.chainId);
    const onChainOrderId = params.onChainOrderId;

    if (!Number.isInteger(chainId) || chainId <= 0 || !/^[1-9]\d*$/.test(onChainOrderId)) {
      return NextResponse.json({ error: "Invalid order reference" }, { status: 400 });
    }

    const order = await prisma.onChainOrder.findUnique({
      where: { chainId_onChainOrderId: { chainId, onChainOrderId } }
    });

    if (!order) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }

    if (!order.trackingNumber) {
      return NextResponse.json(
        { state: "no-tracking", message: "Seller hasn't recorded a tracking number yet." },
        { status: 200 }
      );
    }

    // Cache lookup. Pinned to the current (chainId, onChainOrderId, trackingNumber)
    // so seller updates to the tracking number invalidate naturally.
    const cached = await prisma.trackingSnapshot.findUnique({
      where: { chainId_onChainOrderId: { chainId, onChainOrderId } }
    });

    const fresh = cached &&
      cached.trackingNumber === order.trackingNumber &&
      Date.now() - cached.lastFetchedAt.getTime() < CACHE_TTL_MS;

    if (fresh) {
      return NextResponse.json({
        state: "ok",
        cached: true,
        ...serializeSnapshot(cached)
      });
    }

    // Cache miss or stale — fetch from 17track and upsert.
    let result;

    try {
      result = await fetchTrackingFrom17track(order.trackingNumber);
    } catch (error) {
      console.error("[tracking] 17track lookup failed:", error);

      // Return any stale cache so the user still sees something, even if dated.
      if (cached) {
        return NextResponse.json({
          state: "stale",
          cached: true,
          warning: "Live tracking unavailable; showing last known status.",
          ...serializeSnapshot(cached)
        });
      }

      return NextResponse.json(
        { state: "unavailable", message: "暂无物流信息，请稍后重试。" },
        { status: 200 }
      );
    }

    const snapshot = await prisma.trackingSnapshot.upsert({
      where: { chainId_onChainOrderId: { chainId, onChainOrderId } },
      create: {
        chainId,
        onChainOrderId,
        trackingNumber: order.trackingNumber,
        status: result.status,
        statusCode: result.statusCode,
        latestEventAt: result.latestEventAt,
        events: result.events
      },
      update: {
        trackingNumber: order.trackingNumber,
        status: result.status,
        statusCode: result.statusCode,
        latestEventAt: result.latestEventAt,
        events: result.events,
        lastFetchedAt: new Date()
      }
    });

    return NextResponse.json({
      state: "ok",
      cached: false,
      ...serializeSnapshot(snapshot)
    });
  } catch (error) {
    console.error("[tracking] handler error:", error);
    return NextResponse.json({ error: "Failed to load tracking" }, { status: 500 });
  }
});

function serializeSnapshot(snapshot: {
  trackingNumber: string;
  status: string;
  statusCode: number;
  latestEventAt: Date | null;
  events: unknown;
  lastFetchedAt: Date;
}) {
  return {
    trackingNumber: snapshot.trackingNumber,
    status: snapshot.status,
    statusCode: snapshot.statusCode,
    latestEventAt: snapshot.latestEventAt?.toISOString() ?? null,
    events: Array.isArray(snapshot.events) ? snapshot.events : [],
    lastFetchedAt: snapshot.lastFetchedAt.toISOString()
  };
}
