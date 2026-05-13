"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { CarrierBadge } from "@/components/CarrierBadge";
import { fetchTracking, type TrackingResponse } from "@/lib/api/tracking";

// Maps 17track normalised status to a Chinese-facing label + Tailwind color.
const STATUS_DISPLAY: Record<string, { label: string; color: string }> = {
  Delivered: { label: "已签收", color: "bg-emerald-600" },
  InTransit: { label: "运输中", color: "bg-blue-600" },
  Pickup: { label: "待取件", color: "bg-amber-600" },
  Undelivered: { label: "派送失败", color: "bg-rose-600" },
  Exception: { label: "运输异常", color: "bg-rose-700" },
  Expired: { label: "信息已过期", color: "bg-slate-500" },
  Unknown: { label: "暂无状态", color: "bg-slate-500" }
};

export function TrackingLink({
  chainId,
  onChainOrderId,
  carrier,
  trackingNumber,
  trackingUrl,
  shippingNote
}: {
  chainId: number;
  onChainOrderId: string;
  carrier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  shippingNote: string | null;
}) {
  if (!trackingNumber) {
    return <p className="text-sm text-slate-500">卖家未提供物流信息。</p>;
  }

  return (
    <div className="space-y-3 text-sm">
      <div>
        <p className="text-xs font-medium uppercase text-slate-400">Carrier</p>
        <div className="mt-1">
          <CarrierBadge code={carrier} size="md" />
        </div>
      </div>
      <Info label="Tracking number" value={trackingNumber} />
      {shippingNote ? <Info label="Note" value={shippingNote} /> : null}

      <TrackingTimeline chainId={chainId} onChainOrderId={onChainOrderId} />

      {trackingUrl ? (
        <a
          href={trackingUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white"
        >
          Open tracking
        </a>
      ) : null}
    </div>
  );
}

function TrackingTimeline({ chainId, onChainOrderId }: { chainId: number; onChainOrderId: string }) {
  const [expanded, setExpanded] = useState(false);
  const query = useQuery({
    queryKey: ["tracking", chainId, onChainOrderId],
    queryFn: () => fetchTracking(chainId, onChainOrderId),
    // 2-hour cache aligned with server-side TTL.
    staleTime: 2 * 60 * 60 * 1000,
    retry: false
  });

  if (query.isLoading) {
    return <p className="text-xs text-slate-500">正在拉取物流轨迹...</p>;
  }

  if (query.isError) {
    return <p className="text-xs text-slate-500">暂无物流信息。</p>;
  }

  const data = query.data;

  if (!data) {
    return null;
  }

  if (data.state === "no-tracking") {
    return null; // Should not happen — parent already gates on trackingNumber.
  }

  if (data.state === "unavailable") {
    return <p className="text-xs text-slate-500">{data.message}</p>;
  }

  // After the early returns above, TS now knows we are in the "ok" | "stale"
  // variant, but the discriminated union narrowing needs an explicit guard.
  if (data.state !== "ok" && data.state !== "stale") {
    return null;
  }

  const display = STATUS_DISPLAY[data.status] ?? STATUS_DISPLAY.Unknown;
  const visibleEvents = expanded ? data.events : data.events.slice(0, 3);
  const hiddenCount = Math.max(0, data.events.length - visibleEvents.length);
  const latestEventTime = data.latestEventAt ? new Date(data.latestEventAt).toLocaleString() : null;
  const latestEvent = data.events[0];

  return (
    <div className="rounded-md border border-slate-200 p-3">
      <div className="flex items-center gap-2">
        <span className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium text-white ${display.color}`}>
          {display.label}
        </span>
        {latestEventTime ? <span className="text-xs text-slate-500">{latestEventTime}</span> : null}
        {data.state === "stale" ? (
          <span className="text-xs text-amber-700">（缓存）</span>
        ) : null}
      </div>

      {latestEvent ? (
        <p className="mt-2 text-sm text-slate-800">
          {latestEvent.description}
          {latestEvent.location ? <span className="text-slate-500"> · {latestEvent.location}</span> : null}
        </p>
      ) : null}

      {data.events.length > 0 ? (
        <div className="mt-3 space-y-2 border-t border-slate-100 pt-3">
          {visibleEvents.map((event, idx) => (
            <div key={`${event.time}-${idx}`} className="text-xs">
              <p className="text-slate-500">{new Date(event.time).toLocaleString()}</p>
              <p className="text-slate-800">
                {event.description}
                {event.location ? <span className="text-slate-500"> · {event.location}</span> : null}
              </p>
            </div>
          ))}
          {hiddenCount > 0 ? (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="text-xs font-medium text-blue-700 underline"
            >
              展开剩余 {hiddenCount} 条事件
            </button>
          ) : null}
          {expanded && data.events.length > 3 ? (
            <button
              type="button"
              onClick={() => setExpanded(false)}
              className="text-xs font-medium text-blue-700 underline"
            >
              收起
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase text-slate-400">{label}</p>
      <p className="break-all text-slate-800">{value}</p>
    </div>
  );
}
